local _, ns = ...

---A per-visit tally of what an instance yielded: gold looted, the vendor value of
---items looted, transmog appearances gained, and reputation earned. Pure logic; the
---only WoW-shaped things it touches arrive as injected seams (item prices, transmog
---collection queries) or as raw chat strings it parses itself.
---@class InstanceResults
---@field enter fun(instanceType: string?, money: integer): boolean Sync to a zone; true while tracking.
---@field leave fun() Stop tracking, so the next enter() starts a fresh tally.
---@field money fun(current: integer) Fold the current wallet total into gold looted.
---@field loot fun(message: string) Add a self-loot chat line's vendor value.
---@field reputation fun(message: string) Add a faction-change chat line's gain.
---@field transmogSource fun(sourceID: integer): string? Classify a newly collected source.
---@field isActive fun(): boolean
---@field summary fun(): ResultsSummary

---@class ReputationGain
---@field faction string
---@field amount integer

---@class ResultsSummary
---@field active boolean
---@field goldLooted integer Copper picked up as money.
---@field itemValue integer Summed vendor value of looted items, in copper.
---@field gold integer goldLooted + itemValue, in copper.
---@field newAppearances integer Transmog appearances collected for the first time ever.
---@field newVersions integer New sources of an appearance already known.
---@field reputation ReputationGain[] Per-faction totals, sorted by faction name.

---@class InstanceResultsDeps
---@field trackedTypes table<string, boolean>? IsInInstance types that count. Default party/raid/scenario.
---@field lootFormats string[]? Self-loot message templates, most specific first.
---@field factionFormats string[]? Reputation-increase message templates.
---@field itemSellPrice fun(itemID: integer): integer? Vendor price of one item, in copper.
---@field sourceVisual fun(sourceID: integer): integer? The appearance visual a source belongs to.
---@field appearanceSources fun(visualID: integer): integer[]? Every source that shares a visual.
---@field isSourceCollected fun(sourceID: integer): boolean

local DEFAULT_TRACKED = { party = true, raid = true, scenario = true }

-- Lua-pattern magic characters, escaped so literal chunks of a printf template match verbatim.
local MAGIC = "([%^%$%(%)%.%[%]%*%+%-%?%%])"

---@param text string
---@return string
local function escape(text)
    return (text:gsub(MAGIC, "%%%1"))
end

---Turns a printf-style client template ("You receive loot: %sx%d.") into a Lua
---pattern with one capture per specifier, plus the ordered kind of each capture.
---@param format string
---@return string pattern, string[] specs each "string" (%s) or "number" (%d)
local function compileFormat(format)
    local parts = {}
    local specs = {}
    local index = 1
    local length = #format
    while index <= length do
        local char = format:sub(index, index)
        if char == "%" and index < length then
            local spec = format:sub(index + 1, index + 1)
            if spec == "s" then
                parts[#parts + 1] = "(.-)"
                specs[#specs + 1] = "string"
            elseif spec == "d" then
                parts[#parts + 1] = "(%d+)"
                specs[#specs + 1] = "number"
            else
                parts[#parts + 1] = escape(spec)
            end
            index = index + 2
        else
            parts[#parts + 1] = escape(char)
            index = index + 1
        end
    end
    return "^" .. table.concat(parts) .. "$", specs
end

---@param formats string[]?
---@return { pattern: string, specs: string[] }[]
local function compileAll(formats)
    local compiled = {}
    for _, format in ipairs(formats or {}) do
        local pattern, specs = compileFormat(format)
        compiled[#compiled + 1] = { pattern = pattern, specs = specs }
    end
    return compiled
end

---Formats a copper amount the way the client does, dropping the higher denominations
---that would only ever read as zero. Always shows copper so an empty haul reads "0c".
---@param copper integer?
---@return string
function ns.formatMoney(copper)
    copper = math.floor((copper or 0) + 0.5)
    local gold = math.floor(copper / 10000)
    local silver = math.floor((copper % 10000) / 100)
    local units = copper % 100

    local parts = {}
    if gold > 0 then
        parts[#parts + 1] = gold .. "g"
    end
    if silver > 0 or gold > 0 then
        parts[#parts + 1] = silver .. "s"
    end
    parts[#parts + 1] = units .. "c"
    return table.concat(parts, " ")
end

---@param deps InstanceResultsDeps
---@return InstanceResults
function ns.newInstanceResults(deps)
    deps = deps or {}
    local tracked = deps.trackedTypes or DEFAULT_TRACKED
    local sourceVisual = deps.sourceVisual or function() end
    local appearanceSources = deps.appearanceSources or function() end
    local isSourceCollected = deps.isSourceCollected or function() return false end
    local itemSellPrice = deps.itemSellPrice or function() return 0 end

    local lootPatterns = compileAll(deps.lootFormats)
    local factionPatterns = compileAll(deps.factionFormats)

    local session = {
        active = false,
        moneyBaseline = 0,
        goldLooted = 0,
        itemValue = 0,
        newAppearances = 0,
        newVersions = 0,
        reputation = {},
    }

    ---Wipes the tally clean for a fresh visit, anchoring the money baseline so only
    ---coin gained from here on is counted.
    ---@param money integer?
    local function begin(money)
        session.active = true
        session.moneyBaseline = money or 0
        session.goldLooted = 0
        session.itemValue = 0
        session.newAppearances = 0
        session.newVersions = 0
        session.reputation = {}
    end

    ---Runs `message` through a list of compiled templates, returning the first match's
    ---captures split into the single number and the last string it carried.
    ---@param message string
    ---@param patterns { pattern: string, specs: string[] }[]
    ---@return string? text, integer? amount
    local function parse(message, patterns)
        for _, entry in ipairs(patterns) do
            local captures = { tostring(message):match(entry.pattern) }
            if captures[1] ~= nil then
                local text, amount
                for index, kind in ipairs(entry.specs) do
                    if kind == "number" then
                        amount = tonumber(captures[index])
                    else
                        -- Last string wins: templates read "...with <faction>...", so the
                        -- trailing %s is the name rather than any leading qualifier.
                        text = captures[index]
                    end
                end
                return text, amount
            end
        end
    end

    return {
        ---@param instanceType string?
        ---@param money integer
        ---@return boolean active whether tracking is now running
        enter = function(instanceType, money)
            if tracked[instanceType or ""] then
                -- Re-entering the same instance (a load screen, a graveyard run) must not
                -- wipe progress, so only the world -> instance transition resets.
                if not session.active then
                    begin(money)
                end
            else
                session.active = false
            end
            return session.active
        end,

        ---@param current integer
        money = function(current)
            if not session.active then
                return
            end
            current = current or 0
            local delta = current - session.moneyBaseline
            session.moneyBaseline = current
            -- Only gains are loot; a repair or vendor sale merely re-anchors the baseline.
            if delta > 0 then
                session.goldLooted = session.goldLooted + delta
            end
        end,

        ---@param message string
        loot = function(message)
            if not session.active then
                return
            end
            local link, quantity = parse(message, lootPatterns)
            local itemID = link and link:match("Hitem:(%d+)")
            if itemID then
                local price = itemSellPrice(tonumber(itemID)) or 0
                session.itemValue = session.itemValue + price * (quantity or 1)
            end
        end,

        ---@param message string
        reputation = function(message)
            if not session.active then
                return
            end
            local faction, amount = parse(message, factionPatterns)
            if faction and amount then
                session.reputation[faction] = (session.reputation[faction] or 0) + amount
            end
        end,

        ---A source is a single item that grants an appearance. If it is the only
        ---collected source of its visual it is a brand-new appearance; otherwise the
        ---visual was already known and this is just another version of it.
        ---@param sourceID integer
        ---@return string? kind "appearance", "version", or nil when it could not be classified
        transmogSource = function(sourceID)
            if not session.active then
                return
            end
            local visual = sourceVisual(sourceID)
            if not visual then
                return
            end

            local collected = 0
            for _, id in ipairs(appearanceSources(visual) or {}) do
                if isSourceCollected(id) then
                    collected = collected + 1
                end
            end

            if collected <= 1 then
                session.newAppearances = session.newAppearances + 1
                return "appearance"
            end
            session.newVersions = session.newVersions + 1
            return "version"
        end,

        ---Ends the visit without waiting for a zone change. The tally is left intact
        ---so a caller can still read `summary()` off it; the next enter() wipes it.
        leave = function()
            session.active = false
        end,

        isActive = function()
            return session.active
        end,

        ---@return ResultsSummary
        summary = function()
            local reputation = {}
            for faction, amount in pairs(session.reputation) do
                reputation[#reputation + 1] = { faction = faction, amount = amount }
            end
            table.sort(reputation, function(left, right)
                return left.faction < right.faction
            end)

            return {
                active = session.active,
                goldLooted = session.goldLooted,
                itemValue = session.itemValue,
                gold = session.goldLooted + session.itemValue,
                newAppearances = session.newAppearances,
                newVersions = session.newVersions,
                reputation = reputation,
            }
        end,
    }
end
