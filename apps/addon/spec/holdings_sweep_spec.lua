local loader = require("addon_loader")

describe("ns.readHoldings", function()
    local ns = loader.load()

    ---A client whose currency and reputation panes show exactly the rows the test lists.
    ---
    ---Both lists are given in pane order, headers included, because that is what the walk
    ---actually sees: the client hands back one row per visible line and says which of them
    ---are group titles rather than holdings.
    ---@param options table? `{ currencies, factions, renown, friendship, paragon, labels, without }`
    ---@return table clients
    local function client(options)
        options = options or {}
        local currencyRows = options.currencies or {}
        local factionRows = options.factions or {}
        local missing = {}
        for _, name in ipairs(options.without or {}) do
            missing[name] = true
        end

        local currency = {
            GetCurrencyListSize = function()
                return #currencyRows
            end,
            GetCurrencyListInfo = function(index)
                return currencyRows[index]
            end,
        }

        local reputation = {
            GetNumFactions = function()
                return #factionRows
            end,
            GetFactionDataByIndex = function(index)
                return factionRows[index]
            end,
            IsMajorFaction = function(factionID)
                return (options.renown or {})[factionID] ~= nil
            end,
            IsFactionParagon = function(factionID)
                return (options.paragon or {})[factionID] ~= nil
            end,
            GetFactionParagonInfo = function(factionID)
                local paragon = (options.paragon or {})[factionID] or {}
                return paragon.value, paragon.threshold
            end,
        }

        for name in pairs(missing) do
            currency[name] = nil
            reputation[name] = nil
        end

        return {
            currency = currency,
            reputation = reputation,
            majorFaction = {
                GetMajorFactionData = function(factionID)
                    return (options.renown or {})[factionID]
                end,
            },
            gossip = {
                GetFriendshipReputation = function(factionID)
                    return (options.friendship or {})[factionID]
                end,
            },
            reactionLabel = function(reaction)
                return (options.labels or {})[reaction]
            end,
        }
    end

    -- The shapes below are the ones build 12.0.5.67823 actually hands back, cut down to the
    -- keys the walk reads. A currency header carries currencyID 0; a reputation header
    -- carries a real factionID and is told apart by isHeaderWithRep instead.
    local FLIGHTSTONES = {
        isHeader = false,
        currencyID = 2245,
        name = "Flightstones",
        quantity = 5000,
    }
    local VALORSTONES = {
        isHeader = false,
        currencyID = 3008,
        name = "Valorstones",
        quantity = 0,
    }
    local CURRENCY_HEADER = {
        isHeader = true,
        isHeaderExpanded = true,
        currencyID = 0,
        name = "Midnight",
        quantity = 0,
    }

    local CONSORTIUM = {
        isHeader = false,
        isHeaderWithRep = false,
        factionID = 933,
        name = "The Consortium",
        reaction = 6,
        currentStanding = 12000,
        currentReactionThreshold = 9000,
        nextReactionThreshold = 21000,
    }
    local FACTION_HEADER = {
        isHeader = true,
        isHeaderWithRep = false,
        isCollapsed = false,
        factionID = 2698,
        name = "Midnight",
        reaction = 4,
        currentStanding = 0,
        currentReactionThreshold = 0,
        nextReactionThreshold = 3000,
    }

    it("is exported by the addon files", function()
        assert.is_function(ns.readHoldings)
    end)

    it("reads every currency the pane lists, not only the ones lately earned", function()
        local held = ns.readHoldings(client({
            currencies = { CURRENCY_HEADER, FLIGHTSTONES, VALORSTONES },
        }))

        assert.same({
            { id = 2245, name = "Flightstones", total = 5000 },
            { id = 3008, name = "Valorstones", total = 0 },
        }, held.currencies)
    end)

    -- Zero is the whole point of walking rather than watching: a character that has spent
    -- everything has to be able to say so, or the account total keeps counting what was
    -- last seen instead of what is there.
    it("records a balance of none as a balance rather than leaving it out", function()
        local held = ns.readHoldings(client({ currencies = { VALORSTONES } }))

        assert.equal(1, #held.currencies)
        assert.equal(0, held.currencies[1].total)
    end)

    it("skips the group titles the pane shows between the currencies", function()
        local held = ns.readHoldings(client({ currencies = { CURRENCY_HEADER } }))

        assert.same({}, held.currencies)
    end)

    it("skips a currency row the client will not put a number on", function()
        local held = ns.readHoldings(client({
            currencies = {
                { isHeader = false, currencyID = 3008, name = "Valorstones" },
                { isHeader = false, currencyID = 0, name = "", quantity = 12 },
                "not a row at all",
                FLIGHTSTONES,
            },
        }))

        assert.same({ { id = 2245, name = "Flightstones", total = 5000 } }, held.currencies)
    end)

    it("reads every faction the pane lists, reduced to the same bar a gain is", function()
        local held = ns.readHoldings(client({
            factions = { FACTION_HEADER, CONSORTIUM },
            labels = { [6] = "Honored" },
        }))

        assert.same({
            {
                faction = "The Consortium",
                standing = "Honored",
                current = 3000,
                max = 12000,
                rank = 6,
                system = "reaction",
            },
        }, held.reputation)
    end)

    -- A pure header carries a faction id of its own — the "Midnight" title reads 2698 on
    -- build 12.0.5.67823 — so the id cannot tell one from a faction. isHeaderWithRep is
    -- what says a header is also a standing in its own right, the way a guild's is.
    it("keeps a header that is a faction in its own right", function()
        local held = ns.readHoldings(client({
            factions = {
                {
                    isHeader = true,
                    isHeaderWithRep = true,
                    factionID = 1168,
                    name = "Guild",
                    reaction = 5,
                    currentStanding = 500,
                    currentReactionThreshold = 0,
                    nextReactionThreshold = 3000,
                },
            },
            labels = { [5] = "Neutral" },
        }))

        assert.equal(1, #held.reputation)
        assert.equal("Guild", held.reputation[1].faction)
    end)

    it("carries the renown ladder through, so two characters' standings still compare", function()
        local held = ns.readHoldings(client({
            factions = {
                {
                    isHeader = false,
                    factionID = 2574,
                    name = "Dream Wardens",
                    reaction = 8,
                },
            },
            renown = {
                [2574] = {
                    renownLevel = 12,
                    renownReputationEarned = 500,
                    renownLevelThreshold = 2500,
                },
            },
        }))

        assert.same({
            {
                faction = "Dream Wardens",
                standing = "Renown 12",
                current = 500,
                max = 2500,
                rank = 12,
                system = "renown",
            },
        }, held.reputation)
    end)

    it("leaves out a faction the client names but will not place", function()
        local held = ns.readHoldings(client({
            factions = {
                { isHeader = false, factionID = 933, name = "The Consortium" },
                { isHeader = false, factionID = 934, name = "" },
            },
        }))

        assert.same({}, held.reputation)
    end)

    -- The lesson of #44, which this walk reaches for twice as often as a single gain does:
    -- a function this build does not define is a pane nobody can read, not a Lua error out
    -- of a logout handler.
    it("reads the half of the client that answers when the other half is absent", function()
        local held = ns.readHoldings(client({
            currencies = { FLIGHTSTONES },
            factions = { CONSORTIUM },
            labels = { [6] = "Honored" },
            without = { "GetNumFactions" },
        }))

        assert.equal(1, #held.currencies)
        assert.same({}, held.reputation)

        held = ns.readHoldings(client({
            currencies = { FLIGHTSTONES },
            factions = { CONSORTIUM },
            labels = { [6] = "Honored" },
            without = { "GetCurrencyListInfo" },
        }))

        assert.same({}, held.currencies)
        assert.equal(1, #held.reputation)
    end)

    it("asks a client with no currency or reputation API at all for nothing", function()
        assert.same({ currencies = {}, reputation = {} }, ns.readHoldings({}))
        assert.same({ currencies = {}, reputation = {} }, ns.readHoldings(nil))
    end)

    it("is the shape HoldingsStore.record already takes", function()
        local db = {}
        local store = ns.newHoldingsStore({ db = db, now = function() return 1700 end })

        store.record("Alt-Ravencrest", ns.readHoldings(client({
            currencies = { CURRENCY_HEADER, FLIGHTSTONES, VALORSTONES },
            factions = { FACTION_HEADER, CONSORTIUM },
            labels = { [6] = "Honored" },
        })))

        local entry = db.holdings["Alt-Ravencrest"]
        assert.same({ name = "Flightstones", total = 5000, at = 1700 }, entry.currencies[2245])
        assert.same({ name = "Valorstones", total = 0, at = 1700 }, entry.currencies[3008])
        assert.same({
            standing = "Honored",
            current = 3000,
            max = 12000,
            rank = 6,
            system = "reaction",
            at = 1700,
        }, entry.factions["The Consortium"])
        -- The walk reads holdings, never the wallet: gold answers outright and is already
        -- read whole at every segment close.
        assert.is_nil(entry.gold)
    end)
end)
