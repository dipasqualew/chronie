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

    -- An entry with the picture left out. The same row, written by the same log, and the
    -- absence of `hasImage` is the whole difference: downstream reads it as a moment somebody
    -- marked rather than a photograph whose file has gone astray.
    describe("recording a memory", function()
        it("carries no hasImage at all rather than a false one", function()
            local log, db = newLog()

            local entry = log.record()

            assert.is_nil(entry.hasImage)
            assert.is_nil(db.entries[1].hasImage)
        end)

        it("writes every other field the same way a photograph's is written", function()
            local log, db = newLog()

            log.record()

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
            }, db.entries[1])
        end)

        -- The cooldown exists because two screenshot filenames a second apart are the closest
        -- pair that can still be told from one another. A memory has no file to be confused
        -- with, so somebody writing two sentences in one second gets two memories.
        it("takes two memories in the same second", function()
            local log, db = newLog()

            local first = log.record()
            local second = log.record()

            assert.is_table(first)
            assert.is_table(second)
            assert.equal(2, #db.entries)
            assert.not_equal(first.id, second.id)
        end)

        -- And a memory does not start the cooldown either: the next press of the screenshot
        -- key is judged against the last photograph, not against the last sentence.
        it("does not hold back the photograph that follows it", function()
            local log, db = newLog()

            log.record()

            assert.is_table(log.record({ hasImage = true }))
            assert.equal(2, #db.entries)
        end)

        it("is refused while the account cannot be named, like any other entry", function()
            local log, db = newLog({ author = false })

            assert.is_nil(log.record())
            assert.same({}, db.entries)
        end)
    end)

    -- What a memory nobody wrote anything about is worth keeping: none of it. A photograph is
    -- the opposite, which is why this is a deliberate call by whoever knows which of the two
    -- they are holding rather than a rule the log applies to every noteless entry.
    describe("discarding an entry", function()
        it("takes the row back out of db.entries", function()
            local log, db = newLog()
            local entry = log.record()

            assert.is_true(log.discard(entry))
            assert.same({}, db.entries)
        end)

        it("takes out the row it was handed rather than the last one written", function()
            local log, db, clock = newLog()
            local first = log.record()
            clock.advance(1)
            local second = log.record()
            clock.advance(1)
            local third = log.record()

            assert.is_true(log.discard(second))

            assert.same({ first, third }, db.entries)
        end)

        it("answers false for an entry it never wrote, and leaves the file alone", function()
            local log, db = newLog()
            local mine = log.record()
            local theirs = { id = "somebody else's entry", at = NOW }

            assert.is_false(log.discard(theirs))
            assert.same({ mine }, db.entries)
        end)

        it("answers false the second time the same entry is taken back", function()
            local log = newLog()
            local entry = log.record()
            log.discard(entry)

            assert.is_false(log.discard(entry))
        end)

        -- The counter numbers what has been handed out rather than what survives. An id that
        -- has once been given away must never be given away again: a shared memory pack
        -- somebody else is holding may already name it.
        it("does not wind the counter back, so no id is ever handed out twice", function()
            local log, db, clock = newLog()
            local discarded = log.record()
            log.discard(discarded)

            clock.advance(1)
            local entry = log.record()

            assert.equal(2, db.entryCounter)
            assert.not_equal(discarded.id, entry.id)
            assert.equal(AUTHOR .. "|" .. (NOW + 1) .. "|2", entry.id)
        end)

        -- The same second as the discarded one, which is where a counter derived from
        -- #db.entries would have handed the number straight back out again.
        it("does not reuse the id even inside the second it was written in", function()
            local log = newLog()
            local discarded = log.record()
            log.discard(discarded)

            assert.not_equal(discarded.id, log.record().id)
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
