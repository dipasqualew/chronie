local loader = require("addon_loader")

describe("ns.newCustomSetWriter", function()
    local ns = loader.load()

    local NOW = 1700000000

    ---What an untouched slot has to read as in the list handed to the client: three zeroes,
    ---never an absence. `Constants.Transmog.NoTransmogID` is 0.
    local EMPTY = { appearanceID = 0, secondaryAppearanceID = 0, illusionID = 0 }

    ---Builds a writer over a client the test can read back, which is the only way any of
    ---this is observable: the writer's whole output is calls into the player's wardrobe, so
    ---the calls are what a test asserts on.
    ---
    ---`newIds` is what the fake client answers from `create`, in order; `false` in it models
    ---the client refusing to make a set, which its own API documents by answering nothing.
    ---`noMaxSets` and `noValidName` drop the call entirely, standing in for a client build
    ---that does not define it.
    ---@param options table? `{ requests, sets, store, newIds, maxSets, validName,
    ---  noMaxSets, noValidName, noRequests }`
    ---@return table writer, table calls, table store, table sets
    local function newWriter(options)
        options = options or {}
        local requests = options.requests or {}
        local sets = options.sets or {}
        local store = options.store or {}
        local newIds = options.newIds or {}
        local calls = { created = {}, modified = {} }
        local made = 0

        local client = {
            create = function(name, icon, list)
                made = made + 1
                calls.created[#calls.created + 1] = { name = name, icon = icon, list = list }
                local id = newIds[made]
                if id == nil then
                    -- Numbered from a thousand so a set the fake invented can never be
                    -- mistaken for one the test wrote into `sets` by hand.
                    return 1000 + made
                end
                return id or nil
            end,
            modify = function(setId, list)
                calls.modified[#calls.modified + 1] = { setId = setId, list = list }
            end,
        }
        if not options.noMaxSets then
            client.maxSets = function()
                return options.maxSets
            end
        end
        if not options.noValidName then
            client.validName = options.validName or function()
                return true
            end
        end

        local writer = ns.newCustomSetWriter({
            readRequests = function()
                -- `noRequests` models the shipped-empty module the app has never overwritten,
                -- read through a seam that answers nothing rather than an empty list.
                if options.noRequests then
                    return nil
                end
                return requests
            end,
            readSets = function()
                return sets
            end,
            client = client,
            store = store,
            now = function()
                return NOW
            end,
        })
        return writer, calls, store, sets
    end

    ---One request in the shape `src/CustomSetRequests.lua` carries, so a test says only the
    ---part it is about.
    ---@param fields table
    ---@return table
    local function request(fields)
        return {
            id = fields.id or 1,
            name = fields.name or "Winter Look",
            icon = fields.icon,
            slots = fields.slots or { { slot = 0, appearance = 100 } },
        }
    end

    describe("a name nothing matches", function()
        it("makes a new set, under the name and picture the app asked for", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7, name = "Winter Look", icon = 626185 }) },
            })

            local outcomes = writer.run()

            assert.equal(1, #calls.created)
            assert.equal("Winter Look", calls.created[1].name)
            assert.equal(626185, calls.created[1].icon)
            assert.same({ id = 7, at = NOW, outcome = "created", setId = 1001, name = "Winter Look" }, outcomes[1])
        end)

        -- The single most important assertion in this file. Blizzard's own code walks the
        -- list with `ipairs`, so a hole anywhere in it truncates the set at the slot before
        -- — and the player is left with a set that is silently missing everything below the
        -- first gap, with nothing anywhere saying so.
        it("hands the client thirteen slots, with the empty ones spelled out", function()
            local writer, calls = newWriter({
                requests = { request({ slots = { { slot = 5, appearance = 100 } } }) },
            })

            writer.run()

            local list = calls.created[1].list
            local walked = 0
            for _ in ipairs(list) do
                walked = walked + 1
            end
            assert.equal(13, walked)
            assert.equal(13, #list)
            assert.is_nil(list[14])
            for index = 1, 13 do
                if index ~= 6 then
                    assert.same(EMPTY, list[index])
                end
            end
        end)

        -- The two shapes count from different places, and getting it wrong by one is a set
        -- whose every piece is worn on the wrong body part: the app names the game's own
        -- `TransmogSlot`, which starts at 0 for the head, and Lua's list starts at 1.
        it("puts the app's slot number at that index plus one", function()
            local writer, calls = newWriter({
                requests = {
                    request({
                        slots = {
                            { slot = 0, appearance = 100 },
                            { slot = 12, appearance = 900 },
                        },
                    }),
                },
            })

            writer.run()

            local list = calls.created[1].list
            assert.equal(100, list[1].appearanceID)
            assert.equal(900, list[13].appearanceID)
        end)

        it("carries the second appearance and the illusion a slot was given", function()
            local writer, calls = newWriter({
                requests = {
                    request({ slots = { { slot = 3, appearance = 200, secondary = 201, illusion = 42 } } }),
                },
            })

            writer.run()

            assert.same(
                { appearanceID = 200, secondaryAppearanceID = 201, illusionID = 42 },
                calls.created[1].list[4]
            )
        end)

        -- A slot wearing one appearance and no illusion is not a slot that declines to say:
        -- the client wants a number there, and zero is the number for nothing.
        it("says zero for a second appearance and an illusion the app left out", function()
            local writer, calls = newWriter({
                requests = { request({ slots = { { slot = 3, appearance = 200 } } }) },
            })

            writer.run()

            assert.same(
                { appearanceID = 200, secondaryAppearanceID = 0, illusionID = 0 },
                calls.created[1].list[4]
            )
        end)
    end)

    describe("a name a set already has", function()
        -- Quietly making a second set beside the first would leave the player with two sets
        -- they cannot tell apart and one of them out of date, which is worse than either
        -- outcome they could have asked for.
        it("saves over that set rather than making another", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7, name = "Winter Look" }) },
                sets = { { id = 3, name = "Winter Look" } },
            })

            local outcomes = writer.run()

            assert.same({}, calls.created)
            assert.equal(1, #calls.modified)
            assert.equal(3, calls.modified[1].setId)
            assert.same({ id = 7, at = NOW, outcome = "updated", setId = 3, name = "Winter Look" }, outcomes[1])
        end)

        it("matches the name without regard to case", function()
            local writer, calls = newWriter({
                requests = { request({ name = "winter look" }) },
                sets = { { id = 3, name = "Winter Look" } },
            })

            writer.run()

            assert.same({}, calls.created)
            assert.equal(3, calls.modified[1].setId)
        end)

        it("hands the replacement the same dense thirteen slots a new set gets", function()
            local writer, calls = newWriter({
                requests = { request({ slots = { { slot = 5, appearance = 100 } } }) },
                sets = { { id = 3, name = "Winter Look" } },
            })

            writer.run()

            local list = calls.modified[1].list
            assert.equal(13, #list)
            assert.equal(100, list[6].appearanceID)
            assert.same(EMPTY, list[1])
        end)

        -- The client fires its own event for the change, but not before the loop over the
        -- batch has finished. A second request naming the set the first just made would
        -- otherwise be deciding create-or-replace against a wardrobe one set out of date.
        it("counts a set made a moment ago in the same batch", function()
            local writer, calls = newWriter({
                requests = {
                    request({ id = 7, name = "Winter Look", slots = { { slot = 0, appearance = 100 } } }),
                    request({ id = 8, name = "Winter Look", slots = { { slot = 0, appearance = 200 } } }),
                },
            })

            local outcomes = writer.run()

            assert.equal(1, #calls.created)
            assert.equal(1, #calls.modified)
            assert.equal(1001, calls.modified[1].setId)
            assert.equal(200, calls.modified[1].list[1].appearanceID)
            assert.equal("created", outcomes[1].outcome)
            assert.equal("updated", outcomes[2].outcome)
        end)
    end)

    describe("a request that has already been carried out", function()
        -- What makes this safe to run at every load screen. The app keeps writing the same
        -- file until it has been told the request landed, so the file being there again is
        -- the ordinary case rather than a new instruction.
        it("is skipped entirely, without touching the client a second time", function()
            local writer, calls = newWriter({ requests = { request({ id = 7 }) } })

            writer.run()
            local second = writer.run()

            assert.equal(1, #calls.created)
            assert.same({}, calls.modified)
            assert.same({}, second)
        end)

        -- A player who deletes the resulting set in game keeps it deleted. Chronie asked
        -- once and was answered; asking again on the next zoning would be the app overruling
        -- them in their own wardrobe.
        it("stays skipped after the player deleted the set it made", function()
            local writer, calls, _, sets = newWriter({ requests = { request({ id = 7 }) } })

            writer.run()
            for index = #sets, 1, -1 do
                sets[index] = nil
            end
            writer.run()

            assert.equal(1, #calls.created)
        end)

        it("is recognised from a record a previous session left behind", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7 }) },
                store = { done = { [7] = { id = 7, at = 1, outcome = "created", setId = 3 } } },
            })

            assert.same({}, writer.run())
            assert.same({}, calls.created)
        end)

        it("does not shield the requests beside it", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7 }), request({ id = 8, name = "Summer Look" }) },
                store = { done = { [7] = { id = 7, at = 1, outcome = "created", setId = 3 } } },
            })

            local outcomes = writer.run()

            assert.equal(1, #outcomes)
            assert.equal(8, outcomes[1].id)
            assert.equal("Summer Look", calls.created[1].name)
        end)
    end)

    describe("what it writes down about a request", function()
        it("keys the record by the request's own id", function()
            local writer, _, store = newWriter({
                requests = { request({ id = 7, name = "Winter Look" }) },
            })

            writer.run()

            assert.same(
                { id = 7, at = NOW, outcome = "created", setId = 1001, name = "Winter Look" },
                store.done[7]
            )
        end)

        -- The app clears a request once it has been told about it, so the record has to read
        -- on its own: a row saying only "created" would leave nothing anywhere naming what.
        it("keeps the name, so the record reads without the request beside it", function()
            local writer, _, store = newWriter({ requests = { request({ id = 7, name = "Winter Look" }) } })

            writer.run()

            assert.equal("Winter Look", store.done[7].name)
        end)

        it("adds to the record rather than replacing it, when a later run carries one more", function()
            local first, _, store = newWriter({ requests = { request({ id = 7 }) } })
            first.run()

            local second = newWriter({
                requests = { request({ id = 7 }), request({ id = 8, name = "Summer Look" }) },
                store = store,
            })
            second.run()

            assert.equal(7, store.done[7].id)
            assert.equal(8, store.done[8].id)
        end)

        it("stamps the moment it was handed, rather than reading the clock", function()
            local writer, _, store = newWriter({ requests = { request({ id = 7 }) } })

            writer.run(1700009999)

            assert.equal(1700009999, store.done[7].at)
        end)
    end)

    describe("a record of a request the app has stopped asking for", function()
        -- The one thing that keeps SavedVariables from growing by a row for every outfit a
        -- player ever sends. Safe only because the app keeps writing a request into the file
        -- until it has read what became of it, so a request that has gone from the file is one
        -- the app already knows about and will never ask for again.
        it("is forgotten, because the app has already been told what became of it", function()
            local writer, _, store = newWriter({
                requests = { request({ id = 2 }) },
                store = { done = { [1] = { id = 1, at = 1, outcome = "created", name = "Old" } } },
            })

            writer.run()

            assert.is_nil(store.done[1])
            assert.equal("created", store.done[2].outcome)
        end)

        -- The forgetting runs after the applying, not before it: an entry written a moment ago
        -- for a request still in the file has to survive to be reported at the next logout,
        -- and a prune that ran first would drop the answer before anybody read it.
        it("keeps the answer to a request that is still being asked", function()
            local writer, _, store = newWriter({ requests = { request({ id = 3 }) } })

            writer.run()
            writer.run()

            assert.equal("created", store.done[3].outcome)
        end)

        -- A file the app has emptied — every request answered — leaves nothing behind at all,
        -- which is the state a player who sent one outfit a year ago should end up in.
        it("leaves nothing behind once the app is asking for nothing", function()
            local writer, _, store = newWriter({
                requests = {},
                store = { done = { [1] = { id = 1, at = 1, outcome = "created", name = "Old" } } },
            })

            writer.run()

            assert.same({}, store.done)
        end)
    end)

    describe("a wardrobe with no room left", function()
        -- The cap is the account's, and a set that would not fit is the one case where
        -- there is something the player can actually do about it — so it is reported rather
        -- than attempted and lost.
        it("reports the wardrobe full and creates nothing", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7, name = "Winter Look" }) },
                sets = { { id = 3, name = "Raid" }, { id = 5, name = "Town" } },
                maxSets = 2,
            })

            local outcomes = writer.run()

            assert.same({}, calls.created)
            assert.same({ id = 7, at = NOW, outcome = "full", name = "Winter Look" }, outcomes[1])
        end)

        -- A full wardrobe is no obstacle to saving over a set that is already in it, and
        -- refusing there would be refusing the one thing that needs no room at all.
        it("still saves over a set that is already there", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7, name = "Raid" }) },
                sets = { { id = 3, name = "Raid" }, { id = 5, name = "Town" } },
                maxSets = 2,
            })

            assert.equal("updated", writer.run()[1].outcome)
            assert.equal(1, #calls.modified)
        end)

        -- Refusing on a guess would stop a player saving a set they had room for. The client
        -- refuses the call itself if the guess would have been right, and that comes back as
        -- a failure rather than as a set nobody asked for.
        it("is not guessed at when the client answers nothing", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7 }) },
                sets = { { id = 3, name = "Raid" }, { id = 5, name = "Town" } },
            })

            assert.equal("created", writer.run()[1].outcome)
            assert.equal(1, #calls.created)
        end)

        it("is not guessed at on a client build that has no such call", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7 }) },
                sets = { { id = 3, name = "Raid" } },
                noMaxSets = true,
            })

            assert.equal("created", writer.run()[1].outcome)
            assert.equal(1, #calls.created)
        end)
    end)

    describe("a name the game will not take", function()
        -- Asked before anything is written, so a bad name comes back as a refusal the app can
        -- show rather than as a call that quietly does nothing and a set the player then goes
        -- looking for.
        it("is refused on the server's own opinion, before any set is made", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7, name = "Sw0rn Kn1ght" }) },
                validName = function()
                    return false
                end,
            })

            local outcomes = writer.run()

            assert.same({}, calls.created)
            assert.same({ id = 7, at = NOW, outcome = "refused", name = "Sw0rn Kn1ght" }, outcomes[1])
        end)

        it("refuses an empty name without asking anybody", function()
            local writer, calls = newWriter({ requests = { request({ id = 7, name = "" }) } })

            local outcomes = writer.run()

            assert.same({}, calls.created)
            assert.equal("refused", outcomes[1].outcome)
        end)

        -- Only a flat `false` is an opinion. A client build with no such call answers nil,
        -- and treating that as a refusal would stop every set on it from ever being saved.
        it("is not read into a client build that has no opinion to give", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7 }) },
                validName = function()
                    return nil
                end,
            })

            assert.equal("created", writer.run()[1].outcome)
            assert.equal(1, #calls.created)
        end)

        it("is not read into a client build that has no such call", function()
            local writer, calls = newWriter({ requests = { request({ id = 7 }) }, noValidName = true })

            assert.equal("created", writer.run()[1].outcome)
            assert.equal(1, #calls.created)
        end)
    end)

    describe("a client that would not make the set", function()
        it("says only that it did not happen, because there is nothing else to say", function()
            local writer = newWriter({
                requests = { request({ id = 7, name = "Winter Look" }) },
                newIds = { false },
            })

            local outcomes = writer.run()

            assert.same({ id = 7, at = NOW, outcome = "failed", name = "Winter Look" }, outcomes[1])
        end)

        -- Marked done all the same, or the request would be retried on every load screen for
        -- the rest of the player's life, failing identically each time.
        it("marks the request done rather than retrying it forever", function()
            local writer, calls, store = newWriter({
                requests = { request({ id = 7 }) },
                newIds = { false },
            })

            writer.run()
            writer.run()

            assert.equal("failed", store.done[7].outcome)
            assert.equal(1, #calls.created)
        end)

        -- Nothing was made, so nothing can be saved over. A second request of the same name
        -- has to try again rather than modify a set the client never handed back an id for.
        it("leaves nothing behind for a later request of the same name to save over", function()
            local writer, calls = newWriter({
                requests = { request({ id = 7 }), request({ id = 8 }) },
                newIds = { false },
            })

            writer.run()

            assert.equal(2, #calls.created)
            assert.same({}, calls.modified)
        end)
    end)

    describe("what the app leaves that is not a request", function()
        it("skips a request with no numeric id, since nothing could key the record on it", function()
            local writer, calls = newWriter({
                requests = { { name = "Winter Look", slots = {} }, request({ id = 7, name = "Summer Look" }) },
            })

            local outcomes = writer.run()

            assert.equal(1, #outcomes)
            assert.equal("Summer Look", calls.created[1].name)
        end)

        it("skips an entry that is not a table at all", function()
            local writer, calls = newWriter({ requests = { "Winter Look", 7, request({ id = 9 }) } })

            assert.equal(1, #writer.run())
            assert.equal(1, #calls.created)
        end)

        it("does nothing at all when the app left no list", function()
            local writer, calls = newWriter({ noRequests = true })

            assert.same({}, writer.run())
            assert.same({}, calls.created)
        end)

        -- The app names the game's own `TransmogSlot`, and a number outside 0..12 names no
        -- slot the client has. Dropping it leaves that slot empty, which is a set the player
        -- can see and fix; passing it on would be a fourteenth entry in a list of thirteen.
        it("drops a slot numbered outside the thirteen the game has", function()
            local writer, calls = newWriter({
                requests = {
                    request({
                        slots = {
                            { slot = -1, appearance = 100 },
                            { slot = 13, appearance = 200 },
                            { slot = 4, appearance = 300 },
                        },
                    }),
                },
            })

            writer.run()

            local list = calls.created[1].list
            assert.equal(13, #list)
            assert.equal(300, list[5].appearanceID)
        end)

        it("drops a slot with no appearance in it, leaving that slot empty", function()
            local writer, calls = newWriter({
                requests = { request({ slots = { { slot = 4 }, "head", { slot = 6, appearance = 300 } } }) },
            })

            writer.run()

            local list = calls.created[1].list
            assert.same(EMPTY, list[5])
            assert.equal(300, list[7].appearanceID)
        end)

        it("makes an empty set out of a request that says nothing about slots", function()
            local writer, calls = newWriter({ requests = { { id = 7, name = "Winter Look" } } })

            assert.equal("created", writer.run()[1].outcome)
            for index = 1, 13 do
                assert.same(EMPTY, calls.created[1].list[index])
            end
        end)
    end)
end)

describe("ns.customSetOutcomeText", function()
    local ns = loader.load()

    -- Every line names the set, because a line about "a set" is a line that sends somebody
    -- to open their wardrobe and count.
    it("names the set it saved", function()
        assert.equal(
            "Saved Winter Look to your transmog sets.",
            ns.customSetOutcomeText({ outcome = "created", name = "Winter Look" })
        )
    end)

    it("says a set of that name was saved over, rather than added", function()
        assert.equal(
            "Saved Winter Look over the transmog set of that name.",
            ns.customSetOutcomeText({ outcome = "updated", name = "Winter Look" })
        )
    end)

    -- The one failure the player can act on, so it says what to do rather than what went
    -- wrong, and says the attempt will be made again.
    it("tells the player how to make room, when there is none", function()
        local text = ns.customSetOutcomeText({ outcome = "full", name = "Winter Look" })

        assert.is_truthy(text:find("Winter Look", 1, true))
        assert.is_truthy(text:find("your transmog sets are full", 1, true))
        assert.is_truthy(text:find("Delete one in game", 1, true))
    end)

    it("blames the name when the game would not take it", function()
        assert.equal(
            "Could not save Winter Look: the game would not accept that name.",
            ns.customSetOutcomeText({ outcome = "refused", name = "Winter Look" })
        )
    end)

    -- A player cannot act on "NewCustomSet returned nil", so the line does not pretend to
    -- explain: it says the thing that is true and stops there.
    it("says only that it did not happen when the client would not say why", function()
        assert.equal(
            "Could not save Winter Look to your transmog sets.",
            ns.customSetOutcomeText({ outcome = "failed", name = "Winter Look" })
        )
    end)

    -- A refusal is the outcome most likely to arrive with nothing usable to call the set,
    -- and a line reading "Could not save :" is worse than one that says nothing specific.
    it("falls back to calling it an outfit when the outcome carries no name", function()
        assert.equal(
            "Saved that outfit to your transmog sets.",
            ns.customSetOutcomeText({ outcome = "created" })
        )
        assert.equal(
            "Could not save that outfit: the game would not accept that name.",
            ns.customSetOutcomeText({ outcome = "refused", name = "" })
        )
    end)

    it("falls back to the plainest line for an outcome it does not know", function()
        assert.equal(
            "Could not save Winter Look to your transmog sets.",
            ns.customSetOutcomeText({ outcome = "something new", name = "Winter Look" })
        )
    end)
end)
