local _, ns = ...

---What one equipment set looks like at a moment in time.
---@class EquipsetState
---@field name string What the player called the set.
---@field items table<integer, integer> Item id per inventory slot; a slot holding nothing is absent.

---One item as the character is wearing it right now.
---@class EquippedItem
---@field id integer
---@field level integer? What the item is actually worth, upgrades and all.
---@field name string? Localised item name.

---One thing that happened to one equipment set.
---
---`kind` is what the ledger is a ledger of: a set that appeared, a set that went away, or a
---set whose items were edited. A rename on its own is not a change here — the set is the
---same set, holding the same items, under a new label — but the new name still travels on
---the record, because a change is worth nothing on screen without the name it happened to.
---@class EquipsetChange
---@field setId integer The client's own id for the set, which survives a rename.
---@field name string The set's name as of the change.
---@field kind string "created", "deleted" or "updated".
---@field at integer
---@field items EquipsetSlotState[] What each slot that changed holds now, ascending by slot.

---What one slot holds after a change: the ledger's row, and the whole of it.
---
---There is no "before" here on purpose. The row before this one for the same slot is the
---before, and writing it twice would only create two places for it to disagree. A slot the
---change emptied — a cleared slot, or every slot of a deleted set — carries no `itemId`,
---and the absence is the entry.
---@class EquipsetSlotState
---@field slot integer Inventory slot id: 1 head, 2 neck, 3 shoulder, and so on to 19 tabard.
---@field itemId integer? What is in the slot now.
---@field itemLevel integer? What that item is worth, when the client could be asked.
---@field itemName string? What the client calls it, likewise.

---Watches the character's equipment sets and reports what changed between two looks.
---@class EquipsetLedger
---@field sync fun(at: integer?): EquipsetChange[] Compare with the last look and adopt this one.

---@class EquipsetLedgerDeps
---@field readSets fun(): table<integer, EquipsetState>? Every set the character has right now.
---@field readEquipped fun(): table<integer, EquippedItem>? What the character is wearing, by slot.
---@field store table Where the last look is kept, so an edit is still seen after a reload.
---@field now fun(): integer

---The client reports a slot the set holds nothing for as `0`, and a slot the set has been
---told to leave alone as `1`. Neither is an item, and for a ledger they say the same thing —
---no item is in that slot — so both become an absence and the pair never has to be told
---apart. No real equippable item has an id in that range, so nothing is lost by the rule.
local NOT_AN_ITEM = { [0] = true, [1] = true }

---Normalises one client-shaped set into the shape the diff compares.
---@param state table?
---@return EquipsetState?
local function normalise(state)
    if type(state) ~= "table" then
        return nil
    end
    local items = {}
    for slot, itemId in pairs(state.items or {}) do
        if type(slot) == "number" and type(itemId) == "number" and not NOT_AN_ITEM[itemId] then
            items[slot] = itemId
        end
    end
    return { name = tostring(state.name or ""), items = items }
end

---@param sets table?
---@return table<integer, EquipsetState>
local function snapshot(sets)
    local out = {}
    for setId, state in pairs(sets or {}) do
        local clean = normalise(state)
        if type(setId) == "number" and clean then
            out[setId] = clean
        end
    end
    return out
end

---Every slot mentioned by either side of a comparison, ascending.
---
---Sorting is what makes the result worth storing: `pairs` over a slot table hands the slots
---back in whatever order the hash landed them in, and a ledger whose rows reshuffle between
---two readings of the same change is a ledger nobody can diff by eye.
---@param before table<integer, integer>
---@param after table<integer, integer>
---@return integer[]
local function slotsOf(before, after)
    local seen, slots = {}, {}
    for _, items in ipairs({ before, after }) do
        for slot in pairs(items) do
            if not seen[slot] then
                seen[slot] = true
                slots[#slots + 1] = slot
            end
        end
    end
    table.sort(slots)
    return slots
end

---@param deps EquipsetLedgerDeps
---@return EquipsetLedger
function ns.newEquipsetLedger(deps)
    local store = deps.store
    local readSets = deps.readSets
    local readEquipped = deps.readEquipped
    local now = deps.now

    ---What a slot holds after the change, described as fully as the client allows.
    ---
    ---Saving an equipment set saves what the character is wearing, so at the moment a set is
    ---created or saved over, the items that went into it are the equipped ones and can be
    ---asked their real item level — the one upgrades and sockets and crafted quality made,
    ---which is the only one worth calling an item level. That is why this matches against
    ---what is equipped rather than reading the set: an item that is not on the character
    ---cannot be asked, and the set's own tables would only ever answer the base level.
    ---
    ---A slot whose new item is not the equipped one — a set edited in a session where
    ---nothing was recorded, and only noticed at the next login — keeps its id and goes
    ---without the rest. An unnamed, unlevelled row is a worse row than its neighbours and
    ---a better one than a level that was guessed.
    ---@param slot integer
    ---@param itemId integer?
    ---@param equipped table<integer, EquippedItem>
    ---@return EquipsetSlotState
    local function slotState(slot, itemId, equipped)
        local state = { slot = slot, itemId = itemId }
        local worn = itemId and equipped[slot]
        if worn and worn.id == itemId then
            state.itemLevel = worn.level
            state.itemName = worn.name
        end
        return state
    end

    ---The slots that differ between two states of one set, as they stand afterwards.
    ---@param before table<integer, integer>
    ---@param after table<integer, integer>
    ---@param equipped table<integer, EquippedItem>
    ---@return EquipsetSlotState[]
    local function slotChanges(before, after, equipped)
        local changes = {}
        for _, slot in ipairs(slotsOf(before, after)) do
            if before[slot] ~= after[slot] then
                changes[#changes + 1] = slotState(slot, after[slot], equipped)
            end
        end
        return changes
    end

    ---Compares the character's sets with the last look and reports the difference.
    ---
    ---The very first look reports nothing. The client fires one event for "the sets
    ---changed" without saying which or how, so the only way to know what changed is to
    ---keep the last look and subtract — and on a character the addon has never seen, every
    ---set it owns would otherwise arrive as freshly created on the login that first noticed
    ---them. Seeding the baseline silently costs the ledger only changes made before Chronie
    ---was ever installed, which it could not have witnessed anyway.
    ---@param at integer?
    ---@return EquipsetChange[]
    local function sync(at)
        local current = snapshot(readSets())
        local previous = store.sets
        store.sets = current
        if previous == nil then
            return {}
        end

        at = at or now()
        local equipped = readEquipped and readEquipped() or {}
        local changes = {}
        for setId, state in pairs(current) do
            local was = previous[setId]
            if not was then
                changes[#changes + 1] = {
                    setId = setId,
                    name = state.name,
                    kind = "created",
                    at = at,
                    items = slotChanges({}, state.items, equipped),
                }
            else
                local items = slotChanges(was.items, state.items, equipped)
                if #items > 0 then
                    changes[#changes + 1] = {
                        setId = setId,
                        name = state.name,
                        kind = "updated",
                        at = at,
                        items = items,
                    }
                end
            end
        end
        for setId, state in pairs(previous) do
            if not current[setId] then
                -- A deleted set closes its ledger out rather than trailing off: every slot
                -- it held gets a row saying it now holds nothing, so the latest row per slot
                -- describes a set that is gone instead of one frozen as it last was.
                changes[#changes + 1] = {
                    setId = setId,
                    name = state.name,
                    kind = "deleted",
                    at = at,
                    items = slotChanges(state.items, {}, equipped),
                }
            end
        end

        -- Both loops above walk a hash, so without this the order of a login that created
        -- two sets would be whatever the table felt like. Set id is stable and unique, so
        -- it is the one ordering that reads the same every time the same edit is replayed.
        table.sort(changes, function(left, right)
            return left.setId < right.setId
        end)
        return changes
    end

    return { sync = sync }
end
