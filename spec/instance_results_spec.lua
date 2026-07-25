local loader = require("addon_loader")

describe("ns.newInstanceResults", function()
    local ns = loader.load()

    local LOOT_FORMATS = { "You receive loot: %sx%d.", "You receive loot: %s." }
    local FACTION_FORMATS = { "Your %s reputation has increased by %d." }

    ---Build the tally directly with fake seams, mirroring how lockout_store_spec builds
    ---the store: no frames, no Main, just the pure module and injected dependencies.
    ---@param options table? `{ trackedTypes, prices, sources, appearances, lootFormats, factionFormats }`
    ---@return InstanceResults
    local function newResults(options)
        options = options or {}
        local prices = options.prices or {}
        local sources = options.sources or {}
        local appearances = options.appearances or {}
        return ns.newInstanceResults({
            trackedTypes = options.trackedTypes,
            lootFormats = options.lootFormats or LOOT_FORMATS,
            factionFormats = options.factionFormats or FACTION_FORMATS,
            itemSellPrice = function(itemID)
                return prices[itemID]
            end,
            sourceVisual = function(sourceID)
                local source = sources[sourceID]
                return source and source.visual
            end,
            appearanceSources = function(visual)
                return appearances[visual]
            end,
            isSourceCollected = function(sourceID)
                local source = sources[sourceID]
                return source ~= nil and source.collected == true
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
        assert.is_function(ns.newInstanceResults)
    end)

    describe("entering and leaving instances", function()
        it("starts inactive before any zone is entered", function()
            local results = newResults()

            assert.is_false(results.isActive())
        end)

        it("activates on entering a tracked instance type", function()
            local results = newResults()

            assert.is_true(results.enter("party", 0))
            assert.is_true(results.isActive())
        end)

        it("does not activate for an instance type it does not track", function()
            local results = newResults()

            assert.is_false(results.enter("pvp", 0))
            assert.is_false(results.isActive())
        end)

        it("does not activate out in the open world where the type is nil", function()
            local results = newResults()

            assert.is_false(results.enter(nil, 0))
            assert.is_false(results.isActive())
        end)

        it("tracks party, raid and scenario by default", function()
            assert.is_true(newResults().enter("party", 0))
            assert.is_true(newResults().enter("raid", 0))
            assert.is_true(newResults().enter("scenario", 0))
        end)

        it("honours an injected trackedTypes set instead of the default", function()
            local results = newResults({ trackedTypes = { dungeon = true } })

            assert.is_true(results.enter("dungeon", 0))
            assert.is_false(newResults({ trackedTypes = { dungeon = true } }).enter("party", 0))
        end)

        -- A load screen or a graveyard run fires PLAYER_ENTERING_WORLD again while still
        -- inside the same instance; wiping the tally then would lose the whole run.
        it("does not reset when re-entering a tracked type while already active", function()
            local results = newResults()
            results.enter("party", 100)
            results.money(600) -- +500 looted

            results.enter("party", 999)

            assert.equal(500, results.summary().goldLooted)
        end)

        it("keeps the totals for display when leaving into an untracked type", function()
            local results = newResults()
            results.enter("party", 100)
            results.money(600)

            results.enter(nil, 0)

            local summary = results.summary()
            assert.is_false(summary.active)
            assert.equal(500, summary.goldLooted)
        end)

        it("resets to zero when a tracked type is entered again after leaving", function()
            local results = newResults()
            results.enter("party", 100)
            results.money(600)
            results.enter(nil, 0)

            results.enter("party", 0)

            assert.equal(0, results.summary().goldLooted)
        end)
    end)

    describe("gold looted", function()
        it("adds a positive wallet delta to the gold looted", function()
            local results = newResults()
            results.enter("party", 100)

            results.money(350)

            assert.equal(250, results.summary().goldLooted)
        end)

        it("anchors the baseline to the money passed at enter, not to zero", function()
            local results = newResults()
            results.enter("party", 1000)

            results.money(1000)

            assert.equal(0, results.summary().goldLooted)
        end)

        -- A repair or vendor purchase shrinks the wallet mid-run; that dip must not be
        -- subtracted, only re-baselined, so later gains are still counted in full.
        it("treats a wallet dip as a re-baseline rather than negative loot", function()
            local results = newResults()
            results.enter("party", 100)

            results.money(50) -- spent 50 at a repair vendor
            results.money(150) -- then looted back up

            assert.equal(100, results.summary().goldLooted)
        end)

        it("sums several positive deltas across the visit", function()
            local results = newResults()
            results.enter("party", 0)

            results.money(30)
            results.money(80)

            assert.equal(80, results.summary().goldLooted)
        end)

        it("ignores money changes while inactive", function()
            local results = newResults()

            results.money(500)

            assert.equal(0, results.summary().goldLooted)
        end)
    end)

    describe("item value looted", function()
        it("adds a single item's vendor price at quantity one", function()
            local results = newResults({ prices = { [4242] = 75 } })
            results.enter("party", 0)

            results.loot("You receive loot: " .. link(4242) .. ".")

            assert.equal(75, results.summary().itemValue)
        end)

        it("multiplies the vendor price by the looted quantity", function()
            local results = newResults({ prices = { [4242] = 75 } })
            results.enter("party", 0)

            results.loot("You receive loot: " .. link(4242) .. "x3.")

            assert.equal(225, results.summary().itemValue)
        end)

        -- The multiple-quantity template is listed first so a stack is not mis-read as a
        -- single item; the single template only wins when there is no "xN" suffix.
        it("picks the single-item template when there is no quantity suffix", function()
            local results = newResults({ prices = { [4242] = 75 } })
            results.enter("party", 0)

            results.loot("You receive loot: " .. link(4242) .. ".")

            assert.equal(75, results.summary().itemValue)
        end)

        it("adds nothing for a message that is not a self-loot line", function()
            local results = newResults({ prices = { [4242] = 75 } })
            results.enter("party", 0)

            results.loot("Thrall receives loot: " .. link(4242) .. ".")

            assert.equal(0, results.summary().itemValue)
        end)

        it("adds nothing for a message that matches no template at all", function()
            local results = newResults({ prices = { [4242] = 75 } })
            results.enter("party", 0)

            results.loot("You have gained a level!")

            assert.equal(0, results.summary().itemValue)
        end)

        -- The client cannot always price an item straight away (its data may not be
        -- cached yet); an unknown price contributes zero rather than erroring.
        it("adds zero when the item has no known sell price", function()
            local results = newResults({ prices = {} })
            results.enter("party", 0)

            results.loot("You receive loot: " .. link(9999) .. "x4.")

            assert.equal(0, results.summary().itemValue)
        end)

        it("ignores loot while inactive", function()
            local results = newResults({ prices = { [4242] = 75 } })

            results.loot("You receive loot: " .. link(4242) .. ".")

            assert.equal(0, results.summary().itemValue)
        end)
    end)

    describe("reputation earned", function()
        it("records a faction gain from a reputation-increase line", function()
            local results = newResults()
            results.enter("party", 0)

            results.reputation("Your Argent Dawn reputation has increased by 250.")

            assert.same({ { faction = "Argent Dawn", amount = 250 } }, results.summary().reputation)
        end)

        it("sums repeated gains for the same faction", function()
            local results = newResults()
            results.enter("party", 0)

            results.reputation("Your Argent Dawn reputation has increased by 250.")
            results.reputation("Your Argent Dawn reputation has increased by 75.")

            assert.same({ { faction = "Argent Dawn", amount = 325 } }, results.summary().reputation)
        end)

        it("keeps different factions apart and sorts them by name", function()
            local results = newResults()
            results.enter("party", 0)

            results.reputation("Your Timbermaw Hold reputation has increased by 10.")
            results.reputation("Your Argent Dawn reputation has increased by 20.")

            assert.same({
                { faction = "Argent Dawn", amount = 20 },
                { faction = "Timbermaw Hold", amount = 10 },
            }, results.summary().reputation)
        end)

        it("adds nothing for a non-reputation message", function()
            local results = newResults()
            results.enter("party", 0)

            results.reputation("You receive loot: " .. link(4242) .. ".")

            assert.same({}, results.summary().reputation)
        end)

        it("ignores reputation while inactive", function()
            local results = newResults()

            results.reputation("Your Argent Dawn reputation has increased by 250.")

            assert.same({}, results.summary().reputation)
        end)
    end)

    describe("transmog classification", function()
        it("counts a source whose visual is collected only once as a brand-new appearance", function()
            local results = newResults({
                sources = { [11] = { visual = 500, collected = true } },
                appearances = { [500] = { 11 } },
            })
            results.enter("party", 0)

            assert.equal("appearance", results.transmogSource(11))
            assert.equal(1, results.summary().newAppearances)
            assert.equal(0, results.summary().newVersions)
        end)

        -- Exactly one collected source is the boundary: this was the first source of the
        -- visual, so it is still a new appearance rather than an extra version.
        it("treats exactly one collected source as an appearance, not a version", function()
            local results = newResults({
                sources = {
                    [11] = { visual = 500, collected = true },
                    [12] = { visual = 500, collected = false },
                },
                appearances = { [500] = { 11, 12 } },
            })
            results.enter("party", 0)

            assert.equal("appearance", results.transmogSource(11))
        end)

        it("counts a source of an already-known visual as an additional version", function()
            local results = newResults({
                sources = {
                    [11] = { visual = 500, collected = true },
                    [12] = { visual = 500, collected = true },
                },
                appearances = { [500] = { 11, 12 } },
            })
            results.enter("party", 0)

            assert.equal("version", results.transmogSource(12))
            assert.equal(0, results.summary().newAppearances)
            assert.equal(1, results.summary().newVersions)
        end)

        it("returns nil and changes no counter for an unknown visual", function()
            local results = newResults({ sources = {}, appearances = {} })
            results.enter("party", 0)

            assert.is_nil(results.transmogSource(404))
            assert.equal(0, results.summary().newAppearances)
            assert.equal(0, results.summary().newVersions)
        end)

        it("ignores transmog sources while inactive", function()
            local results = newResults({
                sources = { [11] = { visual = 500, collected = true } },
                appearances = { [500] = { 11 } },
            })

            assert.is_nil(results.transmogSource(11))
            assert.equal(0, results.summary().newAppearances)
        end)
    end)

    describe("summary", function()
        it("reports the active flag", function()
            local results = newResults()
            results.enter("party", 0)

            assert.is_true(results.summary().active)
        end)

        it("sums gold looted and item value into the gold total", function()
            local results = newResults({ prices = { [4242] = 200 } })
            results.enter("party", 0)
            results.money(300)
            results.loot("You receive loot: " .. link(4242) .. "x2.")

            local summary = results.summary()
            assert.equal(300, summary.goldLooted)
            assert.equal(400, summary.itemValue)
            assert.equal(700, summary.gold)
        end)

        it("hands back an empty reputation list on a fresh visit", function()
            local results = newResults()
            results.enter("party", 0)

            assert.same({}, results.summary().reputation)
        end)

        it("carries every tally onto one summary table", function()
            local results = newResults({
                prices = { [4242] = 50 },
                sources = { [11] = { visual = 500, collected = true } },
                appearances = { [500] = { 11 } },
            })
            results.enter("party", 100)
            results.money(200)
            results.loot("You receive loot: " .. link(4242) .. ".")
            results.transmogSource(11)
            results.reputation("Your Argent Dawn reputation has increased by 30.")

            assert.same({
                active = true,
                goldLooted = 100,
                itemValue = 50,
                gold = 150,
                newAppearances = 1,
                newVersions = 0,
                reputation = { { faction = "Argent Dawn", amount = 30 } },
            }, results.summary())
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
end)
