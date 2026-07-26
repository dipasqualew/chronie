local _, ns = ...

---A running tally of the events that happen to one character during one segment:
---a continuous stay in a single location, whether an instance or an open-world zone.
---Pure logic; the only WoW-shaped things it touches arrive as injected seams (item
---prices, transmog collection queries) or as raw chat strings it parses itself.
---
---The tracker owns the segment's boundaries and drives begin()/leave(); this module
---only accumulates whatever lands between them.
---@class SegmentTally
---@field begin fun(money: integer?, currencyItemCounts: table<integer, integer>?) Start a fresh segment,
---anchoring the money baseline and, optionally, the owned-count baseline of each tracked currency item.
---@field leave fun() Stop tallying; the totals survive for one last summary() read.
---@field money fun(current: integer) Fold the current wallet total into loot and net diff.
---@field loot fun(message: string) Add a self-loot chat line's vendor value.
---@field reputation fun(message: string) Add a faction-change chat line's gain.
---@field currency fun(currencyType: integer, change: integer, name: string?) Record a currency change.
---@field currencyItem fun(itemID: integer, total: integer, name: string?) Fold an item-based currency's
---owned total into the same per-currency tallies, as a change from its segment baseline.
---@field achievement fun(id: integer, name: string?, at: integer, accountFirst: boolean?)
---Append an earned achievement.
---@field levelUp fun(level: integer, at: integer) Append a level gained.
---@field quest fun(id: integer, at: integer, name: string?, characterFirst: boolean?, accountFirst: boolean?)
---Append a completed quest.
---@field transmog fun(event: TransmogEvent) Append a newly collected transmog source.
---@field mount fun(id: integer, name: string?, at: integer) Append a newly collected mount.
---@field pet fun(id: integer, name: string?, at: integer, guid: string?) Append a newly collected battle pet.
---@field toy fun(id: integer, name: string?, at: integer) Append a newly collected toy.
---@field housingItem fun(id: integer, name: string?, at: integer, warbandFirst: boolean?)
---Append a collected housing item.
---@field housingXP fun(amount: integer) Fold a housing experience gain into the segment total.
---@field housingLevelUp fun(level: integer, at: integer) Append a housing level gained.
---@field isActive fun(): boolean
---@field hasEvents fun(): boolean Whether anything worth keeping happened this segment.
---@field summary fun(): SegmentSummary

---@class ReputationGain
---@field faction string
---@field amount integer

---@class CurrencyGain
---@field id integer
---@field name string
---@field amount integer Net change over the segment; may be negative.

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

---@class HousingItemEvent
---@field id integer Housing catalog entry / item ID.
---@field name string Localised housing item name.
---@field at integer When it was collected.
---@field warbandFirst boolean True when the warband had never collected it; false for a duplicate.

---@class SegmentSummary
---@field active boolean
---@field lootValue integer Vendor value of items entering the inventory, in copper.
---@field goldLooted integer Copper picked up as money.
---@field itemValue integer Summed vendor value of looted items, in copper.
---@field goldDiff integer Net wallet change over the segment, in copper; may be negative.
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
---@field housingItems HousingItemEvent[] Housing items collected, in acquisition order.
---@field housingXP integer Housing experience gained over the segment.
---@field housingLevelUps LevelUpEvent[] Housing levels gained, in the order they were.

---@class SegmentTallyDeps
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
---A negative amount keeps its sign, so a segment that lost gold reads "-1g 0s 0c".
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

---@param deps SegmentTallyDeps
---@return SegmentTally
function ns.newSegmentTally(deps)
    deps = deps or {}
    local itemSellPrice = deps.itemSellPrice or function() return 0 end

    local lootPatterns = compileAll(deps.lootFormats)
    local factionPatterns = compileAll(deps.factionFormats)

    local segment = {}

    ---Wipes the tally clean for a fresh segment, anchoring the money baselines so only
    ---coin gained from here on is counted, and the net diff runs from this wallet total.
    ---Item-based currencies get the same treatment: their owned counts at segment start
    ---become the baselines every later update is measured against, so currency held before
    ---the segment is never counted as gained.
    ---@param money integer?
    ---@param currencyItemCounts table<integer, integer>?
    local function begin(money, currencyItemCounts)
        money = money or 0
        segment.active = true
        segment.moneyBaseline = money
        segment.openingMoney = money
        segment.latestMoney = money
        segment.goldLooted = 0
        segment.itemValue = 0
        segment.transmogs = {}
        segment.reputation = {}
        segment.currencies = {}
        segment.currencyItemCounts = {}
        if currencyItemCounts then
            for itemID, count in pairs(currencyItemCounts) do
                segment.currencyItemCounts[itemID] = count
            end
        end
        segment.achievements = {}
        segment.levelUps = {}
        segment.mounts = {}
        segment.pets = {}
        segment.quests = {}
        segment.toys = {}
        segment.housingItems = {}
        segment.housingXP = 0
        segment.housingLevelUps = {}
    end

    begin(0)
    segment.active = false

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
            if not segment.active then
                return
            end
            current = current or 0
            local delta = current - segment.moneyBaseline
            segment.moneyBaseline = current
            segment.latestMoney = current
            -- Only gains are loot; a repair or vendor sale merely re-anchors the loot
            -- baseline, but it still moves the net diff below the opening wallet.
            if delta > 0 then
                segment.goldLooted = segment.goldLooted + delta
            end
        end,

        ---@param message string
        loot = function(message)
            if not segment.active then
                return
            end
            local link, quantity = parse(message, lootPatterns)
            local itemID = link and link:match("Hitem:(%d+)")
            if itemID then
                local price = itemSellPrice(tonumber(itemID)) or 0
                segment.itemValue = segment.itemValue + price * (quantity or 1)
            end
        end,

        ---@param message string
        reputation = function(message)
            if not segment.active then
                return
            end
            local faction, amount = parse(message, factionPatterns)
            if faction and amount then
                segment.reputation[faction] = (segment.reputation[faction] or 0) + amount
            end
        end,

        ---Folds a currency change into the per-currency total. The change may be
        ---negative (spending), and the running total is kept even when it nets to zero
        ---so the segment still remembers the currency was touched.
        ---@param currencyType integer
        ---@param change integer
        ---@param name string?
        currency = function(currencyType, change, name)
            if not segment.active or not currencyType or not change or change == 0 then
                return
            end
            local entry = segment.currencies[currencyType]
            if not entry then
                entry = { id = currencyType, name = name or tostring(currencyType), amount = 0 }
                segment.currencies[currencyType] = entry
            end
            -- A later update may carry the name the first one lacked.
            if name and name ~= "" then
                entry.name = name
            end
            entry.amount = entry.amount + change
        end,

        ---Folds an item-based currency into the same per-currency tallies as a real
        ---currency, but driven by the item's grand total owned right now rather than a
        ---signed event. The total is expected to span every storage the character can
        ---reach — bags, both banks and the warband bank — so moving the item in or out of
        ---a bank leaves it unchanged and records no phantom gain or spend; only a real
        ---acquisition or spend shifts it. The recorded change is the difference from the
        ---last total seen, seeded by begin() to the count held when the segment opened.
        ---@param itemID integer
        ---@param total integer
        ---@param name string?
        currencyItem = function(itemID, total, name)
            if not segment.active or not itemID or not total then
                return
            end
            local baseline = segment.currencyItemCounts[itemID]
            segment.currencyItemCounts[itemID] = total
            -- No baseline means the item was not tracked when the segment opened, so tracking
            -- began mid-segment: adopt the current total as the baseline and count nothing, or
            -- holdings that predate the choice to track would be booked as this segment's gain.
            -- begin() seeds every already-tracked item, so those never take this path.
            if baseline == nil then
                return
            end
            local change = total - baseline
            if change == 0 then
                return
            end
            -- Keyed apart from real currencies: an item ID and a currency type are
            -- separate namespaces that could otherwise collide on the same number.
            local key = "item:" .. itemID
            local entry = segment.currencies[key]
            if not entry then
                entry = { id = itemID, name = name or tostring(itemID), amount = 0 }
                segment.currencies[key] = entry
            end
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
            if not segment.active or not id then
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
            segment.achievements[#segment.achievements + 1] = event
        end,

        ---@param level integer
        ---@param at integer
        levelUp = function(level, at)
            if segment.active and level then
                segment.levelUps[#segment.levelUps + 1] = { level = level, at = at }
            end
        end,

        ---@param id integer
        ---@param name string?
        ---@param at integer
        mount = function(id, name, at)
            if segment.active and id then
                segment.mounts[#segment.mounts + 1] = {
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
            if segment.active and id then
                local event = {
                    id = id,
                    name = name or tostring(id),
                    at = at,
                }
                if guid then
                    event.guid = guid
                end
                segment.pets[#segment.pets + 1] = event
            end
        end,

        ---@param id integer
        ---@param at integer
        ---@param name string?
        ---@param characterFirst boolean?
        ---@param accountFirst boolean?
        quest = function(id, at, name, characterFirst, accountFirst)
            if not segment.active or not id then
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
            segment.quests[#segment.quests + 1] = event
        end,

        ---@param id integer
        ---@param name string?
        ---@param at integer
        toy = function(id, name, at)
            if segment.active and id then
                segment.toys[#segment.toys + 1] = {
                    id = id,
                    name = name or tostring(id),
                    at = at,
                }
            end
        end,

        ---A single housing item collected. Whether it is the warband's first copy or a
        ---duplicate is decided upstream and folded onto the event, mirroring how a quest
        ---carries its first-completion scope.
        ---@param id integer
        ---@param name string?
        ---@param at integer
        ---@param warbandFirst boolean?
        housingItem = function(id, name, at, warbandFirst)
            if segment.active and id then
                segment.housingItems[#segment.housingItems + 1] = {
                    id = id,
                    name = name or tostring(id),
                    at = at,
                    warbandFirst = warbandFirst and true or false,
                }
            end
        end,

        ---Folds a housing experience gain into the running segment total.
        ---@param amount integer
        housingXP = function(amount)
            if segment.active and amount and amount ~= 0 then
                segment.housingXP = segment.housingXP + amount
            end
        end,

        ---@param level integer
        ---@param at integer
        housingLevelUp = function(level, at)
            if segment.active and level then
                segment.housingLevelUps[#segment.housingLevelUps + 1] = { level = level, at = at }
            end
        end,

        ---@param event TransmogEvent
        transmog = function(event, at)
            if type(event) == "number" then
                event = { id = event, at = at }
            end
            if not segment.active or not event or not event.id then
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
            segment.transmogs[#segment.transmogs + 1] = copy
        end,

        ---Ends the segment without waiting for a zone change. The tally is left intact
        ---so a caller can still read summary() and hasEvents() off it; begin() wipes it.
        leave = function()
            segment.active = false
        end,

        isActive = function()
            return segment.active
        end,

        ---Whether the segment accrued anything worth persisting. An empty stroll through
        ---a zone leaves every counter at rest, and such a segment is dropped on close.
        ---@return boolean
        hasEvents = function()
            local lootValue = segment.itemValue
            local goldDiff = segment.latestMoney - segment.openingMoney
            return lootValue ~= 0
                or goldDiff ~= 0
                or #segment.transmogs > 0
                or next(segment.currencies) ~= nil
                or next(segment.reputation) ~= nil
                or #segment.achievements > 0
                or #segment.levelUps > 0
                or #segment.mounts > 0
                or #segment.pets > 0
                or #segment.quests > 0
                or #segment.toys > 0
                or #segment.housingItems > 0
                or segment.housingXP ~= 0
                or #segment.housingLevelUps > 0
        end,

        ---@return SegmentSummary
        summary = function()
            local reputation = {}
            local reputationTotal = 0
            for faction, amount in pairs(segment.reputation) do
                reputation[#reputation + 1] = { faction = faction, amount = amount }
                reputationTotal = reputationTotal + amount
            end
            table.sort(reputation, function(left, right)
                return left.faction < right.faction
            end)

            local currencies = {}
            local currencyTotal = 0
            for _, entry in pairs(segment.currencies) do
                currencies[#currencies + 1] = { id = entry.id, name = entry.name, amount = entry.amount }
                currencyTotal = currencyTotal + entry.amount
            end
            table.sort(currencies, function(left, right)
                if left.name ~= right.name then
                    return left.name < right.name
                end
                return left.id < right.id
            end)

            local specs = ns.segmentEventSpecs
            return {
                active = segment.active,
                lootValue = segment.itemValue,
                goldLooted = segment.goldLooted,
                itemValue = segment.itemValue,
                goldDiff = segment.latestMoney - segment.openingMoney,
                transmogs = ns.copyEventList(specs.transmogs, segment.transmogs),
                currencyTotal = currencyTotal,
                currencies = currencies,
                reputationTotal = reputationTotal,
                reputation = reputation,
                achievements = ns.copyEventList(specs.achievements, segment.achievements),
                levelUps = ns.copyEventList(specs.levelUps, segment.levelUps),
                mounts = ns.copyEventList(specs.mounts, segment.mounts),
                pets = ns.copyEventList(specs.pets, segment.pets),
                quests = ns.copyEventList(specs.quests, segment.quests),
                toys = ns.copyEventList(specs.toys, segment.toys),
                housingItems = ns.copyEventList(specs.housingItems, segment.housingItems),
                housingXP = segment.housingXP,
                housingLevelUps = ns.copyEventList(specs.housingLevelUps, segment.housingLevelUps),
            }
        end,
    }
end
