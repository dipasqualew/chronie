local _, ns = ...

---A single instance lockout, normalised for storage.
---@class Lockout
---@field instance string Localised instance name.
---@field difficultyId integer Stable, non-localised difficulty key.
---@field difficulty string Localised difficulty name, e.g. "10 Player (Heroic)".
---@field maxPlayers integer
---@field isRaid boolean
---@field expiry integer Absolute unix time the lockout resets.

---@class LockoutScanner
---@field scan fun(): Lockout[]

---@class LockoutScannerDeps
---@field getNumSavedInstances fun(): integer
--- Returns: name, lockoutId, reset, difficultyId, locked, extended, instanceIDMostSig,
--- isRaid, maxPlayers, difficultyName, numEncounters, encounterProgress, extendDisabled, instanceId
---@field getSavedInstanceInfo fun(index: integer): ...
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
    local now = deps.now

    return {
        ---@return Lockout[]
        scan = function()
            local lockouts = {}
            local scannedAt = now()

            for index = 1, getNumSavedInstances() do
                local name, _, reset, difficultyId, _, _, _, isRaid, maxPlayers, difficultyName =
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
                    }
                end
            end

            return lockouts
        end,
    }
end
