local loader = require("addon_loader")

describe("ns.newCensusResync", function()
    local ns = loader.load()

    local NOW = 1700000000

    ---Every domain this build can walk, in the census's own walk order: cheapest first.
    ---
    ---Deliberately not the order any request below asks for them in, so a walk that took the
    ---request's word for it would come out of this spec looking different.
    local WALKABLE = { "mounts", "appearances", "achievements" }

    ---A `walk` whose passes end when the test says they end.
    ---
    ---The asynchrony is the whole of what this module is about: a request is recorded when its
    ---walk *finishes*, and no fake that called back before returning could tell that apart from
    ---one recorded the moment it started.
    ---@param options table? `{ refuse }`
    ---@return fun(names: string[], onDone: fun()): boolean walk
    ---@return table recorded `{ calls, refusing, finish }`
    local function newWalk(options)
        options = options or {}
        local waiting = {}
        local recorded = { calls = {}, refusing = options.refuse == true }

        ---The census reaching the end of the pass it was asked for.
        function recorded.finish()
            local onDone = assert(table.remove(waiting, 1), "no walk was in flight to finish")
            onDone()
        end

        return function(names, onDone)
            recorded.calls[#recorded.calls + 1] = names
            -- What a pass already in flight answers, which is a refusal and not a failure.
            if recorded.refusing then
                return false
            end
            waiting[#waiting + 1] = onDone
            return true
        end, recorded
    end

    ---@param options table? `{ requests, store, domains, now, refuse, noRequests }`
    ---@return table resync, table walked, table store, table requests
    local function newResync(options)
        options = options or {}
        local requests = options.requests or {}
        local store = options.store or {}
        local walk, walked = newWalk(options)
        local resync = ns.newCensusResync({
            readRequests = function()
                -- `noRequests` is the shipped-empty module a hand-installed copy carries,
                -- reached through a seam that answers nothing rather than an empty list.
                if options.noRequests then
                    return nil
                end
                return requests
            end,
            store = store,
            now = function()
                return options.now or NOW
            end,
            domains = function()
                return options.domains or WALKABLE
            end,
            walk = walk,
        })
        return resync, walked, store, requests
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newCensusResync)
        assert.is_function(ns.censusResyncText)
    end)

    describe("what a request asks to be walked", function()
        -- What the app's own Resync button sends: it has no suspicion about any one collection,
        -- it has a reader who wants the file to be right.
        it("walks every domain this build can answer for a request that names none", function()
            local resync, walked = newResync({ requests = { { id = 1 } } })

            local names = resync.run()

            assert.equal(1, #walked.calls)
            assert.same(WALKABLE, walked.calls[1])
            assert.same(WALKABLE, names)
        end)

        -- In the census's order rather than the request's, and that is deliberate: the census's
        -- is cheapest-first, and a pass is interrupted by whatever ends the session — so the
        -- domain that finishes in a fifth of a second must not be queued behind the one that
        -- takes a minute because a request happened to list it second.
        it("walks only what a request named, in the census's own order", function()
            local resync, walked = newResync({
                requests = { { id = 1, domains = { "achievements", "mounts" } } },
            })

            resync.run()

            assert.same({ "mounts", "achievements" }, walked.calls[1])
        end)

        -- One walk, not one per request. Two readers pressing the button on two machines, or
        -- one pressing it twice, is a single pass over the union of what they asked for.
        it("answers several pending requests with one walk over what they asked between them",
            function()
                local resync, walked, store = newResync({
                    requests = {
                        { id = 1, domains = { "achievements" } },
                        { id = 2, domains = { "mounts" } },
                    },
                })

                resync.run()
                walked.finish()

                assert.equal(1, #walked.calls)
                assert.same({ "mounts", "achievements" }, walked.calls[1])
                assert.equal("walked", store.done[1].outcome)
                assert.equal("walked", store.done[2].outcome)
            end)
    end)

    describe("when a request is written down as carried out", function()
        -- The module's central claim, and the reason the record is not written where it would
        -- be easiest to write it. A player who logs out thirty seconds into a minute-long walk
        -- has had part of an answer; the request is still unanswered, so the app goes on asking
        -- and the next login walks again. Recorded at the start, that half-pass would have been
        -- filed as the fresh census somebody explicitly asked for.
        it("records nothing at all while the walk it began is still in flight", function()
            local resync, _, store = newResync({ requests = { { id = 4 } } })

            resync.run()

            assert.same({}, store.done)
        end)

        it("records what became of it once the walk reaches its end", function()
            local resync, walked, store = newResync({ requests = { { id = 4 } } })
            resync.run()

            walked.finish()

            assert.same({ id = 4, at = NOW, outcome = "walked", domains = WALKABLE }, store.done[4])
        end)

        -- A logout is a walk that simply never calls back, which is the whole of how an
        -- interrupted resync is handled: nothing is written, so nothing claims the request was
        -- answered, so the app asks again.
        it("leaves a request unanswered when its walk never ends", function()
            local resync, _, store = newResync({ requests = { { id = 4 } } })

            resync.run()

            assert.is_nil(store.done[4])
        end)

        -- Refused rather than failed: the census will not begin a second pass while one is in
        -- flight. Nothing is recorded and nothing is said, and the next loading screen — or the
        -- next login — takes the request up again.
        it("leaves it unanswered and unrecorded when the census refuses the pass", function()
            local resync, walked, store = newResync({ requests = { { id = 4 } } })
            walked.refusing = true

            local names = resync.run()

            assert.same({}, names)
            assert.is_nil(store.done[4])

            walked.refusing = false
            assert.same(WALKABLE, resync.run())
        end)

        -- Answered rather than left waiting forever. Every name in it is one this build cannot
        -- walk — a domain a newer app knows about, or one whose client calls this build has not
        -- got — and a request kept open would be written into the addon's folder for the rest of
        -- the player's life waiting for an addon that never arrives.
        it("records a request naming nothing this build can walk as unknown, and walks nothing",
            function()
                local resync, walked, store = newResync({
                    requests = { { id = 9, domains = { "housing", "pets" } } },
                })

                local names = resync.run()

                assert.same({}, names)
                assert.same({}, walked.calls)
                assert.same({ id = 9, at = NOW, outcome = "unknown", domains = {} }, store.done[9])
            end)

        it("starts no walk at all for a request already written down as done", function()
            local resync, walked = newResync({
                requests = { { id = 4 } },
                store = { done = { [4] = { id = 4, at = 1, outcome = "walked", domains = {} } } },
            })

            local names = resync.run()

            assert.same({}, names)
            assert.same({}, walked.calls)
        end)
    end)

    -- `run` is called on the far side of every loading screen, and a request is only marked done
    -- once its walk has ended — so something has to stop the same request being taken up again
    -- by the next zone change. The census would refuse the second pass anyway, but it refuses in
    -- silence, and the player would be told a resync had started once per loading screen.
    describe("a walk already in flight", function()
        it("starts nothing and says nothing while one it began is still going", function()
            local resync, walked = newResync({ requests = { { id = 4 } } })
            resync.run()

            local names = resync.run()

            assert.same({}, names)
            assert.equal(1, #walked.calls)
        end)

        it("takes up the next request once that one has ended", function()
            local resync, walked, _, requests = newResync({ requests = { { id = 4 } } })
            resync.run()
            walked.finish()

            requests[#requests + 1] = { id = 5, domains = { "mounts" } }
            local names = resync.run()

            assert.same({ "mounts" }, names)
            assert.equal(2, #walked.calls)
        end)
    end)

    -- Safe for exactly the reason the same forgetting is safe in `ns.newCustomSetWriter`: the
    -- app keeps writing a request into the addon's folder until it has read what became of it,
    -- so one that has disappeared from the file is one the app has already been told about and
    -- will never ask for again.
    describe("forgetting what the app has stopped asking for", function()
        it("drops the record of a request that is no longer in the file", function()
            local resync, _, store = newResync({
                requests = { { id = 5 } },
                store = {
                    done = {
                        [4] = { id = 4, at = 1, outcome = "walked", domains = {} },
                        [5] = { id = 5, at = 2, outcome = "walked", domains = {} },
                    },
                },
            })

            resync.run()

            assert.is_nil(store.done[4])
            assert.equal(2, store.done[5].at)
        end)

        -- The order inside `run` is what makes this hold: the file is swept after the pending
        -- list has been taken and before anything is written back, so an entry made a moment
        -- ago for a request still in the file survives being made.
        it("keeps a record it wrote itself a moment earlier", function()
            local resync, walked, store = newResync({ requests = { { id = 4 } } })
            resync.run()
            walked.finish()

            resync.run()

            assert.equal("walked", store.done[4].outcome)
        end)
    end)

    -- A hand-installed copy carries the shipped-empty module, and a client that has never met
    -- the desktop app has nothing in the folder at all. Neither is an error.
    it("survives a folder with nothing in it to read", function()
        local resync, walked, store = newResync({ noRequests = true })

        local names = resync.run()

        assert.same({}, names)
        assert.same({}, walked.calls)
        assert.is_nil(store.done)
    end)

    describe("ns.censusResyncText", function()
        -- How many rather than which. Five names is a wall of jargon in a chat frame, and the
        -- one thing worth knowing is that something has started and it is not free.
        it("says how many collections are being walked", function()
            local text = ns.censusResyncText({ "mounts", "achievements" })

            assert.is_truthy(text:find("2 collection(s)", 1, true))
            assert.is_nil(text:find("mounts", 1, true))
        end)
    end)
end)
