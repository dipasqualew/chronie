local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newLockoutStore", function()
    local ns = loader.load()

    local NOW = 1700000000
    local WEEK = 7 * 24 * 60 * 60

    ---@param options table? `{ db = table?, now = integer?, staleAfterSeconds = integer? }`
    ---@return table store, table db the SavedVariables table it writes into
    local function newStore(options)
        options = options or {}
        local db = options.db or {}
        local store = ns.newLockoutStore({
            db = db,
            now = fake.newClock(options.now or NOW).now,
            staleAfterSeconds = options.staleAfterSeconds,
        })
        return store, db
    end

    ---@param overrides table?
    ---@return Lockout
    local function lockout(overrides)
        local row = {
            instance = "Ulduar",
            difficultyId = 4,
            difficulty = "25 Player",
            maxPlayers = 25,
            isRaid = true,
            expiry = NOW + 3600,
        }
        for key, value in pairs(overrides or {}) do
            row[key] = value
        end
        return row
    end

    ---@param rows LockoutRow[]
    ---@return table<string, boolean> a set of "character|instance|difficultyId"
    local function identities(rows)
        local set = {}
        for _, row in ipairs(rows) do
            set[row.character .. "|" .. row.instance .. "|" .. tostring(row.difficultyId)] = true
        end
        return set
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newLockoutStore)
    end)

    describe("initialising the SavedVariables table", function()
        it("creates the characters table when the db is empty", function()
            local _, db = newStore()

            assert.is_table(db.characters)
        end)

        it("keeps the existing characters table when the db was already populated", function()
            local existing = { ["Thrall-Ragnaros"] = {} }
            local db = { characters = existing }

            newStore({ db = db })

            assert.equal(existing, db.characters)
        end)

        it("leaves unrelated keys in the db alone", function()
            local db = { version = 3 }

            newStore({ db = db })

            assert.equal(3, db.version)
        end)
    end)

    describe("save", function()
        it("writes the character's lockouts into the db", function()
            local store, db = newStore()

            store.save("Thrall-Ragnaros", { lockout() })

            assert.is_table(db.characters["Thrall-Ragnaros"])
            assert.equal(1, #store.all())
        end)

        it("keeps only the latest lockout for the same instance and difficulty", function()
            local store = newStore()

            store.save("Thrall-Ragnaros", {
                lockout({ expiry = NOW + 100 }),
                lockout({ expiry = NOW + 5000 }),
            })

            local rows = store.all()
            assert.equal(1, #rows)
            assert.equal(NOW + 5000, rows[1].expiry)
        end)

        it("ignores a later-listed entry that expires sooner", function()
            local store = newStore()

            store.save("Thrall-Ragnaros", {
                lockout({ expiry = NOW + 5000 }),
                lockout({ expiry = NOW + 100 }),
            })

            local rows = store.all()
            assert.equal(1, #rows)
            assert.equal(NOW + 5000, rows[1].expiry)
        end)

        it("keeps the same instance at two difficulties as two separate rows", function()
            local store = newStore()

            store.save("Thrall-Ragnaros", {
                lockout({ difficultyId = 3, difficulty = "10 Player" }),
                lockout({ difficultyId = 4, difficulty = "25 Player" }),
            })

            local rows = store.all()
            assert.equal(2, #rows)
            assert.same({
                ["Thrall-Ragnaros|Ulduar|3"] = true,
                ["Thrall-Ragnaros|Ulduar|4"] = true,
            }, identities(rows))
        end)

        it("keys on difficultyId rather than the localised difficulty name", function()
            local store = newStore()

            store.save("Thrall-Ragnaros", {
                lockout({ difficultyId = 4, difficulty = "25 Player", expiry = NOW + 100 }),
                lockout({ difficultyId = 4, difficulty = "25 Spieler", expiry = NOW + 200 }),
            })

            assert.equal(1, #store.all())
        end)

        it("keeps two different instances at the same difficulty apart", function()
            local store = newStore()

            store.save("Thrall-Ragnaros", {
                lockout({ instance = "Ulduar" }),
                lockout({ instance = "Naxxramas" }),
            })

            assert.equal(2, #store.all())
        end)

        it("replaces the saved character's previous data", function()
            local store = newStore()
            store.save("Thrall-Ragnaros", { lockout({ instance = "Ulduar" }) })

            store.save("Thrall-Ragnaros", { lockout({ instance = "Naxxramas" }) })

            local rows = store.all()
            assert.equal(1, #rows)
            assert.equal("Naxxramas", rows[1].instance)
        end)

        it("leaves other characters untouched when one is saved", function()
            local store = newStore()
            store.save("Jaina-Ragnaros", { lockout({ instance = "Karazhan" }) })

            store.save("Thrall-Ragnaros", { lockout({ instance = "Ulduar" }) })

            assert.same({
                ["Jaina-Ragnaros|Karazhan|4"] = true,
                ["Thrall-Ragnaros|Ulduar|4"] = true,
            }, identities(store.all()))
        end)

        it("empties only that character when it is saved with no lockouts", function()
            local store = newStore()
            store.save("Jaina-Ragnaros", { lockout({ instance = "Karazhan" }) })
            store.save("Thrall-Ragnaros", { lockout({ instance = "Ulduar" }) })

            store.save("Thrall-Ragnaros", {})

            local rows = store.all()
            assert.equal(1, #rows)
            assert.equal("Jaina-Ragnaros", rows[1].character)
        end)

        it("persists across a fresh store built on the same db", function()
            local db = {}
            local first = newStore({ db = db })
            first.save("Thrall-Ragnaros", { lockout() })

            local second = newStore({ db = db })

            assert.equal(1, #second.all())
        end)
    end)

    describe("all", function()
        it("returns an empty list when nothing was ever saved", function()
            local store = newStore()

            assert.same({}, store.all())
        end)

        it("attaches the owning character to every row", function()
            local store = newStore()
            store.save("Thrall-Ragnaros", { lockout() })

            assert.equal("Thrall-Ragnaros", store.all()[1].character)
        end)

        it("carries every stored field through onto the row", function()
            local store = newStore()
            store.save("Thrall-Ragnaros", { lockout() })

            assert.same({
                character = "Thrall-Ragnaros",
                instance = "Ulduar",
                difficultyId = 4,
                difficulty = "25 Player",
                maxPlayers = 25,
                isRaid = true,
                expiry = NOW + 3600,
            }, store.all()[1])
        end)

        it("flattens several characters into one list", function()
            local store = newStore()
            store.save("Thrall-Ragnaros", { lockout({ instance = "Ulduar" }) })
            store.save("Jaina-Ragnaros", { lockout({ instance = "Karazhan" }) })
            store.save("Sylvanas-Draenor", { lockout({ instance = "Naxxramas" }) })

            assert.equal(3, #store.all())
        end)

        it("returns a flat array with no holes", function()
            local store = newStore()
            store.save("Thrall-Ragnaros", {
                lockout({ instance = "Ulduar" }),
                lockout({ instance = "Karazhan" }),
            })
            store.save("Jaina-Ragnaros", { lockout({ instance = "Naxxramas" }) })

            local rows = store.all()
            for index = 1, 3 do
                assert.is_table(rows[index])
            end
            assert.equal(3, #rows)
        end)

        it("hands back copies, so mutating a row does not corrupt the db", function()
            local store = newStore()
            store.save("Thrall-Ragnaros", { lockout() })

            store.all()[1].instance = "Tampered"

            assert.equal("Ulduar", store.all()[1].instance)
        end)
    end)

    describe("pruning stale lockouts", function()
        it("still returns a lockout that expired only recently", function()
            local store = newStore({ now = NOW })

            store.save("Thrall-Ragnaros", { lockout({ expiry = NOW - 60 }) })

            -- Expired entries are greyed out rather than hidden, so they must survive.
            assert.equal(1, #store.all())
        end)

        it("still returns a lockout that expired just inside the stale window", function()
            local store = newStore({ now = NOW })

            store.save("Thrall-Ragnaros", { lockout({ expiry = NOW - WEEK + 1 }) })

            assert.equal(1, #store.all())
        end)

        it("keeps a lockout sitting exactly on the cutoff", function()
            local store = newStore({ now = NOW })

            store.save("Thrall-Ragnaros", { lockout({ expiry = NOW - WEEK }) })

            assert.equal(1, #store.all())
        end)

        it("drops a lockout that expired longer ago than the stale window", function()
            local store = newStore({ now = NOW })

            store.save("Thrall-Ragnaros", { lockout({ expiry = NOW - WEEK - 1 }) })

            assert.same({}, store.all())
        end)

        it("deletes the stale entry from the db itself, not just from the result", function()
            local store, db = newStore({ now = NOW })
            store.save("Thrall-Ragnaros", { lockout({ expiry = NOW - WEEK - 1 }) })
            -- save() records it verbatim; only a read prunes.
            assert.is_not_nil(next(db.characters["Thrall-Ragnaros"]))

            store.all()

            local stored = db.characters["Thrall-Ragnaros"]
            assert.is_table(stored)
            assert.is_nil(next(stored))
        end)

        it("prunes only the stale entries of a character, keeping the live ones", function()
            local store, db = newStore({ now = NOW })

            store.save("Thrall-Ragnaros", {
                lockout({ instance = "Ulduar", expiry = NOW + 3600 }),
                lockout({ instance = "Naxxramas", expiry = NOW - WEEK - 1 }),
            })
            store.all()

            local rows = store.all()
            assert.equal(1, #rows)
            assert.equal("Ulduar", rows[1].instance)

            local names = {}
            for _, stored in pairs(db.characters["Thrall-Ragnaros"]) do
                names[#names + 1] = stored.instance
            end
            assert.same({ "Ulduar" }, names)
        end)

        it("honours an injected staleAfterSeconds instead of the default week", function()
            local store = newStore({ now = NOW, staleAfterSeconds = 60 })

            store.save("Thrall-Ragnaros", {
                lockout({ instance = "Ulduar", expiry = NOW - 30 }),
                lockout({ instance = "Naxxramas", expiry = NOW - 61 }),
            })

            local rows = store.all()
            assert.equal(1, #rows)
            assert.equal("Ulduar", rows[1].instance)
        end)

        it("prunes stale entries across every character", function()
            local store, db = newStore({ now = NOW, staleAfterSeconds = 60 })
            store.save("Thrall-Ragnaros", { lockout({ expiry = NOW - 61 }) })
            store.save("Jaina-Ragnaros", { lockout({ expiry = NOW - 61 }) })

            store.all()

            assert.is_nil(next(db.characters["Thrall-Ragnaros"]))
            assert.is_nil(next(db.characters["Jaina-Ragnaros"]))
        end)
    end)
end)
