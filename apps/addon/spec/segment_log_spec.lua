local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newSegmentLog", function()
    local ns = loader.load()

    local NOW = 1700000000
    local DAY = 24 * 60 * 60

    ---@param options table? `{ db, clock, retainDays }`
    ---@return SegmentLog log, table db, table clock
    local function newLog(options)
        options = options or {}
        local db = options.db or {}
        local clock = options.clock or fake.newClock(NOW)
        local log = ns.newSegmentLog({
            db = db,
            now = clock.now,
            formatDate = fake.newFormatDate(),
            retainDays = options.retainDays,
        })
        return log, db, clock
    end

    ---@param overrides table?
    ---@return SegmentVisit
    local function visit(overrides)
        local base = {
            character = "Thrall-Ragnaros",
            classFile = "WARRIOR",
            level = 41,
            instance = "Ulduar",
            difficulty = "25 Player",
            instanceType = "raid",
            difficultyId = 4,
            startedAt = NOW - 1800,
            endedAt = NOW,
            summary = {
                lootValue = 2000,
                goldDiff = 1500,
                transmogs = { { id = 19019, at = NOW - 100 } },
                currencyTotal = 15,
                reputationTotal = 40,
                currencies = { { id = 1166, name = "Timewarped Badge", amount = 15 } },
                reputation = { { faction = "Argent Dawn", amount = 40 } },
                achievements = { { id = 1, name = "First", at = NOW } },
                levelUps = { { level = 42, at = NOW - 75 } },
                mounts = {},
                pets = {},
                quests = { { id = 7848, at = NOW - 50 } },
                toys = {},
                housingItems = {
                    { id = 4001, name = "Sturdy Oak Chair", at = NOW - 40, warbandFirst = true },
                },
                housingXP = 300,
                housingLevelUps = { { level = 3, at = NOW - 30 } },
                encounters = {
                    {
                        id = 745, name = "Flame Leviathan", at = NOW - 900,
                        difficultyId = 4, groupSize = 25, success = true,
                    },
                },
                equipsetChanges = {
                    {
                        setId = 3, name = "Raid", kind = "updated", at = NOW - 20,
                        items = {
                            { slot = 1, itemId = 100, itemLevel = 639, itemName = "Tideglass Crown" },
                        },
                    },
                },
                experience = { gained = 4500, percent = 0.45, startLevel = 41, endLevel = 41 },
            },
        }
        for key, value in pairs(overrides or {}) do
            base[key] = value
        end
        return base
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newSegmentLog)
    end)

    it("versions the segment feed independently of the rest of SavedVariables", function()
        local _, db = newLog()

        assert.equal(1, db.segmentSchemaVersion)
    end)

    describe("recording a visit", function()
        it("writes every field of the record into db.segments", function()
            local log, db = newLog()

            log.record(visit())

            assert.equal(1, #db.segments)
            assert.same({
                id = "Thrall-Ragnaros|" .. (NOW - 1800) .. "|Ulduar",
                character = "Thrall-Ragnaros",
                classFile = "WARRIOR",
                level = 41,
                day = "<%Y-%m-%d@" .. NOW .. ">",
                instance = "Ulduar",
                difficulty = "25 Player",
                instanceType = "raid",
                difficultyId = 4,
                startedAt = NOW - 1800,
                endedAt = NOW,
                seconds = 1800,
                lootValue = 2000,
                goldDiff = 1500,
                transmogs = { { id = 19019, at = NOW - 100 } },
                currencyTotal = 15,
                reputationTotal = 40,
                currencies = { { id = 1166, name = "Timewarped Badge", amount = 15 } },
                reputation = { { faction = "Argent Dawn", amount = 40 } },
                achievements = { { id = 1, name = "First", at = NOW } },
                levelUps = { { level = 42, at = NOW - 75 } },
                mounts = {},
                pets = {},
                quests = { { id = 7848, at = NOW - 50 } },
                toys = {},
                housingItems = {
                    { id = 4001, name = "Sturdy Oak Chair", at = NOW - 40, warbandFirst = true },
                },
                housingXP = 300,
                housingLevelUps = { { level = 3, at = NOW - 30 } },
                encounters = {
                    {
                        id = 745, name = "Flame Leviathan", at = NOW - 900,
                        difficultyId = 4, groupSize = 25, success = true,
                    },
                },
                equipsetChanges = {
                    {
                        setId = 3, name = "Raid", kind = "updated", at = NOW - 20,
                        items = {
                            { slot = 1, itemId = 100, itemLevel = 639, itemName = "Tideglass Crown" },
                        },
                    },
                },
                experience = { gained = 4500, percent = 0.45, startLevel = 41, endLevel = 41 },
            }, db.segments[1])
        end)

        -- A visit with no keystone must not grow an empty one: the desktop app reads the
        -- key's absence as "this was not a Mythic+ run", which a stub table would break.
        it("leaves out the details the visit never carried", function()
            local log, db = newLog()

            log.record(visit())

            assert.is_nil(db.segments[1].keystone)
            assert.is_nil(db.segments[1].delve)
        end)

        -- The log is a record of events and the wallet's balance is not one. The movement
        -- belongs to the visit and is settled forever; what the character was left holding
        -- goes stale the moment it is spent, and the holdings snapshot is where that lives.
        -- Filed here it would be a balance dated to an evening in March, read forever after
        -- as though it were still true.
        it("keeps the wallet's balance out of the record, and the movement in it", function()
            local log, db = newLog()

            log.record(visit({ summary = { goldDiff = 1500, wallet = 125000 } }))

            assert.equal(1500, db.segments[1].goldDiff)
            assert.is_nil(db.segments[1].wallet)
        end)

        it("carries a keystone run and its expansion onto the record", function()
            local log, db = newLog()

            log.record(visit({
                expansionTier = 3,
                latestExpansionTier = 12,
                summary = {
                    keystone = {
                        level = 14, mapId = 501, affixes = { 9, 6 }, startedAt = NOW - 1800,
                        completedAt = NOW, completed = true, durationMs = 1740000,
                        onTime = true, upgrades = 1,
                    },
                },
            }))

            assert.equal(3, db.segments[1].expansionTier)
            assert.equal(12, db.segments[1].latestExpansionTier)
            assert.same({
                level = 14, mapId = 501, affixes = { 9, 6 }, startedAt = NOW - 1800,
                completedAt = NOW, completed = true, durationMs = 1740000,
                onTime = true, upgrades = 1,
            }, db.segments[1].keystone)
        end)

        -- The tier and the story are the only two things the record cannot recover for
        -- itself: the delve names the segment it was run in, but nothing else says which
        -- tier the entrance was set to or which of the delve's stories the client rolled.
        it("carries a delve run onto the record", function()
            local log, db = newLog()

            log.record(visit({
                summary = {
                    delve = {
                        tier = 8, scenarioId = 2680, startedAt = NOW - 900,
                        completedAt = NOW, completed = true,
                    },
                },
            }))

            assert.same({
                tier = 8, scenarioId = 2680, startedAt = NOW - 900,
                completedAt = NOW, completed = true,
            }, db.segments[1].delve)
        end)

        it("dates the record by the day the visit ended", function()
            local log = newLog()

            local record = log.record(visit({ endedAt = NOW + 500 }))

            assert.equal("<%Y-%m-%d@" .. (NOW + 500) .. ">", record.day)
        end)

        it("returns the record it filed", function()
            local log, db = newLog()

            local record = log.record(visit())

            assert.equal(db.segments[1], record)
        end)

        -- A clock that jumps backwards (a resync mid-visit) must not produce a
        -- negative duration that the report would then have to defend against.
        it("never reports a negative duration", function()
            local log = newLog()

            local record = log.record(visit({ startedAt = NOW, endedAt = NOW - 60 }))

            assert.equal(0, record.seconds)
        end)

        it("falls back to an empty tally when the summary carries nothing", function()
            local log = newLog()

            local record = log.record(visit({ summary = {} }))

            assert.equal(0, record.lootValue)
            assert.equal(0, record.goldDiff)
            assert.same({}, record.transmogs)
            assert.equal(0, record.currencyTotal)
            assert.same({}, record.reputation)
            assert.same({}, record.currencies)
            assert.same({}, record.achievements)
            assert.same({}, record.levelUps)
            assert.same({}, record.mounts)
            assert.same({}, record.pets)
            assert.same({}, record.quests)
            assert.same({}, record.toys)
            assert.same({}, record.housingItems)
            assert.equal(0, record.housingXP)
            assert.same({}, record.housingLevelUps)
        end)

        it("stores an empty difficulty rather than a hole when the client named none", function()
            local log = newLog()
            local unnamed = visit()
            unnamed.difficulty, unnamed.instanceType = nil, nil

            local record = log.record(unnamed)

            assert.equal("", record.difficulty)
            assert.equal("", record.instanceType)
        end)

        it("allows the character level to be unknown", function()
            local log = newLog()
            local pending = visit()
            pending.level = nil

            local record = log.record(pending)

            assert.is_nil(record.level)
        end)

        it("replaces a visit that is filed twice instead of duplicating it", function()
            local log, db = newLog()

            log.record(visit())
            log.record(visit({ endedAt = NOW + 60, summary = { lootValue = 5000 } }))

            assert.equal(1, #db.segments)
            assert.equal(5000, db.segments[1].lootValue)
        end)

        it("keeps two visits of the same instance apart by when they started", function()
            local log, db = newLog()

            log.record(visit())
            log.record(visit({ startedAt = NOW - 100 }))

            assert.equal(2, #db.segments)
        end)

        -- The tally handed over is the live one the addon keeps mutating, so the log
        -- has to take its own copy or a later faction gain would rewrite history.
        it("copies the reputation list out of the caller's summary", function()
            local log = newLog()
            local pending = visit()

            local record = log.record(pending)
            pending.summary.reputation[1].amount = 999
            pending.summary.reputation[2] = { faction = "Timbermaw Hold", amount = 10 }

            assert.same({ { faction = "Argent Dawn", amount = 40 } }, record.reputation)
        end)

        it("copies the currency list out of the caller's summary", function()
            local log = newLog()
            local pending = visit()

            local record = log.record(pending)
            pending.summary.currencies[1].amount = 999
            pending.summary.currencies[2] = { id = 2, name = "Valor", amount = 3 }

            assert.same({ { id = 1166, name = "Timewarped Badge", amount = 15 } }, record.currencies)
        end)

        it("keeps transmog collection metadata needed by saved-segment links", function()
            local log = newLog()
            local pending = visit()
            pending.summary.transmogs = {
                {
                    id = 19019,
                    at = NOW - 100,
                    sourceID = 11,
                    appearanceID = 22,
                    newAppearance = false,
                },
            }

            local record = log.record(pending)

            assert.same(pending.summary.transmogs, record.transmogs)
            assert.not_equal(pending.summary.transmogs[1], record.transmogs[1])
        end)

        it("copies the achievement list out of the caller's summary", function()
            local log = newLog()
            local pending = visit()

            local record = log.record(pending)
            pending.summary.achievements[1].name = "Rewritten"
            pending.summary.achievements[2] = { id = 2, name = "Second", at = NOW }

            assert.same({ { id = 1, name = "First", at = NOW } }, record.achievements)
        end)

        it("copies the level-up list out of the caller's summary", function()
            local log = newLog()
            local pending = visit()

            local record = log.record(pending)
            pending.summary.levelUps[1].level = 99
            pending.summary.levelUps[2] = { level = 43, at = NOW }

            assert.same({ { level = 42, at = NOW - 75 } }, record.levelUps)
        end)

        it("copies the quest list out of the caller's summary", function()
            local log = newLog()
            local pending = visit()
            pending.summary.quests[1].name = "A Hunter's Challenge"
            pending.summary.quests[1].characterFirst = true
            pending.summary.quests[1].accountFirst = false

            local record = log.record(pending)
            pending.summary.quests[1].id = 999
            pending.summary.quests[2] = { id = 2, at = NOW }

            assert.same({
                {
                    id = 7848,
                    name = "A Hunter's Challenge",
                    at = NOW - 50,
                    characterFirst = true,
                    accountFirst = false,
                },
            }, record.quests)
        end)

        it("copies the housing item list and keeps the warband scope", function()
            local log = newLog()
            local pending = visit()

            local record = log.record(pending)
            pending.summary.housingItems[1].name = "Rewritten"
            pending.summary.housingItems[2] = { id = 4002, name = "Extra", at = NOW, warbandFirst = false }

            assert.same({
                { id = 4001, name = "Sturdy Oak Chair", at = NOW - 40, warbandFirst = true },
            }, record.housingItems)
            assert.not_equal(pending.summary.housingItems[1], record.housingItems[1])
        end)

        it("copies the housing level-up list out of the caller's summary", function()
            local log = newLog()
            local pending = visit()

            local record = log.record(pending)
            pending.summary.housingLevelUps[1].level = 99
            pending.summary.housingLevelUps[2] = { level = 4, at = NOW }

            assert.same({ { level = 3, at = NOW - 30 } }, record.housingLevelUps)
        end)
    end)

    describe("the retention window", function()
        it("keeps a visit that ended inside the window", function()
            local log, db, clock = newLog()
            log.record(visit())

            clock.advance(6 * DAY)

            assert.equal(0, log.prune())
            assert.equal(1, #db.segments)
        end)

        it("drops a visit once it falls out of the window", function()
            local log, db, clock = newLog()
            log.record(visit())

            clock.advance(7 * DAY + 1)

            assert.equal(1, log.prune())
            assert.same({}, db.segments)
        end)

        it("honours a shorter window", function()
            local log, db, clock = newLog({ retainDays = 2 })
            log.record(visit())

            clock.advance(2 * DAY + 1)
            log.prune()

            assert.same({}, db.segments)
        end)

        it("prunes as a side effect of recording, so the file never grows unbounded", function()
            local db = {}
            local clock = fake.newClock(NOW)
            local log = newLog({ db = db, clock = clock })
            log.record(visit())

            clock.advance(8 * DAY)
            log.record(visit({ startedAt = clock.now() - 60, endedAt = clock.now() }))

            assert.equal(1, #db.segments)
        end)

        it("prunes as a side effect of reading", function()
            local log, db, clock = newLog()
            log.record(visit())

            clock.advance(8 * DAY)

            assert.same({}, log.all())
            assert.same({}, db.segments)
        end)
    end)

    describe("reading the log", function()
        it("returns nothing when nothing was ever recorded", function()
            local log = newLog()

            assert.same({}, log.all())
        end)

        it("orders visits newest first", function()
            local log = newLog()
            log.record(visit({ instance = "Ulduar", startedAt = NOW - 7200, endedAt = NOW - 3600 }))
            log.record(visit({ instance = "Karazhan", startedAt = NOW - 600, endedAt = NOW }))

            local rows = log.all()

            assert.equal("Karazhan", rows[1].instance)
            assert.equal("Ulduar", rows[2].instance)
        end)

        -- Two characters can leave their instances in the same second; the order has
        -- to be total or the table reshuffles between renders.
        it("breaks a tie on the ending second deterministically", function()
            local log = newLog()
            log.record(visit({ character = "Jaina-Draenor" }))
            log.record(visit({ character = "Bolvar-Draenor" }))

            local rows = log.all()

            assert.equal("Bolvar-Draenor", rows[1].character)
            assert.equal("Jaina-Draenor", rows[2].character)
        end)

        it("leaves the caller's list disconnected from the stored one", function()
            local log, db = newLog()
            log.record(visit())

            local rows = log.all()
            rows[1] = nil

            assert.equal(1, #db.segments)
        end)
    end)

    describe("a db shared by two characters", function()
        it("adds to the segments already in the file rather than replacing them", function()
            local db = {}
            local first = newLog({ db = db })
            first.record(visit({ character = "Thrall-Ragnaros" }))

            local second = newLog({ db = db })
            second.record(visit({ character = "Jaina-Draenor" }))

            assert.equal(2, #db.segments)
            assert.equal(2, #second.all())
        end)

        it("creates the segments table when the file has never seen one", function()
            local db = {}

            newLog({ db = db })

            assert.same({}, db.segments)
        end)
    end)
end)
