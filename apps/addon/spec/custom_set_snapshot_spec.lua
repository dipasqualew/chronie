local loader = require("addon_loader")

describe("ns.newCustomSetSnapshot", function()
    local ns = loader.load()

    local NOW = 1700000000

    ---Builds a snapshot over a set list the test can edit between two syncs, which is the
    ---only way any of this is observable: the client says "the sets changed" and nothing
    ---more, so a change is whatever two consecutive looks disagree about.
    ---@param options table? `{ sets = table?, store = table? }`
    ---@return table snapshot, table sets, table store
    local function newSnapshot(options)
        options = options or {}
        local sets = options.sets or {}
        local store = options.store or {}
        local snapshot = ns.newCustomSetSnapshot({
            readSets = function()
                return sets
            end,
            store = store,
            now = function()
                return NOW
            end,
        })
        return snapshot, sets, store
    end

    ---One set in the shape Main.lua reduces the client's three calls to, so a test says
    ---only the part it is about.
    ---@param fields table
    ---@return table
    local function set(fields)
        return {
            id = fields.id,
            name = fields.name or "Look",
            icon = fields.icon,
            slots = fields.slots or {},
        }
    end

    describe("the first look", function()
        -- Unlike EquipsetLedger, which seeds silently because its whole output is a diff,
        -- this one has nothing to be quiet about: the file is the wardrobe as it stands, and
        -- a player who has never changed a set since installing Chronie still has one.
        it("files what it saw, rather than seeding and saying nothing", function()
            local snapshot, _, store = newSnapshot({
                sets = { set({ id = 3, name = "Raid", slots = { { slot = 0, appearance = 100 } } }) },
            })

            snapshot.sync()

            assert.same({
                { id = 3, name = "Raid", slots = { { slot = 0, appearance = 100 } } },
            }, store.sets)
            assert.equal(NOW, store.at)
        end)

        -- An empty wardrobe and a wardrobe nobody has looked at are different states, and
        -- only the second is a reason for the file to say nothing. Writing the empty list
        -- is what tells the app this character genuinely has no sets.
        it("files an empty wardrobe as an empty wardrobe", function()
            local snapshot, _, store = newSnapshot()

            assert.same({}, snapshot.sync())
            assert.same({}, store.sets)
            assert.equal(NOW, store.at)
        end)

        it("stamps the moment it was handed, rather than reading the clock", function()
            local snapshot, _, store = newSnapshot({ sets = { set({ id = 3 }) } })

            snapshot.sync(1700009999)

            assert.equal(1700009999, store.at)
        end)
    end)

    describe("what it writes down", function()
        it("carries the name and the picture the player gave the set", function()
            local snapshot = newSnapshot({
                sets = { set({ id = 3, name = "Mythic Raid", icon = 626185 }) },
            })

            local sets = snapshot.sync()

            assert.equal("Mythic Raid", sets[1].name)
            assert.equal(626185, sets[1].icon)
        end)

        -- The client hands back whatever `GetCustomSetInfo` felt like, and a set that will
        -- not name itself is still a set the player can see, so it is kept under a blank
        -- name rather than dropped or written down as nil.
        it("gives a set the client would not name an empty name", function()
            local snapshot = newSnapshot({ sets = { { id = 3, slots = {} } } })

            assert.equal("", snapshot.sync()[1].name)
        end)

        it("leaves the picture out entirely when the client offered none", function()
            local snapshot = newSnapshot({ sets = { set({ id = 3 }) } })

            assert.same({ id = 3, name = "Look", slots = {} }, snapshot.sync()[1])
        end)

        -- `GetCustomSets` is a list the client orders for itself, and a file whose rows
        -- reshuffle between two readings of an unchanged wardrobe is a file the comparison
        -- below could never call unchanged.
        it("orders the sets by id, whatever order the client listed them in", function()
            local snapshot = newSnapshot({
                sets = { set({ id = 9 }), set({ id = 3 }), set({ id = 5 }) },
            })

            local ids = {}
            for index, one in ipairs(snapshot.sync()) do
                ids[index] = one.id
            end
            assert.same({ 3, 5, 9 }, ids)
        end)

        it("orders a set's slots ascending, for the same reason", function()
            local snapshot = newSnapshot({
                sets = {
                    set({
                        id = 3,
                        slots = {
                            { slot = 11, appearance = 300 },
                            { slot = 0, appearance = 100 },
                            { slot = 3, appearance = 200 },
                        },
                    }),
                },
            })

            local slots = {}
            for index, worn in ipairs(snapshot.sync()[1].slots) do
                slots[index] = worn.slot
            end
            assert.same({ 0, 3, 11 }, slots)
        end)

        it("keeps the second appearance and the illusion a slot carries", function()
            local snapshot = newSnapshot({
                sets = {
                    set({
                        id = 3,
                        slots = { { slot = 11, appearance = 300, secondary = 301, illusion = 42 } },
                    }),
                },
            })

            assert.same(
                { { slot = 11, appearance = 300, secondary = 301, illusion = 42 } },
                snapshot.sync()[1].slots
            )
        end)
    end)

    describe("a slot the player left empty", function()
        -- The client reports `Constants.Transmog.NoTransmogID` — which is 0 — for a slot
        -- holding no appearance, and 0 is not an appearance anything downstream could look
        -- up. The absence is the record.
        it("is dropped rather than written down as appearance zero", function()
            local snapshot = newSnapshot({
                sets = {
                    set({
                        id = 3,
                        slots = {
                            { slot = 0, appearance = 100 },
                            { slot = 3, appearance = 0 },
                        },
                    }),
                },
            })

            assert.same({ { slot = 0, appearance = 100 } }, snapshot.sync()[1].slots)
        end)

        -- Zero says "no illusion here" as much as it says "no appearance here", so a slot
        -- carrying one real appearance and two zeroes is one appearance and two absences,
        -- not a slot wearing appearance zero twice over.
        it("carries no second appearance or illusion when the client reported zero for them", function()
            local snapshot = newSnapshot({
                sets = {
                    set({
                        id = 3,
                        slots = { { slot = 11, appearance = 300, secondary = 0, illusion = 0 } },
                    }),
                },
            })

            assert.same({ { slot = 11, appearance = 300 } }, snapshot.sync()[1].slots)
        end)
    end)

    describe("a set with nothing usable in it", function()
        -- The player named it and the game is holding it. A snapshot that dropped it would
        -- show them a list their own wardrobe disagrees with, which is worse than showing
        -- them an empty set they can see is empty.
        it("is still kept, because the player can see it in game", function()
            local snapshot = newSnapshot({
                sets = { set({ id = 3, name = "Empty", slots = { { slot = 0, appearance = 0 } } }) },
            })

            assert.same({ { id = 3, name = "Empty", slots = {} } }, snapshot.sync())
        end)

        it("is kept when the client would not say what is in it at all", function()
            local snapshot = newSnapshot({ sets = { { id = 3, name = "Empty" } } })

            assert.same({ { id = 3, name = "Empty", slots = {} } }, snapshot.sync())
        end)
    end)

    describe("what the client hands back that is not a set", function()
        -- The id is what the app matches a set on across readings, so a set that has none
        -- is a row nothing downstream could ever place. There is no repairing it here.
        it("rejects a set with no numeric id", function()
            local snapshot = newSnapshot({
                sets = { { name = "Nameless", slots = {} }, set({ id = 3 }) },
            })

            local sets = snapshot.sync()
            assert.equal(1, #sets)
            assert.equal(3, sets[1].id)
        end)

        it("rejects a set that is not a table", function()
            local snapshot = newSnapshot({ sets = { "Raid", 7, set({ id = 3 }) } })

            local sets = snapshot.sync()
            assert.equal(1, #sets)
            assert.equal(3, sets[1].id)
        end)

        it("rejects a slot that is not a table, and keeps the set around it", function()
            local snapshot = newSnapshot({
                sets = { set({ id = 3, slots = { "head", { slot = 3, appearance = 200 } } }) },
            })

            assert.same({ { slot = 3, appearance = 200 } }, snapshot.sync()[1].slots)
        end)

        it("rejects a slot the client would not number", function()
            local snapshot = newSnapshot({
                sets = { set({ id = 3, slots = { { appearance = 100 }, { slot = 3, appearance = 200 } } }) },
            })

            assert.same({ { slot = 3, appearance = 200 } }, snapshot.sync()[1].slots)
        end)
    end)

    describe("the moment it files against", function()
        ---A snapshot that has already filed its first look, which is the state every test
        ---below is actually about.
        ---@param options table?
        ---@return table snapshot, table sets, table store
        local function filed(options)
            local snapshot, sets, store = newSnapshot(options)
            snapshot.sync(1)
            return snapshot, sets, store
        end

        -- The whole reason the module compares rather than trusting the event. The client
        -- fires TRANSMOG_CUSTOM_SETS_CHANGED for things that leave the wardrobe exactly as
        -- it was — reselecting a set in the dropdown is one — and an `at` that crept forward
        -- on those would tell the app somebody had been rearranging their wardrobe on an
        -- evening they only looked at it.
        it("does not move when a second look says exactly the same thing", function()
            local snapshot, _, store = filed({
                sets = {
                    set({
                        id = 3,
                        name = "Raid",
                        icon = 626185,
                        slots = {
                            { slot = 0, appearance = 100 },
                            { slot = 11, appearance = 300, secondary = 301, illusion = 42 },
                        },
                    }),
                    set({ id = 5, name = "Town" }),
                },
            })

            snapshot.sync(NOW)

            assert.equal(1, store.at)
        end)

        it("does not move for an empty wardrobe that is still empty", function()
            local snapshot, _, store = filed()

            snapshot.sync(NOW)

            assert.equal(1, store.at)
        end)

        it("moves when a slot's appearance was swapped for another", function()
            local snapshot, sets, store = filed({
                sets = { set({ id = 3, slots = { { slot = 0, appearance = 100 } } }) },
            })

            sets[1].slots[1].appearance = 101
            snapshot.sync(NOW)

            assert.equal(NOW, store.at)
        end)

        -- A set stripped back to nothing is not the same set: the appearance is gone from
        -- the player's wardrobe and the app has to stop drawing it.
        it("moves when a set lost its last slot", function()
            local snapshot, sets, store = filed({
                sets = { set({ id = 3, slots = { { slot = 0, appearance = 100 } } }) },
            })

            sets[1].slots[1].appearance = 0
            snapshot.sync(NOW)

            assert.equal(NOW, store.at)
            assert.same({}, store.sets[1].slots)
        end)

        it("moves when a set gained a slot it did not have", function()
            local snapshot, sets, store = filed({
                sets = { set({ id = 3, slots = { { slot = 0, appearance = 100 } } }) },
            })

            sets[1].slots[2] = { slot = 3, appearance = 200 }
            snapshot.sync(NOW)

            assert.equal(NOW, store.at)
        end)

        -- The opposite of the equipment ledger, which stays quiet about a rename because a
        -- ledger row with no items in it says nothing. Here the name is what the player
        -- reads off the list, so a wardrobe whose labels have changed has changed.
        it("moves when a set was only renamed", function()
            local snapshot, sets, store = filed({
                sets = { set({ id = 3, name = "Raid", slots = { { slot = 0, appearance = 100 } } }) },
            })

            sets[1].name = "Mythic Raid"
            snapshot.sync(NOW)

            assert.equal(NOW, store.at)
            assert.equal("Mythic Raid", store.sets[1].name)
        end)

        it("moves when a set was deleted, and stops writing it down", function()
            local snapshot, sets, store = filed({
                sets = { set({ id = 3 }), set({ id = 5 }) },
            })

            table.remove(sets, 2)
            snapshot.sync(NOW)

            assert.equal(NOW, store.at)
            assert.equal(1, #store.sets)
            assert.equal(3, store.sets[1].id)
        end)

        it("moves when a set appeared beside the ones already there", function()
            local snapshot, sets, store = filed({ sets = { set({ id = 3 }) } })

            sets[2] = set({ id = 5, name = "Town" })
            snapshot.sync(NOW)

            assert.equal(NOW, store.at)
            assert.equal(2, #store.sets)
        end)

        it("moves when only the picture on a set changed", function()
            local snapshot, sets, store = filed({ sets = { set({ id = 3, icon = 626185 }) } })

            sets[1].icon = 626186
            snapshot.sync(NOW)

            assert.equal(NOW, store.at)
        end)

        -- Two sets swapping ids is two different wardrobes wearing the same appearances,
        -- and sorting by id means the comparison has to notice it rather than see the same
        -- rows in the same order.
        it("moves when two sets swapped which id wears which look", function()
            local snapshot, sets, store = filed({
                sets = {
                    set({ id = 3, slots = { { slot = 0, appearance = 100 } } }),
                    set({ id = 5, slots = { { slot = 0, appearance = 200 } } }),
                },
            })

            sets[1].slots[1].appearance = 200
            sets[2].slots[1].appearance = 100
            snapshot.sync(NOW)

            assert.equal(NOW, store.at)
        end)

        -- A store handed back by a previous session is exactly what makes a session where
        -- the player changed nothing leave the stamp where the last one left it, rather
        -- than every login reading as an evening spent on the wardrobe.
        it("compares against a look a previous session left behind", function()
            local snapshot, sets, store = newSnapshot({
                store = {
                    at = 1,
                    sets = { { id = 3, name = "Raid", slots = { { slot = 0, appearance = 100 } } } },
                },
                sets = { set({ id = 3, name = "Raid", slots = { { slot = 0, appearance = 100 } } }) },
            })

            snapshot.sync(NOW)
            assert.equal(1, store.at)

            sets[1].slots[1].appearance = 101
            snapshot.sync(NOW)
            assert.equal(NOW, store.at)
        end)

        -- The client's own tables are mutated under the addon's feet, so a snapshot that
        -- held on to one would find every later edit already inside the look it is meant to
        -- be comparing against — and would then call the wardrobe unchanged forever.
        it("does not share a table with the client, so a later edit cannot reach it", function()
            local snapshot, sets, store = filed({
                sets = { set({ id = 3, slots = { { slot = 0, appearance = 100 } } }) },
            })

            sets[1].slots[1].appearance = 101

            assert.equal(100, store.sets[1].slots[1].appearance)
            snapshot.sync(NOW)
            assert.equal(101, store.sets[1].slots[1].appearance)
        end)
    end)
end)
