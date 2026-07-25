local _, ns = ...

---One finished session, as it is written to SavedVariables and later exported. Flat
---and JSON-shaped on purpose: the collector script reads this table verbatim. A session
---is one character's continuous stay in one location — an instance or an open-world zone.
---@class SessionRecord
---@field id string Stable identity, so re-recording the same session overwrites it.
---@field character string "Name-Realm".
---@field classFile string? Non-localised class token of the character that ran it.
---@field day string "YYYY-MM-DD", the local day the session ended.
---@field instance string Location name — the zone or instance the session took place in.
---@field difficulty string "" when the client never named one.
---@field instanceType string "party", "raid", "scenario", "none" (open world), ...
---@field difficultyId integer?
---@field startedAt integer
---@field endedAt integer
---@field seconds integer How long the session lasted.
---@field lootValue integer Coin looted plus the vendor value of items looted, in copper.
---@field goldDiff integer Net wallet change over the session, in copper; may be negative.
---@field newAppearances integer
---@field newVersions integer
---@field currencyTotal integer
---@field reputationTotal integer
---@field currencies CurrencyGain[]
---@field reputation ReputationGain[]
---@field achievements AchievementEvent[]

---What the tracker hands over when a session ends.
---@class SessionVisit
---@field character string
---@field classFile string?
---@field instance string
---@field difficulty string?
---@field instanceType string?
---@field difficultyId integer?
---@field startedAt integer
---@field endedAt integer
---@field summary SessionSummary

---A rolling log of finished sessions, capped at a window of recent days.
---@class SessionLog
---@field record fun(visit: SessionVisit): SessionRecord
---@field all fun(): SessionRecord[] Newest first, pruned to the retention window.
---@field prune fun(): integer How many records were dropped.

---@class SessionLogDeps
---@field db table SavedVariables table; mutated in place so the client persists it.
---@field now fun(): integer
---@field formatDate fun(format: string, timestamp: integer): string Usually the global `date`.
---@field retainDays integer? Days of history to keep. Default 7.

local DAY = 24 * 60 * 60
local DEFAULT_RETAIN_DAYS = 7

---@param deps SessionLogDeps
---@return SessionLog
function ns.newSessionLog(deps)
    local db = deps.db
    local now = deps.now
    local formatDate = deps.formatDate
    local retainSeconds = (deps.retainDays or DEFAULT_RETAIN_DAYS) * DAY

    db.sessions = db.sessions or {}

    ---Drops everything that fell out of the retention window. Called on every read
    ---and every write, so the file the collector picks up is already trimmed.
    ---@return integer dropped
    local function prune()
        local cutoff = now() - retainSeconds
        local kept = {}
        local dropped = 0

        for _, record in ipairs(db.sessions) do
            if (record.endedAt or 0) >= cutoff then
                kept[#kept + 1] = record
            else
                dropped = dropped + 1
            end
        end

        db.sessions = kept
        return dropped
    end

    ---Copies the reputation list so a later mutation of the live tally cannot reach
    ---back into a record that has already been filed.
    ---@param gains ReputationGain[]?
    ---@return ReputationGain[]
    local function copyReputation(gains)
        local copy = {}
        for index, gain in ipairs(gains or {}) do
            copy[index] = { faction = gain.faction, amount = gain.amount }
        end
        return copy
    end

    ---@param gains CurrencyGain[]?
    ---@return CurrencyGain[]
    local function copyCurrencies(gains)
        local copy = {}
        for index, gain in ipairs(gains or {}) do
            copy[index] = { id = gain.id, name = gain.name, amount = gain.amount }
        end
        return copy
    end

    ---@param earned AchievementEvent[]?
    ---@return AchievementEvent[]
    local function copyAchievements(earned)
        local copy = {}
        for index, event in ipairs(earned or {}) do
            copy[index] = { id = event.id, name = event.name, at = event.at }
        end
        return copy
    end

    return {
        prune = prune,

        ---Files a finished session. Recording the same session twice — a flush on logout
        ---after the zone change already filed it — replaces the record rather than
        ---duplicating it, because the identity is the session, not the call.
        ---@param visit SessionVisit
        ---@return SessionRecord
        record = function(visit)
            local summary = visit.summary or {}
            local endedAt = visit.endedAt or now()
            local startedAt = visit.startedAt or endedAt

            local record = {
                id = table.concat({ visit.character, tostring(startedAt), visit.instance }, "|"),
                character = visit.character,
                classFile = visit.classFile,
                day = formatDate("%Y-%m-%d", endedAt),
                instance = visit.instance,
                difficulty = visit.difficulty or "",
                instanceType = visit.instanceType or "",
                difficultyId = visit.difficultyId,
                startedAt = startedAt,
                endedAt = endedAt,
                seconds = math.max(endedAt - startedAt, 0),
                lootValue = summary.lootValue or 0,
                goldDiff = summary.goldDiff or 0,
                newAppearances = summary.newAppearances or 0,
                newVersions = summary.newVersions or 0,
                currencyTotal = summary.currencyTotal or 0,
                reputationTotal = summary.reputationTotal or 0,
                currencies = copyCurrencies(summary.currencies),
                reputation = copyReputation(summary.reputation),
                achievements = copyAchievements(summary.achievements),
            }

            local replaced = false
            for index, existing in ipairs(db.sessions) do
                if existing.id == record.id then
                    db.sessions[index] = record
                    replaced = true
                    break
                end
            end
            if not replaced then
                db.sessions[#db.sessions + 1] = record
            end

            prune()
            return record
        end,

        ---@return SessionRecord[]
        all = function()
            prune()

            local list = {}
            for index, record in ipairs(db.sessions) do
                list[index] = record
            end

            table.sort(list, function(left, right)
                if left.endedAt ~= right.endedAt then
                    return left.endedAt > right.endedAt
                end
                -- Ties are real: two visits can end in the same second. Order by
                -- identity so the table never reshuffles between renders.
                return left.id < right.id
            end)

            return list
        end,
    }
end
