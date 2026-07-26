local _, ns = ...

---@class LockoutTable
---@field sort fun(rows: LockoutRow[], key: "character"|"instance", ascending: boolean): LockoutRow[]
---@field isExpired fun(row: LockoutRow): boolean
---@field formatExpiry fun(row: LockoutRow): string
---@field encounterSummary fun(row: LockoutRow): string

---@class LockoutTableDeps
---@field now fun(): integer
---@field formatDate fun(format: string, timestamp: integer): string Usually the global `date`.

local MINUTE, HOUR, DAY = 60, 3600, 86400

---Field precedence for each sort key. The trailing fields make the order total, so
---the table never reshuffles between identical renders.
local ORDER = {
    character = { "character", "instance", "difficulty" },
    instance = { "instance", "character", "difficulty" },
}

---@param deps LockoutTableDeps
---@return LockoutTable
function ns.newLockoutTable(deps)
    local now = deps.now
    local formatDate = deps.formatDate

    ---@param row LockoutRow
    ---@return boolean
    local function isExpired(row)
        return row.expiry <= now()
    end

    return {
        isExpired = isExpired,

        ---"3/8 bosses defeated", or a clear notice when the lockout predates boss
        ---tracking (rows saved before this feature shipped carry no encounter list).
        ---@param row LockoutRow
        ---@return string
        encounterSummary = function(row)
            local encounters = row.encounters
            if not encounters or #encounters == 0 then
                return "No boss data — log in on this character to record it"
            end

            local killed = 0
            for _, encounter in ipairs(encounters) do
                if encounter.killed then
                    killed = killed + 1
                end
            end

            return string.format("%d/%d bosses defeated", killed, #encounters)
        end,

        ---Sorts a copy; the caller's list is left alone.
        ---@param rows LockoutRow[]
        ---@param key "character"|"instance"
        ---@param ascending boolean
        ---@return LockoutRow[]
        sort = function(rows, key, ascending)
            local fields = ORDER[key] or ORDER.character

            local sorted = {}
            for index, row in ipairs(rows) do
                sorted[index] = row
            end

            table.sort(sorted, function(left, right)
                for _, field in ipairs(fields) do
                    local a, b = left[field] or "", right[field] or ""
                    if a ~= b then
                        if ascending then
                            return a < b
                        end
                        return a > b
                    end
                end
                -- Fully equal on every field: preserve a deterministic tiebreak.
                return left.expiry < right.expiry
            end)

            return sorted
        end,

        ---Absolute date plus a coarse countdown, e.g. "12 Aug 09:00 (3d 4h)".
        ---@param row LockoutRow
        ---@return string
        formatExpiry = function(row)
            local stamp = formatDate("%d %b %H:%M", row.expiry)
            local remaining = row.expiry - now()

            if remaining <= 0 then
                return stamp .. " (expired)"
            end

            local days = math.floor(remaining / DAY)
            local hours = math.floor((remaining % DAY) / HOUR)
            local minutes = math.floor((remaining % HOUR) / MINUTE)

            local countdown
            if days > 0 then
                countdown = string.format("%dd %dh", days, hours)
            elseif hours > 0 then
                countdown = string.format("%dh %dm", hours, minutes)
            else
                countdown = string.format("%dm", minutes)
            end

            return string.format("%s (%s)", stamp, countdown)
        end,
    }
end
