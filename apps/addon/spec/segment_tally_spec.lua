local loader = require("addon_loader")

describe("ns.newSegmentTally", function()
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

    ---Every self-loot template Main.lua hands the tally, in the order it hands them over:
    ---each _MULTIPLE variant ahead of its singular partner. Verbatim from the enUS globals.
    local ALL_LOOT_FORMATS = {
        "You receive loot: %sx%d.",
        "You receive loot: %s.",
        "You receive item: %sx%d.",
        "You receive item: %s.",
        "You receive bonus loot: %sx%d.",
        "You receive bonus loot: %s.",
    }

    ---The three ways an item can land in the player's own bags, each with the wording the
    ---client uses for it: ordinary loot, anything pushed straight to a bag (a quest reward,
    ---a container's contents), and a bonus roll.
    local LOOT_WORDINGS = {
        { name = "an ordinary loot line", prefix = "You receive loot: " },
        { name = "a pushed-loot line", prefix = "You receive item: " },
        { name = "a bonus-loot line", prefix = "You receive bonus loot: " },
    }

    ---Build the tally directly with fake seams, mirroring how lockout_store_spec builds
    ---the store: no frames, no Main, just the pure module and injected dependencies.
    ---`factions` maps a faction name to the standing the client reports for it, or to a
    ---list of standings to hand back one per call, which is how a faction that levels up
    ---part way through a segment is modelled.
    ---@param options table? `{ prices, lootFormats, factionFormats, factions }`
    ---@return SegmentTally
    local function newTally(options)
        options = options or {}
        local prices = options.prices or {}
        local factions = options.factions or {}
        local asked = {}
        return ns.newSegmentTally({
            lootFormats = options.lootFormats or LOOT_FORMATS,
            factionFormats = options.factionFormats or FACTION_FORMATS,
            itemSellPrice = function(itemID)
                return prices[itemID]
            end,
            factionState = function(faction)
                local state = factions[faction]
                if type(state) ~= "table" or state.standing ~= nil or state.max ~= nil then
                    return state
                end
                asked[faction] = (asked[faction] or 0) + 1
                return state[math.min(asked[faction], #state)]
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
        assert.is_function(ns.newSegmentTally)
    end)

    describe("beginning and leaving a segment", function()
        it("starts inactive before any segment is begun", function()
            local tally = newTally()

            assert.is_false(tally.isActive())
        end)

        it("activates on begin", function()
            local tally = newTally()

            tally.begin(0)

            assert.is_true(tally.isActive())
        end)

        it("keeps the totals for display when the segment is left", function()
            local tally = newTally()
            tally.begin(100)
            tally.money(600)

            tally.leave()

            local summary = tally.summary()
            assert.is_false(summary.active)
            assert.equal(500, summary.goldLooted)
        end)

        it("wipes the previous segment's tally when a new one begins", function()
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

        it("sums several positive deltas across the segment", function()
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
        -- player never earned back leaves the segment down on the day.
        it("goes negative when the segment ends poorer than it began", function()
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

    describe("every self-loot template the client can word a drop with", function()
        for _, wording in ipairs(LOOT_WORDINGS) do
            it("counts a single item's vendor value from " .. wording.name, function()
                local tally = newTally({ prices = { [4242] = 75 }, lootFormats = ALL_LOOT_FORMATS })
                tally.begin(0)

                tally.loot(wording.prefix .. link(4242) .. ".")

                assert.equal(75, tally.summary().itemValue)
            end)

            -- The ordering guard. The singular "...: %s." pattern also matches a stacked
            -- line, swallowing the "x3" into the item capture, so a stack of three would be
            -- counted as one unless the _MULTIPLE variant is offered first.
            it("counts a stack of three from " .. wording.name .. " as three, not one", function()
                local tally = newTally({ prices = { [4242] = 75 }, lootFormats = ALL_LOOT_FORMATS })
                tally.begin(0)

                tally.loot(wording.prefix .. link(4242) .. "x3.")

                assert.equal(225, tally.summary().itemValue)
                assert.are_not.equal(75, tally.summary().itemValue)
            end)
        end

        it("counts a haul that arrived through all three wordings at once", function()
            local tally = newTally({ prices = { [4242] = 10 }, lootFormats = ALL_LOOT_FORMATS })
            tally.begin(0)

            tally.loot("You receive loot: " .. link(4242) .. ".")
            tally.loot("You receive item: " .. link(4242) .. "x2.")
            tally.loot("You receive bonus loot: " .. link(4242) .. "x3.")

            assert.equal(60, tally.summary().itemValue)
        end)
    end)

    describe("loot the client has not cached a price for yet", function()
        it("counts nothing at loot time, rather than booking the item as worthless", function()
            local prices = {}
            local tally = newTally({ prices = prices })
            tally.begin(0)

            tally.loot("You receive loot: " .. link(9999) .. "x2.")

            assert.equal(0, tally.summary().lootValue)
        end)

        it("folds the parked value in once the client answers with a price", function()
            local prices = {}
            local tally = newTally({ prices = prices })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. ".")

            prices[9999] = 60
            tally.itemInfoReceived(9999)

            assert.equal(60, tally.summary().lootValue)
        end)

        it("honours the stack quantity the parked loot line carried", function()
            local prices = {}
            local tally = newTally({ prices = prices })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. "x4.")

            prices[9999] = 25
            tally.itemInfoReceived(9999)

            assert.equal(100, tally.summary().lootValue)
        end)

        -- The client answers a given item once however many times it was looted, so both
        -- parked lines have to be settled by that single answer.
        it("resolves two parked loots of the same item on one answer", function()
            local prices = {}
            local tally = newTally({ prices = prices })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. ".")
            tally.loot("You receive loot: " .. link(9999) .. "x3.")

            prices[9999] = 10
            tally.itemInfoReceived(9999)

            assert.equal(40, tally.summary().lootValue)
        end)

        it("resolves parked items independently of one another", function()
            local prices = {}
            local tally = newTally({ prices = prices })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(1111) .. ".")
            tally.loot("You receive loot: " .. link(2222) .. ".")

            prices[1111] = 40
            prices[2222] = 75
            tally.itemInfoReceived(1111)
            assert.equal(40, tally.summary().lootValue)

            tally.itemInfoReceived(2222)
            assert.equal(115, tally.summary().lootValue)
        end)

        -- The event fires for every item the client loads, most of which this segment
        -- never looted; an answer nobody is waiting on must change nothing.
        it("changes nothing for an item that was never parked", function()
            local tally = newTally({ prices = { [4242] = 75, [9999] = 500 } })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(4242) .. ".")

            tally.itemInfoReceived(9999)

            assert.equal(75, tally.summary().lootValue)
        end)

        it("does not count a parked item twice when the answer arrives again", function()
            local prices = {}
            local tally = newTally({ prices = prices })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. "x2.")

            prices[9999] = 30
            tally.itemInfoReceived(9999)
            tally.itemInfoReceived(9999)

            assert.equal(60, tally.summary().lootValue)
        end)

        it("adds nothing when the price is still unavailable on the second look", function()
            local tally = newTally({ prices = {} })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. "x2.")

            tally.itemInfoReceived(9999)

            assert.equal(0, tally.summary().lootValue)
        end)

        -- Treating that still-missing price as zero has to drop the entry too, or a later
        -- answer for the same item would count a haul the tally already settled.
        it("drops the entry when the price is still unavailable, so it cannot count later", function()
            local prices = {}
            local tally = newTally({ prices = prices })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. "x2.")
            tally.itemInfoReceived(9999)

            prices[9999] = 30
            tally.itemInfoReceived(9999)

            assert.equal(0, tally.summary().lootValue)
        end)

        -- Parked loot outlives the loot line itself, so a segment boundary has to clear it
        -- or the previous zone's unpriced drop would be booked against the next one.
        it("clears parked items on begin, so they cannot leak into the next segment", function()
            local prices = {}
            local tally = newTally({ prices = prices })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. "x2.")

            tally.begin(0)
            prices[9999] = 30
            tally.itemInfoReceived(9999)

            assert.equal(0, tally.summary().lootValue)
        end)

        it("ignores an answer that arrives once the segment is over", function()
            local prices = {}
            local tally = newTally({ prices = prices })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. "x2.")
            tally.leave()

            prices[9999] = 30
            tally.itemInfoReceived(9999)

            assert.equal(0, tally.summary().lootValue)
        end)

        it("ignores an answer while no segment was ever begun", function()
            local tally = newTally({ prices = { [9999] = 30 } })

            assert.has_no.errors(function()
                tally.itemInfoReceived(9999)
            end)
            assert.equal(0, tally.summary().lootValue)
        end)

        it("ignores an answer with no item id at all", function()
            local tally = newTally({ prices = {} })
            tally.begin(0)

            assert.has_no.errors(function()
                tally.itemInfoReceived(nil)
            end)
            assert.equal(0, tally.summary().lootValue)
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

        it("records where the character now stands with the faction", function()
            local tally = newTally({
                factions = {
                    ["Argent Dawn"] = { standing = "Honored", current = 3000, max = 12000 },
                },
            })
            tally.begin(0)

            tally.reputation("Your Argent Dawn reputation has increased by 250.")

            assert.same({
                {
                    faction = "Argent Dawn",
                    amount = 250,
                    standing = "Honored",
                    current = 3000,
                    max = 12000,
                },
            }, tally.summary().reputation)
        end)

        -- The standing is a running state, not a property of one gain: a segment that
        -- carries a faction into the next level should report the level it ended on.
        it("keeps the standing read at the last gain, not the first", function()
            local tally = newTally({
                factions = {
                    ["Argent Dawn"] = {
                        { standing = "Friendly", current = 5900, max = 6000 },
                        { standing = "Honored", current = 150, max = 12000 },
                    },
                },
            })
            tally.begin(0)

            tally.reputation("Your Argent Dawn reputation has increased by 100.")
            tally.reputation("Your Argent Dawn reputation has increased by 150.")

            local gain = tally.summary().reputation[1]
            assert.equal(250, gain.amount)
            assert.equal("Honored", gain.standing)
            assert.equal(150, gain.current)
            assert.equal(12000, gain.max)
        end)

        -- The client can go quiet about a faction it answered for a moment earlier; the
        -- standing already read is still true, and dropping it would take the bar away.
        it("keeps the last standing the client gave when a later gain gets none", function()
            local answers = { { standing = "Honored", current = 3000, max = 12000 } }
            local tally = ns.newSegmentTally({
                factionFormats = FACTION_FORMATS,
                factionState = function()
                    return table.remove(answers, 1)
                end,
            })
            tally.begin(0)
            tally.reputation("Your Argent Dawn reputation has increased by 100.")

            tally.reputation("Your Argent Dawn reputation has increased by 150.")

            local gain = tally.summary().reputation[1]
            assert.equal(250, gain.amount)
            assert.equal("Honored", gain.standing)
        end)

        it("leaves the standing absent for a faction the client cannot place", function()
            local tally = newTally()
            tally.begin(0)

            tally.reputation("Your Argent Dawn reputation has increased by 250.")

            assert.same({ { faction = "Argent Dawn", amount = 250 } }, tally.summary().reputation)
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

        it("records what the character holds once the change has landed", function()
            local tally = newTally()
            tally.begin(0)

            tally.currency(1166, 15, "Timewarped Badge", 30)

            assert.same(
                { { id = 1166, name = "Timewarped Badge", amount = 15, total = 30 } },
                tally.summary().currencies
            )
        end)

        it("keeps the holding reported by the most recent change", function()
            local tally = newTally()
            tally.begin(0)

            tally.currency(1166, 15, "Timewarped Badge", 30)
            tally.currency(1166, -10, "Timewarped Badge", 20)

            local gain = tally.summary().currencies[1]
            assert.equal(5, gain.amount)
            assert.equal(20, gain.total)
        end)

        -- An older client build hands the event no quantity at all; the gain is still
        -- worth recording, just without a holding beside it.
        it("leaves the holding absent when the client reported none", function()
            local tally = newTally()
            tally.begin(0)

            tally.currency(1166, 15, "Timewarped Badge")

            assert.is_nil(tally.summary().currencies[1].total)
        end)
    end)

    describe("currency items", function()
        it("records a gain when the owned total rises above the segment baseline", function()
            local tally = newTally()
            tally.begin(0, { [5001] = 40 })

            tally.currencyItem(5001, 55, "Bloody Token")

            assert.same(
                { { id = 5001, name = "Bloody Token", amount = 15, total = 55 } },
                tally.summary().currencies
            )
        end)

        it("records a spend when the owned total falls below the baseline", function()
            local tally = newTally()
            tally.begin(0, { [5001] = 40 })

            tally.currencyItem(5001, 25, "Bloody Token")

            assert.equal(-15, tally.summary().currencies[1].amount)
        end)

        -- Depositing into or withdrawing from the bank moves the item between stores the
        -- grand total already spans, so the total is flat and nothing should be recorded.
        it("records nothing when a bank move leaves the total unchanged", function()
            local tally = newTally()
            tally.begin(0, { [5001] = 40 })

            tally.currencyItem(5001, 40, "Bloody Token")

            assert.same({}, tally.summary().currencies)
        end)

        -- Tracking an item mid-segment leaves it unseeded by begin(); the first sight then
        -- only anchors the baseline, so holdings that predate the choice are not booked.
        it("adopts an unseeded item's first total as its baseline, counting nothing", function()
            local tally = newTally()
            tally.begin(0)

            tally.currencyItem(5001, 12, "Bloody Token")

            assert.same({}, tally.summary().currencies)
        end)

        it("counts changes after an unseeded item is first anchored", function()
            local tally = newTally()
            tally.begin(0)
            tally.currencyItem(5001, 12, "Bloody Token")

            tally.currencyItem(5001, 20, "Bloody Token")

            assert.equal(8, tally.summary().currencies[1].amount)
        end)

        it("accumulates a run of gains and spends from the baseline", function()
            local tally = newTally()
            tally.begin(0, { [5001] = 10 })

            tally.currencyItem(5001, 20, "Bloody Token")
            tally.currencyItem(5001, 15, "Bloody Token")

            assert.equal(5, tally.summary().currencies[1].amount)
        end)

        it("folds item and real currencies into one sorted list", function()
            local tally = newTally()
            tally.begin(0, { [5001] = 0 })

            tally.currency(1, 7, "Honor")
            tally.currencyItem(5001, 3, "Bloody Token")

            assert.same({
                { id = 5001, name = "Bloody Token", amount = 3, total = 3 },
                { id = 1, name = "Honor", amount = 7 },
            }, tally.summary().currencies)
        end)

        it("upgrades a placeholder name when a later update names the item", function()
            local tally = newTally()
            tally.begin(0, { [5001] = 0 })
            tally.currencyItem(5001, 5, nil)

            tally.currencyItem(5001, 8, "Bloody Token")

            assert.equal("Bloody Token", tally.summary().currencies[1].name)
        end)

        it("ignores currency items while inactive", function()
            local tally = newTally()

            tally.currencyItem(5001, 20, "Bloody Token")

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

    describe("housing items", function()
        it("records a warband-first item with its identity, time and scope", function()
            local tally = newTally()
            tally.begin(0)

            tally.housingItem(4001, "Sturdy Oak Chair", 5000, true)

            assert.same({
                { id = 4001, name = "Sturdy Oak Chair", at = 5000, warbandFirst = true },
            }, tally.summary().housingItems)
        end)

        it("marks a duplicate item as not a warband first", function()
            local tally = newTally()
            tally.begin(0)

            tally.housingItem(4001, "Sturdy Oak Chair", 5000, false)

            assert.is_false(tally.summary().housingItems[1].warbandFirst)
        end)

        it("treats a missing scope as an additional copy", function()
            local tally = newTally()
            tally.begin(0)

            tally.housingItem(4001, "Sturdy Oak Chair", 5000)

            assert.is_false(tally.summary().housingItems[1].warbandFirst)
        end)

        it("falls back to the id when no name is given", function()
            local tally = newTally()
            tally.begin(0)

            tally.housingItem(4001, nil, 5000, true)

            assert.equal("4001", tally.summary().housingItems[1].name)
        end)

        it("keeps housing items in acquisition order", function()
            local tally = newTally()
            tally.begin(0)

            tally.housingItem(1, "First", 100, true)
            tally.housingItem(2, "Second", 200, false)

            local items = tally.summary().housingItems
            assert.equal("First", items[1].name)
            assert.equal("Second", items[2].name)
        end)

        it("ignores housing items while inactive", function()
            local tally = newTally()

            tally.housingItem(4001, "Sturdy Oak Chair", 5000, true)

            assert.same({}, tally.summary().housingItems)
        end)
    end)

    describe("housing experience", function()
        it("sums housing experience gains over the segment", function()
            local tally = newTally()
            tally.begin(0)

            tally.housingXP(120)
            tally.housingXP(80)

            assert.equal(200, tally.summary().housingXP)
        end)

        it("ignores a zero gain", function()
            local tally = newTally()
            tally.begin(0)

            tally.housingXP(0)

            assert.equal(0, tally.summary().housingXP)
        end)

        it("ignores housing experience while inactive", function()
            local tally = newTally()

            tally.housingXP(120)

            assert.equal(0, tally.summary().housingXP)
        end)
    end)

    describe("housing levels gained", function()
        it("appends the new housing level and its time", function()
            local tally = newTally()
            tally.begin(0)

            tally.housingLevelUp(3, 5000)

            assert.same({ { level = 3, at = 5000 } }, tally.summary().housingLevelUps)
        end)

        it("ignores housing level ups while inactive", function()
            local tally = newTally()

            tally.housingLevelUp(3, 5000)

            assert.same({}, tally.summary().housingLevelUps)
        end)
    end)

    describe("boss encounters", function()
        ---@param overrides table?
        ---@return EncounterEvent
        local function encounter(overrides)
            local base = {
                id = 745, name = "Flame Leviathan", at = 5000,
                difficultyId = 4, groupSize = 25, success = true,
            }
            for key, value in pairs(overrides or {}) do
                base[key] = value
            end
            return base
        end

        it("appends a kill with everything the client reported about it", function()
            local tally = newTally()
            tally.begin(0)

            tally.encounter(encounter())

            assert.same({ encounter() }, tally.summary().encounters)
        end)

        -- Wipes are the whole point of keeping both outcomes: a night of eight pulls and
        -- one kill is a progression raid, while eight kills and no wipes is a farm clear.
        it("keeps wipes alongside kills, in the order they ended", function()
            local tally = newTally()
            tally.begin(0)

            tally.encounter(encounter({ at = 5000, success = false }))
            tally.encounter(encounter({ at = 5100, success = false }))
            tally.encounter(encounter({ at = 5200, success = true }))

            local encounters = tally.summary().encounters
            assert.equal(3, #encounters)
            assert.same({ false, false, true }, {
                encounters[1].success, encounters[2].success, encounters[3].success,
            })
        end)

        it("normalises the client's truthy success flag to a boolean", function()
            local tally = newTally()
            tally.begin(0)

            tally.encounter(encounter({ success = 1 }))
            -- No success at all: a wipe is exactly how the addon should read that.
            tally.encounter({ id = 745, at = 5100 })

            local encounters = tally.summary().encounters
            assert.is_true(encounters[1].success)
            assert.is_false(encounters[2].success)
        end)

        it("ignores an encounter with no id, and any encounter while inactive", function()
            local tally = newTally()
            tally.begin(0)
            tally.encounter({ name = "Flame Leviathan", at = 5000, success = true })
            tally.leave()
            tally.encounter(encounter())

            assert.same({}, tally.summary().encounters)
        end)
    end)

    describe("mythic keystone runs", function()
        it("records the key's level, map and affixes when the run starts", function()
            local tally = newTally()
            tally.begin(0)

            tally.keystoneStart({ level = 14, mapId = 501, affixes = { 9, 6 } }, 5000)

            assert.same({
                level = 14, mapId = 501, affixes = { 9, 6 },
                startedAt = 5000, completed = false,
            }, tally.summary().keystone)
        end)

        it("copies the affix list rather than aliasing the caller's table", function()
            local tally = newTally()
            tally.begin(0)
            local affixes = { 9, 6 }

            tally.keystoneStart({ level = 14, affixes = affixes }, 5000)
            affixes[1] = 148

            assert.same({ 9, 6 }, tally.summary().keystone.affixes)
        end)

        it("folds the completion report onto the open run", function()
            local tally = newTally()
            tally.begin(0)
            tally.keystoneStart({ level = 14, mapId = 501 }, 5000)

            tally.keystoneComplete({
                level = 14, mapId = 501, durationMs = 1740000, onTime = true, upgrades = 1,
            }, 6800)

            assert.same({
                level = 14, mapId = 501, startedAt = 5000, completedAt = 6800,
                completed = true, durationMs = 1740000, onTime = true, upgrades = 1,
            }, tally.summary().keystone)
        end)

        -- Zoning into a key already in progress means the start was never seen, but the
        -- completion report carries everything that matters, so the run is still recorded.
        it("records a completion that arrived without a start", function()
            local tally = newTally()
            tally.begin(0)

            tally.keystoneComplete({ level = 12, mapId = 501, onTime = false, upgrades = 0 }, 6800)

            local keystone = tally.summary().keystone
            assert.equal(12, keystone.level)
            assert.is_true(keystone.completed)
            assert.is_false(keystone.onTime)
        end)

        it("keeps an abandoned run but strips its completion", function()
            local tally = newTally()
            tally.begin(0)
            tally.keystoneStart({ level = 14, mapId = 501 }, 5000)
            tally.keystoneComplete({ level = 14, durationMs = 1740000, onTime = true }, 6800)

            tally.keystoneReset()

            local keystone = tally.summary().keystone
            assert.equal(14, keystone.level)
            assert.is_false(keystone.completed)
            assert.is_nil(keystone.completedAt)
            assert.is_nil(keystone.durationMs)
            assert.is_nil(keystone.onTime)
        end)

        it("ignores a start with no level, and any keystone call while inactive", function()
            local tally = newTally()
            tally.begin(0)
            tally.keystoneStart({ mapId = 501 }, 5000)
            tally.leave()
            tally.keystoneStart({ level = 14 }, 5000)
            tally.keystoneComplete({ level = 14 }, 6800)

            assert.is_nil(tally.summary().keystone)
        end)
    end)

    describe("experience earned", function()
        ---@param baseline table? `{ level, xp, xpMax }` as the segment opens
        ---@return SegmentTally
        local function newLevellingTally(baseline)
            local tally = newTally()
            tally.begin(0, nil, baseline)
            return tally
        end

        it("counts nothing until experience actually moves", function()
            local tally = newLevellingTally({ level = 41, xp = 2000, xpMax = 10000 })

            assert.is_nil(tally.summary().experience)
            assert.is_false(tally.hasEvents())
        end)

        it("measures a gain inside one level against that level's maximum", function()
            local tally = newLevellingTally({ level = 41, xp = 2000, xpMax = 10000 })

            tally.experience(41, 4500, 10000)

            assert.same({
                gained = 2500, percent = 0.25, startLevel = 41, endLevel = 41,
            }, tally.summary().experience)
        end)

        it("accumulates across several updates", function()
            local tally = newLevellingTally({ level = 41, xp = 0, xpMax = 10000 })

            tally.experience(41, 1000, 10000)
            tally.experience(41, 3000, 10000)

            assert.equal(3000, tally.summary().experience.gained)
            -- A fraction of a level is a running sum of divisions, so it is compared with a
            -- tolerance; the points beside it are the exact figure.
            assert.near(0.3, tally.summary().experience.percent, 1e-9)
        end)

        -- Each side of a level boundary is measured against its own maximum, because the
        -- two levels do not cost the same and a single denominator would misreport both.
        it("splits a gain that crosses a level across both levels' maximums", function()
            local tally = newLevellingTally({ level = 41, xp = 8000, xpMax = 10000 })

            tally.experience(42, 3000, 20000)

            local experience = tally.summary().experience
            assert.equal(5000, experience.gained)
            assert.near(0.35, experience.percent, 1e-9)
            assert.equal(41, experience.startLevel)
            assert.equal(42, experience.endLevel)
        end)

        it("counts the levels skipped when several updates are missed at once", function()
            local tally = newLevellingTally({ level = 41, xp = 9000, xpMax = 10000 })

            tally.experience(44, 5000, 20000)

            local experience = tally.summary().experience
            -- 1000 to finish 41, two whole levels at the new maximum, then 5000 into 44.
            assert.equal(1000 + 2 * 20000 + 5000, experience.gained)
            assert.near(0.1 + 2 + 0.25, experience.percent, 1e-9)
        end)

        it("re-anchors rather than subtracting when experience goes backwards", function()
            local tally = newLevellingTally({ level = 41, xp = 5000, xpMax = 10000 })

            tally.experience(41, 1000, 10000)
            tally.experience(41, 3000, 10000)

            assert.equal(2000, tally.summary().experience.gained)
        end)

        -- Tracking that starts mid-segment has no baseline to measure against, so the
        -- first standing it sees becomes the baseline instead of being booked as a gain.
        it("adopts the first standing as the baseline when the segment opened without one", function()
            local tally = newTally()
            tally.begin(0)

            tally.experience(41, 6000, 10000)
            tally.experience(41, 7000, 10000)

            assert.equal(1000, tally.summary().experience.gained)
        end)

        it("ignores experience while inactive", function()
            local tally = newLevellingTally({ level = 41, xp = 0, xpMax = 10000 })
            tally.leave()

            tally.experience(41, 5000, 10000)

            assert.is_nil(tally.summary().experience)
        end)
    end)

    describe("hasEvents", function()
        it("is false for a segment where nothing happened", function()
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

        -- An unpriced drop is parked, not counted, so it has contributed nothing yet: a
        -- segment holding only that would be filed with an empty haul if it counted here.
        it("stays false while a looted item is parked awaiting its price", function()
            local tally = newTally({ prices = {} })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. "x2.")

            assert.is_false(tally.hasEvents())
        end)

        it("is true once the parked item is priced and folded in", function()
            local prices = {}
            local tally = newTally({ prices = prices })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. "x2.")

            prices[9999] = 30
            tally.itemInfoReceived(9999)

            assert.is_true(tally.hasEvents())
        end)

        -- A genuinely unsellable drop resolves to zero value, which is no more an event
        -- than the parked line was.
        it("stays false when the parked item turns out to be worthless", function()
            local tally = newTally({ prices = {} })
            tally.begin(0)
            tally.loot("You receive loot: " .. link(9999) .. "x2.")

            tally.itemInfoReceived(9999)

            assert.is_false(tally.hasEvents())
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

        it("is true once a currency item is gained", function()
            local tally = newTally()
            tally.begin(0, { [5001] = 40 })
            tally.currencyItem(5001, 45, "Bloody Token")

            assert.is_true(tally.hasEvents())
        end)

        -- Merely holding currency items when the segment opens is not an event; only a
        -- change against that baseline is, so the baseline alone must leave hasEvents false.
        it("stays false when currency items are only baselined", function()
            local tally = newTally()
            tally.begin(0, { [5001] = 40 })

            assert.is_false(tally.hasEvents())
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

        it("is true once a housing item is collected", function()
            local tally = newTally()
            tally.begin(0)
            tally.housingItem(4001, "Sturdy Oak Chair", 100, true)

            assert.is_true(tally.hasEvents())
        end)

        it("is true once housing experience is gained", function()
            local tally = newTally()
            tally.begin(0)
            tally.housingXP(50)

            assert.is_true(tally.hasEvents())
        end)

        it("is true once a housing level is gained", function()
            local tally = newTally()
            tally.begin(0)
            tally.housingLevelUp(2, 100)

            assert.is_true(tally.hasEvents())
        end)

        it("is true once an equipment set changes", function()
            local tally = newTally()
            tally.begin(0)
            tally.equipsetChange({ setId = 3, name = "Raid", kind = "created", at = 100, items = {} })

            assert.is_true(tally.hasEvents())
        end)

        -- A currency that is earned then wholly spent nets to zero, but the segment did
        -- see the currency move, so it is still worth keeping.
        it("stays true for a currency that nets back to zero", function()
            local tally = newTally()
            tally.begin(0)
            tally.currency(1166, 30, "Timewarped Badge")
            tally.currency(1166, -30, "Timewarped Badge")

            assert.is_true(tally.hasEvents())
        end)
    end)

    describe("equipset changes", function()
        it("files what the ledger worked out, slots and all", function()
            local tally = newTally()
            tally.begin(0)
            tally.equipsetChange({
                setId = 3, name = "Raid", kind = "updated", at = 400,
                items = { { slot = 1, itemId = 100, itemLevel = 639, itemName = "Tideglass Crown" } },
            })

            assert.same({
                {
                    setId = 3, name = "Raid", kind = "updated", at = 400,
                    items = {
                        { slot = 1, itemId = 100, itemLevel = 639, itemName = "Tideglass Crown" },
                    },
                },
            }, tally.summary().equipsetChanges)
        end)

        -- A created or deleted set with no slots is still a set coming or going, and worth a
        -- row. An edit with nothing in it is not an edit at all.
        it("keeps a created set that holds nothing", function()
            local tally = newTally()
            tally.begin(0)
            tally.equipsetChange({ setId = 3, name = "Empty", kind = "created", at = 400, items = {} })

            assert.equal(1, #tally.summary().equipsetChanges)
        end)

        it("drops an edit that changed no slot", function()
            local tally = newTally()
            tally.begin(0)
            tally.equipsetChange({ setId = 3, name = "Raid", kind = "updated", at = 400, items = {} })

            assert.same({}, tally.summary().equipsetChanges)
        end)

        it("ignores a change that arrives with no segment open", function()
            local tally = newTally()
            tally.equipsetChange({ setId = 3, name = "Raid", kind = "created", at = 400, items = {} })

            assert.is_false(tally.hasEvents())
        end)

        -- The ledger hands over its own tables; the summary must not be able to reach back
        -- into them, or a later sync editing a slot would rewrite a filed change.
        it("does not share its slot tables with the caller", function()
            local tally = newTally()
            tally.begin(0)
            local items = { { slot = 1, itemId = 100 } }
            tally.equipsetChange({ setId = 3, name = "Raid", kind = "updated", at = 400, items = items })
            items[1].itemId = 999

            assert.equal(100, tally.summary().equipsetChanges[1].items[1].itemId)
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

        it("hands back empty lists on a fresh segment", function()
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
            assert.same({}, summary.housingItems)
            assert.equal(0, summary.housingXP)
            assert.same({}, summary.housingLevelUps)
            assert.same({}, summary.encounters)
            assert.is_nil(summary.keystone)
            assert.is_nil(summary.experience)
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
            tally.equipsetChange({
                setId = 3, name = "Raid", kind = "updated", at = 575,
                items = { { slot = 1, itemId = 100, itemLevel = 639, itemName = "Tideglass Crown" } },
            })

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
                housingItems = {},
                housingXP = 0,
                housingLevelUps = {},
                encounters = {},
                equipsetChanges = {
                    {
                        setId = 3, name = "Raid", kind = "updated", at = 575,
                        items = {
                            { slot = 1, itemId = 100, itemLevel = 639, itemName = "Tideglass Crown" },
                        },
                    },
                },
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

    -- A segment can end down on gold; the sign has to survive the format so a loss does
    -- not read as a gain.
    it("keeps the sign of a negative amount", function()
        assert.equal("-1g 0s 0c", ns.formatMoney(-10000))
        assert.equal("-50c", ns.formatMoney(-50))
    end)
end)
