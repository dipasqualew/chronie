local _, ns = ...

---One finished segment, as it is written to SavedVariables and later exported. Flat
---and JSON-shaped on purpose: the collector script reads this table verbatim. A segment
---is one character's continuous stay in one location — an instance or an open-world zone.
---@class SegmentRecord
---@field id string Stable identity, so re-recording the same segment overwrites it.
---@field character string "Name-Realm".
---@field classFile string? Non-localised class token of the character that ran it.
---@field level integer? Character level when the segment started.
---@field day string "YYYY-MM-DD", the local day the segment ended.
---@field instance string Location name — the zone or instance the segment took place in.
---@field difficulty string "" when the client never named one.
---@field instanceType string "party", "raid", "scenario", "none" (open world), ...
---@field difficultyId integer?
---@field startedAt integer
---@field endedAt integer
---@field seconds integer How long the segment lasted.
---@field lootValue integer Vendor value of items entering the inventory, in copper.
---@field goldDiff integer Net wallet change over the segment, in copper; may be negative.
---@field transmogs TransmogEvent[]
---@field currencyTotal integer
---@field reputationTotal integer
---@field currencies CurrencyGain[]
---@field reputation ReputationGain[]
---@field achievements AchievementEvent[]
---@field levelUps LevelUpEvent[]
---@field mounts CollectionEvent[]
---@field pets CollectionEvent[]
---@field quests QuestEvent[]
---@field toys CollectionEvent[]
---@field housingItems HousingItemEvent[]
---@field housingXP integer Housing experience gained over the segment.
---@field housingLevelUps LevelUpEvent[]

---What the tracker hands over when a segment ends.
---@class SegmentVisit
---@field character string
---@field classFile string?
---@field level integer?
---@field instance string
---@field difficulty string?
---@field instanceType string?
---@field difficultyId integer?
---@field startedAt integer
---@field endedAt integer
---@field summary SegmentSummary

---A rolling log of finished segments, capped at a window of recent days.
---@class SegmentLog
---@field record fun(visit: SegmentVisit): SegmentRecord
---@field all fun(): SegmentRecord[] Newest first, pruned to the retention window.
---@field prune fun(): integer How many records were dropped.

---@class SegmentLogDeps
---@field db table SavedVariables table; mutated in place so the client persists it.
---@field now fun(): integer
---@field formatDate fun(format: string, timestamp: integer): string Usually the global `date`.
---@field retainDays integer? Days of history to keep. Default 7.

local DAY = 24 * 60 * 60
local DEFAULT_RETAIN_DAYS = 7

---@param deps SegmentLogDeps
---@return SegmentLog
function ns.newSegmentLog(deps)
    local db = deps.db
    local now = deps.now
    local formatDate = deps.formatDate
    local retainSeconds = (deps.retainDays or DEFAULT_RETAIN_DAYS) * DAY

    db.segments = db.segments or {}

    ---Drops everything that fell out of the retention window. Called on every read
    ---and every write, so the file the collector picks up is already trimmed.
    ---@return integer dropped
    local function prune()
        local cutoff = now() - retainSeconds
        local kept = {}
        local dropped = 0

        for _, record in ipairs(db.segments) do
            if (record.endedAt or 0) >= cutoff then
                kept[#kept + 1] = record
            else
                dropped = dropped + 1
            end
        end

        db.segments = kept
        return dropped
    end

    -- Every list a record carries is copied out of the live tally through the one shared
    -- schema (ns.segmentEventSpecs / ns.copyEventList), so a filed record shares no table
    -- with the tally and can never be reached by a later mutation of it.
    local specs = ns.segmentEventSpecs

    return {
        prune = prune,

        ---Files a finished segment. Recording the same segment twice — a flush on logout
        ---after the zone change already filed it — replaces the record rather than
        ---duplicating it, because the identity is the segment, not the call.
        ---@param visit SegmentVisit
        ---@return SegmentRecord
        record = function(visit)
            local summary = visit.summary or {}
            local endedAt = visit.endedAt or now()
            local startedAt = visit.startedAt or endedAt

            local record = {
                id = table.concat({ visit.character, tostring(startedAt), visit.instance }, "|"),
                character = visit.character,
                classFile = visit.classFile,
                level = visit.level,
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
                transmogs = ns.copyEventList(specs.transmogs, summary.transmogs),
                currencyTotal = summary.currencyTotal or 0,
                reputationTotal = summary.reputationTotal or 0,
                currencies = ns.copyEventList(specs.currencies, summary.currencies),
                reputation = ns.copyEventList(specs.reputation, summary.reputation),
                achievements = ns.copyEventList(specs.achievements, summary.achievements),
                levelUps = ns.copyEventList(specs.levelUps, summary.levelUps),
                mounts = ns.copyEventList(specs.mounts, summary.mounts),
                pets = ns.copyEventList(specs.pets, summary.pets),
                quests = ns.copyEventList(specs.quests, summary.quests),
                toys = ns.copyEventList(specs.toys, summary.toys),
                housingItems = ns.copyEventList(specs.housingItems, summary.housingItems),
                housingXP = summary.housingXP or 0,
                housingLevelUps = ns.copyEventList(specs.housingLevelUps, summary.housingLevelUps),
            }

            local replaced = false
            for index, existing in ipairs(db.segments) do
                if existing.id == record.id then
                    db.segments[index] = record
                    replaced = true
                    break
                end
            end
            if not replaced then
                db.segments[#db.segments + 1] = record
            end

            prune()
            return record
        end,

        ---@return SegmentRecord[]
        all = function()
            prune()

            local list = {}
            for index, record in ipairs(db.segments) do
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
