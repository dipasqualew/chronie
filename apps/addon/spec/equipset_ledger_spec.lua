local loader = require("addon_loader")

describe("ns.newEquipsetLedger", function()
    local ns = loader.load()

    local NOW = 1700000000

    ---Builds a ledger over tables the test can edit between two syncs, which is the only
    ---way any of this is observable: the client never says what changed, so a change is
    ---whatever two consecutive looks disagree about.
    ---@param options table? `{ sets = table?, equipped = table?, store = table? }`
    ---@return table ledger, table sets, table equipped, table store
    local function newLedger(options)
        options = options or {}
        local sets = options.sets or {}
        local equipped = options.equipped or {}
        local store = options.store or {}
        local ledger = ns.newEquipsetLedger({
            readSets = function()
                return sets
            end,
            readEquipped = function()
                return equipped
            end,
            store = store,
            now = function()
                return NOW
            end,
        })
        return ledger, sets, equipped, store
    end

    ---A ledger that has already taken its first look, which is the state every test but the
    ---seeding ones is actually about.
    ---@param options table?
    ---@return table ledger, table sets, table equipped, table store
    local function seeded(options)
        local ledger, sets, equipped, store = newLedger(options)
        ledger.sync()
        return ledger, sets, equipped, store
    end

    describe("the first look", function()
        it("reports nothing, because nothing has been compared yet", function()
            local ledger = newLedger({ sets = { [1] = { name = "Raid", items = { [1] = 100 } } } })
            assert.same({}, ledger.sync())
        end)

        it("remembers what it saw, so the next look has something to subtract from", function()
            local ledger, _, _, store = newLedger({
                sets = { [1] = { name = "Raid", items = { [1] = 100 } } },
            })
            ledger.sync()
            assert.same({ [1] = { name = "Raid", items = { [1] = 100 } } }, store.sets)
        end)

        -- A character with no sets at all still has to seed, or its first created set would
        -- be missed: an empty table and "never looked" are different states and only one of
        -- them is a reason to stay quiet.
        it("seeds from a character that owns no sets at all", function()
            local ledger, sets = newLedger()
            assert.same({}, ledger.sync())
            sets[1] = { name = "Raid", items = {} }
            local changes = ledger.sync()
            assert.equal(1, #changes)
            assert.equal("created", changes[1].kind)
        end)
    end)

    describe("a set that appeared", function()
        it("is reported as created, with every slot it holds", function()
            local ledger, sets = seeded()
            sets[7] = { name = "Raid", items = { [1] = 100, [5] = 200 } }
            assert.same({
                {
                    setId = 7,
                    name = "Raid",
                    kind = "created",
                    at = NOW,
                    items = {
                        { slot = 1, itemId = 100 },
                        { slot = 5, itemId = 200 },
                    },
                },
            }, ledger.sync())
        end)
    end)

    describe("a set that went away", function()
        it("is reported as deleted, with every slot emptied", function()
            local ledger, sets = seeded({
                sets = { [7] = { name = "Raid", items = { [1] = 100 } } },
            })
            sets[7] = nil
            assert.same({
                {
                    setId = 7,
                    name = "Raid",
                    kind = "deleted",
                    at = NOW,
                    items = { { slot = 1 } },
                },
            }, ledger.sync())
        end)

        -- The name is gone from the client by the time the deletion is noticed, so it can
        -- only come from the last look. A ledger row reading "set 7 was deleted" is a row
        -- nobody can place.
        it("keeps the name the set had, which the client can no longer be asked for", function()
            local ledger, sets = seeded({
                sets = { [7] = { name = "Mythic Raid", items = {} } },
            })
            sets[7] = nil
            assert.equal("Mythic Raid", ledger.sync()[1].name)
        end)
    end)

    describe("a set whose items were edited", function()
        it("reports only the slots that differ", function()
            local ledger, sets = seeded({
                sets = { [7] = { name = "Raid", items = { [1] = 100, [5] = 200, [15] = 300 } } },
            })
            sets[7].items[5] = 250
            assert.same({
                {
                    setId = 7,
                    name = "Raid",
                    kind = "updated",
                    at = NOW,
                    items = { { slot = 5, itemId = 250 } },
                },
            }, ledger.sync())
        end)

        it("reports a slot the edit cleared, as a slot holding nothing", function()
            local ledger, sets = seeded({
                sets = { [7] = { name = "Raid", items = { [1] = 100, [5] = 200 } } },
            })
            sets[7].items[5] = nil
            assert.same({ { slot = 5 } }, ledger.sync()[1].items)
        end)

        it("says nothing about a set nobody touched", function()
            local ledger, sets = seeded({
                sets = { [7] = { name = "Raid", items = { [1] = 100 } } },
            })
            sets[8] = { name = "Other", items = {} }
            local changes = ledger.sync()
            assert.equal(1, #changes)
            assert.equal(8, changes[1].setId)
        end)

        -- The set is the same set holding the same items; only its label moved. Recording
        -- that as a change would fill the ledger with rows that show no items at all.
        it("says nothing about a set that was only renamed", function()
            local ledger, sets = seeded({
                sets = { [7] = { name = "Raid", items = { [1] = 100 } } },
            })
            sets[7].name = "Mythic Raid"
            assert.same({}, ledger.sync())
        end)

        it("carries the new name forward, so the next edit is filed under it", function()
            local ledger, sets = seeded({
                sets = { [7] = { name = "Raid", items = { [1] = 100 } } },
            })
            sets[7].name = "Mythic Raid"
            ledger.sync()
            sets[7].items[1] = 101
            assert.equal("Mythic Raid", ledger.sync()[1].name)
        end)
    end)

    describe("what an item is worth", function()
        -- Saving a set saves what is equipped, so the items that went into it can be asked
        -- their real level — the one upgrades made, not the one the item shipped with.
        it("reads level and name off the equipped item that went into the slot", function()
            local ledger, sets, equipped = seeded()
            equipped[1] = { id = 100, level = 639, name = "Crown of the Tides" }
            sets[7] = { name = "Raid", items = { [1] = 100 } }
            assert.same(
                { { slot = 1, itemId = 100, itemLevel = 639, itemName = "Crown of the Tides" } },
                ledger.sync()[1].items
            )
        end)

        -- An edit made in a session Chronie was not running is only noticed at the next
        -- login, by which point the character may be wearing something else entirely.
        it("records the id alone when the slot's new item is not the one being worn", function()
            local ledger, sets, equipped = seeded()
            equipped[1] = { id = 999, level = 639, name = "Something Else" }
            sets[7] = { name = "Raid", items = { [1] = 100 } }
            assert.same({ { slot = 1, itemId = 100 } }, ledger.sync()[1].items)
        end)

        it("records the id alone when the slot is empty on the character", function()
            local ledger, sets = seeded()
            sets[7] = { name = "Raid", items = { [1] = 100 } }
            assert.same({ { slot = 1, itemId = 100 } }, ledger.sync()[1].items)
        end)
    end)

    describe("what the client reports that is not an item", function()
        -- 0 is a slot the set holds nothing for and 1 is a slot it was told to ignore. For
        -- a ledger both say the same thing, and neither is an item id worth writing down.
        it("treats an empty slot and an ignored slot alike, as no item", function()
            local ledger, sets = seeded({
                sets = { [7] = { name = "Raid", items = { [1] = 100 } } },
            })
            sets[7].items[5] = 0
            sets[7].items[9] = 1
            assert.same({}, ledger.sync())
        end)

        it("reports a slot going from an item to ignored as a slot holding nothing", function()
            local ledger, sets = seeded({
                sets = { [7] = { name = "Raid", items = { [1] = 100 } } },
            })
            sets[7].items[1] = 1
            assert.same({ { slot = 1 } }, ledger.sync()[1].items)
        end)
    end)

    describe("the order rows come back in", function()
        -- Both halves of the diff walk a hash table, so without sorting the same two edits
        -- would file in whatever order the table felt like and no two runs would agree.
        it("orders changes by set id, whatever order the client's table is in", function()
            local ledger, sets = seeded({
                sets = { [9] = { name = "Nine", items = { [1] = 100 } } },
            })
            sets[9] = nil
            sets[3] = { name = "Three", items = {} }
            sets[5] = { name = "Five", items = {} }
            local ids = {}
            for index, change in ipairs(ledger.sync()) do
                ids[index] = change.setId
            end
            assert.same({ 3, 5, 9 }, ids)
        end)

        it("orders a set's slots ascending", function()
            local ledger, sets = seeded()
            sets[7] = { name = "Raid", items = { [15] = 300, [1] = 100, [5] = 200 } }
            local slots = {}
            for index, item in ipairs(ledger.sync()[1].items) do
                slots[index] = item.slot
            end
            assert.same({ 1, 5, 15 }, slots)
        end)
    end)

    describe("the look it keeps", function()
        it("does not share a table with the client, so a later edit cannot reach it", function()
            local ledger, sets, _, store = seeded({
                sets = { [7] = { name = "Raid", items = { [1] = 100 } } },
            })
            sets[7].items[1] = 200
            assert.equal(100, store.sets[7].items[1])
            ledger.sync()
            assert.equal(200, store.sets[7].items[1])
        end)

        -- A store handed back by a previous session is exactly what makes an edit performed
        -- while the addon was loaded, then reloaded, still only be reported once.
        it("subtracts from a look a previous session left behind", function()
            local store = { sets = { [7] = { name = "Raid", items = { [1] = 100 } } } }
            local ledger, sets = newLedger({
                store = store,
                sets = { [7] = { name = "Raid", items = { [1] = 100 } } },
            })
            assert.same({}, ledger.sync())
            sets[7].items[1] = 200
            assert.equal("updated", ledger.sync()[1].kind)
        end)
    end)
end)
