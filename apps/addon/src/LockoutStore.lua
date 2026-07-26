local _, ns = ...

---A stored lockout with its activity and owning character attached.
---@class LockoutRow : Lockout
---@field character string "Name-Realm".
---@field classFile string? Non-localised class token of the owner, when it is known.
---@field period "daily"|"weekly"|"unknown" How often the activity resets.

---What is true of a lockable activity regardless of who is locked to it, or of whether
---anybody currently is.
---@class ActivityRecord
---@field key string
---@field activity string
---@field kind "raid"|"dungeon"|"world_boss"
---@field isRaid boolean
---@field period "daily"|"weekly"|"unknown"

---What we know about a character outside of its lockouts.
---@class CharacterInfo
---@field class string? Localised class name.
---@field classFile string? Non-localised class token, e.g. "WARRIOR".
---@field level integer?

---@class LockoutStore
---@field save fun(character: string, lockouts: Lockout[])
---@field all fun(): LockoutRow[]
---@field activities fun(): ActivityRecord[]
---@field remember fun(character: string, info: CharacterInfo?)
---@field characters fun(): RosterEntry[]

---@class LockoutStoreDeps
---@field db table SavedVariables table; mutated in place so the client persists it.
---@field now fun(): integer
---@field staleAfterSeconds integer? Drop lockouts this long past expiry. Default 7 days.

local DEFAULT_STALE_AFTER = 7 * 24 * 60 * 60

---How often each kind of activity resets. Raids are weekly and dungeons are daily; a world
---boss goes with the raids. This is deliberately a flat rule about the kind of thing an
---activity is rather than anything read off a particular lockout — the client never states
---a cadence, and working one out from how long a lock happened to have left is a guess that
---is wrong for as long as it takes to be corrected.
local PERIOD_OF_KIND = { raid = "weekly", dungeon = "daily", world_boss = "weekly" }

---@param kind string?
---@return "daily"|"weekly"|"unknown"
local function cadenceOf(kind)
    return PERIOD_OF_KIND[kind] or "unknown"
end

---Where one character's save of an activity is filed.
---
---The activity is the lockable thing; a save of it still belongs to one difficulty, and two
---difficulties of the same raid can be held at once. So the slot is finer than the activity
---key, and it is the drill-down's job — not storage's — to decide when being saved at one
---difficulty should count against another. Uses difficultyId rather than the localised
---difficulty name so the slot survives a client locale change.
---@param lockout Lockout
---@return string
local function slotOf(lockout)
    return lockout.key .. "\0" .. tostring(lockout.difficultyId)
end

---The activity a stored entry belongs to. Entries written before activities existed name
---only the instance, which is exactly what the key was built from.
---@param lockout table
---@param slot string
---@return string
local function activityKeyOf(lockout, slot)
    return lockout.key or ("instance\0" .. (lockout.instance or slot))
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
    -- What is true of the activity itself. Also never replaced wholesale: an activity nobody
    -- is currently locked to is still an activity, and forgetting it every quiet week would
    -- mean the drill-down could not offer it at all.
    db.activities = db.activities or {}

    ---Saves written before lockouts were filed under activities name the instance
    ---`instance` and carry no kind. Reading through these fallbacks is what stops an old
    ---save looking like an empty one until every character has logged in again.
    ---@param record table the activity's own record, which may be empty
    ---@param lockout table
    ---@param key string
    ---@return string
    local function activityNameOf(record, lockout, key)
        return lockout.activity or record.activity or lockout.instance or key
    end

    ---@param lockout table
    ---@return "raid"|"dungeon"|"world_boss"
    local function kindOf(lockout)
        return lockout.kind or (lockout.isRaid and "raid" or "dungeon")
    end

    ---Files what this scan says about the activity itself.
    ---@param lockout Lockout
    local function recordActivity(lockout)
        local record = db.activities[lockout.key] or {}
        record.activity = lockout.activity or record.activity
        record.kind = lockout.kind or record.kind
        record.isRaid = lockout.isRaid and true or false
        -- Written out rather than left to be recomputed, so the file says plainly how often
        -- the activity resets instead of making every reader derive it again.
        record.period = cadenceOf(record.kind)
        record.lastSeen = now()
        db.activities[lockout.key] = record
    end

    return {
        ---Records that `character` exists, so it can be listed as "available" for
        ---activities it has never been locked to. Called when the character logs in,
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

        ---Every lockable activity the addon has ever recorded, whether or not anybody is
        ---currently locked to it.
        ---@return ActivityRecord[]
        activities = function()
            local list = {}

            for key, record in pairs(db.activities) do
                local kind = record.kind or (record.isRaid and "raid" or "dungeon")
                list[#list + 1] = {
                    key = key,
                    activity = record.activity or key,
                    kind = kind,
                    isRaid = record.isRaid and true or false,
                    period = cadenceOf(kind),
                }
            end

            table.sort(list, function(left, right)
                return left.activity < right.activity
            end)

            return list
        end,

        ---Replaces what we know about `character`, keeping only the latest lockout per
        ---activity. Only the logged-in character can be scanned, so this never touches
        ---other characters' entries.
        ---@param character string
        ---@param lockouts Lockout[]
        save = function(character, lockouts)
            local latest = {}

            for _, lockout in ipairs(lockouts) do
                recordActivity(lockout)
                local slot = slotOf(lockout)
                local existing = latest[slot]
                if not existing or lockout.expiry > existing.expiry then
                    latest[slot] = lockout
                end
            end

            db.characters[character] = latest
        end,

        ---Flattens every character's lockouts into one list, pruning entries that expired
        ---long enough ago to be noise. Facts about the activity are merged in from
        ---`db.activities`, because that is where they live — a row is one character's save
        ---*of* an activity rather than a copy of it.
        ---@return LockoutRow[]
        all = function()
            local cutoff = now() - staleAfter
            local rows = {}

            for character, lockouts in pairs(db.characters) do
                -- Class lives on the roster, not the lockout: it is a fact about the
                -- character that outlives any particular week's saves.
                local classFile = (db.roster[character] or {}).classFile

                for slot, lockout in pairs(lockouts) do
                    if lockout.expiry < cutoff then
                        lockouts[slot] = nil
                    else
                        local key = activityKeyOf(lockout, slot)
                        local record = db.activities[key] or {}
                        local kind = kindOf(lockout)
                        rows[#rows + 1] = {
                            character = character,
                            classFile = classFile,
                            key = key,
                            activity = activityNameOf(record, lockout, key),
                            kind = kind,
                            period = cadenceOf(kind),
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
