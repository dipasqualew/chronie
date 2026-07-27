local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newEntryLog", function()
    local ns = loader.load()

    local NOW = 1700000000
    local AUTHOR = "Player-970-0002FD1B|1699000000"
    local STAMP = "<%m%d%y_%H%M%S@" .. NOW .. ">"

    ---A segment descriptor of the shape ns.newSegmentTracker keeps open.
    ---@param overrides table?
    ---@return table
    local function openSegment(overrides)
        local segment = {
            character = "Thrall-Ragnaros",
            instance = "Ulduar",
            startedAt = NOW - 1800,
        }
        for key, value in pairs(overrides or {}) do
            segment[key] = value
        end
        return segment
    end

    ---@param options table? `{ db, clock, author, character, map, segment, cooldownSeconds }`
    ---@return EntryLog log, table db, table clock
    local function newLog(options)
        options = options or {}
        local db = options.db or {}
        local clock = options.clock or fake.newClock(NOW)
        local author = options.author
        if author == nil then
            author = AUTHOR
        end
        local map = options.map
        if map == nil then
            map = { uiMapID = 84, x = 0.25, y = 0.75 }
        end
        local segment = options.segment
        if segment == nil then
            segment = openSegment()
        end

        local log = ns.newEntryLog({
            db = db,
            now = clock.now,
            formatDate = fake.newFormatDate(),
            character = function()
                return options.character or "Thrall-Ragnaros"
            end,
            author = function()
                return author or nil
            end,
            mapState = function()
                return map or nil
            end,
            openSegment = function()
                return segment or nil
            end,
            cooldownSeconds = options.cooldownSeconds,
        })
        return log, db, clock
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newEntryLog)
    end)

    it("creates the entries table when the file has never seen one", function()
        local _, db = newLog()

        assert.same({}, db.entries)
    end)

    describe("recording a capture", function()
        it("writes every field of the record into db.entries", function()
            local log, db = newLog()

            log.record({ hasImage = true })

            assert.equal(1, #db.entries)
            assert.same({
                id = AUTHOR .. "|" .. NOW .. "|1",
                schema = 1,
                at = NOW,
                stamp = STAMP,
                character = "Thrall-Ragnaros",
                author = AUTHOR,
                segment = "Thrall-Ragnaros|" .. (NOW - 1800) .. "|Ulduar",
                uiMapID = 84,
                x = 0.25,
                y = 0.75,
                hasImage = true,
            }, db.entries[1])
        end)

        it("returns the entry it wrote", function()
            local log, db = newLog()

            local entry = log.record({ hasImage = true })

            assert.equal(db.entries[1], entry)
        end)

        -- Two clocks on purpose: the epoch orders entries and survives a daylight-saving
        -- change, the local stamp is the only thing that can be matched against the
        -- WoWScrnShot_MMDDYY_HHMMSS filename the client writes.
        it("stamps the local time in the shape the client names a screenshot file", function()
            local log = newLog()

            local entry = log.record({ hasImage = true })

            assert.equal(NOW, entry.at)
            assert.equal(STAMP, entry.stamp)
        end)

        it("adds to the entries already in the file rather than replacing them", function()
            local db = {}
            local first = newLog({ db = db })
            first.record({ hasImage = true })

            local second = newLog({ db = db, clock = fake.newClock(NOW + 60) })
            second.record({ hasImage = true })

            assert.equal(2, #db.entries)
        end)

        it("records an entry with no image when none was asked for", function()
            local log = newLog()

            local entry = log.record()

            assert.is_nil(entry.hasImage)
        end)
    end)

    describe("the segment link", function()
        -- The link has to be exactly the id the log files that segment under, or the
        -- desktop app joins an entry to nothing.
        it("is the identity ns.newSegmentLog would file the open segment under", function()
            local db = {}
            local segmentLog = ns.newSegmentLog({
                db = db,
                now = function()
                    return NOW
                end,
                formatDate = fake.newFormatDate(),
            })
            local log = newLog({ db = db })

            local record = segmentLog.record({
                character = "Thrall-Ragnaros",
                instance = "Ulduar",
                startedAt = NOW - 1800,
                endedAt = NOW,
                summary = {},
            })
            local entry = log.record({ hasImage = true })

            assert.equal(record.id, entry.segment)
        end)

        it("is absent when no segment was open", function()
            local log = newLog({ segment = false })

            assert.is_nil(log.record({ hasImage = true }).segment)
        end)

        -- The whole reason entries are a top-level store: db.segments is pruned to a
        -- rolling week, and a photograph must not age out with the segment around it.
        it("does not put the entry inside the segment store", function()
            local log, db = newLog()

            log.record({ hasImage = true })

            assert.is_nil(db.segments)
        end)
    end)

    describe("where it was taken", function()
        it("records the map and the point where the client gives both", function()
            local log = newLog({ map = { uiMapID = 84, x = 0.25, y = 0.75 } })

            local entry = log.record({ hasImage = true })

            assert.equal(84, entry.uiMapID)
            assert.equal(0.25, entry.x)
            assert.equal(0.75, entry.y)
        end)

        -- Most of instanced content: the client names the map and refuses the point.
        it("records the map and omits the point where there is no position", function()
            local log = newLog({ map = { uiMapID = 2296 } })

            local entry = log.record({ hasImage = true })

            assert.equal(2296, entry.uiMapID)
            assert.is_nil(entry.x)
            assert.is_nil(entry.y)
        end)

        it("omits both where the client cannot name a map at all", function()
            local log = newLog({ map = false })

            local entry = log.record({ hasImage = true })

            assert.is_nil(entry.uiMapID)
            assert.is_nil(entry.x)
            assert.is_nil(entry.y)
        end)
    end)

    describe("the id", function()
        it("carries the account, so two players can never collide", function()
            local mine = newLog().record({ hasImage = true })
            local theirs = newLog({ author = "Player-1147-000BEEF1|1699000000" }).record({ hasImage = true })

            assert.not_equal(mine.id, theirs.id)
        end)

        it("differs between two entries made in the same second", function()
            local log = newLog({ cooldownSeconds = 0 })

            local first = log.record({ hasImage = true })
            local second = log.record({ hasImage = true })

            assert.not_equal(first.id, second.id)
        end)

        -- The counter is persisted rather than derived from #db.entries, so deleting an
        -- entry can never hand its number to a later one.
        it("keeps climbing across sessions", function()
            local db = {}
            newLog({ db = db }).record({ hasImage = true })
            db.entries = {}

            local entry = newLog({ db = db, clock = fake.newClock(NOW) }).record({ hasImage = true })

            assert.equal(AUTHOR .. "|" .. NOW .. "|2", entry.id)
        end)

        it("survives a clock that jumps backwards", function()
            local clock = fake.newClock(NOW)
            local log = newLog({ clock = clock, cooldownSeconds = 0 })
            local first = log.record({ hasImage = true })

            clock.set(NOW - 3600)
            local second = log.record({ hasImage = true })

            assert.not_equal(first.id, second.id)
        end)
    end)

    describe("the cooldown", function()
        -- Screenshot filenames resolve to the second, so a second marker inside that
        -- second could only ever resolve to the wrong picture.
        it("refuses a second capture inside the same second", function()
            local log, db = newLog()

            log.record({ hasImage = true })

            assert.is_nil(log.record({ hasImage = true }))
            assert.equal(1, #db.entries)
        end)

        it("allows a capture once a second has passed", function()
            local log, db, clock = newLog()
            log.record({ hasImage = true })

            clock.advance(1)

            assert.is_table(log.record({ hasImage = true }))
            assert.equal(2, #db.entries)
        end)

        it("honours a longer cooldown", function()
            local log, _, clock = newLog({ cooldownSeconds = 5 })
            log.record({ hasImage = true })

            clock.advance(4)
            assert.is_nil(log.record({ hasImage = true }))

            clock.advance(1)
            assert.is_table(log.record({ hasImage = true }))
        end)

        it("burns no id on a capture it refused", function()
            local log, _, clock = newLog()
            log.record({ hasImage = true })
            log.record({ hasImage = true })

            clock.advance(1)

            assert.equal(AUTHOR .. "|" .. (NOW + 1) .. "|2", log.record({ hasImage = true }).id)
        end)

        -- The ambiguity is between two image files, so an entry that never had one is
        -- not what the cooldown is protecting against.
        it("does not hold back an entry carrying no image", function()
            local log, db = newLog()
            log.record({ hasImage = true })

            assert.is_table(log.record())
            assert.equal(2, #db.entries)
        end)
    end)

    describe("an unauthored entry", function()
        -- Which happens before the world has loaded, and an entry authored by nobody is
        -- not something a later release could repair.
        it("is refused while the account cannot be named", function()
            local log, db = newLog({ author = false })

            assert.is_nil(log.record({ hasImage = true }))
            assert.same({}, db.entries)
        end)

        it("burns no id", function()
            local db = {}
            newLog({ db = db, author = false }).record({ hasImage = true })

            assert.is_nil(db.entryCounter)
        end)

        it("does not start the cooldown, so the next press still works", function()
            local db = {}
            newLog({ db = db, author = false }).record({ hasImage = true })

            local entry = newLog({ db = db }).record({ hasImage = true })

            assert.is_table(entry)
        end)
    end)
end)
