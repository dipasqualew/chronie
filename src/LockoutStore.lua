local _, ns = ...

---A stored lockout with its owning character attached.
---@class LockoutRow : Lockout
---@field character string "Name-Realm".

---@class LockoutStore
---@field save fun(character: string, lockouts: Lockout[])
---@field all fun(): LockoutRow[]

---@class LockoutStoreDeps
---@field db table SavedVariables table; mutated in place so the client persists it.
---@field now fun(): integer
---@field staleAfterSeconds integer? Drop lockouts this long past expiry. Default 7 days.

local DEFAULT_STALE_AFTER = 7 * 24 * 60 * 60

---Identity of a lockout, independent of when it was observed. Uses difficultyId
---rather than the localised difficulty name so the key survives a client locale change.
---@param lockout Lockout
---@return string
local function keyOf(lockout)
    return lockout.instance .. "\0" .. tostring(lockout.difficultyId)
end

---@param deps LockoutStoreDeps
---@return LockoutStore
function ns.newLockoutStore(deps)
    local db = deps.db
    local now = deps.now
    local staleAfter = deps.staleAfterSeconds or DEFAULT_STALE_AFTER

    db.characters = db.characters or {}

    return {
        ---Replaces what we know about `character`, keeping only the latest lockout per
        ---instance+difficulty. Only the logged-in character can be scanned, so this
        ---never touches other characters' entries.
        ---@param character string
        ---@param lockouts Lockout[]
        save = function(character, lockouts)
            local latest = {}

            for _, lockout in ipairs(lockouts) do
                local key = keyOf(lockout)
                local existing = latest[key]
                if not existing or lockout.expiry > existing.expiry then
                    latest[key] = lockout
                end
            end

            db.characters[character] = latest
        end,

        ---Flattens every character's lockouts into one list, pruning entries that
        ---expired long enough ago to be noise.
        ---@return LockoutRow[]
        all = function()
            local cutoff = now() - staleAfter
            local rows = {}

            for character, lockouts in pairs(db.characters) do
                for key, lockout in pairs(lockouts) do
                    if lockout.expiry < cutoff then
                        lockouts[key] = nil
                    else
                        rows[#rows + 1] = {
                            character = character,
                            instance = lockout.instance,
                            difficultyId = lockout.difficultyId,
                            difficulty = lockout.difficulty,
                            maxPlayers = lockout.maxPlayers,
                            isRaid = lockout.isRaid,
                            expiry = lockout.expiry,
                        }
                    end
                end
            end

            return rows
        end,
    }
end
