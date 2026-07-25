local loader = require("addon_loader")

describe("ns.newSessionTally", function()
    local ns = loader.load()

    describe("transmog appearance classification", function()
        it("treats the first collected source as a new appearance even if the UI marker is false", function()
            assert.is_true(ns.isNewTransmogAppearance({ { isCollected = true } }, false))
        end)

        it("treats an additional collected source as a known appearance variant", function()
            assert.is_false(ns.isNewTransmogAppearance({
                { isCollected = true },
                { isCollected = true },
            }, true))
        end)

        it("falls back to the UI marker when collection sources are unavailable", function()
            assert.is_true(ns.isNewTransmogAppearance(nil, true))
        end)
    end)

    local LOOT_FORMATS = { "You receive loot: %sx%d.", "You receive loot: %s." }
    local FACTION_FORMATS = { "Your %s reputation has increased by %d." }

    ---Build the tally directly with fake seams, mirroring how lockout_store_spec builds
    ---the store: no frames, no Main, just the pure module and injected dependencies.
    ---@param options table? `{ prices, lootFormats, factionFormats }`
    ---@return SessionTally
    local function newTally(options)
        options = options or {}
        local prices = options.prices or {}
        return ns.newSessionTally({
            lootFormats = options.lootFormats or LOOT_FORMATS,
            factionFormats = options.factionFormats or FACTION_FORMATS,
            itemSellPrice = function(itemID)
                return prices[itemID]
            end,
        })
    end

    ---A believable item hyperlink, the shape the client wraps around a loot line. The
    ---itemID is the only part the module reads, but the surrounding cruft proves the
    ---`|Hitem:(%d+)` extraction copes with a real link rather than a bare number.
    ---@param itemID integer
    ---@return string
    local function link(itemID)
        return "|cffa335ee|Hitem:" .. itemID .. "::::::::::::|h[Item " .. itemID .. "]|h|r"
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newSessionTally)
    end)

    describe("beginning and leaving a session", function()
        it("starts inactive before any session is begun", function()
            local tally = newTally()

            assert.is_false(tally.isActive())
        end)

        it("activates on begin", function()
            local tally = newTally()

            tally.begin(0)

            assert.is_true(tally.isActive())
        end)

        it("keeps the totals for display when the session is left", function()
            local tally = newTally()
            tally.begin(100)
            tally.money(600)

            tally.leave()

            local summary = tally.summary()
            assert.is_false(summary.active)
            assert.equal(500, summary.goldLooted)
        end)

        it("wipes the previous session's tally when a new one begins", function()
            local tally = newTally()
            tally.begin(100)
            tally.money(600)

            tally.begin(0)

            assert.equal(0, tally.summary().goldLooted)
        end)
    end)

    describe("gold looted", function()
        it("adds a positive wallet delta to the gold looted", function()
            local tally = newTally()
            tally.begin(100)

            tally.money(350)

            assert.equal(250, tally.summary().goldLooted)
        end)

        it("anchors the baseline to the money passed at begin, not to zero", function()
            local tally = newTally()
            tally.begin(1000)

            tally.money(1000)

            assert.equal(0, tally.summary().goldLooted)
        end)

        -- A repair or vendor purchase shrinks the wallet mid-run; that dip must not be
        -- subtracted from gold looted, only re-baselined, so later gains still count in full.
        it("treats a wallet dip as a re-baseline rather than negative loot", function()
            local tally = newTally()
            tally.begin(100)

            tally.money(50) -- spent 50 at a repair vendor
            tally.money(150) -- then looted back up

            assert.equal(100, tally.summary().goldLooted)
        end)

        it("sums several positive deltas across the session", function()
            local tally = newTally()
            tally.begin(0)

            tally.money(30)
            tally.money(80)

            assert.equal(80, tally.summary().goldLooted)
        end)

        it("ignores money changes while inactive", function()
            local tally = newTally()

            tally.money(500)

            assert.equal(0, tally.summary().goldLooted)
        end)
    end)

    describe("net gold difference", function()
        it("is zero when the wallet never moved", function()
            local tally = newTally()
            tally.begin(1000)

            assert.equal(0, tally.summary().goldDiff)
        end)

        it("reports the net change from the opening wallet", function()
            local tally = newTally()
            tally.begin(1000)

            tally.money(2500)

            assert.equal(1500, tally.summary().goldDiff)
        end)

        -- Unlike gold looted, the net diff goes below the opening wallet: a repair the
        -- player never earned back leaves the session down on the day.
        it("goes negative when the session ends poorer than it began", function()
            local tally = newTally()
            tally.begin(1000)

            tally.money(300) -- a 700 repair bill, nothing looted back

            assert.equal(-700, tally.summary().goldDiff)
        end)

        it("tracks the latest wallet across several moves", function()
            local tally = newTally()
            tally.begin(1000)

            tally.money(1500)
            tally.money(1200)

            assert.equal(200, tally.summary().goldDiff)
        end)
    end)

    describe("item value looted", function()
        it("adds a single item's vendor price at quantity one", function()
            local tally = newTally({ prices = { [4242] = 75 } })
            tally.begin(0)

            tally.loot("You receive loot: " .. link(4242) .. ".")

            assert.equal(75, tally.summary().itemValue)
        end)

        it("multiplies the vendor price by the looted quantity", function()
            local tally = newTally({ prices = { [4242] = 75 } })
            tally.begin(0)

            tally.loot("You receive loot: " .. link(4242) .. "x3.")

            assert.equal(225, tally.summary().itemValue)
        end)

        it("adds nothing for a message that is not a self-loot line", function()
            local tally = newTally({ prices = { [4242] = 75 } })
            tally.begin(0)

            tally.loot("Thrall receives loot: " .. link(4242) .. ".")

            assert.equal(0, tally.summary().itemValue)
        end)

        -- The client cannot always price an item straight away (its data may not be
        -- cached yet); an unknown price contributes zero rather than erroring.
        it("adds zero when the item has no known sell price", function()
            local tally = newTally({ prices = {} })
            tally.begin(0)

            tally.loot("You receive loot: " .. link(9999) .. "x4.")

            assert.equal(0, tally.summary().itemValue)
        end)

        it("ignores loot while inactive", function()
            local tally = newTally({ prices = { [4242] = 75 } })

            tally.loot("You receive loot: " .. link(4242) .. ".")

            assert.equal(0, tally.summary().itemValue)
        end)
    end)

    describe("reputation earned", function()
        it("records a faction gain from a reputation-increase line", function()
            local tally = newTally()
            tally.begin(0)

            tally.reputation("Your Argent Dawn reputation has increased by 250.")

            assert.same({ { faction = "Argent Dawn", amount = 250 } }, tally.summary().reputation)
        end)

        it("sums repeated gains for the same faction", function()
            local tally = newTally()
            tally.begin(0)

            tally.reputation("Your Argent Dawn reputation has increased by 250.")
            tally.reputation("Your Argent Dawn reputation has increased by 75.")

            assert.same({ { faction = "Argent Dawn", amount = 325 } }, tally.summary().reputation)
        end)

        it("keeps different factions apart and sorts them by name", function()
            local tally = newTally()
            tally.begin(0)

            tally.reputation("Your Timbermaw Hold reputation has increased by 10.")
            tally.reputation("Your Argent Dawn reputation has increased by 20.")

            assert.same({
                { faction = "Argent Dawn", amount = 20 },
                { faction = "Timbermaw Hold", amount = 10 },
            }, tally.summary().reputation)
        end)

        it("totals reputation across every faction", function()
            local tally = newTally()
            tally.begin(0)

            tally.reputation("Your Timbermaw Hold reputation has increased by 10.")
            tally.reputation("Your Argent Dawn reputation has increased by 20.")

            assert.equal(30, tally.summary().reputationTotal)
        end)

        it("ignores reputation while inactive", function()
            local tally = newTally()

            tally.reputation("Your Argent Dawn reputation has increased by 250.")

            assert.same({}, tally.summary().reputation)
        end)
    end)

    describe("currency earned", function()
        it("records a currency change under its type", function()
            local tally = newTally()
            tally.begin(0)

            tally.currency(1166, 15, "Timewarped Badge")

            assert.same({ { id = 1166, name = "Timewarped Badge", amount = 15 } }, tally.summary().currencies)
        end)

        it("sums repeated changes for the same currency", function()
            local tally = newTally()
            tally.begin(0)

            tally.currency(1166, 15, "Timewarped Badge")
            tally.currency(1166, 5, "Timewarped Badge")

            assert.same({ { id = 1166, name = "Timewarped Badge", amount = 20 } }, tally.summary().currencies)
        end)

        it("keeps a currency spend as a negative amount", function()
            local tally = newTally()
            tally.begin(0)

            tally.currency(1166, 50, "Timewarped Badge")
            tally.currency(1166, -30, "Timewarped Badge")

            assert.equal(20, tally.summary().currencies[1].amount)
        end)

        it("keeps different currencies apart and sorts them by name", function()
            local tally = newTally()
            tally.begin(0)

            tally.currency(2, 3, "Valor")
            tally.currency(1, 7, "Honor")

            assert.same({
                { id = 1, name = "Honor", amount = 7 },
                { id = 2, name = "Valor", amount = 3 },
            }, tally.summary().currencies)
        end)

        it("totals the signed change across every currency", function()
            local tally = newTally()
            tally.begin(0)

            tally.currency(1, 7, "Honor")
            tally.currency(2, -2, "Valor")

            assert.equal(5, tally.summary().currencyTotal)
        end)

        it("falls back to the type id when no name is given", function()
            local tally = newTally()
            tally.begin(0)

            tally.currency(1166, 15, nil)

            assert.equal("1166", tally.summary().currencies[1].name)
        end)

        -- A later update may carry the localised name the first change lacked.
        it("upgrades a placeholder name when a later change names the currency", function()
            local tally = newTally()
            tally.begin(0)
            tally.currency(1166, 15, nil)

            tally.currency(1166, 5, "Timewarped Badge")

            assert.equal("Timewarped Badge", tally.summary().currencies[1].name)
        end)

        it("ignores a zero change", function()
            local tally = newTally()
            tally.begin(0)

            tally.currency(1166, 0, "Timewarped Badge")

            assert.same({}, tally.summary().currencies)
        end)

        it("ignores currency while inactive", function()
            local tally = newTally()

            tally.currency(1166, 15, "Timewarped Badge")

            assert.same({}, tally.summary().currencies)
        end)
    end)

    describe("achievements earned", function()
        it("appends an achievement with its identity and time", function()
            local tally = newTally()
            tally.begin(0)

            tally.achievement(1234, "The Loremaster", 5000)

            assert.same({ { id = 1234, name = "The Loremaster", at = 5000 } }, tally.summary().achievements)
        end)

        it("keeps achievements in the order they were earned", function()
            local tally = newTally()
            tally.begin(0)

            tally.achievement(1, "First", 100)
            tally.achievement(2, "Second", 200)

            local achievements = tally.summary().achievements
            assert.equal("First", achievements[1].name)
            assert.equal("Second", achievements[2].name)
        end)

        it("falls back to the id when no name is given", function()
            local tally = newTally()
            tally.begin(0)

            tally.achievement(1234, nil, 5000)

            assert.equal("1234", tally.summary().achievements[1].name)
        end)

        it("ignores achievements while inactive", function()
            local tally = newTally()

            tally.achievement(1234, "The Loremaster", 5000)

            assert.same({}, tally.summary().achievements)
        end)
    end)

    describe("levels gained", function()
        it("appends the new level and its time", function()
            local tally = newTally()
            tally.begin(0)

            tally.levelUp(42, 5000)

            assert.same({ { level = 42, at = 5000 } }, tally.summary().levelUps)
        end)

        it("ignores level ups while inactive", function()
            local tally = newTally()

            tally.levelUp(42, 5000)

            assert.same({}, tally.summary().levelUps)
        end)
    end)

    describe("transmog events", function()
        it("records every newly collected item with its acquisition time", function()
            local tally = newTally()
            tally.begin(0)

            tally.transmog(19019, 1234)
            tally.transmog(17182, 1235)

            assert.same({
                { id = 19019, at = 1234 },
                { id = 17182, at = 1235 },
            }, tally.summary().transmogs)
        end)

        it("ignores transmog while inactive", function()
            local tally = newTally()

            tally.transmog(19019, 1234)
            assert.same({}, tally.summary().transmogs)
        end)
    end)

    describe("quests completed", function()
        it("records every quest with its id and completion time", function()
            local tally = newTally()
            tally.begin(0)

            tally.quest(7848, 5000)
            tally.quest(7849, 5001)

            assert.same({
                { id = 7848, at = 5000 },
                { id = 7849, at = 5001 },
            }, tally.summary().quests)
        end)

        it("keeps first-completion scope and the quest name when known", function()
            local tally = newTally()
            tally.begin(0)

            tally.quest(7848, 5000, "A Hunter's Challenge", true, false)

            assert.same({
                {
                    id = 7848,
                    name = "A Hunter's Challenge",
                    at = 5000,
                    characterFirst = true,
                    accountFirst = false,
                },
            }, tally.summary().quests)
        end)

        it("ignores quests while inactive", function()
            local tally = newTally()

            tally.quest(7848, 5000)

            assert.same({}, tally.summary().quests)
        end)
    end)

    describe("mount, pet and toy collections", function()
        it("records named collection entries and the pet GUID", function()
            local tally = newTally()
            tally.begin(0)

            tally.mount(123, "Alabaster Hyena", 100)
            tally.pet(456, "Darkmoon Rabbit", 101, "BattlePet-0-1")
            tally.toy(789, "Katy's Stampwhistle", 102)

            local summary = tally.summary()
            assert.same({ { id = 123, name = "Alabaster Hyena", at = 100 } }, summary.mounts)
            assert.same({
                { id = 456, name = "Darkmoon Rabbit", at = 101, guid = "BattlePet-0-1" },
            }, summary.pets)
            assert.same({ { id = 789, name = "Katy's Stampwhistle", at = 102 } }, summary.toys)
            assert.is_true(tally.hasEvents())
        end)

        it("ignores collection events while inactive", function()
            local tally = newTally()

            tally.mount(1, "Mount", 100)
            tally.pet(2, "Pet", 100)
            tally.toy(3, "Toy", 100)

            assert.same({}, tally.summary().mounts)
            assert.same({}, tally.summary().pets)
            assert.same({}, tally.summary().toys)
        end)
    end)

    describe("hasEvents", function()
        it("is false for a session where nothing happened", function()
            local tally = newTally()
            tally.begin(1000)

            assert.is_false(tally.hasEvents())
        end)

        it("is true once gold is looted", function()
            local tally = newTally()
            tally.begin(0)
            tally.money(500)

            assert.is_true(tally.hasEvents())
        end)

        it("is true once the wallet nets a loss", function()
            local tally = newTally()
            tally.begin(1000)
            tally.money(300)

            assert.is_true(tally.hasEvents())
        end)

        it("is true once an item is looted", function()
            local tally = newTally({ prices = { [4242] = 75 } })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(4242) .. ".")

            assert.is_true(tally.hasEvents())
        end)

        it("is true once reputation is earned", function()
            local tally = newTally()
            tally.begin(0)
            tally.reputation("Your Argent Dawn reputation has increased by 20.")

            assert.is_true(tally.hasEvents())
        end)

        it("is true once currency changes", function()
            local tally = newTally()
            tally.begin(0)
            tally.currency(1166, 15, "Timewarped Badge")

            assert.is_true(tally.hasEvents())
        end)

        it("is true once an achievement is earned", function()
            local tally = newTally()
            tally.begin(0)
            tally.achievement(1, "First", 100)

            assert.is_true(tally.hasEvents())
        end)

        it("is true once a level is gained", function()
            local tally = newTally()
            tally.begin(0)
            tally.levelUp(42, 100)

            assert.is_true(tally.hasEvents())
        end)

        it("is true once a quest is completed", function()
            local tally = newTally()
            tally.begin(0)
            tally.quest(7848, 100)

            assert.is_true(tally.hasEvents())
        end)

        -- A currency that is earned then wholly spent nets to zero, but the session did
        -- see the currency move, so it is still worth keeping.
        it("stays true for a currency that nets back to zero", function()
            local tally = newTally()
            tally.begin(0)
            tally.currency(1166, 30, "Timewarped Badge")
            tally.currency(1166, -30, "Timewarped Badge")

            assert.is_true(tally.hasEvents())
        end)
    end)

    describe("summary", function()
        it("reports the active flag", function()
            local tally = newTally()
            tally.begin(0)

            assert.is_true(tally.summary().active)
        end)

        it("uses only items entering inventory for loot value", function()
            local tally = newTally({ prices = { [4242] = 200 } })
            tally.begin(0)
            tally.money(300)
            tally.loot("You receive loot: " .. link(4242) .. "x2.")

            local summary = tally.summary()
            assert.equal(300, summary.goldLooted)
            assert.equal(400, summary.itemValue)
            assert.equal(400, summary.lootValue)
        end)

        it("hands back empty lists on a fresh session", function()
            local tally = newTally()
            tally.begin(0)

            local summary = tally.summary()
            assert.same({}, summary.reputation)
            assert.same({}, summary.currencies)
            assert.same({}, summary.achievements)
            assert.same({}, summary.levelUps)
            assert.same({}, summary.mounts)
            assert.same({}, summary.pets)
            assert.same({}, summary.transmogs)
            assert.same({}, summary.quests)
            assert.same({}, summary.toys)
        end)

        it("carries every tally onto one summary table", function()
            local tally = newTally({
                prices = { [4242] = 50 },
            })
            tally.begin(100)
            tally.money(200)
            tally.loot("You receive loot: " .. link(4242) .. ".")
            tally.transmog(19019, 450)
            tally.reputation("Your Argent Dawn reputation has increased by 30.")
            tally.currency(1166, 15, "Timewarped Badge")
            tally.achievement(1, "First", 500)
            tally.levelUp(42, 525)
            tally.quest(7848, 550)

            assert.same({
                active = true,
                lootValue = 50,
                goldLooted = 100,
                itemValue = 50,
                goldDiff = 100,
                transmogs = { { id = 19019, at = 450 } },
                currencyTotal = 15,
                currencies = { { id = 1166, name = "Timewarped Badge", amount = 15 } },
                reputationTotal = 30,
                reputation = { { faction = "Argent Dawn", amount = 30 } },
                achievements = { { id = 1, name = "First", at = 500 } },
                levelUps = { { level = 42, at = 525 } },
                mounts = {},
                pets = {},
                quests = { { id = 7848, at = 550 } },
                toys = {},
            }, tally.summary())
        end)
    end)
end)

describe("ns.formatMoney", function()
    local ns = loader.load()

    it("is exported by the addon files", function()
        assert.is_function(ns.formatMoney)
    end)

    it("always shows copper, even for an empty haul", function()
        assert.equal("0c", ns.formatMoney(0))
    end)

    it("treats a nil amount as zero copper", function()
        assert.equal("0c", ns.formatMoney(nil))
    end)

    it("shows copper alone below one silver", function()
        assert.equal("50c", ns.formatMoney(50))
    end)

    it("drops the higher zero denominations but keeps silver and copper", function()
        assert.equal("3s 5c", ns.formatMoney(305))
    end)

    it("renders gold, silver and copper together", function()
        assert.equal("123g 45s 67c", ns.formatMoney(1234567))
    end)

    -- Once gold is on show, a zero silver is kept so the reading is not "1g 5c", which
    -- would misread as more than it is; the client pads the lower denominations in.
    it("keeps a zero silver once gold is present", function()
        assert.equal("1g 0s 5c", ns.formatMoney(10005))
    end)

    it("rounds a fractional copper to the nearest whole", function()
        assert.equal("1s 50c", ns.formatMoney(149.5))
    end)

    it("rounds a fraction below the half down", function()
        assert.equal("0c", ns.formatMoney(0.4))
    end)

    -- A session can end down on gold; the sign has to survive the format so a loss does
    -- not read as a gain.
    it("keeps the sign of a negative amount", function()
        assert.equal("-1g 0s 0c", ns.formatMoney(-10000))
        assert.equal("-50c", ns.formatMoney(-50))
    end)
end)
