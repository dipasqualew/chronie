---Hand-written fakes for the slice of the WoW API the addon depends on.
---These are injected through the same seams the game uses (WowEnv /
---EventDispatcherDeps), so no monkey patching is needed anywhere.
local fake = {}

---A stand-in for a FontString. Records the last text and colour it was given, and
---whether it is currently visible, which is all any assertion needs.
---@return table
function fake.newFontString()
    local fontString = { shown = true, points = {}, scripts = {} }

    function fontString:SetText(text)
        self.text = text
    end

    function fontString:SetTextColor(r, g, b)
        self.color = { r, g, b }
    end

    function fontString:SetPoint(...)
        self.points[#self.points + 1] = { ... }
    end

    function fontString:SetWidth(width)
        self.width = width
    end

    function fontString:SetJustifyH(justify)
        self.justify = justify
    end

    function fontString:SetWordWrap(enabled)
        self.wordWrap = enabled
    end

    function fontString:Show()
        self.shown = true
    end

    function fontString:Hide()
        self.shown = false
    end

    function fontString:IsShown()
        return self.shown
    end

    function fontString:EnableMouse(enabled)
        self.mouseEnabled = enabled
    end

    function fontString:SetScript(name, handler)
        self.scripts[name] = handler
    end

    function fontString:run(name, ...)
        local handler = assert(self.scripts[name], "no " .. name .. " script was set")
        return handler(self, ...)
    end

    return fontString
end

---A stand-in for a WoW Frame. Records what the addon asked of it and lets the
---test drive the frame's scripts by hand.
---
---The layout setters are deliberately no-ops that only record: the addon's geometry
---is not behaviour worth asserting, but calling them must not blow up either.
---@return table
function fake.newFrame()
    local frame = {
        scripts = {},
        registered = {},
        registeredOrder = {},
        fontStrings = {},
        points = {},
        shown = false,
    }

    function frame:SetScript(name, handler)
        self.scripts[name] = handler
    end

    ---Invoke a script the addon installed, as the client would.
    ---@param name string
    function frame:run(name, ...)
        local handler = assert(self.scripts[name], "no " .. name .. " script was set")
        return handler(self, ...)
    end

    function frame:RegisterEvent(event)
        self.registered[event] = (self.registered[event] or 0) + 1
        self.registeredOrder[#self.registeredOrder + 1] = event
    end

    ---Simulate the client firing an event at this frame.
    ---@param event string
    function frame:fire(event, ...)
        local onEvent = assert(self.scripts.OnEvent, "no OnEvent script was set")
        return onEvent(self, event, ...)
    end

    function frame:CreateFontString()
        local fontString = fake.newFontString()
        self.fontStrings[#self.fontStrings + 1] = fontString
        return fontString
    end

    function frame:SetPoint(...)
        self.points[#self.points + 1] = { ... }
    end

    -- EditBox widgets carry text of their own, and the report window's read-only
    -- boxes are the only thing a test can inspect to prove what it offered to copy.
    function frame:SetText(text)
        self.text = text
    end

    function frame:GetText()
        return self.text
    end

    function frame:HighlightText()
        self.highlighted = (self.highlighted or 0) + 1
    end

    function frame:Show()
        self.shown = true
    end

    function frame:Hide()
        self.shown = false
    end

    function frame:IsShown()
        return self.shown
    end

    ---Returns whatever point the test planted on the frame, defaulting to the centre.
    ---Shape mirrors the real API: point, relativeTo, relativePoint, x, y.
    function frame:GetPoint()
        local placed = self.placedPoint or { "CENTER", nil, "CENTER", 0, 0 }
        return placed[1], placed[2], placed[3], placed[4], placed[5]
    end

    function frame:GetCenter()
        if self.center then
            return self.center[1], self.center[2]
        end
        return nil, nil
    end

    for _, name in ipairs({
        "SetSize",
        "SetAllPoints",
        "SetWidth",
        "SetHeight",
        "SetFrameStrata",
        "SetToplevel",
        "SetBackdrop",
        "SetMovable",
        "EnableMouse",
        "RegisterForDrag",
        "SetClampedToScreen",
        "SetScrollChild",
        "SetNormalTexture",
        "SetHighlightTexture",
        "RegisterForClicks",
        "SetJustifyH",
        "SetAutoFocus",
        "SetCursorPosition",
        "SetFontObject",
        "ClearAllPoints",
        "ClearFocus",
        "Raise",
        "StartMoving",
        "StopMovingOrSizing",
    }) do
        frame[name] = function() end
    end

    return frame
end

---A `createFrame` fake that hands back frames and remembers them. The frame's
---requested global name is stored on the frame itself, so a test can pick one
---window out of several by name rather than by creation order.
---@return fun(frameType: string, name: string?, parent: table?, template: string?): table createFrame
---@return table frames created frames, in creation order
---@return table types frame types requested, in creation order
function fake.newCreateFrame()
    local frames = {}
    local types = {}

    local function createFrame(frameType, name, parent, template)
        types[#types + 1] = frameType
        local frame = fake.newFrame()
        frame.frameType = frameType
        frame.frameName = name
        frame.parent = parent
        frame.template = template
        frames[#frames + 1] = frame
        return frame
    end

    return createFrame, frames, types
end

---A fake `GetSavedInstanceInfo` pair, driven by a list of readable tables rather
---than the client's fourteen positional return values.
---
---Each entry accepts `{ name, reset, difficultyId, isRaid, maxPlayers, difficultyName }`.
---`reset` is SECONDS REMAINING, exactly as the real API reports it. Any field may be
---omitted so tests can exercise the degrade-to-default paths.
---
---Bosses are declared on the entry as `bosses = { { name = "Ragnaros", killed = true }, ... }`,
---and `numEncounters` is derived from that list. A test that wants the two to disagree —
---a client reporting a count it cannot back with data — sets `numEncounters` explicitly.
---`killed` is passed through verbatim, so `1`/`nil`/`false`/`true` all reach the addon as
---the client would send them; a boss with no `name` models a gap in the client's data.
---@param entries table[]?
---@return fun(): integer getNumSavedInstances
---@return fun(index: integer): ... getSavedInstanceInfo
---@return table calls indexes the addon asked about, in order
---@return fun(instanceIndex: integer, encounterIndex: integer): ... getSavedInstanceEncounterInfo
---@return table encounterCalls `{ { instance = integer, encounter = integer }, ... }`
function fake.newSavedInstances(entries)
    entries = entries or {}
    local calls = {}
    local encounterCalls = {}

    local function getNumSavedInstances()
        return #entries
    end

    local function getSavedInstanceEncounterInfo(instanceIndex, encounterIndex)
        encounterCalls[#encounterCalls + 1] = { instance = instanceIndex, encounter = encounterIndex }
        local entry = entries[instanceIndex]
        local boss = entry and entry.bosses and entry.bosses[encounterIndex]
        if not boss then
            return nil
        end
        -- bossName, fileDataID, isKilled
        return boss.name, boss.fileDataID or 0, boss.killed
    end

    local function getSavedInstanceInfo(index)
        calls[#calls + 1] = index
        local entry = entries[index]
        if not entry then
            return nil
        end
        -- name, lockoutId, reset, difficultyId, locked, extended, instanceIDMostSig,
        -- isRaid, maxPlayers, difficultyName, numEncounters, encounterProgress, ...
        return entry.name,
            entry.lockoutId or 0,
            entry.reset,
            entry.difficultyId,
            entry.locked,
            entry.extended,
            0,
            entry.isRaid,
            entry.maxPlayers,
            entry.difficultyName,
            entry.numEncounters or (entry.bosses and #entry.bosses) or 0,
            entry.encounterProgress or 0
    end

    return getNumSavedInstances, getSavedInstanceInfo, calls, getSavedInstanceEncounterInfo, encounterCalls
end

---A stand-in for the global GameTooltip that records the lines it was asked to draw.
---@return table tooltip, table recorded `{ owner, anchor, lines, shown, hidden }`
function fake.newTooltip()
    local recorded = { lines = {}, shown = 0, hidden = 0 }
    local tooltip = {}

    -- Declared with dot syntax and an ignored first parameter: the addon calls these
    -- with `:` on the global tooltip, so `self` arrives whether or not it is wanted.
    function tooltip.SetOwner(_, owner, anchor)
        recorded.owner = owner
        recorded.anchor = anchor
        -- The real tooltip clears itself when it changes owner.
        recorded.lines = {}
    end

    function tooltip.AddLine(_, text, ...)
        recorded.lines[#recorded.lines + 1] = { text = text, color = { ... } }
    end

    function tooltip.AddDoubleLine(_, left, right, ...)
        recorded.lines[#recorded.lines + 1] = { text = left, right = right, color = { ... } }
    end

    function tooltip.Show()
        recorded.shown = recorded.shown + 1
    end

    function tooltip.Hide()
        recorded.hidden = recorded.hidden + 1
    end

    return tooltip, recorded
end

---A fake Encounter Journal, driven by a readable tier list rather than the client's
---select-then-enumerate protocol.
---
---Each tier is `{ name = "Classic", raids = { "Molten Core" }, dungeons = { "Deadmines" } }`.
---The fakes honour the real API's statefulness: `getInstanceByIndex` only sees the tier
---that was last selected, so an addon that forgets to call `selectTier` reads nothing.
---@param tiers table[]?
---@return table journal `{ getNumTiers, getCurrentTier, selectTier, getTierInfo, getInstanceByIndex }`
---@return table recorded `{ selected = integer[], current = fun(): integer }`
function fake.newEncounterJournal(tiers)
    tiers = tiers or {}
    local selected = {}
    local current = 1

    local journal = {}

    function journal.getNumTiers()
        return #tiers
    end

    function journal.getCurrentTier()
        return current
    end

    function journal.selectTier(tier)
        selected[#selected + 1] = tier
        current = tier
    end

    function journal.getTierInfo(tier)
        local entry = tiers[tier]
        return entry and entry.name
    end

    function journal.getInstanceByIndex(index, isRaid)
        local entry = tiers[current]
        if not entry then
            return nil
        end
        local list = (isRaid and entry.raids or entry.dungeons) or {}
        local name = list[index]
        if not name then
            return nil
        end
        -- instanceID, name
        return 1000 + index, name
    end

    return journal, {
        selected = selected,
        ---@return integer the tier the journal is left on
        current = function()
            return current
        end,
    }
end

---Class colours and icon coordinates for a handful of classes, in the shape the
---real globals use. Enough to prove the addon reads them correctly; not a full roster.
---@return fun(classFile: string): (number?, number?, number?) classColor
---@return table<string, number[]> classIconCoords
function fake.newClassLook()
    local colors = {
        WARRIOR = { r = 0.78, g = 0.61, b = 0.43 },
        MAGE = { r = 0.25, g = 0.78, b = 0.92 },
        PRIEST = { r = 1, g = 1, b = 1 },
    }

    local coords = {
        WARRIOR = { 0, 0.25, 0, 0.25 },
        MAGE = { 0.25, 0.49609375, 0, 0.25 },
        PRIEST = { 0.49609375, 0.7421875, 0, 0.25 },
    }

    return function(classFile)
        local color = colors[classFile]
        if not color then
            return nil
        end
        return color.r, color.g, color.b
    end, coords
end

---A clock the test controls. `now()` is fixed until the test advances it.
---@param start integer?
---@return table `{ now = fun(): integer, set = fun(t: integer), advance = fun(by: integer) }`
function fake.newClock(start)
    local current = start or 0
    local clock = {}

    function clock.now()
        return current
    end

    function clock.set(value)
        current = value
    end

    function clock.advance(by)
        current = current + by
    end

    return clock
end

---A deterministic stand-in for the global `date`, so expiry strings never depend on
---the machine's timezone or locale.
---@return fun(format: string, timestamp: integer): string
---@return table calls `{ { format = string, timestamp = integer }, ... }`
function fake.newFormatDate()
    local calls = {}

    local function formatDate(format, timestamp)
        calls[#calls + 1] = { format = format, timestamp = timestamp }
        return "<" .. format .. "@" .. tostring(timestamp) .. ">"
    end

    return formatDate, calls
end

---A complete fake WowEnv plus the recordings the test asserts on.
---
---`options.db` may be shared between two `newEnv` calls to model two characters on
---one account writing into the same SavedVariables table.
---@param options table? `{ playerName, realmName, class, classFile, level, now, savedInstances, db,
---  tiers, money, instanceType, instanceName, difficultyId, difficultyName, itemPrices,
---  transmogSources, currencies, achievements, mounts, pets, toys, housingItems, activeQuests,
---  questStates, lootFormats, factionFormats }`
---  `housingItems` maps an id to `{ name, quantity }`, quantity being the warband-owned count.
---  `currencies` maps a currencyType to its localised name; `achievements` maps an id to its name.
---  `currencyItems` maps an item id to `{ name, count }`, count being the grand total owned.
---  `trackedCurrencies` is a list of item ids to pre-seed into the tracked-currency store.
---@return table env, table recorded
function fake.newEnv(options)
    options = options or {}
    local createFrame, frames, types = fake.newCreateFrame()
    local lines = {}
    local unitsAsked = {}
    local classAsked = {}
    local levelAsked = {}
    local raidInfoRequests = 0
    local slashRegistrations = {}
    local specialFrames = options.specialFrames or {}
    local db = options.db or {}
    local clock = options.clock or fake.newClock(options.now or 1000)
    local formatDate, formatDateCalls = fake.newFormatDate()
    local getNumSavedInstances, getSavedInstanceInfo, savedInstanceCalls,
        getSavedInstanceEncounterInfo, encounterCalls = fake.newSavedInstances(options.savedInstances)
    local tooltip, tooltipRecorded = fake.newTooltip()
    local journal, journalRecorded = fake.newEncounterJournal(options.tiers)
    local classColor, classIconCoords = fake.newClassLook()

    -- Mutable so a test can drive the wallet, the zone, and the collection across a
    -- sequence of events, the same way the client mutates them under the addon's feet.
    local money = options.money or 0
    local zone = {
        name = options.instanceName or "Deadmines",
        kind = options.instanceType,
        difficultyId = options.difficultyId or 1,
        difficulty = options.difficultyName or "Normal",
    }
    local itemPrices = options.itemPrices or {}
    local transmogSources = options.transmogSources or {}
    local currencyNames = options.currencies or {}
    local achievementNames = options.achievements or {}
    local mountNames = options.mounts or {}
    local pets = options.pets or {}
    local toyNames = options.toys or {}
    local housingItems = options.housingItems or {}
    -- Maps an item ID to `{ name, count }`, count being the grand total the character owns
    -- across every store — bags and every bank — the way ownedItemCount reports it.
    local currencyItems = options.currencyItems or {}
    -- The item the client currently has on the cursor, or nil; drives getCursorItem.
    local cursor
    local cursorCleared = 0
    -- Pre-seed the tracked-currency store the way a player who had already added items would,
    -- mapping each id to its world name so the manager and tally see it as tracked from boot.
    if options.trackedCurrencies then
        db.currencyItems = db.currencyItems or {}
        for _, itemID in ipairs(options.trackedCurrencies) do
            local world = currencyItems[itemID]
            db.currencyItems[itemID] = (world and world.name) or tostring(itemID)
        end
    end
    local activeQuests = options.activeQuests or {}
    local questStates = options.questStates or {}

    local env = {
        createFrame = createFrame,
        print = function(message)
            lines[#lines + 1] = message
        end,
        unitName = function(unit)
            unitsAsked[#unitsAsked + 1] = unit
            return options.playerName
        end,
        unitClass = function(unit)
            classAsked[#classAsked + 1] = unit
            return options.class, options.classFile
        end,
        unitLevel = function(unit)
            levelAsked[#levelAsked + 1] = unit
            return options.level
        end,
        realmName = function()
            return options.realmName
        end,
        now = clock.now,
        formatDate = formatDate,
        getNumSavedInstances = getNumSavedInstances,
        getSavedInstanceInfo = getSavedInstanceInfo,
        getSavedInstanceEncounterInfo = getSavedInstanceEncounterInfo,
        tooltip = tooltip,
        requestRaidInfo = function()
            raidInfoRequests = raidInfoRequests + 1
        end,
        classColor = classColor,
        classIconCoords = classIconCoords,
        getNumTiers = journal.getNumTiers,
        getCurrentTier = journal.getCurrentTier,
        selectTier = journal.selectTier,
        getTierInfo = journal.getTierInfo,
        getInstanceByIndex = journal.getInstanceByIndex,
        registerSlash = function(tokens, handler)
            slashRegistrations[#slashRegistrations + 1] = { tokens = tokens, handler = handler }
        end,
        getMoney = function()
            return money
        end,
        instanceInfo = function()
            return {
                name = zone.name,
                kind = zone.kind,
                difficultyId = zone.difficultyId,
                difficulty = zone.difficulty,
            }
        end,
        itemSellPrice = function(itemID)
            return itemPrices[itemID]
        end,
        transmogSourceInfo = function(sourceID)
            local source = transmogSources[sourceID]
            if not source then
                return nil
            end
            return {
                itemID = source.item,
                visualID = source.visualID,
                newAppearance = source.newAppearance,
            }
        end,
        currencyInfo = function(currencyType)
            return currencyNames[currencyType]
        end,
        ownedItemCount = function(itemID)
            local item = currencyItems[itemID]
            return item and item.count or 0
        end,
        getCursorItem = function()
            if not cursor then
                return nil
            end
            return cursor.id, cursor.name
        end,
        clearCursor = function()
            cursor = nil
            cursorCleared = cursorCleared + 1
        end,
        achievementInfo = function(id)
            return achievementNames[id]
        end,
        mountInfo = function(id)
            return mountNames[id]
        end,
        petInfo = function(guid)
            local pet = pets[guid] or {}
            return pet.id, pet.name
        end,
        toyInfo = function(id)
            return toyNames[id]
        end,
        housingItemInfo = function(id)
            local item = housingItems[id]
            if not item then
                return nil
            end
            return item.name, item.quantity
        end,
        activeQuestIDs = function()
            local ids = {}
            for index, id in ipairs(activeQuests) do
                ids[index] = id
            end
            return ids
        end,
        questCompletionInfo = function(id)
            local state = questStates[id] or {}
            return {
                name = state.name,
                characterCompleted = state.characterCompleted and true or false,
                accountCompleted = state.accountCompleted and true or false,
            }
        end,
        openAchievement = function() end,
        previewTransmog = function() end,
        openTransmogCollection = function() end,
        itemName = function(itemID)
            local currencyItem = currencyItems[itemID]
            if currencyItem and currencyItem.name then
                return currencyItem.name
            end
            local source = itemPrices[itemID]
            return source and ("Item " .. itemID)
        end,
        lootSelfFormats = options.lootFormats or {
            "You receive loot: %sx%d.",
            "You receive loot: %s.",
        },
        factionIncreaseFormats = options.factionFormats or {
            "Your %s reputation has increased by %d.",
        },
        uiParent = options.uiParent or { name = "UIParent" },
        minimap = options.minimap or { frameName = "Minimap" },
        specialFrames = specialFrames,
        db = db,
    }

    return env, {
        lines = lines,
        frames = frames,
        frameTypes = types,
        unitsAsked = unitsAsked,
        classAsked = classAsked,
        levelAsked = levelAsked,
        db = db,
        clock = clock,
        specialFrames = specialFrames,
        formatDateCalls = formatDateCalls,
        slashRegistrations = slashRegistrations,
        tooltip = tooltipRecorded,
        savedInstanceCalls = savedInstanceCalls,
        encounterCalls = encounterCalls,
        journal = journalRecorded,
        ---Drive the wallet the addon reads through env.getMoney.
        ---@param value integer
        setMoney = function(value)
            money = value
        end,
        ---Drive the grand-total owned count the addon reads through env.ownedItemCount,
        ---as looting, spending or moving a currency item between stores would.
        ---@param itemID integer
        ---@param count integer
        setItemCount = function(itemID, count)
            local item = currencyItems[itemID]
            if item then
                item.count = count
            else
                currencyItems[itemID] = { count = count }
            end
        end,
        ---Put an item on the cursor, as picking one up from a bag would, so a drop onto the
        ---currency manager has something to read. Passing nil empties the cursor.
        ---@param itemID integer?
        ---@param name string?
        setCursorItem = function(itemID, name)
            if itemID == nil then
                cursor = nil
                return
            end
            local world = currencyItems[itemID]
            cursor = { id = itemID, name = name or (world and world.name) }
        end,
        ---@return integer how many times the addon cleared the cursor
        cursorCleared = function()
            return cursorCleared
        end,
        ---Drive the instance type the addon reads through env.instanceInfo. Passing
        ---nil models zoning out into the open world.
        ---@param value string?
        setInstanceType = function(value)
            zone.kind = value
        end,
        ---Drive the whole zone at once, for tests that move between instances.
        ---@param value table `{ name, kind, difficultyId, difficulty }`
        setInstance = function(value)
            for key, field in pairs(value) do
                zone[key] = field
            end
        end,
        ---@return integer how many times the addon asked the client for raid info
        raidInfoRequests = function()
            return raidInfoRequests
        end,
    }
end

return fake
