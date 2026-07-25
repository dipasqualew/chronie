local _, ns = ...

---Turns the session log into a DetailSpec: a totals section over the whole retention
---window, then one section per day, newest first. Pure — it renders no widgets, so
---the shape of the report is testable without the frame API.
---@class SessionTable
---@field spec fun(records: SessionRecord[]): DetailSpec
---@field formatDuration fun(seconds: integer): string
---@field formatReputation fun(gains: ReputationGain[]): string
---@field formatCurrencies fun(gains: CurrencyGain[]): string

---@class SessionTableDeps
---@field classDisplay ClassDisplay
---@field formatMoney fun(copper: integer): string
---@field retainDays integer? Only used in the title. Default 7.

local ROW_COLOR = { 1, 1, 1 }
local TOTAL_COLOR = { 1, 0.82, 0 }

local NONE = "—"
local MINUTE, HOUR = 60, 3600

---How many entries fit in the reputation/currency cell before it is abbreviated.
local NAMED_SHOWN = 2

local DAY_COLUMNS = {
    { title = "Character", width = 148 },
    { title = "Location", width = 150 },
    { title = "Difficulty", width = 80 },
    { title = "Time", width = 52 },
    { title = "Loot", width = 92 },
    { title = "Gold Δ", width = 84 },
    { title = "Transmog", width = 56 },
    { title = "Currency", width = 88 },
    { title = "Reputation", width = 66 },
}

local TOTAL_COLUMNS = {
    { title = "Character", width = 148 },
    { title = "Sessions", width = 150 },
    { title = "", width = 80 },
    { title = "Time", width = 52 },
    { title = "Loot", width = 92 },
    { title = "Gold Δ", width = 84 },
    { title = "Transmog", width = 56 },
    { title = "Currency", width = 88 },
    { title = "Reputation", width = 66 },
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

---Names the first couple of entries in full, then counts the rest, so a busy cell reads
---"Argent Dawn +40, Timbermaw Hold +10, +2 more" without overflowing.
---@param entries table[]?
---@param label fun(entry: table): string
---@return string
local function summarise(entries, label)
    entries = entries or {}
    if #entries == 0 then
        return NONE
    end

    local parts = {}
    for index = 1, math.min(#entries, NAMED_SHOWN) do
        parts[#parts + 1] = label(entries[index])
    end
    if #entries > NAMED_SHOWN then
        parts[#parts + 1] = "+" .. (#entries - NAMED_SHOWN) .. " more"
    end

    return table.concat(parts, ", ")
end

---@param gains ReputationGain[]?
---@return string
local function formatReputation(gains)
    return summarise(gains, function(gain)
        return gain.faction .. " +" .. gain.amount
    end)
end

---@param gains CurrencyGain[]?
---@return string
local function formatCurrencies(gains)
    return summarise(gains, function(gain)
        return gain.name .. " " .. (gain.amount >= 0 and "+" or "") .. gain.amount
    end)
end

---Folds a record into a running tally. Reputation and currency collapse to a name
---count, which is all a totals line has room to say.
---@param tally table?
---@param record SessionRecord
---@return table
local function accumulate(tally, record)
    tally = tally or {
        sessions = 0, seconds = 0, lootValue = 0, goldDiff = 0, transmog = 0,
        factions = {}, factionCount = 0, currencies = {}, currencyCount = 0,
    }
    tally.sessions = tally.sessions + 1
    tally.seconds = tally.seconds + (record.seconds or 0)
    tally.lootValue = tally.lootValue + (record.lootValue or 0)
    tally.goldDiff = tally.goldDiff + (record.goldDiff or 0)
    tally.transmog = tally.transmog + #(record.transmogs or {})

    for _, gain in ipairs(record.reputation or {}) do
        if not tally.factions[gain.faction] then
            tally.factions[gain.faction] = true
            tally.factionCount = tally.factionCount + 1
        end
    end

    for _, gain in ipairs(record.currencies or {}) do
        if not tally.currencies[gain.id] then
            tally.currencies[gain.id] = true
            tally.currencyCount = tally.currencyCount + 1
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
                formatMoney(record.lootValue),
                formatMoney(record.goldDiff),
                tostring(#(record.transmogs or {})),
                formatCurrencies(record.currencies),
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
            if a.lootValue ~= b.lootValue then
                return a.lootValue > b.lootValue
            end
            return left < right
        end)

        local rows = {}
        for index, character in ipairs(order) do
            local tally = byCharacter[character]
            rows[index] = {
                cells = {
                    classDisplay.decorate(tally.classFile, character),
                    plural(tally.sessions, "session"),
                    "",
                    formatDuration(tally.seconds),
                    formatMoney(tally.lootValue),
                    formatMoney(tally.goldDiff),
                    tostring(tally.transmog),
                    tally.currencyCount > 0 and plural(tally.currencyCount, "currency") or NONE,
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
        formatCurrencies = formatCurrencies,

        ---@param records SessionRecord[] Newest first, as SessionLog.all returns them.
        ---@return DetailSpec
        spec = function(records)
            records = records or {}

            local sections = {
                {
                    heading = "Totals",
                    columns = TOTAL_COLUMNS,
                    rows = totalRows(records),
                    empty = "No sessions recorded yet.",
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
                        plural(bucket.tally.sessions, "session"),
                        formatMoney(bucket.tally.lootValue)
                    ),
                    columns = DAY_COLUMNS,
                    rows = bucket.rows,
                }
            end

            return {
                title = "Sessions — last " .. retainDays .. " days",
                sections = sections,
            }
        end,
    }
end
