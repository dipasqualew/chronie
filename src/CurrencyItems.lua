local _, ns = ...

---The set of item-based currencies the player has chosen to track, persisted in the
---SavedVariables so the choice survives a logout. Pure logic over the db table: the
---tally's currency-item snapshot and the manager window both read and edit the list
---through this rather than poking db.currencyItems directly.
---@class CurrencyItems
---@field ids fun(): integer[] Tracked item IDs, ascending.
---@field has fun(itemID: integer): boolean Whether an item is currently tracked.
---@field add fun(itemID: integer, name: string?): boolean True only when it was newly added.
---@field remove fun(itemID: integer): boolean True only when it was present and removed.
---@field list fun(): { id: integer, name: string }[] Tracked items, sorted by name then id.

---@class CurrencyItemsDeps
---@field db table SavedVariables root; the list lives under db.currencyItems.

---@param deps CurrencyItemsDeps
---@return CurrencyItems
function ns.newCurrencyItems(deps)
    local db = deps.db

    ---A list written by an earlier build stored bare IDs in an array; the current shape is
    ---a map of item ID to display name. Folding the old array into the map on every read
    ---keeps membership tests and removal O(1), makes a double-add a no-op, and lets the
    ---name ride along so the manager can show a row even when the item is in no bag. The
    ---migration only touches array entries whose value is a number, so a map entry that
    ---happens to sit at a low integer key is never mistaken for an old-format ID.
    ---@return table<integer, string>
    local function items()
        db.currencyItems = db.currencyItems or {}
        local map = db.currencyItems
        local migrated
        for index, value in ipairs(map) do
            if type(value) == "number" then
                migrated = migrated or {}
                migrated[value] = tostring(value)
                map[index] = nil
            end
        end
        for id, name in pairs(migrated or {}) do
            map[id] = map[id] or name
        end
        return map
    end

    return {
        ids = function()
            local ids = {}
            for id in pairs(items()) do
                ids[#ids + 1] = id
            end
            table.sort(ids)
            return ids
        end,

        has = function(itemID)
            return itemID ~= nil and items()[itemID] ~= nil
        end,

        ---@param itemID integer
        ---@param name string?
        ---@return boolean added
        add = function(itemID, name)
            if type(itemID) ~= "number" then
                return false
            end
            local map = items()
            local named = name and name ~= "" and name or nil
            if map[itemID] ~= nil then
                -- Already tracked; still fold in a name that arrived after a bare add.
                if named then
                    map[itemID] = named
                end
                return false
            end
            map[itemID] = named or tostring(itemID)
            return true
        end,

        ---@param itemID integer
        ---@return boolean removed
        remove = function(itemID)
            local map = items()
            if itemID == nil or map[itemID] == nil then
                return false
            end
            map[itemID] = nil
            return true
        end,

        list = function()
            local list = {}
            for id, name in pairs(items()) do
                list[#list + 1] = { id = id, name = name }
            end
            table.sort(list, function(left, right)
                if left.name ~= right.name then
                    return left.name < right.name
                end
                return left.id < right.id
            end)
            return list
        end,
    }
end
