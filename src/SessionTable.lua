local _, ns = ...

---Turns the session log into a DetailSpec: a totals section over the whole retention
---window, then one section per day, newest first. Pure — it renders no widgets, so
---the shape of the report is testable without the frame API.
---@class SessionTable
---@field spec fun(records: SessionRecord[]): DetailSpec
---@field formatDuration fun(seconds: integer): string
---@field formatReputation fun(gains: ReputationGain[]): string

---@class SessionTableDeps
---@field classDisplay ClassDisplay
---@field formatMoney fun(copper: integer): string
---@field retainDays integer? Only used in the title. Default 7.

local ROW_COLOR = { 1, 1, 1 }
local TOTAL_COLOR = { 1, 0.82, 0 }

local NONE = "—"
local MINUTE, HOUR = 60, 3600

---How many factions fit in the reputation cell before it is abbreviated.
local REPUTATION_SHOWN = 2

local DAY_COLUMNS = {
    { title = "Character", width = 170 },
    { title = "Instance", width = 190 },
    { title = "Difficulty", width = 110 },
    { title = "Time", width = 60 },
    { title = "Gold", width = 110 },
    { title = "Transmog", width = 80 },
    { title = "Reputation", width = 120 },
}

local TOTAL_COLUMNS = {
    { title = "Character", width = 170 },
    { title = "Runs", width = 190 },
    { title = "", width = 110 },
    { title = "Time", width = 60 },
    { title = "Gold", width = 110 },
    { title = "Transmog", width = 80 },
    { title = "Reputation", width = 120 },
}

---@param seconds integer?
---@return string
local function formatDuration(seconds)
    seconds = math.max(math.floor(seconds or 0), 0)
    if seconds >= HOUR then
        return string.format("%dh %02dm", math.floor(seconds / HOUR), math.floor((seconds % HOUR) / MINUTE))
    end
    return string.format("%d:%02d", math.floor(seconds / MINUTE), seconds % MINUTE)
end

---@param gains ReputationGain[]?
---@return string
local function formatReputation(gains)
    gains = gains or {}
    if #gains == 0 then
        return NONE
    end

    local parts = {}
    for index = 1, math.min(#gains, REPUTATION_SHOWN) do
        parts[#parts + 1] = gains[index].faction .. " +" .. gains[index].amount
    end
    if #gains > REPUTATION_SHOWN then
        parts[#parts + 1] = "+" .. (#gains - REPUTATION_SHOWN) .. " more"
    end

    return table.concat(parts, ", ")
end

---Folds a record into a running tally. Reputation collapses to a faction count,
---which is all a totals line has room to say.
---@param tally table?
---@param record SessionRecord
---@return table
local function accumulate(tally, record)
    tally = tally or { runs = 0, seconds = 0, gold = 0, transmog = 0, factions = {}, factionCount = 0 }
    tally.runs = tally.runs + 1
    tally.seconds = tally.seconds + (record.seconds or 0)
    tally.gold = tally.gold + (record.gold or 0)
    tally.transmog = tally.transmog + (record.newAppearances or 0)

    for _, gain in ipairs(record.reputation or {}) do
        if not tally.factions[gain.faction] then
            tally.factions[gain.faction] = true
            tally.factionCount = tally.factionCount + 1
        end
    end

    return tally
end

---@param count integer
---@param noun string
---@return string
local function plural(count, noun)
    return count .. " " .. noun .. (count == 1 and "" or "s")
end

---@param deps SessionTableDeps
---@return SessionTable
function ns.newSessionTable(deps)
    local classDisplay = deps.classDisplay
    local formatMoney = deps.formatMoney
    local retainDays = deps.retainDays or 7

    ---@param record SessionRecord
    ---@return DetailRow
    local function rowOf(record)
        return {
            cells = {
                classDisplay.decorate(record.classFile, record.character),
                record.instance,
                record.difficulty ~= "" and record.difficulty or NONE,
                formatDuration(record.seconds),
                formatMoney(record.gold),
                record.newAppearances .. " / " .. record.newVersions,
                formatReputation(record.reputation),
            },
            color = ROW_COLOR,
        }
    end

    ---One line per character, summed over every record in the window.
    ---@param records SessionRecord[]
    ---@return DetailRow[]
    local function totalRows(records)
        local byCharacter = {}
        local order = {}

        for _, record in ipairs(records) do
            if not byCharacter[record.character] then
                order[#order + 1] = record.character
            end
            byCharacter[record.character] = accumulate(byCharacter[record.character], record)
            byCharacter[record.character].classFile = record.classFile or byCharacter[record.character].classFile
        end

        table.sort(order, function(left, right)
            local a, b = byCharacter[left], byCharacter[right]
            if a.gold ~= b.gold then
                return a.gold > b.gold
            end
            return left < right
        end)

        local rows = {}
        for index, character in ipairs(order) do
            local tally = byCharacter[character]
            rows[index] = {
                cells = {
                    classDisplay.decorate(tally.classFile, character),
                    plural(tally.runs, "run"),
                    "",
                    formatDuration(tally.seconds),
                    formatMoney(tally.gold),
                    tostring(tally.transmog),
                    tally.factionCount > 0 and plural(tally.factionCount, "faction") or NONE,
                },
                color = TOTAL_COLOR,
            }
        end

        return rows
    end

    return {
        formatDuration = formatDuration,
        formatReputation = formatReputation,

        ---@param records SessionRecord[] Newest first, as SessionLog.all returns them.
        ---@return DetailSpec
        spec = function(records)
            records = records or {}

            local sections = {
                {
                    heading = "Totals",
                    columns = TOTAL_COLUMNS,
                    rows = totalRows(records),
                    empty = "No instances recorded yet.",
                },
            }

            -- Records arrive newest first, so days come out in that order too and no
            -- second sort is needed to keep today at the top.
            local days = {}
            local order = {}
            for _, record in ipairs(records) do
                local day = record.day or "?"
                if not days[day] then
                    days[day] = { rows = {}, tally = nil }
                    order[#order + 1] = day
                end
                local bucket = days[day]
                bucket.rows[#bucket.rows + 1] = rowOf(record)
                bucket.tally = accumulate(bucket.tally, record)
            end

            for _, day in ipairs(order) do
                local bucket = days[day]
                sections[#sections + 1] = {
                    heading = string.format(
                        "%s — %s, %s",
                        day,
                        plural(bucket.tally.runs, "run"),
                        formatMoney(bucket.tally.gold)
                    ),
                    columns = DAY_COLUMNS,
                    rows = bucket.rows,
                }
            end

            return {
                title = "Instance sessions — last " .. retainDays .. " days",
                sections = sections,
            }
        end,
    }
end
