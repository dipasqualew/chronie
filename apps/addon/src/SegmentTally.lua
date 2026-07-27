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
---@field itemInfoReceived fun(itemID: integer) Price the loot that was parked waiting on this
---item's data and fold it in.
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
---@field encounter fun(event: EncounterEvent) Append a boss encounter that ended, kill or wipe.
---@field equipsetChange fun(change: EquipsetChange) Append a change to one equipment set.
---@field keystoneStart fun(info: table, at: integer) Open a Mythic+ run: `{ level, mapId, affixes }`.
---@field keystoneComplete fun(info: table, at: integer) Close it: `{ durationMs, onTime, upgrades, level }`.
---@field keystoneReset fun() Abandon the open run; the level and map stay, completion does not.
---@field experience fun(level: integer, xp: integer, xpMax: integer) Fold the character's
---current experience standing into the segment's gain.
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

---One boss fight that reached an end, whether the group won it or wiped. Both outcomes are
---kept: a raid night is as much its wipes as its kills, and the ratio is the clearest signal
---there is for telling a progression raid from a farm clear.
---@class EncounterEvent
---@field id integer Encounter (journal) ID.
---@field name string? Localised boss name.
---@field at integer When the fight ended.
---@field difficultyId integer? Difficulty the fight ran on.
---@field groupSize integer? How many players were in the group.
---@field success boolean True for a kill, false for a wipe.

---A Mythic+ run, at most one per segment. A segment is one continuous stay in one instance
---at one difficulty, and a party that finishes a key and immediately starts another one in
---the same dungeon never leaves — so a second run inside a segment overwrites the first
---rather than appending. That is rare, and losing the earlier of two runs beats reporting a
---segment that claims two keystone levels at once.
---@class KeystoneRun
---@field level integer Keystone level the run started on.
---@field mapId integer? Challenge-mode map ID.
---@field affixes integer[]? Affix IDs in effect.
---@field startedAt integer When the key was activated.
---@field completedAt integer? When the dungeon was completed; absent for an abandoned run.
---@field completed boolean Whether the run reached the final boss.
---@field durationMs integer? Clock time the client reported, in milliseconds.
---@field onTime boolean? Whether it beat the timer.
---@field upgrades integer? Keystone upgrade levels earned: 0 for depleted-but-completed, 1..3 otherwise.

---How much experience the character earned over the segment.
---@class ExperienceGain
---@field gained integer Raw experience points.
---@field percent number Gain as a fraction of a level: 1.0 is exactly one full level's worth.
---@field startLevel integer Level held when the segment opened.
---@field endLevel integer Level held at the last update seen.

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
---@field encounters EncounterEvent[] Boss fights that ended, in the order they did.
---@field keystone KeystoneRun? The Mythic+ run this segment was, when it was one.
---@field experience ExperienceGain? Experience earned, when the client ever reported any.

---@class SegmentTallyDeps
---@field lootFormats string[]? Self-loot message templates, most specific first.
---@field factionFormats string[]? Reputation-increase message templates.
---@field itemSellPrice fun(itemID: integer): integer? Vendor price of one item, in copper.
---nil means the client has not cached the item yet — distinct from 0, which means the item
---genuinely cannot be sold.

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
    ---Experience is anchored the same way, from whatever standing the character holds as
    ---the segment opens: `{ level, xp, xpMax }`. Without a baseline the first update of the
    ---segment cannot be turned into a gain, so the tracker reads it at begin() rather than
    ---letting the tally swallow the first event to learn where it started.
    ---@param money integer?
    ---@param currencyItemCounts table<integer, integer>?
    ---@param experience table? `{ level, xp, xpMax }` as of right now.
    local function begin(money, currencyItemCounts, experience)
        money = money or 0
        segment.active = true
        segment.moneyBaseline = money
        segment.openingMoney = money
        segment.latestMoney = money
        segment.goldLooted = 0
        segment.itemValue = 0
        segment.pendingItems = {}
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
        segment.encounters = {}
        segment.equipsetChanges = {}
        segment.keystone = nil
        segment.experienceGained = 0
        segment.experiencePercent = 0
        segment.experienceBaseline = nil
        segment.experienceLast = nil
        if experience and experience.level then
            segment.experienceBaseline = {
                level = experience.level,
                xp = experience.xp or 0,
                xpMax = experience.xpMax or 0,
            }
            segment.experienceLast = {
                level = segment.experienceBaseline.level,
                xp = segment.experienceBaseline.xp,
                xpMax = segment.experienceBaseline.xpMax,
            }
        end
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

        ---Folds a self-loot line's vendor value into the segment.
        ---
        ---An item the client has never seen is not cached when the loot line arrives, and
        ---the price query is answered asynchronously — so pricing it right now would read
        ---nil and book the item as worthless. That is the common case for a first-time drop
        ---and it silently undercounts the haul, which is why an unpriced item is parked
        ---here and folded in by itemInfoReceived once the server answers. Asking for the
        ---price is itself what triggers the query, so no separate request is needed.
        ---@param message string
        loot = function(message)
            if not segment.active then
                return
            end
            local link, quantity = parse(message, lootPatterns)
            local itemID = link and tonumber(link:match("Hitem:(%d+)"))
            if not itemID then
                return
            end
            quantity = quantity or 1
            local price = itemSellPrice(itemID)
            if price == nil then
                local waiting = segment.pendingItems[itemID]
                if not waiting then
                    waiting = {}
                    segment.pendingItems[itemID] = waiting
                end
                waiting[#waiting + 1] = quantity
                return
            end
            segment.itemValue = segment.itemValue + price * quantity
        end,

        ---The client has finished loading an item's data, so anything loot() parked on it
        ---can be priced. A price that is still unavailable is treated as worthless and
        ---dropped rather than parked again, so a bad item ID cannot accumulate forever.
        ---@param itemID integer
        itemInfoReceived = function(itemID)
            if not segment.active or not itemID then
                return
            end
            local waiting = segment.pendingItems[itemID]
            if not waiting then
                return
            end
            segment.pendingItems[itemID] = nil
            local price = itemSellPrice(itemID) or 0
            for _, quantity in ipairs(waiting) do
                segment.itemValue = segment.itemValue + price * quantity
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

        ---A boss fight that ended. Wipes are recorded alongside kills, so the ratio between
        ---them survives into the record; a reader that only wants kills filters on success.
        ---@param event EncounterEvent
        encounter = function(event)
            if not segment.active or not event or not event.id then
                return
            end
            segment.encounters[#segment.encounters + 1] = {
                id = event.id,
                name = event.name,
                at = event.at,
                difficultyId = event.difficultyId,
                groupSize = event.groupSize,
                success = event.success and true or false,
            }
        end,

        ---Something that happened to one of the character's equipment sets.
        ---
        ---The ledger has already worked out what changed; this only files it against the
        ---segment it happened during. A change carrying no slots at all is still recorded
        ---when the set itself came or went — an empty set is a set — but never for an edit,
        ---because "these items changed" with nothing in the list is not an edit.
        ---@param change EquipsetChange
        equipsetChange = function(change)
            if not segment.active or not change or not change.setId or not change.kind then
                return
            end
            local items = {}
            for index, item in ipairs(change.items or {}) do
                items[index] = {
                    slot = item.slot,
                    itemId = item.itemId,
                    itemLevel = item.itemLevel,
                    itemName = item.itemName,
                }
            end
            if #items == 0 and change.kind == "updated" then
                return
            end
            segment.equipsetChanges[#segment.equipsetChanges + 1] = {
                setId = change.setId,
                name = change.name,
                kind = change.kind,
                at = change.at,
                items = items,
            }
        end,

        ---Opens a Mythic+ run on this segment. A level of nil is not a keystone start the
        ---tally can say anything useful about, so it is dropped rather than recorded as a
        ---run of unknown level.
        ---@param info table `{ level, mapId, affixes }`
        ---@param at integer
        keystoneStart = function(info, at)
            if not segment.active or not info or not info.level then
                return
            end
            local affixes
            if info.affixes then
                affixes = {}
                for index, affix in ipairs(info.affixes) do
                    affixes[index] = affix
                end
            end
            segment.keystone = {
                level = info.level,
                mapId = info.mapId,
                affixes = affixes,
                startedAt = at,
                completed = false,
            }
        end,

        ---Closes the open run. The completion report carries its own level, which is the
        ---authority: a run can only be completed at the level it was started on, and the
        ---start may have been missed entirely by a player who zoned in mid-key. So a
        ---completion with no open run still records one, dated to the completion itself.
        ---@param info table `{ level, mapId, durationMs, onTime, upgrades }`
        ---@param at integer
        keystoneComplete = function(info, at)
            if not segment.active or not info then
                return
            end
            local run = segment.keystone
            if not run then
                run = { level = info.level, mapId = info.mapId, startedAt = at }
                segment.keystone = run
            end
            run.level = info.level or run.level
            run.mapId = info.mapId or run.mapId
            run.completed = true
            run.completedAt = at
            run.durationMs = info.durationMs
            run.onTime = info.onTime and true or false
            run.upgrades = info.upgrades
        end,

        ---The party abandoned or reset the key. The run stays on the segment — it is still
        ---what the player spent the time doing — but it never became a completion.
        keystoneReset = function()
            if segment.active and segment.keystone then
                segment.keystone.completed = false
                segment.keystone.completedAt = nil
                segment.keystone.durationMs = nil
                segment.keystone.onTime = nil
                segment.keystone.upgrades = nil
            end
        end,

        ---Folds the character's current experience standing into the segment's gain.
        ---
        ---Both the raw points and the fraction of a level they represent are kept, because
        ---neither answers on its own: raw points are incomparable between levels, while the
        ---fraction is what "did I actually level meaningfully here?" is asking. The fraction
        ---accumulates each step against the maximum in force at the time, so a gain spanning
        ---a level boundary is still measured against the right denominators.
        ---
        ---Crossing more than one level in a single update is only possible when several
        ---updates are missed at once; those middle levels are counted at the new level's
        ---maximum, which is an approximation the summary cannot avoid — the client never
        ---reports what the maxima of the levels in between were.
        ---@param level integer
        ---@param xp integer
        ---@param xpMax integer
        experience = function(level, xp, xpMax)
            if not segment.active or not level then
                return
            end
            xp = xp or 0
            xpMax = xpMax or 0
            local last = segment.experienceLast
            if not last then
                -- No baseline: tracking began mid-segment, so adopt this standing as the
                -- start and count nothing, exactly as an untracked currency item does.
                segment.experienceBaseline = { level = level, xp = xp, xpMax = xpMax }
                segment.experienceLast = { level = level, xp = xp, xpMax = xpMax }
                return
            end

            local gained, percent = 0, 0
            if level == last.level then
                gained = xp - last.xp
                if last.xpMax > 0 then
                    percent = gained / last.xpMax
                end
            elseif level > last.level then
                local remainder = math.max((last.xpMax or 0) - last.xp, 0)
                local middleLevels = level - last.level - 1
                gained = remainder + middleLevels * xpMax + xp
                if last.xpMax > 0 then
                    percent = remainder / last.xpMax
                end
                percent = percent + middleLevels
                if xpMax > 0 then
                    percent = percent + xp / xpMax
                end
            end
            -- A level loss, or experience going backwards inside one level, is not something
            -- the game does; treat it as a client hiccup and re-anchor rather than subtract.
            segment.experienceLast = { level = level, xp = xp, xpMax = xpMax }
            if gained <= 0 then
                return
            end
            segment.experienceGained = segment.experienceGained + gained
            segment.experiencePercent = segment.experiencePercent + percent
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
                or #segment.encounters > 0
                or #segment.equipsetChanges > 0
                or segment.keystone ~= nil
                or segment.experienceGained ~= 0
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
            local details = ns.segmentDetailSpecs
            local experience
            if segment.experienceGained ~= 0 then
                experience = {
                    gained = segment.experienceGained,
                    percent = segment.experiencePercent,
                    startLevel = segment.experienceBaseline and segment.experienceBaseline.level,
                    endLevel = segment.experienceLast and segment.experienceLast.level,
                }
            end
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
                encounters = ns.copyEventList(specs.encounters, segment.encounters),
                equipsetChanges = ns.copyEventList(specs.equipsetChanges, segment.equipsetChanges),
                keystone = ns.copyDetail(details.keystone, segment.keystone),
                experience = ns.copyDetail(details.experience, experience),
            }
        end,
    }
end
