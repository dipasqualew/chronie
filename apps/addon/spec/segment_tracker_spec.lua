local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newSegmentTracker", function()
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

        local tally = ns.newSegmentTally({})
        local log = ns.newSegmentLog({ db = db, now = clock.now, formatDate = fake.newFormatDate() })

        local tracker = ns.newSegmentTracker({
            tally = tally,
            segmentLog = log,
            now = clock.now,
            instanceInfo = function()
                return zone
            end,
            getMoney = function()
                return money
            end,
            currencyItemCounts = options.currencyItemCounts and function()
                return options.currencyItemCounts
            end or nil,
            character = function()
                return options.character or "Thrall-Ragnaros"
            end,
            classFile = function()
                return options.classFile or "WARRIOR"
            end,
            level = function()
                return options.level
            end,
            holdings = options.holdings ~= false
                and ns.newHoldingsStore({ db = db, now = clock.now })
                or nil,
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
            ---segment has an event and is not dropped on close.
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
        assert.is_function(ns.newSegmentTracker)
    end)

    describe("opening a segment", function()
        it("opens a segment out in the open world", function()
            local harness = newTracker({ zone = WORLD })

            assert.is_true(harness.tracker.sync())
            assert.equal("Elwynn Forest", harness.tracker.current().instance)
        end)

        it("opens a segment on entering an instance", function()
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
        -- one zone; treating any of them as a new segment would split the stay in two.
        it("keeps one segment across a second sync in the same zone", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            local opened = harness.tracker.current()

            harness.clock.advance(600)
            harness.tracker.sync()

            assert.equal(opened, harness.tracker.current())
            assert.same({}, harness.log.all())
        end)
    end)

    describe("dropping segments that saw nothing", function()
        it("files nothing when an empty world segment closes", function()
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

        it("keeps a world segment once something happened in it", function()
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

    describe("closing a segment", function()
        it("files exactly one record on the way out of an instance that earned", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.earn(400)

            harness.clock.advance(1800)
            harness.setZone(WORLD)
            harness.tracker.sync()

            assert.equal(1, #harness.log.all())
        end)

        it("carries the segment's identity onto the record", function()
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
        it("starts the second segment's tally from scratch", function()
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

        it("treats the same instance at another difficulty as a new segment", function()
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

    describe("currency item baselines", function()
        -- The tracker seeds the tally with what the character already owns when a segment
        -- opens, so a bank move that leaves the total flat records nothing while a genuine
        -- gain above the baseline still counts.
        it("seeds the tally so currency held on arrival is not counted as gained", function()
            local harness = newTracker({ zone = DUNGEON, currencyItemCounts = { [5001] = 40 } })
            harness.tracker.sync()

            harness.tally.currencyItem(5001, 40, "Bloody Token")
            assert.same({}, harness.tally.summary().currencies)

            harness.tally.currencyItem(5001, 52, "Bloody Token")
            assert.equal(12, harness.tally.summary().currencies[1].amount)
        end)

        it("re-seeds the baseline for each new segment", function()
            local counts = { [5001] = 40 }
            local harness = newTracker({ zone = DUNGEON, currencyItemCounts = counts })
            harness.tracker.sync()
            harness.tally.currencyItem(5001, 60, "Bloody Token") -- a real gain keeps the visit on file

            harness.clock.advance(600)
            counts[5001] = 60
            harness.setZone(RAID)
            harness.tracker.sync()

            -- The new segment starts from 60; withdrawing back to that total records nothing.
            harness.tally.currencyItem(5001, 60, "Bloody Token")
            assert.same({}, harness.tally.summary().currencies)
        end)
    end)

    describe("a character change", function()
        -- Two characters can be standing in the same-named starting zone; a relog must
        -- never fold the second player's stay into the first player's open segment.
        it("closes the segment and opens a fresh one for the new character", function()
            local db = {}
            local clock = fake.newClock(NOW)
            local zone = { name = "Elwynn Forest", kind = "none", difficultyId = 0 }
            local character = "Thrall-Ragnaros"
            local money = 0

            local tally = ns.newSegmentTally({})
            local log = ns.newSegmentLog({ db = db, now = clock.now, formatDate = fake.newFormatDate() })
            local tracker = ns.newSegmentTracker({
                tally = tally,
                segmentLog = log,
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

    -- What a character was left holding is a fact about the character rather than about the
    -- segment, and segment close is the last moment the addon can write it down: logout
    -- flushes through the same path, and SavedVariables only reach disk once it has.
    describe("writing down what the character was left holding", function()
        it("files the holdings and standings the segment saw", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.tally.currency(3008, 15, "Valorstones", 1200)

            harness.tracker.flush()

            local held = harness.db.holdings["Thrall-Ragnaros"]
            assert.equal(1200, held.currencies[3008].total)
            assert.equal(NOW, held.updatedAt)
        end)

        it("writes nothing down for a segment that saw nothing", function()
            local harness = newTracker({ zone = WORLD })
            harness.tracker.sync()

            harness.tracker.flush()

            assert.same({}, harness.db.holdings)
        end)

        it("files against the character that played the segment, not the one after it", function()
            local harness = newTracker({ zone = DUNGEON, character = "Thrall-Ragnaros" })
            harness.tracker.sync()
            harness.tally.currency(3008, 15, "Valorstones", 1200)

            harness.tracker.flush()

            assert.is_table(harness.db.holdings["Thrall-Ragnaros"])
        end)
    end)

    describe("flushing at logout", function()
        it("files the segment that is still open when it earned", function()
            local harness = newTracker({ zone = DUNGEON })
            harness.tracker.sync()
            harness.earn(120)

            harness.clock.advance(120)
            local record = harness.tracker.flush()

            assert.equal("Deadmines", record.instance)
            assert.equal(NOW + 120, record.endedAt)
            assert.equal(1, #harness.log.all())
        end)

        it("drops the open segment at logout when nothing happened", function()
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
        -- still standing in the dungeon, so a fresh segment has to open.
        it("opens a new segment when the player syncs again after a flush", function()
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
