local loader = require("addon_loader")

describe("ns.factionStanding", function()
    local ns = loader.load()

    it("is exported by the addon files", function()
        assert.is_function(ns.factionStanding)
    end)

    it("has nothing to say about a faction the client cannot place", function()
        assert.is_nil(ns.factionStanding({}))
        assert.is_nil(ns.factionStanding(nil))
    end)

    describe("the reaction ladder", function()
        it("measures the bar from the current level's floor, not from zero", function()
            local standing = ns.factionStanding({
                faction = {
                    currentStanding = 12000,
                    currentReactionThreshold = 9000,
                    nextReactionThreshold = 21000,
                },
                reactionLabel = "Honored",
            })

            assert.same({ standing = "Honored", current = 3000, max = 12000 }, standing)
        end)

        it("draws the last level full rather than empty", function()
            local standing = ns.factionStanding({
                faction = {
                    currentStanding = 42999,
                    currentReactionThreshold = 42000,
                    nextReactionThreshold = 0,
                },
                reactionLabel = "Exalted",
            })

            assert.equal("Exalted", standing.standing)
            assert.equal(standing.max, standing.current)
            assert.is_true(standing.max > 0)
        end)

        it("keeps a bar the client reports past its own end inside it", function()
            local standing = ns.factionStanding({
                faction = {
                    currentStanding = 99000,
                    currentReactionThreshold = 9000,
                    nextReactionThreshold = 21000,
                },
                reactionLabel = "Honored",
            })

            assert.equal(12000, standing.current)
            assert.equal(12000, standing.max)
        end)

        it("still reports the numbers when the client offers no label for them", function()
            local standing = ns.factionStanding({
                faction = {
                    currentStanding = 100,
                    currentReactionThreshold = 0,
                    nextReactionThreshold = 3000,
                },
            })

            assert.same({ standing = nil, current = 100, max = 3000 }, standing)
        end)
    end)

    describe("a major faction", function()
        it("counts renown levels rather than the reaction it also reports", function()
            local standing = ns.factionStanding({
                faction = {
                    currentStanding = 5000,
                    currentReactionThreshold = 0,
                    nextReactionThreshold = 42000,
                },
                reactionLabel = "Friendly",
                renown = {
                    renownLevel = 12,
                    renownReputationEarned = 900,
                    renownLevelThreshold = 2500,
                },
            })

            assert.same({ standing = "Renown 12", current = 900, max = 2500 }, standing)
        end)
    end)

    describe("a paragon faction", function()
        it("shows what is left over past the last reward, not Exalted's full bar", function()
            local standing = ns.factionStanding({
                faction = {
                    currentStanding = 42999,
                    currentReactionThreshold = 42000,
                    nextReactionThreshold = 0,
                },
                reactionLabel = "Exalted",
                paragon = { value = 25000, threshold = 10000 },
            })

            assert.same({ standing = "Paragon", current = 5000, max = 10000 }, standing)
        end)

        it("is ignored while the character is too low a level to have one", function()
            local standing = ns.factionStanding({
                faction = {
                    currentStanding = 3000,
                    currentReactionThreshold = 0,
                    nextReactionThreshold = 6000,
                },
                reactionLabel = "Friendly",
                paragon = { value = 0, threshold = 0 },
            })

            assert.same({ standing = "Friendly", current = 3000, max = 6000 }, standing)
        end)
    end)

    describe("a friendship", function()
        it("uses the rank's own name and thresholds", function()
            local standing = ns.factionStanding({
                faction = {
                    currentStanding = 8400,
                    currentReactionThreshold = 3000,
                    nextReactionThreshold = 9000,
                },
                reactionLabel = "Honored",
                friendship = {
                    friendshipFactionID = 2135,
                    reaction = "Best Friend",
                    standing = 8400,
                    reactionThreshold = 8400,
                    nextThreshold = 16800,
                },
            })

            assert.same({ standing = "Best Friend", current = 0, max = 8400 }, standing)
        end)

        it("draws the last rank full", function()
            local standing = ns.factionStanding({
                faction = { currentStanding = 42999, currentReactionThreshold = 42000 },
                friendship = {
                    friendshipFactionID = 2135,
                    reaction = "Best Friend",
                    standing = 42999,
                    reactionThreshold = 42000,
                },
            })

            assert.equal("Best Friend", standing.standing)
            assert.equal(standing.max, standing.current)
        end)

        -- Every faction answers GetFriendshipReputation; only a real friendship comes back
        -- with an ID in it, so that is what tells the two apart.
        it("is ignored when the client answers with an empty friendship", function()
            local standing = ns.factionStanding({
                faction = {
                    currentStanding = 3000,
                    currentReactionThreshold = 0,
                    nextReactionThreshold = 6000,
                },
                reactionLabel = "Friendly",
                friendship = { friendshipFactionID = 0 },
            })

            assert.same({ standing = "Friendly", current = 3000, max = 6000 }, standing)
        end)
    end)
end)

describe("ns.readFactionState", function()
    local ns = loader.load()

    ---A client that answers for exactly one faction, out of whichever of the reputation
    ---APIs the test says this build has. `options.without` names the C_Reputation
    ---functions to leave undefined, which is how a build that has dropped one is spelled.
    ---@param options table? `{ data, renown, friendship, paragon, labels, without }`
    ---@return table clients
    local function client(options)
        options = options or {}
        local data = options.data
        local missing = {}
        for _, name in ipairs(options.without or {}) do
            missing[name] = true
        end

        local reputation = {
            GetFactionDataByName = function(name)
                return data and data.name == name and data or nil
            end,
            GetNumFactions = function()
                return data and 1 or 0
            end,
            GetFactionDataByIndex = function(index)
                return index == 1 and data or nil
            end,
            IsMajorFaction = function()
                return options.renown ~= nil
            end,
            IsFactionParagon = function()
                return options.paragon ~= nil
            end,
            GetFactionParagonInfo = function()
                local paragon = options.paragon or {}
                return paragon.value, paragon.threshold
            end,
        }
        for name in pairs(missing) do
            reputation[name] = nil
        end

        return {
            reputation = reputation,
            majorFaction = { GetMajorFactionData = function() return options.renown end },
            gossip = { GetFriendshipReputation = function() return options.friendship end },
            reactionLabel = function(reaction)
                return (options.labels or {})[reaction]
            end,
        }
    end

    local HONORED = {
        name = "The Consortium",
        factionID = 933,
        reaction = 6,
        currentStanding = 12000,
        currentReactionThreshold = 9000,
        nextReactionThreshold = 21000,
    }

    it("is exported by the addon files", function()
        assert.is_function(ns.readFactionState)
    end)

    it("reads a faction off the client by name", function()
        local standing = ns.readFactionState(client({ data = HONORED, labels = { [6] = "Honored" } }),
            "The Consortium")

        assert.same({ standing = "Honored", current = 3000, max = 12000 }, standing)
    end)

    -- The bug behind #44: the client this addon ran on had no
    -- C_Reputation.GetFactionDataByName, and calling it threw a Lua error at every
    -- reputation gain in the instance. A function this build does not define is a faction
    -- nobody can look up, not a crash.
    it("falls back to the faction list when the client cannot look up by name", function()
        local clients = client({
            data = HONORED,
            labels = { [6] = "Honored" },
            without = { "GetFactionDataByName" },
        })

        local standing = ns.readFactionState(clients, "The Consortium")

        assert.same({ standing = "Honored", current = 3000, max = 12000 }, standing)
    end)

    it("says nothing when the client offers no way to find a faction at all", function()
        local clients = client({
            data = HONORED,
            without = { "GetFactionDataByName", "GetNumFactions", "GetFactionDataByIndex" },
        })

        assert.is_nil(ns.readFactionState(clients, "The Consortium"))
    end)

    it("says nothing when the client has no reputation API whatsoever", function()
        assert.is_nil(ns.readFactionState({}, "The Consortium"))
        assert.is_nil(ns.readFactionState(nil, "The Consortium"))
    end)

    it("says nothing about a faction the client does not know", function()
        assert.is_nil(ns.readFactionState(client({ data = HONORED }), "Bilgewater Cartel"))
    end)

    it("is asked nothing without a faction to ask about", function()
        assert.is_nil(ns.readFactionState(client({ data = HONORED }), nil))
    end)

    -- Each of these lives in a different namespace, and a build that drops any one of them
    -- must still produce the ladder bar rather than an error.
    it("keeps the ladder bar when the renown, friendship and paragon APIs are absent", function()
        local clients = client({ data = HONORED, labels = { [6] = "Honored" } })
        clients.majorFaction = nil
        clients.gossip = nil
        clients.reputation.IsMajorFaction = nil
        clients.reputation.IsFactionParagon = nil
        clients.reputation.GetFactionParagonInfo = nil

        local standing = ns.readFactionState(clients, "The Consortium")

        assert.same({ standing = "Honored", current = 3000, max = 12000 }, standing)
    end)

    it("prefers renown when the faction is a major one", function()
        local clients = client({
            data = { name = "Dream Wardens", factionID = 2574, reaction = 8 },
            renown = { renownLevel = 12, renownReputationEarned = 500, renownLevelThreshold = 2500 },
        })

        local standing = ns.readFactionState(clients, "Dream Wardens")

        assert.same({ standing = "Renown 12", current = 500, max = 2500 }, standing)
    end)

    it("carries the paragon bar through", function()
        local clients = client({
            data = { name = "Valdrakken Accord", factionID = 2510, reaction = 8 },
            paragon = { value = 12500, threshold = 10000 },
        })

        local standing = ns.readFactionState(clients, "Valdrakken Accord")

        assert.same({ standing = "Paragon", current = 2500, max = 10000 }, standing)
    end)

    it("carries the friendship bar through", function()
        local clients = client({
            data = { name = "Brann Bronzebeard", factionID = 2640, reaction = 5 },
            friendship = {
                friendshipFactionID = 2640,
                reaction = "Best Friend",
                standing = 1500,
                reactionThreshold = 1000,
                nextThreshold = 3000,
            },
        })

        local standing = ns.readFactionState(clients, "Brann Bronzebeard")

        assert.same({ standing = "Best Friend", current = 500, max = 2000 }, standing)
    end)
end)
