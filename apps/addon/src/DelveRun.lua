local _, ns = ...

---What the client will say about a delve, read at one moment.
---@class DelveState
---@field inProgress boolean A delve is running right now.
---@field completed boolean The delve reached its end.
---@field tier integer? The tier it is being run at. Nothing else a segment carries says
---this: every delve, from tier 1 to the top of the season, is difficulty 208 ("Delves").
---@field scenarioId integer? Which of the delve's stories the client rolled. An id rather
---than a name because there is no name — see below.

---Reads the delve the player is inside, or decides they are not in one.
---
---A delve is an instance of its own — `Map.InstanceType` 5, the same "scenario" the client
---reports for Horrific Visions and every other scenario — named for the delve itself, so the
---segment already records the name. Two things it does not record, and this is what reads
---them:
---
---* **The tier.** Delves have one difficulty between them, 208 ("Delves"), whatever tier the
---  entrance was set to. `C_DelvesUI.GetActiveDelveTier` is the only thing that answers.
---* **The story.** Each delve has three to six of them and they change what happens inside.
---  Nothing names one. In the client's data every story is a `Scenario` row of its own
---  (`Type` 8) whose steps all carry the delve's own name — "Fungal Folly" five times over —
---  so the scenario the client rolled *is* the story, and its id is the only handle on it.
---  Two runs sharing an id ran the same story; that is the whole of what can be said, and it
---  is more than nothing.
---
---Read on a scenario event rather than on entering the zone, because none of these answers
---are ready before the scenario itself has started.
---@param client table? `{ isDelveInProgress, isDelveComplete, activeTier, scenarioStep }` —
---the client's own calls. A build with no delves in it passes nils and is told nothing.
---@return DelveState?
function ns.readDelve(client)
    if type(client) ~= "table" then
        return nil
    end

    -- Every one of these is called on every scenario update, in a client that may be part
    -- way through loading one; an error out of a read is not worth taking the handler down
    -- for, and answering "nothing to say" is exactly right when a call will not answer.
    local function ask(call)
        if type(call) ~= "function" then
            return nil
        end
        local ok, value = pcall(call)
        if not ok then
            return nil
        end
        return value
    end

    local inProgress = ask(client.isDelveInProgress) == true
    local completed = ask(client.isDelveComplete) == true
    if not inProgress and not completed then
        return nil
    end

    local tier = ask(client.activeTier)
    local step = ask(client.scenarioStep)
    local scenarioId = type(step) == "table" and step.scenarioID or nil

    return {
        inProgress = inProgress,
        completed = completed,
        -- Zero is the client's way of saying it has no answer yet, for both of these. It is
        -- neither a tier nor a scenario, so it is left absent rather than written down.
        tier = type(tier) == "number" and tier > 0 and tier or nil,
        scenarioId = type(scenarioId) == "number" and scenarioId > 0 and scenarioId or nil,
    }
end
