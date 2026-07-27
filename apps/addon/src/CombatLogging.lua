local _, ns = ...

---Turning the client's combat log on, and saying honestly whether it went on.
---
---Two switches, not one. `LoggingCombat(true)` produces a file; the `advancedCombatLogging`
---CVar — the Advanced Combat Logging box in the Network options — is what puts positions,
---map ids and facing into the lines of it. A log without the second is close to useless for
---anything that wants to know where the player was standing, so "logging is on" is not the
---question worth answering and this module never answers only that.
---
---Neither switch is trusted to have worked. `SetCVar` does nothing from insecure code for
---the CVars Blizzard protects and raises on others, and no list of which those are holds
---across patches — so the value is written and then read back, and whatever the read says is
---what gets reported. The same for logging itself. That way the player is told what the
---client actually did rather than what the addon asked it to do.
---@class CombatLogging
---@field apply fun(): CombatLoggingState Assert the requested state, then report the real one.
---@field state fun(): CombatLoggingState Report the real one, changing nothing.
---@field describe fun(state: CombatLoggingState): string What to tell the player about it.

---What the client is really doing, read back after the asking.
---@class CombatLoggingState
---@field requested boolean Whether the desktop app's setting asked for logging at all.
---@field logging boolean Whether the client says it is writing a combat log.
---@field advanced boolean Whether the advanced CVar is on, which is what puts positions in it.

---@class CombatLoggingDeps
---@field settings table The installed settings table; `combatLogging` is the field read.
---@field loggingCombat fun(enable: boolean?): boolean Client LoggingCombat: sets when passed
---a value, and reports the current state either way.
---@field getCVar fun(name: string): string? Client GetCVar.
---@field setCVar fun(name: string, value: string): any Client SetCVar. May fail, silently or
---by raising, when the CVar is protected — which is the whole reason for the read-back.

local ADVANCED = "advancedCombatLogging"

---Whether a CVar's value means on. The client answers with the string "1", but a client that
---one day answers with a number or a boolean should not read as off.
---@param value any
---@return boolean
local function isOn(value)
    return value == "1" or value == 1 or value == true
end

---@param deps CombatLoggingDeps
---@return CombatLogging
function ns.newCombatLogging(deps)
    ---@return CombatLoggingState
    local function read()
        return {
            requested = deps.settings ~= nil and deps.settings.combatLogging == true,
            logging = deps.loggingCombat() == true,
            advanced = isOn(deps.getCVar(ADVANCED)),
        }
    end

    return {
        state = read,

        apply = function()
            if not read().requested then
                -- Deliberately turns nothing off. The setting says whether Chronie starts
                -- logging, not whether the player is allowed to: somebody who switched
                -- logging on for their own reasons this session should not find that a
                -- Chronie setting they never touched silently stopped it.
                return read()
            end

            -- pcall because a protected CVar raises from insecure code on some client builds
            -- and merely does nothing on others. Both are the same answer here — the CVar did
            -- not take — and the read-back in read() is what establishes which happened.
            pcall(deps.setCVar, ADVANCED, "1")
            deps.loggingCombat(true)
            return read()
        end,

        describe = function(state)
            if not state.requested then
                return state.logging
                    and "combat logging is on, though Chronie did not ask for it."
                    or "combat logging is off. Turn it on in Chronie's Setup screen."
            end
            if not state.logging then
                return "combat logging was asked for but this client is not logging."
            end
            if not state.advanced then
                return "combat logging is on, but advanced combat logging is not, so the log "
                    .. "will have no positions in it. Tick Advanced Combat Logging in "
                    .. "Options > Network."
            end
            return "combat logging is on, with advanced combat logging."
        end,
    }
end
