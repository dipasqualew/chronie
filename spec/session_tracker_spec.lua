local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newSessionTracker", function()
    local ns = loader.load()

    local NOW = 1700000000

    ---A tracker over the real tally and the real log: all three are pure, and the
    ---boundaries only mean anything when the modules that own them are the real ones.
    ---@param options table? `{ zone, money, character, classFile }`
    ---@return table `{ tracker, log, db, clock, zone, setZone, setMoney }`
    local function newTracker(options)
        options = options or {}
        local db = {}
        local clock = fake.newClock(NOW)
        local zone = options.zone or { name = "Open World", kind = "none" }
        local money = options.money or 0

        local results = ns.newInstanceResults({})
        local log = ns.newSessionLog({ db = db, now = clock.now, formatDate = fake.newFormatDate() })

        local tracker = ns.newSessionTracker({
            results = results,
            sessionLog = log,
            now = clock.now,
            instanceInfo = function()
                return zone
            end,
            getMoney = function()
                return money
            end,
            character = function()
                return options.character or "Thrall-Ragnaros"
            end,
            classFile = function()
                return options.classFile or "WARRIOR"
            end,
        })

        return {
            tracker = tracker,
            results = results,
            log = log,
            db = db,
            clock = clock,
            setZone = function(value)
                zone = value
            end,
            setMoney = function(value)
                money = value
            end,
        }
    end

    local DUNGEON = { name = "Deadmines", kind = "party", difficultyId = 1, difficulty = "Normal" }
    local RAID = { name = "Ulduar", kind = "raid", difficultyId = 4, difficulty = "25 Player" }
    local WORLD = { name = "Elwynn Forest", kind = "none" }

    it("is exported by the addon files", function()
        assert.is_function(ns.newSessionTracker)
    end)

    describe("opening a visit", function()
        it("opens nothing out in the open world", function()
            local harness = newTracker()

            assert.is_false(harness.tracker.sync())
            assert.is_nil(harness.tracker.current())
            assert.same({}, harness.log.all())
        end)

        it("opens a visit on entering an instance", function()
            local harness = newTracker({ zone = DUNGEON })

            assert.is_true(harness.tracker.sync())
            assert.equal("Deadmines", harness.tracker.current().instance)
        end)

        it("records who was on and what they were running", function()
            local harness = newTracker({ zone = RAID })

            harness.tracker.sync()

            local current = harness.tracker.current()
            assert.equal("Thrall-Ragnaros", current.character)
            assert.equal("WARRIOR", current.classFile)
            assert.equal("25 Player", current.difficulty)
            assert.equal("raid", current.instanceType)
            assert.equal(NOW, current.startedAt)
        end)

        -- A load screen, a graveyard run and a summon all fire the same event inside
        -- one instance; treating any of them as a new visit would split the run in two.
        it("keeps one visit across a second sync in the same zone", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            local opened = harness.tracker.current()

            harness.clock.advance(600)
            harness.tracker.sync()

            assert.equal(opened, harness.tracker.current())
            assert.same({}, harness.log.all())
        end)
    end)

    describe("closing a visit", function()
        it("files exactly one record on the way out to the open world", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()

            harness.clock.advance(1800)
            harness.setZone(WORLD)

            assert.is_false(harness.tracker.sync())
            assert.is_nil(harness.tracker.current())
            assert.equal(1, #harness.log.all())
        end)

        it("carries the visit's identity onto the record", function()
            local harness = newTracker({ zone = RAID })
            harness.tracker.sync()

            harness.clock.advance(3600)
            harness.setZone(WORLD)
            harness.tracker.sync()

            local record = harness.log.all()[1]
            assert.equal("Ulduar", record.instance)
            assert.equal("25 Player", record.difficulty)
            assert.equal("raid", record.instanceType)
            assert.equal("Thrall-Ragnaros", record.character)
            assert.equal("WARRIOR", record.classFile)
            assert.equal(NOW, record.startedAt)
            assert.equal(NOW + 3600, record.endedAt)
            assert.equal(3600, record.seconds)
        end)

        it("carries the gold gathered inside onto the record", function()
            local harness = newTracker({ zone = DUNGEON, money = 500 })
            harness.tracker.sync()

            harness.setMoney(9500)
            harness.results.money(9500)
            harness.setZone(WORLD)
            harness.tracker.sync()

            assert.equal(9000, harness.log.all()[1].goldLooted)
        end)

        it("files nothing extra when the player never left the world", function()
            local harness = newTracker({ zone = WORLD })

            harness.tracker.sync()
            harness.tracker.sync()

            assert.same({}, harness.log.all())
        end)

        -- Leaving a dungeon for a battleground is still leaving: the zone is named
        -- and real, it just is not one the addon tallies.
        it("closes the visit when the new zone is a type it does not track", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()

            harness.setZone({ name = "Warsong Gulch", kind = "pvp", difficultyId = 0 })

            assert.is_false(harness.tracker.sync())
            assert.equal(1, #harness.log.all())
        end)
    end)

    describe("moving between instances", function()
        it("files the first and opens the second when zoning straight across", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()

            harness.clock.advance(900)
            harness.setZone(RAID)
            harness.tracker.sync()

            assert.equal(1, #harness.log.all())
            assert.equal("Deadmines", harness.log.all()[1].instance)
            assert.equal("Ulduar", harness.tracker.current().instance)
            assert.equal(NOW + 900, harness.tracker.current().startedAt)
        end)

        -- The whole point of closing the tally: a portal from one dungeon into the
        -- next must not report the first one's haul twice.
        it("starts the second visit's tally from scratch", function()
            local harness = newTracker({ zone = DUNGEON, money = 0 })
            harness.tracker.sync()
            harness.setMoney(4000)
            harness.results.money(4000)

            harness.clock.advance(600)
            harness.setZone(RAID)
            harness.tracker.sync()
            harness.clock.advance(600)
            harness.setZone(WORLD)
            harness.tracker.sync()

            local rows = harness.log.all()
            assert.equal(2, #rows)
            assert.equal("Ulduar", rows[1].instance)
            assert.equal(0, rows[1].goldLooted)
            assert.equal(4000, rows[2].goldLooted)
        end)

        it("treats the same instance at another difficulty as a new visit", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()

            harness.setZone({ name = "Deadmines", kind = "party", difficultyId = 23, difficulty = "Mythic" })
            harness.tracker.sync()

            assert.equal(1, #harness.log.all())
            assert.equal("Normal", harness.log.all()[1].difficulty)
            assert.equal("Mythic", harness.tracker.current().difficulty)
        end)
    end)

    describe("flushing at logout", function()
        it("files the visit that is still open", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()

            harness.clock.advance(120)
            local record = harness.tracker.flush()

            assert.equal("Deadmines", record.instance)
            assert.equal(NOW + 120, record.endedAt)
            assert.equal(1, #harness.log.all())
        end)

        it("does nothing when no visit is open", function()
            local harness = newTracker({ zone = WORLD })
            harness.tracker.sync()

            assert.is_nil(harness.tracker.flush())
            assert.same({}, harness.log.all())
        end)

        it("files nothing more on a second flush", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.tracker.flush()

            assert.is_nil(harness.tracker.flush())
            assert.equal(1, #harness.log.all())
        end)

        -- Reloading the UI flushes and then re-syncs from the same spot: the player
        -- is still standing in the dungeon, so a fresh visit has to open.
        it("opens a new visit when the player syncs again after a flush", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.tracker.flush()

            harness.clock.advance(60)
            harness.tracker.sync()

            assert.equal(NOW + 60, harness.tracker.current().startedAt)
            assert.equal(1, #harness.log.all())
        end)
    end)
end)
