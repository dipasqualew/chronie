local _, ns = ...

---One boss within a lockout.
---@class Encounter
---@field name string
---@field killed boolean

---A single instance lockout, normalised for storage.
---@class Lockout
---@field instance string Localised instance name.
---@field difficultyId integer Stable, non-localised difficulty key.
---@field difficulty string Localised difficulty name, e.g. "10 Player (Heroic)".
---@field maxPlayers integer
---@field isRaid boolean
---@field expiry integer Absolute unix time the lockout resets.
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
---@field now fun(): integer Unix time.

---Reads the client's saved-instance list.
---
---`reset` from the API is SECONDS REMAINING, not a timestamp. It is only meaningful
---relative to the moment of the scan, so it is converted to an absolute expiry here —
---that conversion is the whole reason cross-character data works at all.
---@param deps LockoutScannerDeps
---@return LockoutScanner
function ns.newLockoutScanner(deps)
    local getNumSavedInstances = deps.getNumSavedInstances
    local getSavedInstanceInfo = deps.getSavedInstanceInfo
    local getSavedInstanceEncounterInfo = deps.getSavedInstanceEncounterInfo
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

    return {
        ---@return Lockout[]
        scan = function()
            local lockouts = {}
            local scannedAt = now()

            for index = 1, getNumSavedInstances() do
                local name, _, reset, difficultyId, _, _, _, isRaid, maxPlayers, difficultyName, numEncounters =
                    getSavedInstanceInfo(index)

                -- reset == 0 means the lockout has already lapsed; the client still
                -- lists it for a while, and we have no real expiry to record.
                if name and reset and reset > 0 then
                    lockouts[#lockouts + 1] = {
                        instance = name,
                        difficultyId = difficultyId or 0,
                        difficulty = difficultyName or "",
                        maxPlayers = maxPlayers or 0,
                        isRaid = isRaid and true or false,
                        expiry = scannedAt + reset,
                        encounters = readEncounters(index, numEncounters),
                    }
                end
            end

            return lockouts
        end,
    }
end
