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
