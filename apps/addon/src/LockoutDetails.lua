local _, ns = ...

---A character known to the addon, as the detail views need it.
---@class RosterEntry
---@field character string "Name-Realm".
---@field class string?
---@field classFile string?
---@field level integer?
---@field lastSeen integer?

---One lockable activity, stripped of whoever happens to be locked to it. Difficulty is
---metadata rather than identity: being saved to a raid at one difficulty bars the others
---too, so grouping per difficulty would report a locked character as available at the
---sibling size.
---@class ActivityDescriptor
---@field key string Identity: the activity's own key.
---@field activity string Localised name.
---@field kind "raid"|"dungeon"|"world_boss"
---@field period "daily"|"weekly"|"unknown"
---@field difficultyId integer? Difficulty of the row this was derived from, if any.
---@field difficulty string Difficulty of the row this was derived from; "" when unknown.
---@field isRaid boolean

---How far through an activity a character is.
---@class LockoutStatus
---@field state "available"|"partial"|"locked"
---@field killed integer
---@field total integer

---A rendered line: cell texts plus the colour the whole line is drawn in.
---@class DetailRow
---@field cells string[]
---@field color number[] `{ r, g, b }`

---@class DetailSection
---@field heading string?
---@field columns { title: string, width: integer }[]
---@field rows DetailRow[]
---@field empty string? Shown in place of `rows` when there are none.

---@class DetailSpec
---@field title string
---@field sections DetailSection[]

---@class LockoutDetails
---@field statusOf fun(row: LockoutRow?): LockoutStatus
---@field descriptorOf fun(row: LockoutRow): ActivityDescriptor
---@field activities fun(rows: LockoutRow[]): ActivityDescriptor[]
---@field forActivity fun(descriptor: ActivityDescriptor, roster: RosterEntry[], rows: LockoutRow[]): DetailSpec
---@field forCharacter fun(character: string, rows: LockoutRow[]): DetailSpec

---@class LockoutDetailsDeps
---@field now fun(): integer
---@field lockoutTable LockoutTable
---@field classDisplay ClassDisplay
---@field expansions ExpansionIndex

local AVAILABLE_COLOR = { 0.35, 1, 0.35 }
local PARTIAL_COLOR = { 1, 0.82, 0 }
local LOCKED_COLOR = { 1, 0.4, 0.4 }

---Ready-check art ships with every client, so the state reads at a glance without
---relying on the game font carrying any particular unicode glyph.
local ICONS = {
    available = "|TInterface\\RaidFrame\\ReadyCheck-Ready:12|t",
    partial = "|TInterface\\RaidFrame\\ReadyCheck-Waiting:12|t",
    locked = "|TInterface\\RaidFrame\\ReadyCheck-NotReady:12|t",
}

local LABELS = {
    available = "Available",
    partial = "Partial",
    locked = "Locked",
}

local COLORS = {
    available = AVAILABLE_COLOR,
    partial = PARTIAL_COLOR,
    locked = LOCKED_COLOR,
}

---Available first, then whatever is still worth running, then dead weight.
local STATE_RANK = { available = 1, partial = 2, locked = 3 }

---Which section of a character's drill-down an activity belongs in.
local SECTION_OF_KIND = { raid = "raids", dungeon = "dungeons", world_boss = "worldBosses" }

local PERIOD_PREFIX = { daily = "Daily", weekly = "Weekly" }

local NONE = "—"

---The activity a lockout row belongs to, stripped of the character that owns it.
---@param row LockoutRow
---@return ActivityDescriptor
local function descriptorOf(row)
    return {
        key = row.key,
        activity = row.activity,
        kind = row.kind or (row.isRaid and "raid" or "dungeon"),
        period = row.period or "unknown",
        difficultyId = row.difficultyId,
        difficulty = row.difficulty or "",
        isRaid = row.isRaid and true or false,
    }
end

---@param deps LockoutDetailsDeps
---@return LockoutDetails
function ns.newLockoutDetails(deps)
    local now = deps.now
    local lockoutTable = deps.lockoutTable
    local classDisplay = deps.classDisplay
    local expansions = deps.expansions

    ---An absent or lapsed lockout both mean the character is free to go in.
    ---A lockout with no recorded bosses counts as fully locked: we cannot prove
    ---anything is left, so the safe reading is that nothing is. That is also exactly
    ---right for a world boss, which is locked outright or not at all.
    ---@param row LockoutRow?
    ---@return LockoutStatus
    local function statusOf(row)
        if not row or row.expiry <= now() then
            return { state = "available", killed = 0, total = 0 }
        end

        local encounters = row.encounters or {}
        local killed = 0
        for _, encounter in ipairs(encounters) do
            if encounter.killed then
                killed = killed + 1
            end
        end

        local state = "locked"
        if #encounters > 0 and killed < #encounters then
            state = "partial"
        end

        return { state = state, killed = killed, total = #encounters }
    end

    ---@param row LockoutRow
    ---@return integer
    local function killCount(row)
        local killed = 0
        for _, encounter in ipairs(row.encounters or {}) do
            if encounter.killed then
                killed = killed + 1
            end
        end
        return killed
    end

    ---A character saved to one instance at two difficulties is locked out of both,
    ---so a single row has to speak for the pair. The later reset wins, because that
    ---is when the character is really free again; equal resets fall to whichever row
    ---shows more progress, so the drill-down never understates a lockout.
    ---@param current LockoutRow?
    ---@param candidate LockoutRow
    ---@return LockoutRow
    local function moreBinding(current, candidate)
        if not current then
            return candidate
        end
        if candidate.expiry ~= current.expiry then
            return candidate.expiry > current.expiry and candidate or current
        end
        return killCount(candidate) > killCount(current) and candidate or current
    end

    ---@param rows LockoutRow[]
    ---@return table<string, LockoutRow> indexed by character .. "\1" .. activity key
    local function indexRows(rows)
        local index = {}
        for _, row in ipairs(rows) do
            local key = row.character .. "\1" .. row.key
            index[key] = moreBinding(index[key], row)
        end
        return index
    end

    ---@param status LockoutStatus
    ---@return string
    local function progressText(status)
        if status.state == "available" then
            return NONE
        end
        if status.total == 0 then
            return "no boss data"
        end
        if status.state == "partial" then
            return string.format("%d of %d left", status.total - status.killed, status.total)
        end
        return string.format("%d/%d", status.killed, status.total)
    end

    ---@param row LockoutRow?
    ---@param status LockoutStatus
    ---@return string
    local function resetText(row, status)
        if not row or status.state == "available" then
            return NONE
        end
        return lockoutTable.formatExpiry(row)
    end

    ---Sorts by state first so the answer to "who can still go?" sits at the top.
    ---@param entries { state: string, sortKey: string }[]
    local function sortByState(entries)
        table.sort(entries, function(left, right)
            if left.state ~= right.state then
                return STATE_RANK[left.state] < STATE_RANK[right.state]
            end
            return left.sortKey < right.sortKey
        end)
    end

    ---@param rows LockoutRow[]
    ---@return ActivityDescriptor[]
    local function activities(rows)
        local seen = {}
        local list = {}

        for _, row in ipairs(rows) do
            local descriptor = descriptorOf(row)
            if not seen[descriptor.key] then
                seen[descriptor.key] = true
                list[#list + 1] = descriptor
            end
        end

        table.sort(list, function(left, right)
            return left.activity < right.activity
        end)

        return list
    end

    return {
        statusOf = statusOf,
        descriptorOf = descriptorOf,
        activities = activities,

        ---Every known character measured against one activity, across all of its
        ---difficulties: a save at any difficulty locks the character out of the rest.
        ---@param descriptor ActivityDescriptor
        ---@param roster RosterEntry[]
        ---@param rows LockoutRow[]
        ---@return DetailSpec
        forActivity = function(descriptor, roster, rows)
            local index = indexRows(rows)
            local entries = {}

            for _, entry in ipairs(roster) do
                local row = index[entry.character .. "\1" .. descriptor.key]
                local status = statusOf(row)
                entries[#entries + 1] = {
                    state = status.state,
                    sortKey = entry.character,
                    cells = {
                        -- The class colour is inlined rather than applied to the cell:
                        -- the cell's own colour is the lockout status, and both matter.
                        ICONS[status.state] .. " " .. classDisplay.decorate(entry.classFile, entry.character),
                        LABELS[status.state],
                        -- Which difficulty the save sits on: no longer part of the
                        -- grouping, but still the thing the player wants to see.
                        (row and status.state ~= "available" and row.difficulty ~= "" and row.difficulty) or NONE,
                        progressText(status),
                        resetText(row, status),
                    },
                    color = COLORS[status.state],
                }
            end

            sortByState(entries)

            -- The cadence leads the title because it is the fact that belongs to the
            -- activity itself rather than to any one character's save of it.
            local title = descriptor.activity
            local tag = expansions.tagFor(descriptor.activity)
            if tag ~= "" then
                title = tag .. " " .. title
            end
            local period = PERIOD_PREFIX[descriptor.period]
            if period then
                title = period .. " — " .. title
            end

            return {
                title = title,
                sections = {
                    {
                        heading = "Characters",
                        columns = {
                            { title = "Character", width = 200 },
                            { title = "Status", width = 100 },
                            { title = "Difficulty", width = 120 },
                            { title = "Bosses", width = 120 },
                            { title = "Resets", width = 190 },
                        },
                        rows = entries,
                        empty = "No characters recorded yet.",
                    },
                },
            }
        end,

        ---One character measured against every activity any character has seen, split by
        ---kind. The roster is not consulted: an activity is only "known" because some
        ---character is saved to it, so `rows` is the universe.
        ---@param character string
        ---@param rows LockoutRow[]
        ---@return DetailSpec
        forCharacter = function(character, rows)
            local index = indexRows(rows)
            local buckets = { raids = {}, dungeons = {}, worldBosses = {} }
            local classFile

            for _, row in ipairs(rows) do
                if row.character == character and row.classFile then
                    classFile = row.classFile
                    break
                end
            end

            for _, descriptor in ipairs(activities(rows)) do
                local row = index[character .. "\1" .. descriptor.key]
                local status = statusOf(row)
                local entry = {
                    state = status.state,
                    sortKey = descriptor.activity,
                    cells = {
                        ICONS[status.state] .. " " .. descriptor.activity,
                        expansions.tagFor(descriptor.activity),
                        -- The difficulty this character is saved to, not the one the
                        -- descriptor happened to be built from.
                        (row and row.difficulty ~= "" and row.difficulty) or NONE,
                        LABELS[status.state],
                        progressText(status),
                        resetText(row, status),
                    },
                    color = COLORS[status.state],
                }

                local bucket = buckets[SECTION_OF_KIND[descriptor.kind] or "dungeons"]
                bucket[#bucket + 1] = entry
            end

            local columns = {
                { title = "Activity", width = 190 },
                { title = "Expansion", width = 80 },
                { title = "Difficulty", width = 120 },
                { title = "Status", width = 90 },
                { title = "Bosses", width = 110 },
                { title = "Resets", width = 190 },
            }

            local sections = {}
            for _, section in ipairs({
                { key = "raids", heading = "Raids", empty = "No raids recorded yet." },
                { key = "dungeons", heading = "Dungeons", empty = "No dungeons recorded yet." },
                { key = "worldBosses", heading = "World bosses", empty = "No world bosses recorded yet." },
            }) do
                sortByState(buckets[section.key])
                sections[#sections + 1] = {
                    heading = section.heading,
                    columns = columns,
                    rows = buckets[section.key],
                    empty = section.empty,
                }
            end

            return {
                title = classDisplay.decorate(classFile, character),
                sections = sections,
            }
        end,
    }
end
