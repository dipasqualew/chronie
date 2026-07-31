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

        it("writes down that a currency is the account's pot rather than the character's", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", total = 1000, accountWide = true } },
            }))

            assert.same({ name = "Trader's Tender", total = 1000, accountWide = true, at = NOW },
                db.holdings["Alt-Ravencrest"].currencies[2032])
        end)

        -- Only the pane walk reads the flag; a gain arrives off an event that never carries
        -- one. Clearing it on every gain would unshare a currency between two zonings-in.
        it("keeps the shared flag through a gain that says nothing about it", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", total = 1000, accountWide = true } },
            }))
            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", amount = 50, total = 1050 } },
            }))

            local held = db.holdings["Alt-Ravencrest"].currencies[2032]
            assert.equal(1050, held.total)
            assert.is_true(held.accountWide)
        end)

        -- A walk reads the flag off the same row it reads the quantity off, so it is a
        -- complete answer rather than a silence: a currency Blizzard un-shares stops being
        -- shared here at the next zoning-in rather than staying flagged forever.
        it("lets a later walk take the shared flag back off again", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", total = 1000, accountWide = true } },
            }))
            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", total = 1000, accountWide = false } },
            }))

            -- Absent rather than false, because the snapshot is the account's SavedVariables
            -- and a key per currency per character saying "no" costs a file to say nothing.
            assert.is_nil(db.holdings["Alt-Ravencrest"].currencies[2032].accountWide)
        end)

        -- Filed under the faction's own id, with the name beside it for something to draw
        -- rather than to key on. A name is localised, so a snapshot keyed on one forks into a
        -- second faction the moment the player switches the client's language.
        it("writes each character's standings under the faction's own id", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({
                reputation = { { id = 2574, faction = "Dream Wardens", amount = 250,
                    standing = "Renown 8", current = 500, max = 2500, rank = 8,
                    system = "renown" } },
            }))

            assert.same({
                name = "Dream Wardens",
                standing = "Renown 8",
                current = 500,
                max = 2500,
                rank = 8,
                system = "renown",
                at = NOW,
            }, db.holdings["Alt-Ravencrest"].factions[2574])
        end)

        it("keeps a faction the client would not place out of the snapshot", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({
                reputation = { { faction = "Hallowfall Arathi", amount = 250 } },
            }))

            assert.same({}, db.holdings["Alt-Ravencrest"].factions)
            assert.is_nil(db.holdings["Alt-Ravencrest"].updatedAt)
        end)

        -- The id and the standing arrive from the same lookup, so a gain with no id is a
        -- faction the client would not place — but a gain the chat line named and the client
        -- did place has both, and filing it under the name instead is the fork the id exists
        -- to prevent. There is nowhere else for it to go, so it goes nowhere.
        it("keeps a standing the client would not put an id on out of the snapshot", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({
                reputation = { { faction = "Hallowfall Arathi", amount = 250,
                    standing = "Renown 4", rank = 4, system = "renown" } },
            }))

            assert.same({}, db.holdings["Alt-Ravencrest"].factions)
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

    describe("the gold a character was left holding", function()
        it("writes the balance down against the moment it was read", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({ wallet = 125000 }))

            assert.same({ total = 125000, at = NOW }, db.holdings["Alt-Ravencrest"].gold)
        end)

        -- Unlike a currency, which is only ever reported as part of a gain, the wallet is read
        -- whole every time. A balance of zero is therefore a reading and not a silence, and it
        -- has to be able to overwrite a fortune the character has since spent.
        it("lets a character that spent everything say so", function()
            local store, db = newStore()

            store.record("Alt-Ravencrest", summary({ wallet = 125000 }))
            store.record("Alt-Ravencrest", summary({ wallet = 0 }))

            assert.equal(0, db.holdings["Alt-Ravencrest"].gold.total)
        end)

        -- Refused on the same terms the warband pot refuses it: no wallet holds less than
        -- nothing, so this is a broken reading rather than a poor character.
        it("refuses a balance below zero, which no wallet has", function()
            local store, db = newStore()
            store.record("Alt-Ravencrest", summary({ wallet = 125000 }))

            store.record("Alt-Ravencrest", summary({ wallet = -1 }))

            assert.equal(125000, db.holdings["Alt-Ravencrest"].gold.total)
        end)

        it("keeps the last balance when the summary carried none", function()
            local store, db, clock = newStore()

            store.record("Alt-Ravencrest", summary({ wallet = 125000 }))
            clock.advance(DAY)
            store.record("Alt-Ravencrest", summary())

            -- Nothing was said this time, and the number we already had is a better answer
            -- than none — including the stamp, which is when it was actually true.
            assert.same({ total = 125000, at = NOW }, db.holdings["Alt-Ravencrest"].gold)
        end)
    end)

    describe("the warband bank's own gold", function()
        it("writes the pot down against the moment it was read", function()
            local store, db = newStore()

            store.recordWarband(500000)

            assert.same({ gold = 500000, at = NOW }, db.warband)
        end)

        it("records an emptied bank, because zero is a balance somebody read", function()
            local store, db = newStore()
            store.recordWarband(500000)

            store.recordWarband(0)

            assert.same({ gold = 0, at = NOW }, db.warband)
        end)

        -- A client build with no warband bank hands back nothing at all, and a nothing must
        -- never be filed as an emptied pot: the last real reading is the better answer, and
        -- every other character on the account is about to read it.
        for _, case in ipairs({
            { what = "a client that has no warband bank at all", amount = nil },
            { what = "an answer that is not a number", amount = "lots" },
            { what = "a balance below zero, which no pot has", amount = -1 },
        }) do
            it("leaves the last reading standing for " .. case.what, function()
                local store, db = newStore()
                store.recordWarband(500000)

                store.recordWarband(case.amount)

                assert.same({ gold = 500000, at = NOW }, db.warband)
            end)
        end
    end)

    describe("what the account is worth in gold", function()
        -- The mistake this rollup exists to prevent. Every character reads the same pot, so a
        -- total built by adding it in per character would be out by the size of the roster.
        it("adds every wallet together and the one shared pot exactly once", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({ wallet = 125000 }))
            store.record("Alt-Ravencrest", summary({ wallet = 40000 }))
            store.record("Bank-Ravencrest", summary({ wallet = 35000 }))
            store.recordWarband(500000)

            local rollup = store.gold()

            assert.equal(200000, rollup.wallets)
            assert.equal(500000, rollup.warband)
            assert.equal(700000, rollup.total)
            assert.equal(3, #rollup.characters)
            -- Sorted, so a panel drawing the list never reshuffles it between renders.
            assert.equal("Alt-Ravencrest", rollup.characters[1].character)
            assert.equal("Bank-Ravencrest", rollup.characters[2].character)
            assert.equal("Main-Ravencrest", rollup.characters[3].character)
        end)

        it("is the wallets alone when no warband bank has ever answered", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({ wallet = 125000 }))

            local rollup = store.gold()

            assert.equal(125000, rollup.total)
            assert.is_nil(rollup.warband)
            assert.is_nil(rollup.warbandAt)
        end)

        it("is the pot alone when it is all anybody has read", function()
            local store = newStore()

            store.recordWarband(500000)

            local rollup = store.gold()

            assert.equal(0, rollup.wallets)
            assert.equal(500000, rollup.total)
            assert.same({}, rollup.characters)
        end)

        -- The eldest reading is the weakest claim in the sum, and the number the panel warns
        -- with. It is the character last played weeks ago as often as it is the pot.
        it("dates the total by the eldest wallet in it", function()
            local store, _, clock = newStore()

            store.record("Alt-Ravencrest", summary({ wallet = 40000 }))
            clock.advance(3 * DAY)
            store.record("Main-Ravencrest", summary({ wallet = 125000 }))
            store.recordWarband(500000)

            assert.equal(NOW, store.gold().oldest)
        end)

        it("dates it by the warband reading when that is the stale one", function()
            local store, _, clock = newStore()

            store.recordWarband(500000)
            clock.advance(3 * DAY)
            store.record("Main-Ravencrest", summary({ wallet = 125000 }))

            local rollup = store.gold()

            assert.equal(NOW, rollup.oldest)
            assert.equal(NOW, rollup.warbandAt)
        end)

        it("says nothing at all before any balance has been read", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                currencies = { { id = 3008, name = "Valorstones", amount = 15, total = 1200 } },
            }))

            -- Not a total of zero: nobody has looked, which is a different claim, and one
            -- that would draw an account with gold in it as an account with none.
            assert.is_nil(store.gold())
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

        -- The bug this describes: the client reports a warband currency's shared balance to
        -- every character that asks, so every character reports the same pot and summing
        -- them multiplies it by the size of the roster.
        it("counts the account's shared pot once rather than once per character", function()
            local store, _, clock = newStore()

            store.record("Main-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", total = 2000, accountWide = true } },
            }))
            clock.advance(DAY)
            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", total = 2000, accountWide = true } },
            }))

            local rollup = store.currency(2032)

            assert.equal(2000, rollup.total)
            assert.is_true(rollup.accountWide)
            -- Every character that read the pot is still listed, because the list is what
            -- says the number was checked from more than one place.
            assert.equal(2, #rollup.characters)
        end)

        -- Two characters read the same pot at different times, so the older reading is not a
        -- second holding to add on: it is the same holding, out of date. The freshest is the
        -- one to believe, and it is also the whole claim, so it is what dates the total.
        it("believes the freshest reading of the shared pot rather than the eldest", function()
            local store, _, clock = newStore()

            store.record("Main-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", total = 2000, accountWide = true } },
            }))
            clock.advance(DAY)
            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", total = 1500, accountWide = true } },
            }))

            local rollup = store.currency(2032)

            assert.equal(1500, rollup.total)
            assert.equal(NOW + DAY, rollup.oldest)
        end)

        -- Whether a currency is shared is a fact about the currency, not about the character
        -- that looked. A snapshot written before the flag was ever collected simply has not
        -- been asked yet, so one character that has been is enough to settle it for all.
        it("treats a currency as shared once any character has read the flag", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", total = 2000 } },
            }))
            store.record("Alt-Ravencrest", summary({
                currencies = { { id = 2032, name = "Trader's Tender", total = 2000, accountWide = true } },
            }))

            local rollup = store.currency(2032)

            assert.is_true(rollup.accountWide)
            assert.equal(2000, rollup.total)
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
        -- Real ids, because the whole of what this rollup is now keyed on is the id: Dream
        -- Wardens is 2574, Brann Bronzebeard's friendship is 2640, and the Council of
        -- Dornogal — a warband reputation — is 2590.
        local WARDENS = 2574
        local BRANN = 2640
        local DORNOGAL = 2590

        ---@param id integer The faction's own id, which is what the snapshot is keyed on.
        ---@param faction string What the client called it, which is only ever drawn.
        ---@param standing string
        ---@param rank integer
        ---@param options table? `{ system = string?, current = integer?, accountWide = boolean? }`
        ---@return table
        local function gain(id, faction, standing, rank, options)
            options = options or {}
            return {
                id = id,
                faction = faction,
                accountWide = options.accountWide,
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
                reputation = { gain(WARDENS, "Dream Wardens", "Renown 8", 8) },
            }))
            store.record("Alt-Ravencrest", summary({
                reputation = { gain(WARDENS, "Dream Wardens", "Renown 22", 22) },
            }))

            local rollup = store.standing(WARDENS)

            assert.equal(WARDENS, rollup.id)
            assert.equal("Dream Wardens", rollup.faction)
            assert.equal("Alt-Ravencrest", rollup.best.character)
            assert.equal("Renown 22", rollup.best.standing)
            assert.equal(2, #rollup.characters)
        end)

        -- The fork the id keying exists to prevent, played out. Two characters on one account
        -- can be read by clients set to two languages — an alt levelled while the player had
        -- the game in German reports "Traumwächter" for the very faction the main reports as
        -- "Dream Wardens" — and keyed on that string the account's best would be decided
        -- between two halves of one grind. Keyed on 2574 they are one faction, as they are.
        it("rolls two characters up as one faction however their clients spell it", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                reputation = { gain(WARDENS, "Dream Wardens", "Renown 8", 8) },
            }))
            store.record("Alt-Ravencrest", summary({
                reputation = { gain(WARDENS, "Traumwächter", "Renown 22", 22) },
            }))

            local rollup = store.standing(WARDENS)

            assert.equal(2, #rollup.characters)
            assert.equal("Alt-Ravencrest", rollup.best.character)
        end)

        -- What the store looked like before #254: standings filed under the localised name.
        -- Those rows are not migrated and are not reached — the next sweep of either pane
        -- writes the same character's standing under the id and the legacy row is simply
        -- left behind, which is cheaper and safer than guessing an id from a string.
        it("does not find a standing an older addon filed under the faction's name", function()
            local store, db = newStore({
                db = {
                    holdings = {
                        ["Alt-Ravencrest"] = {
                            currencies = {},
                            factions = {
                                ["Dream Wardens"] = {
                                    standing = "Renown 22", current = 300, max = 2500,
                                    rank = 22, system = "renown", at = NOW - DAY,
                                },
                            },
                        },
                    },
                },
            })

            assert.is_nil(store.standing(WARDENS))
            -- Still on disk rather than deleted: it costs nothing to leave, and a reader that
            -- went round destroying rows it did not understand would be a worse citizen.
            assert.is_table(db.holdings["Alt-Ravencrest"].factions["Dream Wardens"])
        end)

        it("breaks a tie on progress into the level", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                reputation = { gain(WARDENS, "Dream Wardens", "Renown 8", 8, { current = 2000 }) },
            }))
            store.record("Alt-Ravencrest", summary({
                reputation = { gain(WARDENS, "Dream Wardens", "Renown 8", 8, { current = 100 }) },
            }))

            assert.equal("Main-Ravencrest", store.standing(WARDENS).best.character)
        end)

        -- A build that cannot reach the friendship API falls back to the reaction ladder,
        -- whose ranks run 1 to 8 against a friendship's several thousand. Ranking the two
        -- against each other would hand the crown to whichever ladder counts higher rather
        -- than to whichever character is further along, so the odd reading out is set aside.
        it("judges a faction on the ladder most of its characters were read off", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                reputation = { gain(BRANN, "Brann Bronzebeard", "Best Friend", 8400,
                    { system = "friendship" }) },
            }))
            store.record("Second-Ravencrest", summary({
                reputation = { gain(BRANN, "Brann Bronzebeard", "Pal", 1200,
                    { system = "friendship" }) },
            }))
            store.record("Odd-Ravencrest", summary({
                reputation = { gain(BRANN, "Brann Bronzebeard", "Honored", 6,
                    { system = "reaction" }) },
            }))

            local rollup = store.standing(BRANN)

            assert.equal("Main-Ravencrest", rollup.best.character)
            -- Set aside for ranking, still listed: it is a real reading of a real character.
            assert.equal(3, #rollup.characters)
        end)

        -- Whether a standing is the warband's is a fact about the faction rather than about
        -- whoever looked, so one character that has been asked settles it for the roster — the
        -- same rule a shared currency's flag keeps, and for the same reason: a snapshot
        -- written before the flag was ever collected is an unasked question, not a "no".
        it("treats a standing as the warband's once any character has read the flag", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                reputation = { gain(DORNOGAL, "Council of Dornogal", "Renown 8", 8) },
            }))
            store.record("Alt-Ravencrest", summary({
                reputation = { gain(DORNOGAL, "Council of Dornogal", "Renown 8", 8,
                    { accountWide = true }) },
            }))

            assert.is_true(store.standing(DORNOGAL).accountWide)
        end)

        -- Only a walk of the pane reads the flag; a gain arrives off a chat line that never
        -- carries one. Clearing it on every gain would unshare a warband reputation between
        -- two zonings-in and start counting it once per alt again.
        it("keeps the warband flag through a later reading that says nothing about it", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                reputation = { gain(DORNOGAL, "Council of Dornogal", "Renown 8", 8,
                    { accountWide = true }) },
            }))
            store.record("Main-Ravencrest", summary({
                reputation = { gain(DORNOGAL, "Council of Dornogal", "Renown 9", 9) },
            }))

            local rollup = store.standing(DORNOGAL)

            assert.is_true(rollup.accountWide)
            assert.equal("Renown 9", rollup.best.standing)
        end)

        it("never crowns a standing that cannot be placed on a ladder at all", function()
            local store = newStore()

            store.record("Main-Ravencrest", summary({
                reputation = { { id = WARDENS, faction = "Dream Wardens", amount = 250,
                    standing = "Honored" } },
            }))

            -- Recorded, because the name is worth keeping; never the best, because there is
            -- nothing to measure it with.
            local rollup = store.standing(WARDENS)
            assert.is_nil(rollup)
        end)

        it("says nothing about a faction no character has been seen with", function()
            local store = newStore()

            assert.is_nil(store.standing(WARDENS))
            -- A name is not an id, and asking with one is a caller that has not been updated
            -- rather than a faction to go looking for.
            assert.is_nil(store.standing("Dream Wardens"))
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
