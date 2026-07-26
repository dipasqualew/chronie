local _, ns = ...

---One boss within a lockout.
---@class Encounter
---@field name string
---@field killed boolean

---A lock the client reports, normalised for storage.
---
---`key` names the *activity* — the lockable thing — and is what a lockout is filed under.
---Everything else is either a fact about the activity or a fact about this character's
---particular save.
---@class Lockout
---@field key string Identity of the activity, non-localised wherever the client allows it.
---@field activity string Localised name of the activity.
---@field kind "raid"|"dungeon"|"world_boss"
---@field difficultyId integer Stable, non-localised difficulty key. Zero when there is none.
---@field difficulty string Localised difficulty name, e.g. "10 Player (Heroic)".
---@field maxPlayers integer
---@field isRaid boolean
---@field expiry integer Absolute unix time the lockout resets.
---@field resetSeconds integer Span the client reported; the only evidence of the cadence.
---@field encounters Encounter[] Boss list in journal order.

---@class LockoutScanner
---@field scan fun(): Lockout[]

---@class LockoutScannerDeps
---@field getNumSavedInstances fun(): integer
--- Returns: name, lockoutId, reset, difficultyId, locked, extended, instanceIDMostSig,
--- isRaid, maxPlayers, difficultyName, numEncounters, encounterProgress, extendDisabled, instanceId
---@field getSavedInstanceInfo fun(index: integer): ...
--- Returns: bossName, fileDataID, isKilled
---@field getSavedInstanceEncounterInfo fun(instanceIndex: integer, encounterIndex: integer): ...
---@field getNumSavedWorldBosses fun(): integer?
--- Returns: name, worldBossID, reset
---@field getSavedWorldBossInfo fun(index: integer): ...
---@field now fun(): integer Unix time.

---Identity of an instance lockout: the instance name alone, deliberately. Being saved to a
---raid at one difficulty bars the others too, so keying per difficulty would report a locked
---character as free at the sibling size.
---@param name string
---@return string
local function instanceKey(name)
    return "instance\0" .. name
end

---Identity of a world boss. The client's numeric id when it has one, because that survives a
---locale change; the name only as a fallback.
---@param name string
---@param worldBossID integer?
---@return string
local function worldBossKey(name, worldBossID)
    return "worldboss\0" .. tostring(worldBossID or name)
end

---Reads every lock the client knows this character is under.
---
---`reset` from both APIs is SECONDS REMAINING, not a timestamp. It is only meaningful
---relative to the moment of the scan, so it is converted to an absolute expiry here — that
---conversion is the whole reason cross-character data works at all. The raw span is kept
---beside it, because it is the only evidence of how often the activity resets.
---@param deps LockoutScannerDeps
---@return LockoutScanner
function ns.newLockoutScanner(deps)
    local getNumSavedInstances = deps.getNumSavedInstances
    local getSavedInstanceInfo = deps.getSavedInstanceInfo
    local getSavedInstanceEncounterInfo = deps.getSavedInstanceEncounterInfo
    local getNumSavedWorldBosses = deps.getNumSavedWorldBosses
    local getSavedWorldBossInfo = deps.getSavedWorldBossInfo
    local now = deps.now

    ---Encounter info is indexed by position in the live saved-instance list, so it is
    ---only readable for the logged-in character. It has to be captured here, at scan
    ---time, or it cannot be shown for anyone else later.
    ---@param instanceIndex integer
    ---@param numEncounters integer?
    ---@return Encounter[]
    local function readEncounters(instanceIndex, numEncounters)
        local encounters = {}

        for encounterIndex = 1, numEncounters or 0 do
            local bossName, _, isKilled = getSavedInstanceEncounterInfo(instanceIndex, encounterIndex)
            if bossName then
                encounters[#encounters + 1] = {
                    name = bossName,
                    killed = isKilled and true or false,
                }
            end
        end

        return encounters
    end

    ---@param lockouts Lockout[]
    ---@param scannedAt integer
    local function readInstances(lockouts, scannedAt)
        for index = 1, getNumSavedInstances() do
            local name, _, reset, difficultyId, _, _, _, isRaid, maxPlayers, difficultyName, numEncounters =
                getSavedInstanceInfo(index)

            -- reset == 0 means the lockout has already lapsed; the client still
            -- lists it for a while, and we have no real expiry to record.
            if name and reset and reset > 0 then
                lockouts[#lockouts + 1] = {
                    key = instanceKey(name),
                    activity = name,
                    kind = isRaid and "raid" or "dungeon",
                    difficultyId = difficultyId or 0,
                    difficulty = difficultyName or "",
                    maxPlayers = maxPlayers or 0,
                    isRaid = isRaid and true or false,
                    expiry = scannedAt + reset,
                    resetSeconds = reset,
                    encounters = readEncounters(index, numEncounters),
                }
            end
        end
    end

    ---World bosses are a separate list behind a separate API, and the client says nothing
    ---about them beyond the name and the reset: appearing on the list *is* the kill, so
    ---there is no encounter to read. A build without the API is simply a build with no
    ---world bosses, which is why this degrades to nothing rather than failing the scan.
    ---@param lockouts Lockout[]
    ---@param scannedAt integer
    local function readWorldBosses(lockouts, scannedAt)
        if not getNumSavedWorldBosses or not getSavedWorldBossInfo then
            return
        end

        for index = 1, getNumSavedWorldBosses() or 0 do
            local name, worldBossID, reset = getSavedWorldBossInfo(index)

            if name and reset and reset > 0 then
                lockouts[#lockouts + 1] = {
                    key = worldBossKey(name, worldBossID),
                    activity = name,
                    kind = "world_boss",
                    difficultyId = 0,
                    difficulty = "",
                    maxPlayers = 0,
                    isRaid = false,
                    expiry = scannedAt + reset,
                    resetSeconds = reset,
                    encounters = {},
                }
            end
        end
    end

    return {
        ---@return Lockout[]
        scan = function()
            local lockouts = {}
            local scannedAt = now()

            readInstances(lockouts, scannedAt)
            readWorldBosses(lockouts, scannedAt)

            return lockouts
        end,
    }
end
