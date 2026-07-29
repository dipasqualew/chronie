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
