local loader = require("addon_loader")

describe("ns.newTransmogPreview", function()
    local ns = loader.load()

    local ITEM = 19019
    local LINK = "item:" .. ITEM
    local OTHER = 12640
    local OTHER_LINK = "item:" .. OTHER

    ---A dressing room that writes down everything done to it, in the order it was done.
    ---
    ---The order is the whole of the behaviour here, so the fake records a list rather than a
    ---set of flags: stripping the model after the item has been fitted takes the item straight
    ---back off, and a fake that only remembered *that* both happened would call that a pass.
    ---How many times the actor was asked for is counted apart from the list, because asking is
    ---not something done to the dressing room and would sit in the middle of the ordering the
    ---tests are here to pin down.
    ---@param options table? `{ dressable = boolean?, actor = boolean? }` — false for the client
    ---that refuses the link, and false for the one that opens a room with nobody in it.
    ---@return TransmogPreview preview, table room `{ calls = table[], actorRequests = integer }`
    local function newPreview(options)
        options = options or {}
        local room = { calls = {}, actorRequests = 0 }
        -- Colon methods, because the client's actor is an object rather than a table of
        -- closures: a module calling `actor.Undress()` would hand it no self and raise inside
        -- the client, which is exactly the mistake worth catching here.
        local actor = {
            Undress = function(_)
                room.calls[#room.calls + 1] = { call = "undress" }
            end,
            TryOn = function(_, link)
                room.calls[#room.calls + 1] = { call = "tryOn", link = link }
            end,
        }
        local preview = ns.newTransmogPreview({
            dressUp = function(link)
                room.calls[#room.calls + 1] = { call = "dressUp", link = link }
                return options.dressable ~= false
            end,
            playerActor = function()
                room.actorRequests = room.actorRequests + 1
                if options.actor == false then
                    return nil
                end
                return actor
            end,
        })
        return preview, room
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newTransmogPreview)
    end)

    describe("showing one collected appearance", function()
        -- Issue #207, and the reason the module exists at all. `DressUpItemLink` on its own
        -- lays the item over whatever the character is wearing, so a robe hides the legs and
        -- the feet the run just collected and the click shows the old look rather than the new
        -- one. Undressing first is what makes the picture answer "what does this look like".
        -- The assertion is on the whole list in order: reverse the two calls in the module and
        -- the model ends up naked, and only an ordered assertion says so.
        it("strips the model first and only then fits the item that was clicked", function()
            local preview, room = newPreview()

            preview.show(ITEM)

            assert.same({
                { call = "dressUp", link = LINK },
                { call = "undress" },
                { call = "tryOn", link = LINK },
            }, room.calls)
        end)

        -- Two fittings of the same link, and the same link both times. The first is the only
        -- way to get a dressing room open and its actor built; the second is what survives the
        -- undressing between them. A second link would fit something the player never clicked.
        it("tries on the same link it dressed up", function()
            local preview, room = newPreview()

            preview.show(ITEM)

            assert.equal(room.calls[1].link, room.calls[3].link)
        end)

        -- The dressing room stays open between clicks, so the model the second click lands on
        -- is already wearing the first click's item. Undressing on every showing is what stops
        -- an evening's collected appearances piling up on one body, a shoulder at a time.
        it("leaves the model wearing only the latest item after a second click", function()
            local preview, room = newPreview()

            preview.show(ITEM)
            preview.show(OTHER)

            assert.same({
                { call = "dressUp", link = LINK },
                { call = "undress" },
                { call = "tryOn", link = LINK },
                { call = "dressUp", link = OTHER_LINK },
                { call = "undress" },
                { call = "tryOn", link = OTHER_LINK },
            }, room.calls)
        end)
    end)

    describe("showing the whole set the appearance belongs to", function()
        -- Source ids rather than links, and there is no way round it: a set's pieces are
        -- item-modified-appearance ids, so there is no item id to look up and no link to
        -- build. `TryOn` takes `itemLinkOrItemModifiedAppearanceID` on 12.0.5.67823, which
        -- is what makes handing it the raw ids correct rather than a shortcut.
        local SOURCES = { 4242, 4243, 4244 }

        -- The room is opened with the piece that was clicked and not with the set, because
        -- `DressUpItemLink` is the only entry point that picks which of the several dress-up
        -- frames the player is standing in front of and builds an actor inside it — and it
        -- takes a link. So the item opens the room and the set is fitted over the stripped
        -- model afterwards. The whole ordered list is asserted for the same reason the single
        -- appearance's is: strip after fitting and the player is looking at a naked character,
        -- and a test that only checked both had happened would call that a pass.
        it("opens the room with the item clicked and fits the set over a stripped model", function()
            local preview, room = newPreview()

            preview.showSet(ITEM, SOURCES)

            assert.same({
                { call = "dressUp", link = LINK },
                { call = "undress" },
                { call = "tryOn", link = 4242 },
                { call = "tryOn", link = 4243 },
                { call = "tryOn", link = 4244 },
            }, room.calls)
        end)

        -- The order the client listed the pieces in is the order they go on. Two pieces of a
        -- set can share a slot — a set with both a one-hander and its off-hand partner — and
        -- fitting them in any other order puts the wrong one on the body.
        it("fits the pieces in the order the client listed them", function()
            local preview, room = newPreview()

            preview.showSet(ITEM, { 9, 8, 7 })

            local worn = {}
            for _, call in ipairs(room.calls) do
                if call.call == "tryOn" then
                    worn[#worn + 1] = call.link
                end
            end
            assert.same({ 9, 8, 7 }, worn)
        end)

        -- The piece that was clicked is a piece of the set, so the loop puts it back on along
        -- with the rest: nothing is left on the model that the set does not contain, and the
        -- link used to open the room is never worn as a link of its own.
        it("leaves nothing on the model that the set does not contain", function()
            local preview, room = newPreview()

            preview.showSet(ITEM, SOURCES)

            for _, call in ipairs(room.calls) do
                if call.call == "tryOn" then
                    assert.is_number(call.link)
                end
            end
        end)

        -- The dressing room stays open between clicks, so the second set lands on a body
        -- already wearing the first. Undressing on every showing is what stops eight pieces
        -- of Bloodfang hanging off a model meant to be showing eight of Nightslayer.
        it("strips the previous set off before fitting the next one", function()
            local preview, room = newPreview()

            preview.showSet(ITEM, { 1 })
            preview.showSet(OTHER, { 2 })

            assert.same({
                { call = "dressUp", link = LINK },
                { call = "undress" },
                { call = "tryOn", link = 1 },
                { call = "dressUp", link = OTHER_LINK },
                { call = "undress" },
                { call = "tryOn", link = 2 },
            }, room.calls)
        end)

        -- Same shape as the single appearance's refusals, and the same reason: undressing is
        -- the half that always succeeds, so a module that stripped the model and only then
        -- found it had nothing to fit would leave the player looking at a naked character.
        -- The three that never reach the client at all matter most — a shifted click on a row
        -- whose set the client would not enumerate must not open a dressing room over nothing.
        for _, case in ipairs({
            {
                what = "there is no item id to open the room with",
                options = {},
                itemID = nil,
                sources = SOURCES,
                dressedUp = false,
                actorRequests = 0,
            },
            {
                what = "the set came back with no sources at all",
                options = {},
                itemID = ITEM,
                sources = nil,
                dressedUp = false,
                actorRequests = 0,
            },
            {
                what = "the set the client named turned out to be empty",
                options = {},
                itemID = ITEM,
                sources = {},
                dressedUp = false,
                actorRequests = 0,
            },
            {
                what = "the client will not put the clicked item on a body",
                options = { dressable = false },
                itemID = ITEM,
                sources = SOURCES,
                dressedUp = true,
                actorRequests = 0,
            },
            {
                what = "the dressing room came back with no player actor in it",
                options = { actor = false },
                itemID = ITEM,
                sources = SOURCES,
                dressedUp = true,
                actorRequests = 1,
            },
        }) do
            it("does nothing to the model when " .. case.what, function()
                local preview, room = newPreview(case.options)

                assert.has_no.errors(function()
                    preview.showSet(case.itemID, case.sources)
                end)

                local expected = {}
                if case.dressedUp then
                    expected[1] = { call = "dressUp", link = LINK }
                end
                assert.same(expected, room.calls)
                assert.equal(case.actorRequests, room.actorRequests)
            end)
        end
    end)

    describe("a click there is nothing to show for", function()
        -- Every one of these ends with a model nothing was taken off and nothing was put on.
        -- That matters more than it sounds: undressing is the half that always succeeds, so a
        -- module that stripped first and only then discovered it had nothing to fit would
        -- leave the player looking at a naked character — a worse answer than doing nothing.
        -- What differs between the three is only how far the module got before it stopped.
        for _, case in ipairs({
            -- False from the client is it saying this is not something it will put on a body,
            -- and it has already told the player so. No room was opened, so there is no actor
            -- to go looking for and asking for one would be reading a frame that never showed.
            {
                what = "the client will not put the item on a body at all",
                options = { dressable = false },
                itemID = ITEM,
                dressedUp = true,
                actorRequests = 0,
            },
            -- A room the client opened without building a player actor in it. Nothing to
            -- assert beyond survival: reaching for `Undress` on a nil actor raises, and a Lua
            -- error out of a mouse click is the failure a player actually sees.
            {
                what = "the dressing room came back with no player actor in it",
                options = { actor = false },
                itemID = ITEM,
                dressedUp = true,
                actorRequests = 1,
            },
            -- A row drawn for a transmog the tally never got an item id for. Building
            -- "item:nil" and handing it to the client is a dressing room opened over nothing.
            {
                what = "there is no item id to show",
                options = {},
                itemID = nil,
                dressedUp = false,
                actorRequests = 0,
            },
        }) do
            it("does nothing to the model when " .. case.what, function()
                local preview, room = newPreview(case.options)

                assert.has_no.errors(function()
                    preview.show(case.itemID)
                end)

                local expected = {}
                if case.dressedUp then
                    expected[1] = { call = "dressUp", link = LINK }
                end
                assert.same(expected, room.calls)
                assert.equal(case.actorRequests, room.actorRequests)
            end)
        end
    end)
end)
