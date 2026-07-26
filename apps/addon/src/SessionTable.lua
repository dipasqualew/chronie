local _, ns = ...

---Turns the session log into a DetailSpec: a totals section over the whole retention
---window, then one section per day, newest first. Pure — it renders no widgets, so
---the shape of the report is testable without the frame API.
---@class SessionTable
---@field spec fun(records: SessionRecord[]): DetailSpec
---@field formatDuration fun(seconds: integer): string
---@field formatReputation fun(gains: ReputationGain[]): string
---@field formatCurrencies fun(gains: CurrencyGain[]): string
---@field filter fun(records: SessionRecord[], filters: SessionFilters?): SessionRecord[]

---@class SessionFilters
---@field character string?
---@field day string?
---@field location string?

---@class SessionTableDeps
---@field classDisplay ClassDisplay
---@field formatMoney fun(copper: integer): string
---@field retainDays integer? Only used in the title. Default 7.
---@field onSessionSelected fun(record: SessionRecord)?

local ROW_COLOR = { 1, 1, 1 }
local TOTAL_COLOR = { 1, 0.82, 0 }

local NONE = "—"
local MINUTE, HOUR = 60, 3600

local DAY_COLUMNS = {
    { title = "Character", width = 148 },
    { title = "Location", width = 150 },
    { title = "Difficulty", width = 80 },
    { title = "Time", width = 52 },
    { title = "Loot value", width = 92 },
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
    { title = "Loot value", width = 92 },
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

---@param gains ReputationGain[]?
---@return string
local function formatReputation(gains)
    local total = 0
    for _, gain in ipairs(gains or {}) do
        total = total + (gain.amount or 0)
    end
    return #(gains or {}) > 0 and ((total >= 0 and "+" or "") .. total) or NONE
end

---@param gains CurrencyGain[]?
---@return string
local function formatCurrencies(gains)
    local total = 0
    for _, gain in ipairs(gains or {}) do
        total = total + (gain.amount or 0)
    end
    return #(gains or {}) > 0 and ((total >= 0 and "+" or "") .. total) or NONE
end

---Folds a record into a running tally.
---@param tally table?
---@param record SessionRecord
---@return table
local function accumulate(tally, record)
    tally = tally or {
        sessions = 0, seconds = 0, lootValue = 0, goldDiff = 0, transmog = 0,
        reputation = 0, reputationSeen = false, currency = 0, currencySeen = false,
    }
    tally.sessions = tally.sessions + 1
    tally.seconds = tally.seconds + (record.seconds or 0)
    tally.lootValue = tally.lootValue + (record.lootValue or 0)
    tally.goldDiff = tally.goldDiff + (record.goldDiff or 0)
    tally.transmog = tally.transmog + #(record.transmogs or {})

    for _, gain in ipairs(record.reputation or {}) do
        tally.reputation = tally.reputation + (gain.amount or 0)
        tally.reputationSeen = true
    end

    for _, gain in ipairs(record.currencies or {}) do
        tally.currency = tally.currency + (gain.amount or 0)
        tally.currencySeen = true
    end

    return tally
end

---@param value string?
---@return string
local function normalise(value)
    return string.lower((value or ""):match("^%s*(.-)%s*$"))
end

---@param records SessionRecord[]
---@param filters SessionFilters?
---@return SessionRecord[]
local function filter(records, filters)
    filters = filters or {}
    local character = normalise(filters.character)
    local day = normalise(filters.day)
    local location = normalise(filters.location)
    local filtered = {}

    for _, record in ipairs(records or {}) do
        local matchesCharacter = character == "" or string.find(normalise(record.character), character, 1, true)
        local matchesDay = day == "" or string.find(normalise(record.day), day, 1, true)
        local matchesLocation = location == "" or string.find(normalise(record.instance), location, 1, true)
        if matchesCharacter and matchesDay and matchesLocation then
            filtered[#filtered + 1] = record
        end
    end

    return filtered
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
    local onSessionSelected = deps.onSessionSelected

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
            onClick = onSessionSelected and function()
                onSessionSelected(record)
            end or nil,
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
                    tally.currencySeen and ((tally.currency >= 0 and "+" or "") .. tally.currency) or NONE,
                    tally.reputationSeen and ((tally.reputation >= 0 and "+" or "") .. tally.reputation) or NONE,
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
        filter = filter,

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
