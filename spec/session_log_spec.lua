local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newSessionLog", function()
    local ns = loader.load()

    local NOW = 1700000000
    local DAY = 24 * 60 * 60

    ---@param options table? `{ db, clock, retainDays }`
    ---@return SessionLog log, table db, table clock
    local function newLog(options)
        options = options or {}
        local db = options.db or {}
        local clock = options.clock or fake.newClock(NOW)
        local log = ns.newSessionLog({
            db = db,
            now = clock.now,
            formatDate = fake.newFormatDate(),
            retainDays = options.retainDays,
        })
        return log, db, clock
    end

    ---@param overrides table?
    ---@return SessionVisit
    local function visit(overrides)
        local base = {
            character = "Thrall-Ragnaros",
            classFile = "WARRIOR",
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
            },
        }
        for key, value in pairs(overrides or {}) do
            base[key] = value
        end
        return base
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newSessionLog)
    end)

    describe("recording a visit", function()
        it("writes every field of the record into db.sessions", function()
            local log, db = newLog()

            log.record(visit())

            assert.equal(1, #db.sessions)
            assert.same({
                id = "Thrall-Ragnaros|" .. (NOW - 1800) .. "|Ulduar",
                character = "Thrall-Ragnaros",
                classFile = "WARRIOR",
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
            }, db.sessions[1])
        end)

        it("dates the record by the day the visit ended", function()
            local log = newLog()

            local record = log.record(visit({ endedAt = NOW + 500 }))

            assert.equal("<%Y-%m-%d@" .. (NOW + 500) .. ">", record.day)
        end)

        it("returns the record it filed", function()
            local log, db = newLog()

            local record = log.record(visit())

            assert.equal(db.sessions[1], record)
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
        end)

        it("stores an empty difficulty rather than a hole when the client named none", function()
            local log = newLog()
            local unnamed = visit()
            unnamed.difficulty, unnamed.instanceType = nil, nil

            local record = log.record(unnamed)

            assert.equal("", record.difficulty)
            assert.equal("", record.instanceType)
        end)

        it("replaces a visit that is filed twice instead of duplicating it", function()
            local log, db = newLog()

            log.record(visit())
            log.record(visit({ endedAt = NOW + 60, summary = { lootValue = 5000 } }))

            assert.equal(1, #db.sessions)
            assert.equal(5000, db.sessions[1].lootValue)
        end)

        it("keeps two visits of the same instance apart by when they started", function()
            local log, db = newLog()

            log.record(visit())
            log.record(visit({ startedAt = NOW - 100 }))

            assert.equal(2, #db.sessions)
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

        it("copies the achievement list out of the caller's summary", function()
            local log = newLog()
            local pending = visit()

            local record = log.record(pending)
            pending.summary.achievements[1].name = "Rewritten"
            pending.summary.achievements[2] = { id = 2, name = "Second", at = NOW }

            assert.same({ { id = 1, name = "First", at = NOW } }, record.achievements)
        end)
    end)

    describe("the retention window", function()
        it("keeps a visit that ended inside the window", function()
            local log, db, clock = newLog()
            log.record(visit())

            clock.advance(6 * DAY)

            assert.equal(0, log.prune())
            assert.equal(1, #db.sessions)
        end)

        it("drops a visit once it falls out of the window", function()
            local log, db, clock = newLog()
            log.record(visit())

            clock.advance(7 * DAY + 1)

            assert.equal(1, log.prune())
            assert.same({}, db.sessions)
        end)

        it("honours a shorter window", function()
            local log, db, clock = newLog({ retainDays = 2 })
            log.record(visit())

            clock.advance(2 * DAY + 1)
            log.prune()

            assert.same({}, db.sessions)
        end)

        it("prunes as a side effect of recording, so the file never grows unbounded", function()
            local db = {}
            local clock = fake.newClock(NOW)
            local log = newLog({ db = db, clock = clock })
            log.record(visit())

            clock.advance(8 * DAY)
            log.record(visit({ startedAt = clock.now() - 60, endedAt = clock.now() }))

            assert.equal(1, #db.sessions)
        end)

        it("prunes as a side effect of reading", function()
            local log, db, clock = newLog()
            log.record(visit())

            clock.advance(8 * DAY)

            assert.same({}, log.all())
            assert.same({}, db.sessions)
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

            assert.equal(1, #db.sessions)
        end)
    end)

    describe("a db shared by two characters", function()
        it("adds to the sessions already in the file rather than replacing them", function()
            local db = {}
            local first = newLog({ db = db })
            first.record(visit({ character = "Thrall-Ragnaros" }))

            local second = newLog({ db = db })
            second.record(visit({ character = "Jaina-Draenor" }))

            assert.equal(2, #db.sessions)
            assert.equal(2, #second.all())
        end)

        it("creates the sessions table when the file has never seen one", function()
            local db = {}

            newLog({ db = db })

            assert.same({}, db.sessions)
        end)
    end)
end)
