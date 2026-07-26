local _, ns = ...

---Which expansion an instance belongs to.
---@class Expansion
---@field tier integer Encounter Journal tier index, 1 = Classic.
---@field name string Localised tier name, e.g. "Wrath of the Lich King".
---@field abbreviation string Short tag shown in tables, e.g. "WotLK".
---@field color number[] `{ r, g, b }`

---@class ExpansionIndex
---@field forInstance fun(instance: string): Expansion?
---@field abbreviationFor fun(instance: string): string
---@field colorOf fun(instance: string): number, number, number
---@field tagFor fun(instance: string): string

---@class ExpansionIndexDeps
---@field getNumTiers fun(): integer EJ_GetNumTiers.
---@field getCurrentTier fun(): integer EJ_GetCurrentTier.
---@field selectTier fun(tier: integer) EJ_SelectTier.
---@field getTierInfo fun(tier: integer): string? EJ_GetTierInfo; localised tier name.
--- EJ_GetInstanceByIndex. Returns instanceID, name, ...
---@field getInstanceByIndex fun(index: integer, isRaid: boolean): ...

---Tags in Encounter Journal tier order. The journal has always listed tiers oldest
---first, so the index doubles as the expansion number; anything past the end of this
---list is a tier newer than this build knows about and falls back to its own name.
local TAGS = {
    { abbreviation = "Classic", color = { 0.78, 0.72, 0.55 } },
    { abbreviation = "TBC", color = { 0.40, 0.78, 0.30 } },
    { abbreviation = "WotLK", color = { 0.45, 0.78, 0.95 } },
    { abbreviation = "Cata", color = { 0.90, 0.45, 0.25 } },
    { abbreviation = "MoP", color = { 0.30, 0.80, 0.60 } },
    { abbreviation = "WoD", color = { 0.75, 0.55, 0.30 } },
    { abbreviation = "Legion", color = { 0.60, 0.85, 0.25 } },
    { abbreviation = "BfA", color = { 0.85, 0.35, 0.35 } },
    { abbreviation = "SL", color = { 0.55, 0.75, 0.95 } },
    { abbreviation = "DF", color = { 0.95, 0.55, 0.35 } },
    { abbreviation = "TWW", color = { 0.55, 0.50, 0.85 } },
    { abbreviation = "Midnight", color = { 0.70, 0.45, 0.90 } },
}

local UNKNOWN_COLOR = { 0.6, 0.6, 0.6 }
local NONE = ""

---@param value number
---@return integer
local function toByte(value)
    return math.floor(math.min(math.max(value, 0), 1) * 255 + 0.5)
end

---The client reports saved instances by localised name only, so the Encounter
---Journal — which lists every instance under its tier, in the same locale — is the
---one source that can answer "which expansion?" without a hand-maintained table.
---@param deps ExpansionIndexDeps
---@return ExpansionIndex
function ns.newExpansionIndex(deps)
    ---@type table<string, Expansion>?
    local byInstance

    ---Reads whichever tier the journal is currently selected on; the caller owns that
    ---selection, exactly as the real API demands.
    ---@param isRaid boolean
    ---@param into table<string, Expansion>
    ---@param expansion Expansion
    local function collectTier(isRaid, into, expansion)
        local index = 1
        while true do
            local _, name = deps.getInstanceByIndex(index, isRaid)
            if not name then
                return
            end
            -- First tier wins: a handful of instances are listed under more than one
            -- tier, and the one that shipped them is the honest answer.
            if not into[name] then
                into[name] = expansion
            end
            index = index + 1
        end
    end

    ---Walking the journal means selecting each tier in turn, which is global UI state.
    ---The player's own selection is restored afterwards so opening the Adventure Guide
    ---does not land them somewhere they never chose.
    ---@return table<string, Expansion>
    local function build()
        local into = {}
        local restore = deps.getCurrentTier()

        for tier = 1, deps.getNumTiers() do
            deps.selectTier(tier)

            local tag = TAGS[tier]
            local name = deps.getTierInfo(tier) or (tag and tag.abbreviation) or tostring(tier)
            local expansion = {
                tier = tier,
                name = name,
                abbreviation = tag and tag.abbreviation or name,
                color = tag and tag.color or UNKNOWN_COLOR,
            }

            collectTier(true, into, expansion)
            collectTier(false, into, expansion)
        end

        if restore then
            deps.selectTier(restore)
        end

        return into
    end

    ---@param instance string
    ---@return Expansion?
    local function forInstance(instance)
        if not byInstance then
            byInstance = build()
        end
        return byInstance[instance]
    end

    return {
        forInstance = forInstance,

        ---@param instance string
        ---@return string
        abbreviationFor = function(instance)
            local expansion = forInstance(instance)
            return expansion and expansion.abbreviation or NONE
        end,

        ---@param instance string
        ---@return number, number, number
        colorOf = function(instance)
            local expansion = forInstance(instance)
            local color = expansion and expansion.color or UNKNOWN_COLOR
            return color[1], color[2], color[3]
        end,

        ---Coloured inline, for cells whose own colour already carries a meaning.
        ---@param instance string
        ---@return string
        tagFor = function(instance)
            local expansion = forInstance(instance)
            if not expansion then
                return NONE
            end

            local color = expansion.color
            return string.format(
                "|cff%02x%02x%02x%s|r",
                toByte(color[1]),
                toByte(color[2]),
                toByte(color[3]),
                expansion.abbreviation
            )
        end,
    }
end
