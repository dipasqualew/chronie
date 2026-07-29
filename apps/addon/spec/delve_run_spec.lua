local loader = require("addon_loader")

describe("ns.readDelve", function()
    local ns = loader.load()

    ---The client's four calls, in the shape ns.readDelve wants them: functions rather than
    ---answers, because a build with no delves in it hands over nils instead of calls.
    ---@param options table? `{ inProgress, completed, tier, scenarioId }`
    ---@return table
    local function client(options)
        options = options or {}
        return {
            isDelveInProgress = function()
                return options.inProgress
            end,
            isDelveComplete = function()
                return options.completed
            end,
            activeTier = function()
                return options.tier
            end,
            -- The real GetScenarioStepInfo returns a table of everything about the step; the
            -- scenario id is the only field of it a delve is read from.
            scenarioStep = function()
                return { scenarioID = options.scenarioId }
            end,
        }
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.readDelve)
    end)

    -- The two things a segment cannot say for itself. The delve's own name is already the
    -- instance name, and every tier of every delve is difficulty 208, so without these a
    -- tier 11 Fungal Folly and a tier 1 one are the same record.
    it("reads the tier and the story out of a delve in progress", function()
        local state = ns.readDelve(client({ inProgress = true, tier = 8, scenarioId = 2680 }))

        assert.same({ inProgress = true, completed = false, tier = 8, scenarioId = 2680 }, state)
    end)

    -- Both calls answer for a while after the player has walked out of one, and every
    -- scenario update outside a delve asks anyway, so "no" has to mean nothing at all.
    it("says nothing about a player who is in no delve", function()
        assert.is_nil(ns.readDelve(client({ inProgress = false, completed = false })))
    end)

    -- Every build before The War Within, where C_PartyInfo.IsDelveInProgress and the rest
    -- simply do not exist and Main.lua passes the nils it found.
    it("tells a build that has never heard of delves nothing", function()
        assert.is_nil(ns.readDelve(nil))
        assert.is_nil(ns.readDelve({}))
        assert.is_nil(ns.readDelve({
            isDelveInProgress = nil, isDelveComplete = nil, activeTier = nil, scenarioStep = nil,
        }))
    end)

    -- Zero is how the client says "not settled yet" for both of these, and neither a tier 0
    -- nor a scenario 0 exists. Anything that is not a number at all is the same non-answer.
    for _, unanswered in ipairs({
        { name = "a zero", value = 0 },
        { name = "a string", value = "8" },
        { name = "a boolean", value = false },
    }) do
        it("leaves a tier and a story of " .. unanswered.name .. " absent rather than recording it", function()
            local state = ns.readDelve(client({
                inProgress = true,
                tier = unanswered.value,
                scenarioId = unanswered.value,
            }))

            assert.is_true(state.inProgress)
            assert.is_nil(state.tier)
            assert.is_nil(state.scenarioId)
        end)
    end

    -- The moment the run ends the client stops calling it in progress, and this is the only
    -- reading that says the delve was finished rather than abandoned part way.
    it("still reads a delve that has reached its end", function()
        local state = ns.readDelve(client({
            inProgress = false, completed = true, tier = 11, scenarioId = 2681,
        }))

        assert.is_false(state.inProgress)
        assert.is_true(state.completed)
        assert.equal(11, state.tier)
    end)

    -- These are read on every scenario update, in a client that may be part way through
    -- loading one. A read that errors is worth losing the tier over, not the handler.
    it("keeps reading when one of the client's own calls raises", function()
        local raising = client({ inProgress = true, scenarioId = 2680 })
        raising.activeTier = function()
            error("C_DelvesUI is not ready")
        end

        local state = ns.readDelve(raising)

        assert.is_true(state.inProgress)
        assert.is_nil(state.tier)
        assert.equal(2680, state.scenarioId)
    end)
end)
