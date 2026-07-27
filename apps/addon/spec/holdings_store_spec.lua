local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newHoldingsStore", function()
    local ns = loader.load()

    local NOW = 1700000000
    local DAY = 24 * 60 * 60

    ---@param options table? `{ db = table?, now = integer? }`
    ---@return table store, table db the SavedVariables table it writes into, table clock
    local function newStore(options)
        options = options or {}
        local db = options.db or {}
        local clock = options.clock or fake.newClock(options.now or NOW)
        return ns.newHoldingsStore({ db = db, now = clock.now }), db, clock
    end

    ---A segment summary carrying only the two lists this store reads.
    ---@param overrides table?
    ---@return table
    local function summary(overrides)
        local base = { currencies = {}, reputation = {} }
        for key, value in pairs(overrides or {}) do
            base[key] = value
        end
        return base
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newHoldingsStore)
    end)

    describe("recording what a character was left holding", function()
        it("writes each character's holdings under its own key", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 3008, name = "Valorstones", amount = 15, total = 1200 } },
            }))

            assert.same({ name = "Valorstones", total = 1200, at = NOW },
                db.holdings["Alt-Ravencrest"].currencies[3008])
        end)

        it("keeps the last holding when the client answered a gain with none", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 3008, name = "Valorstones", amount = 15, total = 1200 } },
            }))
            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 3008, name = "Valorstones", amount = 15 } },
            }))

            -- A gain with no holding on it is the client saying nothing, and the number we
            -- already had is a better answer than none at all.
            assert.equal(1200, db.holdings["Alt-Ravencrest"].currencies[3008].total)
        end)

        it("keeps a faction the client would not place out of the snapshot", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({
                reputation = { { faction = "Hallowfall Arathi", amount = 250 } },
            }))

            assert.same({}, db.holdings["Alt-Ravencrest"].factions)
            assert.is_nil(db.holdings["Alt-Ravencrest"].updatedAt)
        end)

        it("ignores a summary with no character to file it against", function()
            local store, db = newStore()

            store.record(nil, summary({
                currencies = { { id = 3008, name = "Valorstones", amount = 15, total = 1200 } },
            }))
            store.record("", summary())

            assert.same({}, db.holdings)
        end)
    end)

    describe("the account's total of a currency", function()
        it("sums every character that has reported holding any", function()
            local store, db, clock = newStore()

            store.record("Main-Ravencrest", summary({
                currencies = { { id = 3008, name = "Valorstones", amount = 15, total = 1200 } },
            }))
            clock.advance(DAY)
            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 3008, name = "Valorstones", amount = 40, total = 800 } },
            }))

            local rollup = store.currency(3008)

            assert.equal(2000, rollup.total)
            assert.equal("Valorstones", rollup.name)
            assert.equal(2, #rollup.characters)
            -- Sorted, so a panel drawing the list never reshuffles it between renders.
            assert.equal("Alt-Ravencrest", rollup.characters[1].character)
            -- The eldest reading, because it is the weakest claim in the sum.
            assert.equal(NOW, rollup.oldest)
            assert.is_table(db.holdings["Main-Ravencrest"])
        end)

        it("says nothing at all about a currency nobody has reported", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                currencies = { { id = 3008, name = "Valorstones", amount = 15, total = 1200 } },
            }))

            -- Not a total of zero: nobody has looked, which is a different claim.
            assert.is_nil(store.currency(2245))
            assert.is_nil(store.currency(nil))
        end)
    end)

    describe("where the account stands with a faction", function()
        ---@param faction string
        ---@param standing string
        ---@param rank integer
        ---@param options table? `{ system = string?, current = integer? }`
        ---@return table
        local function gain(faction, standing, rank, options)
            options = options or {}
            return {
                faction = faction,
                amount = 250,
                standing = standing,
                current = options.current or 0,
                max = 2500,
                rank = rank,
                system = options.system or "renown",
            }
        end

        it("names the character that has got furthest", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                reputation = { gain("Dream Wardens", "Renown 8", 8) },
            }))
            store.record("Alt-Ravencrest", summary({
                reputation = { gain("Dream Wardens", "Renown 22", 22) },
            }))

            local rollup = store.standing("Dream Wardens")

            assert.equal("Alt-Ravencrest", rollup.best.character)
            assert.equal("Renown 22", rollup.best.standing)
            assert.equal(2, #rollup.characters)
        end)

        it("breaks a tie on progress into the level", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                reputation = { gain("Dream Wardens", "Renown 8", 8, { current = 2000 }) },
            }))
            store.record("Alt-Ravencrest", summary({
                reputation = { gain("Dream Wardens", "Renown 8", 8, { current = 100 }) },
            }))

            assert.equal("Main-Ravencrest", store.standing("Dream Wardens").best.character)
        end)

        -- A build that cannot reach the friendship API falls back to the reaction ladder,
        -- whose ranks run 1 to 8 against a friendship's several thousand. Ranking the two
        -- against each other would hand the crown to whichever ladder counts higher rather
        -- than to whichever character is further along, so the odd reading out is set aside.
        it("judges a faction on the ladder most of its characters were read off", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                reputation = { gain("Brann Bronzebeard", "Best Friend", 8400,
                    { system = "friendship" }) },
            }))
            store.record("Second-Ravencrest", summary({
                reputation = { gain("Brann Bronzebeard", "Pal", 1200, { system = "friendship" }) },
            }))
            store.record("Odd-Ravencrest", summary({
                reputation = { gain("Brann Bronzebeard", "Honored", 6, { system = "reaction" }) },
            }))

            local rollup = store.standing("Brann Bronzebeard")

            assert.equal("Main-Ravencrest", rollup.best.character)
            -- Set aside for ranking, still listed: it is a real reading of a real character.
            assert.equal(3, #rollup.characters)
        end)

        it("never crowns a standing that cannot be placed on a ladder at all", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                reputation = { { faction = "Dream Wardens", amount = 250, standing = "Honored" } },
            }))

            -- Recorded, because the name is worth keeping; never the best, because there is
            -- nothing to measure it with.
            local rollup = store.standing("Dream Wardens")
            assert.is_nil(rollup)
        end)

        it("says nothing about a faction no character has been seen with", function()
            local store = newStore()

            assert.is_nil(store.standing("Dream Wardens"))
            assert.is_nil(store.standing(""))
            assert.is_nil(store.standing(nil))
        end)
    end)

    describe("ns.formatAge", function()
        it("rounds down to a single unit, because it is a warning and not a clock", function()
            assert.equal("now", ns.formatAge(0))
            assert.equal("now", ns.formatAge(59))
            assert.equal("5m ago", ns.formatAge(5 * 60 + 30))
            assert.equal("3h ago", ns.formatAge(3 * 3600 + 59 * 60))
            assert.equal("2d ago", ns.formatAge(2 * DAY + 20 * 3600))
        end)

        it("treats a clock that has run backwards as no age at all", function()
            assert.equal("now", ns.formatAge(-500))
            assert.equal("now", ns.formatAge(nil))
        end)
    end)
end)
