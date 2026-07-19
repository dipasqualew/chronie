local _, ns = ...

---A stored lockout with its owning character attached.
---@class LockoutRow : Lockout
---@field character string "Name-Realm".

---What we know about a character outside of its lockouts.
---@class CharacterInfo
---@field class string? Localised class name.
---@field classFile string? Non-localised class token, e.g. "WARRIOR".
---@field level integer?

---@class LockoutStore
---@field save fun(character: string, lockouts: Lockout[])
---@field all fun(): LockoutRow[]
---@field remember fun(character: string, info: CharacterInfo?)
---@field characters fun(): RosterEntry[]

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
    -- Kept beside `characters` rather than inside it: lockout entries are replaced
    -- wholesale on every scan, and roster facts must outlive that.
    db.roster = db.roster or {}

    return {
        ---Records that `character` exists, so it can be listed as "available" for
        ---instances it has never been locked to. Called when the character logs in,
        ---which is the only moment the client can tell us about it.
        ---@param character string
        ---@param info CharacterInfo?
        remember = function(character, info)
            info = info or {}
            local entry = db.roster[character] or {}
            entry.class = info.class or entry.class
            entry.classFile = info.classFile or entry.classFile
            entry.level = info.level or entry.level
            entry.lastSeen = now()
            db.roster[character] = entry
        end,

        ---Every character the addon has ever seen, whether it was remembered at login
        ---or only ever showed up as the owner of a lockout.
        ---@return RosterEntry[]
        characters = function()
            local seen = {}
            local list = {}

            local function add(character)
                if seen[character] then
                    return
                end
                seen[character] = true
                local entry = db.roster[character] or {}
                list[#list + 1] = {
                    character = character,
                    class = entry.class,
                    classFile = entry.classFile,
                    level = entry.level,
                    lastSeen = entry.lastSeen,
                }
            end

            for character in pairs(db.roster) do
                add(character)
            end
            for character in pairs(db.characters) do
                add(character)
            end

            table.sort(list, function(left, right)
                return left.character < right.character
            end)

            return list
        end,

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
                            encounters = lockout.encounters or {},
                        }
                    end
                end
            end

            return rows
        end,
    }
end
