local _, ns = ...

---A walk the app has asked for, as it arrives in `src/CensusRequests.lua`.
---@class CensusRequest
---@field id integer Chronie's own id for the request, which is what "already done" is keyed by.
---@field domains string[]? Which domains to walk. Absent or empty asks for every one this build
---can answer, which is what the Resync button sends; naming them is what a targeted probe would
---use once the app starts handing over a suspicion rather than a whole pass.

---What became of one request, which is the whole of what the app is told back.
---@class CensusResyncOutcome
---@field id integer The request's id.
---@field at integer When the walk it asked for *ended*, not when it was picked up.
---@field outcome string "walked" or "unknown".
---@field domains string[] What was actually walked, which is not always what was asked for.

---Carries out the walks the app asked for, and remembers that it did.
---@class CensusResync
---@field run fun(): string[] Begin whatever has been asked for and not done. Returns the domains a
---walk was started over, empty when there was nothing to do.

---@class CensusResyncDeps
---@field readRequests fun(): CensusRequest[]? What the app left in the addon's own folder.
---@field store table Where the record of what has been done is kept, across sessions.
---@field now fun(): integer
---@field domains fun(): string[] Every domain this build can walk, in walk order.
---@field walk fun(names: string[], onDone: fun()): boolean Begins a pass and calls back when it
---ends; false when it would not begin one, which is what a pass already in flight answers. A pass
---that never ends never calls back, which is the whole of how an interrupted resync is handled —
---see `run`.

---What a resync reads as in chat, said when one starts rather than when it finishes.
---
---A walk takes about a minute and the player is standing in a loading screen when it begins, so
---the acknowledgement has to come at the start or it comes long after they have stopped
---wondering. It says how many domains rather than naming them: five names is a wall of jargon,
---and the one thing worth knowing is that something is happening and it is not free.
---@param names string[]
---@return string
function ns.censusResyncText(names)
    return "Chronie is walking " .. #names .. " collection(s) again, because the app asked for a "
        .. "fresh census. It runs in the background and is written down when you log out."
end

---@param deps CensusResyncDeps
---@return CensusResync
function ns.newCensusResync(deps)
    local readRequests = deps.readRequests
    local store = deps.store
    local now = deps.now

    ---Whether a walk this module asked for is still going.
    ---
    ---Not persisted, and not the census's own `running` either. `run` is called on the far side of
    ---every loading screen, and a request is only marked done once its walk has *ended* — so
    ---between those two moments something has to stop the same request being taken up again by
    ---the next zone change. The census would refuse the second pass anyway, but it refuses in
    ---silence, and the player would be told a resync had started once per loading screen.
    local walking = false

    ---Every domain the pending requests between them asked for, in walk order.
    ---
    ---Order is the census's rather than the requests', because the census's is cheapest-first and
    ---a pass is interrupted by whatever ends the session: the domain that finishes in a fifth of a
    ---second should not be queued behind the one that takes a minute because a request happened to
    ---list it second.
    ---@param requests CensusRequest[]
    ---@return string[]
    local function wanted(requests)
        local asked = {}
        local everything = false
        for _, request in ipairs(requests) do
            local domains = type(request) == "table" and request.domains
            if type(domains) ~= "table" or #domains == 0 then
                everything = true
            else
                for _, name in ipairs(domains) do
                    asked[name] = true
                end
            end
        end

        local names = {}
        for _, name in ipairs(deps.domains()) do
            -- Filtered against what this build can actually walk, so a name from a newer app —
            -- or a domain whose client calls this build has not got — is reported as unknown
            -- rather than quietly making the request look carried out.
            if everything or asked[name] then
                names[#names + 1] = name
            end
        end
        return names
    end

    ---Drops the record of requests the app has stopped asking for.
    ---
    ---Safe for exactly the reason it is safe next door in `ns.newCustomSetWriter`: **the app keeps
    ---writing a request into this file until it has read what became of it**, so a request that
    ---has disappeared from the file is one the app has already been told about and will never ask
    ---for again. Forgetting it here cannot make it happen twice.
    ---@param done table<integer, CensusResyncOutcome>
    ---@param requests CensusRequest[]
    ---@return table<integer, CensusResyncOutcome>
    local function forget(done, requests)
        local asked = {}
        for _, request in ipairs(requests) do
            local id = type(request) == "table" and tonumber(request.id)
            if id then
                asked[id] = true
            end
        end
        local kept = {}
        for id, outcome in pairs(done) do
            if asked[id] then
                kept[id] = outcome
            end
        end
        return kept
    end

    ---@param ids integer[]
    ---@param names string[]
    ---@param outcome string
    local function record(ids, names, outcome)
        local done = store.done or {}
        local at = now()
        for _, id in ipairs(ids) do
            done[id] = { id = id, at = at, outcome = outcome, domains = names }
        end
        store.done = done
    end

    ---Begins whatever has been asked for and not carried out.
    ---
    ---**The record is written when the walk ends, not when it starts**, and that asymmetry is the
    ---whole of how an interrupted resync is handled. A player who logs out thirty seconds into a
    ---minute-long walk has had part of an answer, which the census files as the positive
    ---observations it is; the request is still unanswered, so the app goes on writing it and the
    ---next login walks again. A record written at the start would have marked that as done and
    ---left the reader with the half-pass they explicitly asked to be rid of.
    ---
    ---The cost of that choice is a resync nobody can ever finish — a player who logs out inside
    ---the first minute every time — going round again at every login. It is the same walk the
    ---audit would provoke anyway, and it stops the moment one pass completes.
    ---@return string[]
    local function run()
        local requests = readRequests()
        if type(requests) ~= "table" or walking then
            return {}
        end
        local done = store.done or {}
        local pending = {}
        local ids = {}
        for _, request in ipairs(requests) do
            local id = type(request) == "table" and tonumber(request.id)
            if id and not done[id] then
                pending[#pending + 1] = request
                ids[#ids + 1] = id
            end
        end
        -- After the pending list has been taken and before anything is written back, so an
        -- entry made a moment ago for a request still in the file survives being tidied up.
        store.done = forget(done, requests)
        if #ids == 0 then
            return {}
        end

        local names = wanted(pending)
        if #names == 0 then
            -- Answered rather than left waiting. Every name in it was one this build cannot walk,
            -- and a request kept open would be written into the folder for the rest of the
            -- player's life waiting for an addon that never arrives.
            record(ids, {}, "unknown")
            return {}
        end

        walking = true
        if not deps.walk(names, function()
            walking = false
            record(ids, names, "walked")
        end) then
            -- Refused, which is what a pass already in flight answers. Nothing is recorded and
            -- nothing is said: the request is still waiting, and the next loading screen — or the
            -- next login — takes it up again.
            walking = false
            return {}
        end
        return names
    end

    return { run = run }
end
