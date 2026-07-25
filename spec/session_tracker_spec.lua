local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newSessionTracker", function()
    local ns = loader.load()

    local NOW = 1700000000

    ---A tracker over the real tally and the real log: all three are pure, and the
    ---boundaries only mean anything when the modules that own them are the real ones.
    ---@param options table? `{ zone, money, character, classFile, level }`
    ---@return table `{ tracker, tally, log, db, clock, setZone, setMoney, earn }`
    local function newTracker(options)
        options = options or {}
        local db = {}
        local clock = fake.newClock(NOW)
        local zone = options.zone or { name = "Elwynn Forest", kind = "none" }
        local money = options.money or 0

        local tally = ns.newSessionTally({})
        local log = ns.newSessionLog({ db = db, now = clock.now, formatDate = fake.newFormatDate() })

        local tracker = ns.newSessionTracker({
            tally = tally,
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
            level = function()
                return options.level
            end,
        })

        return {
            tracker = tracker,
            tally = tally,
            log = log,
            db = db,
            clock = clock,
            setZone = function(value)
                zone = value
            end,
            setMoney = function(value)
                money = value
            end,
            ---Bump the wallet and fold it in, the way PLAYER_MONEY would, so the open
            ---session has an event and is not dropped on close.
            earn = function(amount)
                money = money + amount
                tally.money(money)
            end,
        }
    end

    local DUNGEON = { name = "Deadmines", kind = "party", difficultyId = 1, difficulty = "Normal" }
    local RAID = { name = "Ulduar", kind = "raid", difficultyId = 4, difficulty = "25 Player" }
    local WORLD = { name = "Elwynn Forest", kind = "none", difficultyId = 0 }
    local OTHER_WORLD = { name = "Westfall", kind = "none", difficultyId = 0 }

    it("is exported by the addon files", function()
        assert.is_function(ns.newSessionTracker)
    end)

    describe("opening a session", function()
        it("opens a session out in the open world", function()
            local harness = newTracker({ zone = WORLD })

            assert.is_true(harness.tracker.sync())
            assert.equal("Elwynn Forest", harness.tracker.current().instance)
        end)

        it("opens a session on entering an instance", function()
            local harness = newTracker({ zone = DUNGEON })

            assert.is_true(harness.tracker.sync())
            assert.equal("Deadmines", harness.tracker.current().instance)
        end)

        it("records who was on and what they were doing", function()
            local harness = newTracker({ zone = RAID, level = 41 })

            harness.tracker.sync()

            local current = harness.tracker.current()
            assert.equal("Thrall-Ragnaros", current.character)
            assert.equal("WARRIOR", current.classFile)
            assert.equal(41, current.level)
            assert.equal("25 Player", current.difficulty)
            assert.equal("raid", current.instanceType)
            assert.equal(4, current.difficultyId)
            assert.equal(NOW, current.startedAt)
        end)

        it("allows the character level to be unknown", function()
            local harness = newTracker({ zone = RAID })

            harness.tracker.sync()

            assert.is_nil(harness.tracker.current().level)
        end)

        -- A load screen, a graveyard run and a summon all fire the same event inside
        -- one zone; treating any of them as a new session would split the stay in two.
        it("keeps one session across a second sync in the same zone", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            local opened = harness.tracker.current()

            harness.clock.advance(600)
            harness.tracker.sync()

            assert.equal(opened, harness.tracker.current())
            assert.same({}, harness.log.all())
        end)
    end)

    describe("dropping sessions that saw nothing", function()
        it("files nothing when an empty world session closes", function()
            local harness = newTracker({ zone = WORLD })
            harness.tracker.sync()

            harness.clock.advance(1800)
            harness.setZone(OTHER_WORLD)
            harness.tracker.sync()

            assert.same({}, harness.log.all())
        end)

        it("files nothing when an empty instance visit closes", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()

            harness.setZone(WORLD)
            harness.tracker.sync()

            assert.same({}, harness.log.all())
        end)

        it("keeps a world session once something happened in it", function()
            local harness = newTracker({ zone = WORLD })
            harness.tracker.sync()
            harness.earn(500)

            harness.setZone(OTHER_WORLD)
            harness.tracker.sync()

            assert.equal(1, #harness.log.all())
            assert.equal("Elwynn Forest", harness.log.all()[1].instance)
            assert.equal(0, harness.log.all()[1].lootValue)
        end)
    end)

    describe("closing a session", function()
        it("files exactly one record on the way out of an instance that earned", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.earn(400)

            harness.clock.advance(1800)
            harness.setZone(WORLD)
            harness.tracker.sync()

            assert.equal(1, #harness.log.all())
        end)

        it("carries the session's identity onto the record", function()
            local harness = newTracker({ zone = RAID, level = 41 })
            harness.tracker.sync()
            harness.earn(100)

            harness.clock.advance(3600)
            harness.setZone(WORLD)
            harness.tracker.sync()

            local record = harness.log.all()[1]
            assert.equal("Ulduar", record.instance)
            assert.equal("25 Player", record.difficulty)
            assert.equal("raid", record.instanceType)
            assert.equal(4, record.difficultyId)
            assert.equal("Thrall-Ragnaros", record.character)
            assert.equal("WARRIOR", record.classFile)
            assert.equal(41, record.level)
            assert.equal(NOW, record.startedAt)
            assert.equal(NOW + 3600, record.endedAt)
            assert.equal(3600, record.seconds)
        end)

        it("keeps gathered gold out of inventory loot value", function()
            local harness = newTracker({ zone = DUNGEON, money = 500 })
            harness.tracker.sync()

            harness.earn(9000)
            harness.setZone(WORLD)
            harness.tracker.sync()

            assert.equal(0, harness.log.all()[1].lootValue)
        end)
    end)

    describe("moving between zones", function()
        it("files the first and opens the second when zoning straight across", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.earn(200)

            harness.clock.advance(900)
            harness.setZone(RAID)
            harness.tracker.sync()

            assert.equal(1, #harness.log.all())
            assert.equal("Deadmines", harness.log.all()[1].instance)
            assert.equal("Ulduar", harness.tracker.current().instance)
            assert.equal(NOW + 900, harness.tracker.current().startedAt)
        end)

        -- The whole point of closing the tally: a portal from one dungeon into the next
        -- must not report the first one's haul twice.
        it("starts the second session's tally from scratch", function()
            local harness = newTracker({ zone = DUNGEON, money = 0 })
            harness.tracker.sync()
            harness.earn(4000)

            harness.clock.advance(600)
            harness.setZone(RAID)
            harness.tracker.sync()
            harness.earn(0) -- nudge the tally without adding gold
            harness.clock.advance(600)
            harness.setZone(WORLD)
            harness.tracker.sync()

            local rows = harness.log.all()
            -- The empty second visit is dropped, so only the first dungeon is on file.
            assert.equal(1, #rows)
            assert.equal("Deadmines", rows[1].instance)
            assert.equal(0, rows[1].lootValue)
        end)

        it("treats the same instance at another difficulty as a new session", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.earn(100)

            harness.setZone({ name = "Deadmines", kind = "party", difficultyId = 23, difficulty = "Mythic" })
            harness.tracker.sync()

            assert.equal(1, #harness.log.all())
            assert.equal("Normal", harness.log.all()[1].difficulty)
            assert.equal("Mythic", harness.tracker.current().difficulty)
        end)
    end)

    describe("a character change", function()
        -- Two characters can be standing in the same-named starting zone; a relog must
        -- never fold the second player's stay into the first player's open session.
        it("closes the session and opens a fresh one for the new character", function()
            local db = {}
            local clock = fake.newClock(NOW)
            local zone = { name = "Elwynn Forest", kind = "none", difficultyId = 0 }
            local character = "Thrall-Ragnaros"
            local money = 0

            local tally = ns.newSessionTally({})
            local log = ns.newSessionLog({ db = db, now = clock.now, formatDate = fake.newFormatDate() })
            local tracker = ns.newSessionTracker({
                tally = tally,
                sessionLog = log,
                now = clock.now,
                instanceInfo = function() return zone end,
                getMoney = function() return money end,
                character = function() return character end,
                classFile = function() return "WARRIOR" end,
                level = function() return nil end,
            })

            tracker.sync()
            money = 300
            tally.money(money) -- Thrall earned something
            character = "Jaina-Draenor"
            tracker.sync()

            assert.equal(1, #log.all())
            assert.equal("Thrall-Ragnaros", log.all()[1].character)
            assert.equal("Jaina-Draenor", tracker.current().character)
        end)
    end)

    describe("flushing at logout", function()
        it("files the session that is still open when it earned", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.earn(120)

            harness.clock.advance(120)
            local record = harness.tracker.flush()

            assert.equal("Deadmines", record.instance)
            assert.equal(NOW + 120, record.endedAt)
            assert.equal(1, #harness.log.all())
        end)

        it("drops the open session at logout when nothing happened", function()
            local harness = newTracker({ zone = WORLD })
            harness.tracker.sync()

            assert.is_nil(harness.tracker.flush())
            assert.same({}, harness.log.all())
        end)

        it("files nothing more on a second flush", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.earn(50)
            harness.tracker.flush()

            assert.is_nil(harness.tracker.flush())
            assert.equal(1, #harness.log.all())
        end)

        -- Reloading the UI flushes and then re-syncs from the same spot: the player is
        -- still standing in the dungeon, so a fresh session has to open.
        it("opens a new session when the player syncs again after a flush", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.earn(50)
            harness.tracker.flush()

            harness.clock.advance(60)
            harness.tracker.sync()

            assert.equal(NOW + 60, harness.tracker.current().startedAt)
            assert.equal(1, #harness.log.all())
        end)
    end)
end)
