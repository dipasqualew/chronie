local _, ns = ...

---One appearance in a saved set, and where on the character it sits.
---
---`slot` is the client's own `TransmogSlot`: 0 head, 1 shoulder, 2 back, 3 chest, 4 body,
---5 tabard, 6 wrist, 7 hand, 8 waist, 9 legs, 10 feet, 11 main hand, 12 off hand. It is
---carried rather than worked out again downstream because it is the only thing that answers
---which hand a one-hander goes in — a question the game's display types cannot settle, and
---one the app otherwise has to guess at.
---
---`appearance` is a *source* id, an `ItemModifiedAppearance` row, which is the same number the
---app already stores against a piece of a set of its own. That is what lets a set read out of
---the game and a set assembled in the app end up drawn by the same code.
---@class CustomSetSlotState
---@field slot integer
---@field appearance integer
---@field secondary integer? The second appearance a slot can carry, where it carries one.
---@field illusion integer? The enchant illusion on a weapon, likewise.

---One of the player's own transmog sets, as the game holds it.
---@class CustomSetState
---@field id integer The client's id for the set, which survives a rename.
---@field name string What the player called it.
---@field icon integer? The file id of the picture the game shows it under.
---@field slots CustomSetSlotState[] What is in it, ascending by slot.

---Keeps the last look at the player's own transmog sets, so the app can be told about them.
---@class CustomSetSnapshot
---@field sync fun(at: integer?): CustomSetState[] Take a look, and file it if it says anything new.

---@class CustomSetSnapshotDeps
---@field readSets fun(): CustomSetState[]? Every set the account has right now.
---@field store table Where the last look is kept, so a logout still has it to write out.
---@field now fun(): integer

---An empty slot reports `Constants.Transmog.NoTransmogID`, which is `0`, rather than nothing
---at all. It is not an appearance and a set is not shorter for holding one, so the slot is
---dropped and the absence is the record — the same rule `EquipsetLedger` applies to the `0`
---and `1` the equipment manager reports for a slot holding nothing.
local NO_TRANSMOG = 0

---One number, or nothing, out of whatever the client handed over.
---@param value any
---@return integer?
local function number(value)
    return type(value) == "number" and value or nil
end

---An optional appearance: a real one, or nothing.
---
---Zero is the client's way of saying "no illusion here" as much as "no appearance here", so
---it is dropped from the two optional fields for the same reason it is dropped from the
---required one. A field carried as `0` would read downstream as an appearance nobody can
---look up.
---@param value any
---@return integer?
local function appearance(value)
    local id = number(value)
    if not id or id == NO_TRANSMOG then
        return nil
    end
    return id
end

---Normalises one client-shaped slot, or rejects it.
---@param state any
---@return CustomSetSlotState?
local function slotState(state)
    if type(state) ~= "table" then
        return nil
    end
    local slot, worn = number(state.slot), appearance(state.appearance)
    if not slot or not worn then
        return nil
    end
    return {
        slot = slot,
        appearance = worn,
        secondary = appearance(state.secondary),
        illusion = appearance(state.illusion),
    }
end

---Normalises one client-shaped set, or rejects it.
---
---A set with nothing in it is still a set. The player named it and the game is holding it,
---and a snapshot that dropped it would show them a list their own wardrobe disagrees with.
---@param state any
---@return CustomSetState?
local function setState(state)
    if type(state) ~= "table" then
        return nil
    end
    local id = number(state.id)
    if not id then
        return nil
    end
    local slots = {}
    for _, raw in ipairs(state.slots or {}) do
        slots[#slots + 1] = slotState(raw)
    end
    -- Ascending by slot, because `pairs` over the client's list would hand these back in
    -- whatever order it felt like and a file whose rows reshuffle between two readings of an
    -- unchanged wardrobe is a file the sync below can never call unchanged.
    table.sort(slots, function(left, right)
        return left.slot < right.slot
    end)
    return {
        id = id,
        name = tostring(state.name or ""),
        icon = number(state.icon),
        slots = slots,
    }
end

---Every set the client named, normalised and ordered by id.
---@param sets any
---@return CustomSetState[]
local function snapshot(sets)
    local out = {}
    for _, raw in ipairs(sets or {}) do
        out[#out + 1] = setState(raw)
    end
    table.sort(out, function(left, right)
        return left.id < right.id
    end)
    return out
end

---Whether two normalised snapshots say the same thing.
---
---Both sides are already sorted and already stripped of everything optional that was empty,
---which is what makes a walk in step a fair comparison rather than an accident of ordering.
---@param left any
---@param right any
---@return boolean
local function same(left, right)
    if type(left) ~= type(right) then
        return false
    end
    if type(left) ~= "table" then
        return left == right
    end
    for key, value in pairs(left) do
        if not same(value, right[key]) then
            return false
        end
    end
    for key in pairs(right) do
        if left[key] == nil then
            return false
        end
    end
    return true
end

---@param deps CustomSetSnapshotDeps
---@return CustomSetSnapshot
function ns.newCustomSetSnapshot(deps)
    local readSets = deps.readSets
    local store = deps.store
    local now = deps.now

    ---Looks at the player's sets and files the look, if it says anything the last one did not.
    ---
    ---The whole list every time rather than what changed, which is the opposite of what
    ---`EquipsetLedger` does with equipment sets, and deliberately. A ledger of changes is what
    ---a *history* is made of; this is a *wardrobe*, and what the app wants to draw is what the
    ---player has now. Writing it wholesale is also the only cleaning up the file ever needs:
    ---a set deleted in game stops being written the moment it stops existing, so nothing
    ---accumulates and nothing downstream has to prune.
    ---
    ---`at` moves only when the sets actually differ. The client fires its event for things
    ---that leave the wardrobe exactly as it was — reselecting a set in the dropdown is one —
    ---and an `at` that crept forward on those would tell the app a player had been rearranging
    ---their wardrobe on an evening they only looked at it.
    ---@param at integer?
    ---@return CustomSetState[]
    local function sync(at)
        local current = snapshot(readSets())
        if not same(current, store.sets) then
            store.sets = current
            store.at = at or now()
        end
        return current
    end

    return { sync = sync }
end
