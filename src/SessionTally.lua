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
---@field achievement fun(id: integer, name: string?, at: integer, accountFirst: boolean?)
---Append an earned achievement.
---@field levelUp fun(level: integer, at: integer) Append a level gained.
---@field quest fun(id: integer, at: integer, name: string?, characterFirst: boolean?, accountFirst: boolean?)
---Append a completed quest.
---@field transmog fun(event: TransmogEvent) Append a newly collected transmog source.
---@field mount fun(id: integer, name: string?, at: integer) Append a newly collected mount.
---@field pet fun(id: integer, name: string?, at: integer, guid: string?) Append a newly collected battle pet.
---@field toy fun(id: integer, name: string?, at: integer) Append a newly collected toy.
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
---@field accountFirst boolean True when this was also the account's first completion.

---@class LevelUpEvent
---@field level integer The new character level.
---@field at integer When the level was gained.

---@class TransmogEvent
---@field id integer Item ID.
---@field sourceID integer? Item modified appearance/source ID.
---@field appearanceID integer? Shared visual appearance ID.
---@field newAppearance boolean True for a new visual; false for another source/variant.
---@field at integer When it was collected.

---@class QuestEvent
---@field id integer Quest ID.
---@field name string? Localised quest title when available.
---@field at integer When it was completed.
---@field characterFirst boolean? True when this character had not completed it before.
---@field accountFirst boolean? True when no character on the account had completed it before.

---@class CollectionEvent
---@field id integer Collection ID (mount ID, pet species ID, or toy item ID).
---@field name string Localised collection entry name.
---@field at integer When it was collected.
---@field guid string? Instance GUID, present for battle pets.

---@class SessionSummary
---@field active boolean
---@field lootValue integer Vendor value of items entering the inventory, in copper.
---@field goldLooted integer Copper picked up as money.
---@field itemValue integer Summed vendor value of looted items, in copper.
---@field goldDiff integer Net wallet change over the session, in copper; may be negative.
---@field transmogs TransmogEvent[] Newly collected transmog items, in acquisition order.
---@field currencyTotal integer Summed absolute-signed currency change across every currency.
---@field currencies CurrencyGain[] Per-currency totals, sorted by name.
---@field reputationTotal integer Summed reputation gained across every faction.
---@field reputation ReputationGain[] Per-faction totals, sorted by faction name.
---@field achievements AchievementEvent[] Achievements earned, in the order they were.
---@field levelUps LevelUpEvent[] Levels gained, in the order they were.
---@field mounts CollectionEvent[] Mounts collected, in acquisition order.
---@field pets CollectionEvent[] Battle pets collected, in acquisition order.
---@field quests QuestEvent[] Quests completed, in completion order.
---@field toys CollectionEvent[] Toys collected, in acquisition order.

---@class SessionTallyDeps
---@field lootFormats string[]? Self-loot message templates, most specific first.
---@field factionFormats string[]? Reputation-increase message templates.
---@field itemSellPrice fun(itemID: integer): integer? Vendor price of one item, in copper.

-- Lua-pattern magic characters, escaped so literal chunks of a printf template match verbatim.
local MAGIC = "([%^%$%(%)%.%[%]%*%+%-%?%%])"

---Classifies a source-add event by durable collection state. IsNewAppearance is a
---wardrobe "unseen" marker, so it is only a fallback when source data is unavailable.
---@param sources table[]?
---@param uiNew boolean?
---@return boolean
function ns.isNewTransmogAppearance(sources, uiNew)
    local collected = 0
    for _, source in ipairs(sources or {}) do
        if source.isCollected then
            collected = collected + 1
        end
    end
    if collected > 0 then
        return collected == 1
    end
    return uiNew and true or false
end

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
        session.transmogs = {}
        session.reputation = {}
        session.currencies = {}
        session.achievements = {}
        session.levelUps = {}
        session.mounts = {}
        session.pets = {}
        session.quests = {}
        session.toys = {}
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
        ---@param accountFirst boolean?
        achievement = function(id, name, at, accountFirst)
            if not session.active or not id then
                return
            end
            local event = {
                id = id,
                name = name or tostring(id),
                at = at,
            }
            if accountFirst ~= nil then
                event.accountFirst = accountFirst and true or false
            end
            session.achievements[#session.achievements + 1] = event
        end,

        ---@param level integer
        ---@param at integer
        levelUp = function(level, at)
            if session.active and level then
                session.levelUps[#session.levelUps + 1] = { level = level, at = at }
            end
        end,

        ---@param id integer
        ---@param name string?
        ---@param at integer
        mount = function(id, name, at)
            if session.active and id then
                session.mounts[#session.mounts + 1] = {
                    id = id,
                    name = name or tostring(id),
                    at = at,
                }
            end
        end,

        ---@param id integer
        ---@param name string?
        ---@param at integer
        ---@param guid string?
        pet = function(id, name, at, guid)
            if session.active and id then
                local event = {
                    id = id,
                    name = name or tostring(id),
                    at = at,
                }
                if guid then
                    event.guid = guid
                end
                session.pets[#session.pets + 1] = event
            end
        end,

        ---@param id integer
        ---@param at integer
        ---@param name string?
        ---@param characterFirst boolean?
        ---@param accountFirst boolean?
        quest = function(id, at, name, characterFirst, accountFirst)
            if not session.active or not id then
                return
            end
            local event = { id = id, at = at }
            if name and name ~= "" then
                event.name = name
            end
            if characterFirst ~= nil then
                event.characterFirst = characterFirst and true or false
            end
            if accountFirst ~= nil then
                event.accountFirst = accountFirst and true or false
            end
            session.quests[#session.quests + 1] = event
        end,

        ---@param id integer
        ---@param name string?
        ---@param at integer
        toy = function(id, name, at)
            if session.active and id then
                session.toys[#session.toys + 1] = {
                    id = id,
                    name = name or tostring(id),
                    at = at,
                }
            end
        end,

        ---@param event TransmogEvent
        transmog = function(event, at)
            if type(event) == "number" then
                event = { id = event, at = at }
            end
            if not session.active or not event or not event.id then
                return
            end
            local copy = { id = event.id, at = event.at }
            if event.sourceID then
                copy.sourceID = event.sourceID
            end
            if event.appearanceID then
                copy.appearanceID = event.appearanceID
            end
            if event.newAppearance ~= nil then
                copy.newAppearance = event.newAppearance and true or false
            end
            session.transmogs[#session.transmogs + 1] = copy
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
            local lootValue = session.itemValue
            local goldDiff = session.latestMoney - session.openingMoney
            return lootValue ~= 0
                or goldDiff ~= 0
                or #session.transmogs > 0
                or next(session.currencies) ~= nil
                or next(session.reputation) ~= nil
                or #session.achievements > 0
                or #session.levelUps > 0
                or #session.mounts > 0
                or #session.pets > 0
                or #session.quests > 0
                or #session.toys > 0
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
                if earned.accountFirst ~= nil then
                    achievements[index].accountFirst = earned.accountFirst
                end
            end

            local levelUps = {}
            for index, event in ipairs(session.levelUps) do
                levelUps[index] = { level = event.level, at = event.at }
            end

            local transmogs = {}
            for index, event in ipairs(session.transmogs) do
                transmogs[index] = { id = event.id, at = event.at }
                for _, key in ipairs({ "sourceID", "appearanceID", "newAppearance" }) do
                    if event[key] ~= nil then
                        transmogs[index][key] = event[key]
                    end
                end
            end

            local quests = {}
            for index, event in ipairs(session.quests) do
                quests[index] = { id = event.id, at = event.at }
                for _, key in ipairs({ "name", "characterFirst", "accountFirst" }) do
                    if event[key] ~= nil then
                        quests[index][key] = event[key]
                    end
                end
            end

            local function copyCollection(events)
                local copy = {}
                for index, event in ipairs(events) do
                    copy[index] = { id = event.id, name = event.name, at = event.at }
                    if event.guid then
                        copy[index].guid = event.guid
                    end
                end
                return copy
            end

            return {
                active = session.active,
                lootValue = session.itemValue,
                goldLooted = session.goldLooted,
                itemValue = session.itemValue,
                goldDiff = session.latestMoney - session.openingMoney,
                transmogs = transmogs,
                currencyTotal = currencyTotal,
                currencies = currencies,
                reputationTotal = reputationTotal,
                reputation = reputation,
                achievements = achievements,
                levelUps = levelUps,
                mounts = copyCollection(session.mounts),
                pets = copyCollection(session.pets),
                quests = quests,
                toys = copyCollection(session.toys),
            }
        end,
    }
end
