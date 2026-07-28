local _, ns = ...

---One outfit the app wants the game to hold, as it arrives in `src/CustomSetRequests.lua`.
---@class CustomSetRequest
---@field id integer Chronie's own id for the request, which is what "already done" is keyed by.
---@field name string What the set should be called.
---@field icon integer? The picture to give it, where the app picked one.
---@field slots CustomSetSlotState[] What goes in it, by the client's own `TransmogSlot`.

---What became of one request, which is the whole of what the app is told back.
---@class CustomSetOutcome
---@field id integer The request's id.
---@field at integer
---@field outcome string "created", "updated", "full", "refused" or "failed".
---@field setId integer? The client's id for the set that resulted, where there is one.
---@field name string What the app asked it to be called, kept so the record reads without
---the request beside it — the app clears a request once it has been told, and the record
---outlives it.

---Carries out what the app asked for, and remembers what came of it.
---@class CustomSetWriter
---@field run fun(at: integer?): CustomSetOutcome[] Apply everything not yet applied.

---The seam onto the client's own wardrobe. Everything here is a write.
---@class CustomSetClient
---@field create fun(name: string, icon: integer?, list: table[]): integer? `NewCustomSet`.
---@field modify fun(setId: integer, list: table[]) `ModifyCustomSet`.
---@field maxSets fun(): integer? `GetNumMaxCustomSets`, or nothing on a client without it.
---@field validName fun(name: string): boolean? `IsValidCustomSetName` — the server's own opinion.

---@class CustomSetWriterDeps
---@field readRequests fun(): CustomSetRequest[]? What the app left in the addon's own folder.
---@field readSets fun(): CustomSetState[]? Every set the account has right now.
---@field client CustomSetClient
---@field store table Where the record of what has been done is kept, across sessions.
---@field now fun(): integer

---The client's `TransmogSlot` runs 0 to 12 inclusive: head through off hand.
local SLOTS = 13

---What an empty slot holds, which is a number and not an absence.
---
---`Constants.Transmog.NoTransmogID`. It matters twice: the list handed to the client has to be
---**dense** — Blizzard's own code walks these with `ipairs`, so a hole would truncate the set at
---the slot before it — and a slot the player left empty is a real answer that has to be spelled
---rather than skipped.
local NO_TRANSMOG = 0

---An outfit as the client wants it: thirteen `ItemTransmogInfo`s, one per slot, in order.
---
---Built rather than copied because the two shapes disagree about everything. The app names only
---the slots it filled, keyed by the game's own slot number counting from zero; the client wants
---every slot, counting from one, with the empty ones saying so out loud.
---@param slots CustomSetSlotState[]?
---@return table[]
local function transmogList(slots)
    local list = {}
    for index = 1, SLOTS do
        list[index] = {
            appearanceID = NO_TRANSMOG,
            secondaryAppearanceID = NO_TRANSMOG,
            illusionID = NO_TRANSMOG,
        }
    end
    for _, held in ipairs(type(slots) == "table" and slots or {}) do
        local slot = type(held) == "table" and tonumber(held.slot)
        local appearance = slot and tonumber(held.appearance)
        if slot and appearance and slot >= 0 and slot < SLOTS then
            list[slot + 1] = {
                appearanceID = appearance,
                secondaryAppearanceID = tonumber(held.secondary) or NO_TRANSMOG,
                illusionID = tonumber(held.illusion) or NO_TRANSMOG,
            }
        end
    end
    return list
end

---The set already called this, if there is one — which is what makes a send a *replace*.
---
---Without regard to case, because that is what the app's own saving does and what the game's
---own dialog offers: a player sending "winter look" over the "Winter Look" they saved last
---month means that set, and quietly making a second one beside it would leave them with two
---sets they cannot tell apart and one of them wrong.
---@param sets CustomSetState[]
---@param name string
---@return CustomSetState?
local function named(sets, name)
    local wanted = string.lower(name)
    for _, set in ipairs(sets) do
        if string.lower(set.name or "") == wanted then
            return set
        end
    end
    return nil
end

---What one outcome reads as in chat, named so the player can go and look.
---
---Every line says the set's name, because a line about "a set" is a line that sends somebody
---to open their wardrobe and count. The two failures say what to do rather than what went
---wrong: a player cannot act on "NewCustomSet returned nil", and can act on being told their
---wardrobe is full.
---@param outcome CustomSetOutcome
---@return string
function ns.customSetOutcomeText(outcome)
    local name = outcome.name
    local called = (type(name) == "string" and name ~= "") and name or "that outfit"
    if outcome.outcome == "created" then
        return "Saved " .. called .. " to your transmog sets."
    elseif outcome.outcome == "updated" then
        return "Saved " .. called .. " over the transmog set of that name."
    elseif outcome.outcome == "full" then
        return "Could not save " .. called .. ": your transmog sets are full. "
            .. "Delete one in game and it will be saved next time you log in."
    elseif outcome.outcome == "refused" then
        return "Could not save " .. called .. ": the game would not accept that name."
    end
    return "Could not save " .. called .. " to your transmog sets."
end

---@param deps CustomSetWriterDeps
---@return CustomSetWriter
function ns.newCustomSetWriter(deps)
    local readRequests = deps.readRequests
    local readSets = deps.readSets
    local client = deps.client
    local store = deps.store
    local now = deps.now

    ---Whether there is room for one more set, as far as the client will say.
    ---
    ---A client that will not say is taken at its word rather than second-guessed: the cap is
    ---the server's and refusing on a guess would stop a player saving a set they had room for.
    ---The client refuses the call itself if it is wrong, and that reads as a failure rather
    ---than as a set nobody asked for.
    ---@param sets CustomSetState[]
    ---@return boolean
    local function hasRoom(sets)
        local cap = client.maxSets and client.maxSets()
        return type(cap) ~= "number" or #sets < cap
    end

    ---Carries out one request, and says what came of it.
    ---@param request CustomSetRequest
    ---@param sets CustomSetState[]
    ---@param at integer
    ---@return CustomSetOutcome
    local function carryOut(request, sets, at)
        local name = tostring(request.name or "")
        -- The server's own opinion, asked before anything is written. A name it will not take
        -- comes back as a refusal the app can show, rather than as a call that quietly does
        -- nothing and a set the player then goes looking for.
        if name == "" or (client.validName and client.validName(name) == false) then
            return { id = request.id, at = at, outcome = "refused", name = name }
        end

        local list = transmogList(request.slots)
        local existing = named(sets, name)
        if existing then
            client.modify(existing.id, list)
            return { id = request.id, at = at, outcome = "updated", setId = existing.id, name = name }
        end
        if not hasRoom(sets) then
            return { id = request.id, at = at, outcome = "full", name = name }
        end
        local setId = client.create(name, request.icon, list)
        -- `NewCustomSet` is documented as answering nothing when it did not make one. There is
        -- nothing to say about why, so the record says only that it did not happen — and
        -- because the request stays marked done either way, it is not retried on every load
        -- screen for the rest of the player's life.
        if type(setId) ~= "number" then
            return { id = request.id, at = at, outcome = "failed", name = name }
        end
        return { id = request.id, at = at, outcome = "created", setId = setId, name = name }
    end

    ---Drops the record of requests the app has stopped asking for.
    ---
    ---This is what keeps SavedVariables from growing by one row for every outfit a player ever
    ---sends. It is safe for one reason and only that reason: **the app keeps writing a request
    ---into this file until it has read what became of it**, so a request that has disappeared
    ---from the file is one the app has already been told about and will never ask for again.
    ---Forgetting it here cannot therefore make it happen twice.
    ---
    ---The order the two halves run in matters. This runs *after* the loop below, so an entry
    ---written a moment ago for a request still in the file survives to be reported at logout.
    ---@param done table<integer, CustomSetOutcome>
    ---@param requests CustomSetRequest[]
    ---@return table<integer, CustomSetOutcome>
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

    ---Applies every request the app has made that has not been applied already.
    ---
    ---Keyed on the request's own id rather than on anything about the set, which is what makes
    ---this safe to run at every load screen: the app writes the same file until it has been
    ---told the request landed, and a request already done is skipped rather than done twice. A
    ---player who deletes the resulting set in game keeps it deleted; Chronie asked once and was
    ---answered, and asking again on the next zoning would be the app overruling them.
    ---@param at integer?
    ---@return CustomSetOutcome[]
    local function run(at)
        local requests = readRequests()
        if type(requests) ~= "table" then
            return {}
        end
        at = at or now()
        local done = store.done or {}
        local sets = readSets() or {}
        local outcomes = {}
        for _, request in ipairs(requests) do
            local id = type(request) == "table" and tonumber(request.id)
            if id and not done[id] then
                local outcome = carryOut(request, sets, at)
                done[id] = outcome
                outcomes[#outcomes + 1] = outcome
                -- The client fires its own event for the change, but not before this loop
                -- finishes, so a second request in the same batch would otherwise be deciding
                -- create-or-replace against a wardrobe one set out of date.
                if outcome.setId and not named(sets, outcome.name) then
                    sets[#sets + 1] = { id = outcome.setId, name = outcome.name }
                end
            end
        end
        store.done = forget(done, requests)
        return outcomes
    end

    return { run = run }
end
