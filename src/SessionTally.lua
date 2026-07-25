local _, ns = ...

---A running tally of the events that happen to one character during one session:
---a continuous stay in a single location, whether an instance or an open-world zone.
---Pure logic; the only WoW-shaped things it touches arrive as injected seams (item
---prices, transmog collection queries) or as raw chat strings it parses itself.
---
---The tracker owns the session's boundaries and drives begin()/leave(); this module
---only accumulates whatever lands between them.
---@class SessionTally
---@field begin fun(money: integer?) Start a fresh session, anchoring the money baseline.
---@field leave fun() Stop tallying; the totals survive for one last summary() read.
---@field money fun(current: integer) Fold the current wallet total into loot and net diff.
---@field loot fun(message: string) Add a self-loot chat line's vendor value.
---@field reputation fun(message: string) Add a faction-change chat line's gain.
---@field currency fun(currencyType: integer, change: integer, name: string?) Record a currency change.
---@field achievement fun(id: integer, name: string?, at: integer) Append an earned achievement.
---@field transmogSource fun(sourceID: integer): string? Classify a newly collected source.
---@field isActive fun(): boolean
---@field hasEvents fun(): boolean Whether anything worth keeping happened this session.
---@field summary fun(): SessionSummary

---@class ReputationGain
---@field faction string
---@field amount integer

---@class CurrencyGain
---@field id integer
---@field name string
---@field amount integer Net change over the session; may be negative.

---@class AchievementEvent
---@field id integer
---@field name string
---@field at integer When it was earned.

---@class SessionSummary
---@field active boolean
---@field lootValue integer Coin looted plus the vendor value of items looted, in copper.
---@field goldLooted integer Copper picked up as money.
---@field itemValue integer Summed vendor value of looted items, in copper.
---@field goldDiff integer Net wallet change over the session, in copper; may be negative.
---@field newAppearances integer Transmog appearances collected for the first time ever.
---@field newVersions integer New sources of an appearance already known.
---@field currencyTotal integer Summed absolute-signed currency change across every currency.
---@field currencies CurrencyGain[] Per-currency totals, sorted by name.
---@field reputationTotal integer Summed reputation gained across every faction.
---@field reputation ReputationGain[] Per-faction totals, sorted by faction name.
---@field achievements AchievementEvent[] Achievements earned, in the order they were.

---@class SessionTallyDeps
---@field lootFormats string[]? Self-loot message templates, most specific first.
---@field factionFormats string[]? Reputation-increase message templates.
---@field itemSellPrice fun(itemID: integer): integer? Vendor price of one item, in copper.
---@field sourceVisual fun(sourceID: integer): integer? The appearance visual a source belongs to.
---@field appearanceSources fun(visualID: integer): integer[]? Every source that shares a visual.
---@field isSourceCollected fun(sourceID: integer): boolean

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
---A negative amount keeps its sign, so a session that lost gold reads "-1g 0s 0c".
---@param copper integer?
---@return string
function ns.formatMoney(copper)
    copper = math.floor((copper or 0) + 0.5)
    local sign = ""
    if copper < 0 then
        sign = "-"
        copper = -copper
    end
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
    return sign .. table.concat(parts, " ")
end

---@param deps SessionTallyDeps
---@return SessionTally
function ns.newSessionTally(deps)
    deps = deps or {}
    local sourceVisual = deps.sourceVisual or function() end
    local appearanceSources = deps.appearanceSources or function() end
    local isSourceCollected = deps.isSourceCollected or function() return false end
    local itemSellPrice = deps.itemSellPrice or function() return 0 end

    local lootPatterns = compileAll(deps.lootFormats)
    local factionPatterns = compileAll(deps.factionFormats)

    local session = {}

    ---Wipes the tally clean for a fresh session, anchoring the money baselines so only
    ---coin gained from here on is counted, and the net diff runs from this wallet total.
    ---@param money integer?
    local function begin(money)
        money = money or 0
        session.active = true
        session.moneyBaseline = money
        session.openingMoney = money
        session.latestMoney = money
        session.goldLooted = 0
        session.itemValue = 0
        session.newAppearances = 0
        session.newVersions = 0
        session.reputation = {}
        session.currencies = {}
        session.achievements = {}
    end

    begin(0)
    session.active = false

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
        ---@param money integer?
        begin = begin,

        ---@param current integer
        money = function(current)
            if not session.active then
                return
            end
            current = current or 0
            local delta = current - session.moneyBaseline
            session.moneyBaseline = current
            session.latestMoney = current
            -- Only gains are loot; a repair or vendor sale merely re-anchors the loot
            -- baseline, but it still moves the net diff below the opening wallet.
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

        ---Folds a currency change into the per-currency total. The change may be
        ---negative (spending), and the running total is kept even when it nets to zero
        ---so the session still remembers the currency was touched.
        ---@param currencyType integer
        ---@param change integer
        ---@param name string?
        currency = function(currencyType, change, name)
            if not session.active or not currencyType or not change or change == 0 then
                return
            end
            local entry = session.currencies[currencyType]
            if not entry then
                entry = { id = currencyType, name = name or tostring(currencyType), amount = 0 }
                session.currencies[currencyType] = entry
            end
            -- A later update may carry the name the first one lacked.
            if name and name ~= "" then
                entry.name = name
            end
            entry.amount = entry.amount + change
        end,

        ---@param id integer
        ---@param name string?
        ---@param at integer
        achievement = function(id, name, at)
            if not session.active or not id then
                return
            end
            session.achievements[#session.achievements + 1] = {
                id = id,
                name = name or tostring(id),
                at = at,
            }
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

        ---Ends the session without waiting for a zone change. The tally is left intact
        ---so a caller can still read summary() and hasEvents() off it; begin() wipes it.
        leave = function()
            session.active = false
        end,

        isActive = function()
            return session.active
        end,

        ---Whether the session accrued anything worth persisting. An empty stroll through
        ---a zone leaves every counter at rest, and such a session is dropped on close.
        ---@return boolean
        hasEvents = function()
            local lootValue = session.goldLooted + session.itemValue
            local goldDiff = session.latestMoney - session.openingMoney
            return lootValue ~= 0
                or goldDiff ~= 0
                or session.newAppearances > 0
                or session.newVersions > 0
                or next(session.currencies) ~= nil
                or next(session.reputation) ~= nil
                or #session.achievements > 0
        end,

        ---@return SessionSummary
        summary = function()
            local reputation = {}
            local reputationTotal = 0
            for faction, amount in pairs(session.reputation) do
                reputation[#reputation + 1] = { faction = faction, amount = amount }
                reputationTotal = reputationTotal + amount
            end
            table.sort(reputation, function(left, right)
                return left.faction < right.faction
            end)

            local currencies = {}
            local currencyTotal = 0
            for _, entry in pairs(session.currencies) do
                currencies[#currencies + 1] = { id = entry.id, name = entry.name, amount = entry.amount }
                currencyTotal = currencyTotal + entry.amount
            end
            table.sort(currencies, function(left, right)
                if left.name ~= right.name then
                    return left.name < right.name
                end
                return left.id < right.id
            end)

            local achievements = {}
            for index, earned in ipairs(session.achievements) do
                achievements[index] = { id = earned.id, name = earned.name, at = earned.at }
            end

            return {
                active = session.active,
                lootValue = session.goldLooted + session.itemValue,
                goldLooted = session.goldLooted,
                itemValue = session.itemValue,
                goldDiff = session.latestMoney - session.openingMoney,
                newAppearances = session.newAppearances,
                newVersions = session.newVersions,
                currencyTotal = currencyTotal,
                currencies = currencies,
                reputationTotal = reputationTotal,
                reputation = reputation,
                achievements = achievements,
            }
        end,
    }
end
