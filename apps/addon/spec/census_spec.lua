local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newCensus", function()
    local ns = loader.load()

    local NOW = 1700000000
    local MINUTE = 60
    local BUILD = "12.0.5.67823"
    local WALKER = "Aster-Vale"

    ---A domain the test owns outright, and the record of what the walk asked it.
    ---
    ---Deliberately neither `ns.mountCensus` nor `ns.achievementCensus`: what is under test here
    ---is the walk, and a real domain would put the client's own answers between the spec and it.
    ---A position is its own id, which is the mount journal's own arrangement and the shortest
    ---thing to read a test against.
    ---@param options table? `{ name, scope, positions, holds, list, read, count, partial }`
    ---@return table domain, table recorded `{ reads, lists }`
    local function newDomain(options)
        options = options or {}
        local recorded = { reads = {}, lists = 0 }
        local domain = {
            name = options.name or "things",
            scope = options.scope or "account",
            list = function()
                recorded.lists = recorded.lists + 1
                if options.list then
                    return options.list()
                end
                return options.positions
            end,
            read = function(position)
                recorded.reads[#recorded.reads + 1] = position
                if options.read then
                    return options.read(position)
                end
                local held = options.holds and options.holds[position]
                if not held then
                    return nil, nil
                end
                -- A fresh table per read, the way a real domain builds one out of the client's
                -- answer rather than handing the same table back twice. The walk stamps `seen`
                -- onto whatever it is given, and a shared table would carry one pass's stamp
                -- into the next.
                local entry = {}
                for key, value in pairs(held) do
                    entry[key] = value
                end
                return position, entry
            end,
            count = options.count,
            partial = options.partial,
        }
        return domain, recorded
    end

    ---@param options table? `{ db, clock, now, domains, budget, build, character }`
    ---@return table census, table db, table clock, table scheduler
    local function newCensus(options)
        options = options or {}
        local db = options.db or {}
        local clock = options.clock or fake.newClock(options.now or NOW)
        local scheduler = fake.newScheduler(clock)
        local census = ns.newCensus({
            db = db,
            now = clock.now,
            after = scheduler.after,
            character = options.character or function()
                return WALKER
            end,
            build = options.build,
            domains = options.domains or {},
            budget = options.budget,
        })
        return census, db, clock, scheduler
    end

    ---Drives a started pass to its end a slice at a time, without a scheduler in the way.
    ---
    ---The cap is there so a pass that never finishes fails the test loudly rather than hanging
    ---the suite, which is the same bargain `fake.newScheduler` makes.
    ---@param census table
    local function walk(census)
        for _ = 1, 100 do
            if not census.step() then
                return
            end
        end
        error("a pass took more than a hundred slices without finishing")
    end

    ---Starts a pass over exactly these domains and walks it to the end.
    ---
    ---Named rather than left to `audit`, and that is the point of the helper: a second pass over
    ---a domain the first one left whole and current is precisely what `audit` declines to start,
    ---so every test below about what a *second* pass does would otherwise be a test of nothing
    ---happening at all.
    ---@param census table
    ---@param names string[]?
    local function sweep(census, names)
        census.start(names or { "things" })
        walk(census)
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newCensus)
    end)

    describe("where a reading is filed", function()
        it("keeps an account domain once, under the domain's own name", function()
            local domain = newDomain({
                name = "mounts",
                positions = { 6, 9 },
                holds = { [6] = { name = "Swift Zhevra" }, [9] = { name = "Kua'fon" } },
            })
            local census, db = newCensus({ domains = { domain } })

            census.start()
            walk(census)

            local state = db.census.account.mounts
            assert.equal("Swift Zhevra", state.entries[6].name)
            assert.equal(NOW, state.entries[6].seen)
            assert.equal(2, state.held)
            -- Once, and not under the character that happened to do the walking: every
            -- character on the account would answer the same, so a copy per alt would be the
            -- same reading stored as many times as there are alts.
            assert.same({}, db.census.characters)
            assert.equal(WALKER, state.by)
        end)

        it("keeps a character domain under the character that walked it", function()
            local domain = newDomain({
                name = "wallets",
                scope = "character",
                positions = { 3008 },
                holds = { [3008] = { total = 1200 } },
            })
            local census, db = newCensus({ domains = { domain } })

            census.start()
            walk(census)

            assert.equal(1200, db.census.characters[WALKER].wallets.entries[3008].total)
            assert.is_nil(db.census.account.wallets)
            -- Nobody to blame for a reading that is already filed against the only character
            -- it could have come from.
            assert.is_nil(db.census.characters[WALKER].wallets.by)
        end)

        -- Not `segmentSchemaVersion`. The two feeds share a file and nothing else, and a domain
        -- added here must not make every reader re-import every segment.
        it("stamps the account schema version, which is not the segment feed's", function()
            local census, db = newCensus({ domains = { newDomain({ positions = {} }) } })

            census.start()
            walk(census)

            assert.equal(1, db.census.version)
        end)
    end)

    describe("what a reading contains", function()
        -- The catalogue of what exists lives in the game's own tables, which the desktop reads.
        -- A census that also wrote down every absence would be several times the size and would
        -- say nothing that could not be worked out by subtraction.
        it("writes down what is held and says nothing at all about what is not", function()
            local domain = newDomain({
                positions = { 1, 2, 3 },
                holds = { [2] = { name = "the one they own" } },
            })
            local census, db = newCensus({ domains = { domain } })

            census.start()
            walk(census)

            local state = db.census.account.things
            assert.equal("the one they own", state.entries[2].name)
            assert.is_nil(state.entries[1])
            assert.is_nil(state.entries[3])
            assert.equal(1, state.held)
        end)

        -- Both or neither. A domain that names an id and then says nothing about it has
        -- reported an absence, and one that describes a holding it cannot name has nowhere to
        -- file it — either way there is nothing here that a reader could join on.
        for _, case in ipairs({
            {
                what = "an id with nothing said about it",
                read = function(position)
                    return position, nil
                end,
            },
            {
                what = "a holding with no id to file it under",
                read = function()
                    return nil, { name = "nobody's" }
                end,
            },
        }) do
            it("records nothing for " .. case.what, function()
                local domain = newDomain({ positions = { 1 }, read = case.read })
                local census, db = newCensus({ domains = { domain } })

                census.start()
                walk(census)

                assert.same({}, db.census.account.things.entries)
                assert.equal(0, db.census.account.things.held)
            end)
        end
    end)

    describe("how much of a claim a reading is", function()
        -- The flag the whole feature turns on. Between the first slice and the last the entries
        -- are half of one reading and half of another, which is a position the account was
        -- never in — so for as long as that is true the file has to say so out loud.
        it("says nothing is whole for as long as the walk is running", function()
            local domain = newDomain({
                positions = { 1, 2, 3, 4 },
                holds = { [1] = { name = "one" } },
            })
            local census, db = newCensus({ domains = { domain }, budget = 2 })

            census.start()
            census.step()

            local state = db.census.account.things
            assert.is_false(state.complete)
            assert.equal(NOW, state.startedAt)
            assert.is_nil(state.completedAt)
            assert.equal(0, state.revision)
            assert.is_true(census.running())
        end)

        it("dates and numbers the reading only once the walk has finished", function()
            local domain = newDomain({
                positions = { 1, 2 },
                holds = { [1] = { name = "one" } },
                count = function()
                    return 1
                end,
            })
            local census, db, clock = newCensus({ domains = { domain } })

            census.start()
            clock.advance(MINUTE)
            walk(census)

            local state = db.census.account.things
            assert.is_true(state.complete)
            assert.equal(NOW, state.startedAt)
            assert.equal(NOW + MINUTE, state.completedAt)
            assert.equal(1, state.revision)
            -- What the client's own counter said at the moment the pass ended, kept beside what
            -- the pass found so that a later audit is a comparison rather than another walk.
            assert.equal(1, state.counted)
            assert.is_false(census.running())
        end)

        it("bumps the revision once per pass, so a reader knows it has seen these entries",
            function()
                local domain = newDomain({ positions = { 1 }, holds = { [1] = { name = "one" } } })
                local census = newCensus({ domains = { domain } })

                sweep(census)
                sweep(census)

                assert.equal(2, census.state("things").revision)
            end)
    end)

    describe("what a finished pass takes away", function()
        -- The only place a census ever removes anything. A pass asks about every id the client
        -- named and writes down every one that is held, so an entry left with a stamp from
        -- before the pass began is either an id the client no longer names or one it no longer
        -- says is held — and both of those are gone.
        it("drops what it did not see again and keeps what it did", function()
            local holds = { [1] = { name = "sold" }, [2] = { name = "kept" } }
            local domain = newDomain({ positions = { 1, 2, 3 }, holds = holds })
            local census, db, clock = newCensus({ domains = { domain } })
            sweep(census)

            holds[1] = nil
            holds[3] = { name = "bought since" }
            clock.advance(MINUTE)
            sweep(census)

            local state = db.census.account.things
            assert.is_nil(state.entries[1])
            assert.equal("kept", state.entries[2].name)
            assert.equal("bought since", state.entries[3].name)
            assert.equal(2, state.held)
        end)

        -- The rule the whole feature exists to state: an absence means a removal only inside a
        -- reading that says it is complete. A logout in the middle of a thirteen-thousand-call
        -- walk is ordinary rather than exceptional, and a pass that pruned on the way through
        -- would tell every reader the account had lost everything it had not reached yet.
        it("never drops anything on a pass that was cut short", function()
            local holds = { [1] = { name = "one" }, [2] = { name = "two" }, [3] = { name = "three" } }
            local domain = newDomain({ positions = { 1, 2, 3 }, holds = holds })
            local census, db, clock = newCensus({ domains = { domain }, budget = 1 })
            sweep(census)

            -- Everything is gone as far as this pass can tell, and the pass never gets far
            -- enough to be allowed to say so.
            holds[1], holds[2], holds[3] = nil, nil, nil
            clock.advance(MINUTE)
            census.start({ "things" })
            census.step()

            local state = db.census.account.things
            assert.is_false(state.complete)
            assert.equal("one", state.entries[1].name)
            assert.equal("two", state.entries[2].name)
            assert.equal("three", state.entries[3].name)
            assert.equal(3, state.held)
        end)

        -- An empty list is an answer where a missing list is not, and against a reading that
        -- has never held anything it is an answer worth believing: a brand new account holds no
        -- mounts, and the census has to be able to say so rather than stay silent forever.
        it("completes on an empty answer when nothing was ever held", function()
            local domain = newDomain({
                list = function()
                    return {}
                end,
            })
            local census, db = newCensus({ domains = { domain } })

            census.start()
            walk(census)

            local state = db.census.account.things
            assert.same({}, state.entries)
            assert.equal(0, state.held)
            assert.is_true(state.complete)
            assert.equal(1, state.revision)
        end)

        -- The same empty answer against a reading that held something is a different claim
        -- entirely, and one that is almost certainly false. A census is provoked at a loading
        -- screen, which is exactly where the server has not finished telling the client what
        -- this account has; a walk that runs then is not told the account owns nothing, it is
        -- told nothing at all. Believing it would delete an account's whole history on one
        -- unlucky login, so it is treated as the interrupted pass it very probably is.
        it("refuses to complete on an empty answer against a reading that held something",
            function()
                local holds = { [1] = { name = "one" }, [2] = { name = "two" } }
                local domain = newDomain({ positions = { 1, 2 }, holds = holds })
                local census, db, clock = newCensus({ domains = { domain } })
                sweep(census)

                domain.list = function()
                    return {}
                end
                clock.advance(MINUTE)
                sweep(census)

                local state = db.census.account.things
                assert.equal("one", state.entries[1].name)
                assert.equal("two", state.entries[2].name)
                assert.equal(2, state.held)
                -- Down, and left down: the next pass to actually find something is what puts
                -- it back up, and until then the file says out loud that it is not whole.
                assert.is_false(state.complete)
                assert.equal(1, state.revision)
                assert.is_nil(state.completedAt)
            end)

        -- The same refusal reached the other way round: the client names every id it always
        -- did and then says the account holds none of them, which is what a client answering
        -- before the server has told it anything looks like from in here.
        it("refuses to complete when every id the client named turned out to hold nothing",
            function()
                local holds = { [1] = { name = "one" }, [2] = { name = "two" } }
                local domain = newDomain({ positions = { 1, 2 }, holds = holds })
                local census, db, clock = newCensus({ domains = { domain } })
                sweep(census)

                holds[1], holds[2] = nil, nil
                clock.advance(MINUTE)
                sweep(census)

                local state = db.census.account.things
                assert.equal(2, state.held)
                assert.is_false(state.complete)
            end)

        -- And the line between the two: a pass that found even one thing is a pass the client
        -- answered, so everything it did not find really is gone.
        it("still drops the rest of a reading when the walk found so much as one thing",
            function()
                local holds = { [1] = { name = "one" }, [2] = { name = "two" } }
                local domain = newDomain({ positions = { 1, 2 }, holds = holds })
                local census, db, clock = newCensus({ domains = { domain } })
                sweep(census)

                holds[2] = nil
                clock.advance(MINUTE)
                sweep(census)

                local state = db.census.account.things
                assert.equal("one", state.entries[1].name)
                assert.is_nil(state.entries[2])
                assert.equal(1, state.held)
                assert.is_true(state.complete)
            end)
    end)

    -- The domain that can only ever see part of what the account holds, which on a real client
    -- is `ns.appearanceCensus`: the wardrobe is answered for through the logged-in character's
    -- class filter, so a mage's walk is the account's cloth and none of its plate however
    -- faithfully it runs to the end. Everything below is what stops that reading being mistaken
    -- for a whole one.
    describe("a domain that can only ever be walked in part", function()
        it("never claims to be whole, however far the pass got", function()
            local domain = newDomain({ partial = true, positions = { 1 }, holds = { [1] = {} } })
            local census, db = newCensus({ domains = { domain } })

            sweep(census)

            assert.is_false(db.census.account.things.complete)
        end)

        -- The whole point of the flag. A paladin's walk must add its plate to the cloth a mage's
        -- walk found rather than replace it, and a prune here would empty the account's wardrobe
        -- at every login by a character of a different armour type.
        it("keeps what a walk was never shown, where a whole one would take it away", function()
            local holds = { [1] = { name = "cloth" }, [2] = { name = "plate" } }
            local domain = newDomain({ partial = true, positions = { 1, 2 }, holds = holds })
            local census, db, clock = newCensus({ domains = { domain } })
            sweep(census)

            -- The next character cannot see the second one at all, which is not the same thing
            -- as the account having stopped holding it.
            holds[2] = nil
            clock.advance(MINUTE)
            sweep(census)

            local state = db.census.account.things
            assert.equal("cloth", state.entries[1].name)
            assert.equal("plate", state.entries[2].name)
            assert.equal(2, state.held)
        end)

        -- It still ran to the end, and everything about a finished pass except the claim is
        -- worth writing down — not least `counted`, which is the client's own opinion of how
        -- much of this there is and therefore the one measure of how far the union has got.
        it("dates and numbers the pass that ran to the end anyway", function()
            local domain = newDomain({
                partial = true,
                positions = { 1 },
                holds = { [1] = {} },
                count = function()
                    return 12
                end,
            })
            local census, db, clock = newCensus({ domains = { domain } })

            clock.advance(MINUTE)
            sweep(census)

            local state = db.census.account.things
            assert.equal(NOW + MINUTE, state.completedAt)
            assert.equal(1, state.revision)
            assert.equal(12, state.counted)
            assert.equal(1, state.held)
        end)

        -- And so it is walked once a session. Nothing else in a session tells this domain that
        -- the account collected a look, and the character in front of the client is a different
        -- part of the answer every time — so unlike every other domain there is always a reason
        -- to walk it again.
        it("is never settled by an audit, because the next character sees something else",
            function()
                local domain = newDomain({ partial = true, positions = { 1 }, holds = { [1] = {} } })
                local census = newCensus({
                    domains = { domain },
                    build = function()
                        return BUILD
                    end,
                })

                sweep(census)

                assert.same({ "things" }, census.audit())
            end)
    end)

    describe("spreading the walk out", function()
        it("asks about no more than the budget in one slice", function()
            local domain, recorded = newDomain({ positions = { 1, 2, 3, 4, 5 } })
            local census = newCensus({ domains = { domain }, budget = 2 })
            census.start()

            assert.is_true(census.step())
            assert.same({ 1, 2 }, recorded.reads)

            assert.is_true(census.step())
            assert.same({ 1, 2, 3, 4 }, recorded.reads)

            -- The slice that reaches the end finishes the domain and finds no other, so it is
            -- also the one that reports there is nothing left to do.
            assert.is_false(census.step())
            assert.same({ 1, 2, 3, 4, 5 }, recorded.reads)
        end)

        it("drives itself to the end through the client's own scheduler", function()
            local domain, recorded = newDomain({
                positions = { 1, 2, 3, 4, 5 },
                holds = { [4] = { name = "four" } },
            })
            local census, db, _, scheduler = newCensus({ domains = { domain }, budget = 2 })

            census.run()
            -- The first slice runs where `run` was called; everything after it is a callback
            -- the client is holding, which is what makes this something a player plays through.
            assert.equal(2, #recorded.reads)
            assert.equal(1, scheduler.pending())

            scheduler.settle()

            assert.equal(5, #recorded.reads)
            assert.equal(0, scheduler.pending())
            assert.is_true(db.census.account.things.complete)
            assert.equal("four", db.census.account.things.entries[4].name)
        end)

        -- A second chain of slices over the same domain would walk the same ids twice and, far
        -- worse, could finish the first chain's domain against the second chain's start time —
        -- pruning away everything the first chain had already written down.
        it("refuses to start a second pass over a walk already in flight", function()
            local domain, recorded = newDomain({ positions = { 1, 2, 3, 4, 5 } })
            local census, _, _, scheduler = newCensus({ domains = { domain }, budget = 2 })

            census.run()
            census.run()

            assert.equal(1, recorded.lists)
            assert.equal(2, #recorded.reads)
            assert.equal(1, scheduler.pending())

            scheduler.settle()

            -- Every position asked about exactly once, which is the whole claim: a doubled
            -- pass would have read five ids twice.
            assert.same({ 1, 2, 3, 4, 5 }, recorded.reads)
        end)
    end)

    -- What makes a pass something another module can wait on. `ns.newCensusResync` records a
    -- walk somebody asked for as carried out on this callback and on nothing else, so every
    -- claim below is one that module is leaning on.
    describe("saying when a pass has run to the end", function()
        ---A census whose slices after the first wait for the test to ask for them.
        ---
        ---`fake.newScheduler` drains a whole chain of slices in one go, which is what the tests
        ---above want and is precisely wrong for the case that matters here: a logout lands
        ---*between* two slices, and standing in that gap means holding the queue by hand.
        ---@param options table `{ positions, budget }`
        ---@return table census, table frames `{ next = fun(), waiting = fun(): integer }`
        local function newHeldCensus(options)
            local waiting = {}
            local census = ns.newCensus({
                db = {},
                now = function()
                    return NOW
                end,
                after = function(_, callback)
                    waiting[#waiting + 1] = callback
                end,
                character = function()
                    return WALKER
                end,
                domains = { newDomain({ positions = options.positions }) },
                budget = options.budget,
            })
            return census, {
                ---The client handing the addon the next frame it asked for.
                next = function()
                    local slice = assert(table.remove(waiting, 1),
                        "the census was not waiting on the client for anything")
                    slice()
                end,
                waiting = function()
                    return #waiting
                end,
            }
        end

        it("calls back once, and only once the queue has run out", function()
            local census, frames = newHeldCensus({ positions = { 1, 2, 3, 4, 5 }, budget = 2 })
            local done = 0

            assert.is_true(census.run({ "things" }, function()
                done = done + 1
            end))
            -- The first slice runs where `run` was called, and there are three to go.
            assert.equal(0, done)

            frames.next()
            assert.equal(0, done)

            frames.next()

            assert.equal(1, done)
            assert.is_false(census.running())
            -- Nothing left waiting to call it a second time.
            assert.equal(0, frames.waiting())
        end)

        -- A pass a logout cuts short never calls back, because there is no frame left to call it
        -- from — and that silence is the whole of how an interrupted resync is handled. A
        -- callback fired on the way out would mark half an answer as the fresh census somebody
        -- asked for.
        it("never calls back for a pass that was abandoned part-way", function()
            local census, frames = newHeldCensus({ positions = { 1, 2, 3, 4, 5 }, budget = 2 })
            local done = 0

            census.run({ "things" }, function()
                done = done + 1
            end)
            frames.next()

            assert.equal(0, done)
            assert.is_true(census.running())
            assert.equal(1, frames.waiting())
        end)

        -- The refusal a second pass meets, reported rather than raised: the caller has to be
        -- able to tell "I started that" from "somebody else is already walking", because only
        -- the first of them will ever call back.
        it("answers false and never calls back where a pass is already in flight", function()
            local domain = newDomain({ positions = { 1, 2, 3, 4, 5 } })
            local census, _, _, scheduler = newCensus({ domains = { domain }, budget = 2 })
            local second = 0

            assert.is_true(census.run({ "things" }))
            assert.is_false(census.run({ "things" }, function()
                second = second + 1
            end))
            scheduler.settle()

            assert.equal(0, second)
        end)

        it("answers false and never calls back where there was nothing to begin", function()
            local domain = newDomain({ positions = { 1 }, holds = { [1] = { name = "one" } } })
            local census = newCensus({ domains = { domain } })
            sweep(census)
            local done = 0
            local function onDone()
                done = done + 1
            end

            -- Nothing the audit distrusts, and then a name this build has never heard of.
            assert.is_false(census.run(nil, onDone))
            assert.is_false(census.run({ "housing" }, onDone))

            assert.equal(0, done)
        end)
    end)

    describe("a client build that will not answer", function()
        -- Nil is not an empty list. A build that has moved a call, or a server that has not sent
        -- the tree yet, has said nothing — and replacing a census with an empty one on the
        -- strength of a silence would tell a reader the account had lost everything it owns.
        it("leaves the last census standing, and whole, for a domain it cannot list", function()
            local domain = newDomain({ positions = { 1 }, holds = { [1] = { name = "one" } } })
            local census, db, clock = newCensus({ domains = { domain } })
            sweep(census)

            domain.list = function()
                return nil
            end
            clock.advance(MINUTE)
            census.run({ "things" })

            local state = db.census.account.things
            assert.equal("one", state.entries[1].name)
            assert.equal(1, state.held)
            -- Not demoted, because nothing about the reading changed: nobody could be asked, so
            -- the last whole answer is still the last whole answer.
            assert.is_true(state.complete)
            assert.equal(1, state.revision)
            assert.equal(NOW, state.completedAt)
        end)

        it("carries on to the domains behind it rather than stopping at the hole", function()
            local absent = newDomain({
                name = "absent",
                list = function()
                    return nil
                end,
            })
            local present, recorded = newDomain({ name = "present", positions = { 1, 2 } })
            local census = newCensus({ domains = { absent, present } })

            census.start({ "absent", "present" })
            walk(census)

            assert.same({ 1, 2 }, recorded.reads)
            assert.is_true(census.state("present").complete)
        end)
    end)

    describe("which domains an audit distrusts", function()
        ---A census over one domain whose build and counter the test drives by hand.
        ---@param options table? `{ counted, positions, holds }`
        ---@return table census, table build `{ value }`, table domain
        local function auditable(options)
            options = options or {}
            local build = { value = BUILD }
            local domain = newDomain({
                positions = options.positions or { 1, 2 },
                holds = options.holds or { [1] = { name = "one" }, [2] = { name = "two" } },
                count = options.counted and function()
                    return options.counted.value
                end or nil,
            })
            local census = newCensus({
                domains = { domain },
                build = function()
                    return build.value
                end,
            })
            return census, build, domain
        end

        -- Nothing has ever finished, so there is nothing to trust. This is what a fresh install
        -- looks like, and the reason the first login takes a census at all.
        it("names a domain no pass has ever finished", function()
            local census = auditable()

            assert.same({ "things" }, census.audit())
        end)

        -- A patch adds mounts, retires achievements and moves appearances between categories,
        -- so a census taken on the build before it is a census of a different game. The string
        -- is exact, which is what stops this ever firing when nothing has changed.
        it("names a domain last walked on another build of the game", function()
            local census, build = auditable()
            census.start()
            walk(census)
            assert.same({}, census.audit())

            build.value = "12.0.6.68000"

            assert.same({ "things" }, census.audit())
        end)

        -- The case events cannot cover: an evening played on another machine's install, or a
        -- session a crash took with it. Nothing announced those, and the client's own counter
        -- is the one call that notices them.
        it("names a domain the client counts more of than was written down", function()
            local counted = { value = 2 }
            local census = auditable({ counted = counted })
            census.start()
            walk(census)
            assert.same({}, census.audit())

            counted.value = 3

            assert.same({ "things" }, census.audit())
        end)

        -- The other direction is not the same claim, and is deliberately not acted on. A
        -- counter need not be counting the same set the census records — the achievement
        -- counter's treatment of guild achievements, which the domain refuses on purpose, is
        -- the open question — so a count that comes in low is ambiguous where a count that
        -- comes in high means things are missing. Provoking on the ambiguous one would walk
        -- thirteen thousand achievements at every single login and change nothing.
        it("leaves a domain alone when the client counts fewer than was written down", function()
            local counted = { value = 2 }
            local census = auditable({ counted = counted })
            census.start()
            walk(census)

            counted.value = 1

            assert.same({}, census.audit())
        end)

        it("names nothing when the reading is whole, current, and agrees with the client",
            function()
                local census = auditable({ counted = { value = 2 } })

                census.start()
                walk(census)

                assert.same({}, census.audit())
            end)

        -- A domain whose client offers no counter cannot be distrusted by one, so it is walked
        -- only when something else provokes a pass rather than on every login forever.
        it("never distrusts a domain on a count nobody offers", function()
            local census = auditable()

            census.start()
            walk(census)

            assert.same({}, census.audit())
        end)
    end)

    describe("what a domain last said", function()
        it("says nothing about a domain it was never given", function()
            local census = newCensus({ domains = { newDomain({ positions = {} }) } })

            assert.is_nil(census.state("appearances"))
            assert.is_table(census.state("things"))
        end)
    end)
end)
