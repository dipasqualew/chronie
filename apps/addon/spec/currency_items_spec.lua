local loader = require("addon_loader")

describe("ns.newCurrencyItems", function()
    local ns = loader.load()

    ---@param db table?
    ---@return CurrencyItems store, table db
    local function newStore(db)
        db = db or {}
        return ns.newCurrencyItems({ db = db }), db
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newCurrencyItems)
    end)

    it("starts empty", function()
        local store = newStore()

        assert.same({}, store.ids())
        assert.same({}, store.list())
        assert.is_false(store.has(5001))
    end)

    describe("adding", function()
        it("tracks an item and reports it as present", function()
            local store = newStore()

            assert.is_true(store.add(5001, "Bloody Token"))
            assert.is_true(store.has(5001))
            assert.same({ 5001 }, store.ids())
        end)

        it("keeps the name for the list", function()
            local store = newStore()
            store.add(5001, "Bloody Token")

            assert.same({ { id = 5001, name = "Bloody Token" } }, store.list())
        end)

        it("falls back to the id when no name is given", function()
            local store = newStore()
            store.add(5001)

            assert.same({ { id = 5001, name = "5001" } }, store.list())
        end)

        it("reports a repeat add as not newly added", function()
            local store = newStore()
            store.add(5001, "Bloody Token")

            assert.is_false(store.add(5001, "Bloody Token"))
            assert.same({ 5001 }, store.ids())
        end)

        it("upgrades a placeholder name on a later add", function()
            local store = newStore()
            store.add(5001)

            store.add(5001, "Bloody Token")

            assert.equal("Bloody Token", store.list()[1].name)
        end)

        it("rejects a non-numeric item id", function()
            local store = newStore()

            assert.is_false(store.add("nope"))
            assert.is_false(store.add(nil))
            assert.same({}, store.ids())
        end)

        it("persists into the shared db table", function()
            local store, db = newStore()

            store.add(5001, "Bloody Token")

            assert.equal("Bloody Token", db.currencyItems[5001])
        end)
    end)

    describe("removing", function()
        it("drops a tracked item and reports it removed", function()
            local store = newStore()
            store.add(5001, "Bloody Token")

            assert.is_true(store.remove(5001))
            assert.is_false(store.has(5001))
            assert.same({}, store.ids())
        end)

        it("reports removing an untracked item as no change", function()
            local store = newStore()

            assert.is_false(store.remove(5001))
            assert.is_false(store.remove(nil))
        end)
    end)

    describe("listing", function()
        it("sorts by name then id", function()
            local store = newStore()
            store.add(3, "Valor")
            store.add(1, "Honor")
            store.add(2, "Honor")

            assert.same({
                { id = 1, name = "Honor" },
                { id = 2, name = "Honor" },
                { id = 3, name = "Valor" },
            }, store.list())
        end)

        it("returns ids in ascending order", function()
            local store = newStore()
            store.add(5003, "C")
            store.add(5001, "A")
            store.add(5002, "B")

            assert.same({ 5001, 5002, 5003 }, store.ids())
        end)
    end)

    -- An earlier build stored the list as a bare array of ids; upgrading must not drop them.
    describe("migrating an old array-of-ids list", function()
        it("folds array entries into the map", function()
            local store, db = newStore({ currencyItems = { 5001, 5002 } })

            assert.same({ 5001, 5002 }, store.ids())
            assert.is_nil(db.currencyItems[1])
            assert.equal("5001", db.currencyItems[5001])
        end)

        it("leaves an already-migrated map untouched", function()
            local store = newStore({ currencyItems = { [5001] = "Bloody Token" } })

            assert.same({ { id = 5001, name = "Bloody Token" } }, store.list())
        end)
    end)
end)
