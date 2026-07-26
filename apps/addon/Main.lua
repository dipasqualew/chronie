local addonName, ns = ...

---Everything the addon needs from the outside world, in one injectable bag.
---@class WowEnv
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field print fun(message: string)
---@field unitName fun(unit: string): string?
---@field unitClass fun(unit: string): string?, string? Localised class name, class token.
---@field unitLevel fun(unit: string): integer?
---@field realmName fun(): string
---@field now fun(): integer
---@field formatDate fun(format: string, timestamp: integer): string
---@field getNumSavedInstances fun(): integer
---@field getSavedInstanceInfo fun(index: integer): ...
---@field getSavedInstanceEncounterInfo fun(instanceIndex: integer, encounterIndex: integer): ...
---@field requestRaidInfo fun()
---@field classColor fun(classFile: string): (number?, number?, number?)
---@field classIconCoords table<string, number[]> Global CLASS_ICON_TCOORDS.
---@field getNumTiers fun(): integer
---@field getCurrentTier fun(): integer
---@field selectTier fun(tier: integer)
---@field getTierInfo fun(tier: integer): string?
---@field getInstanceByIndex fun(index: integer, isRaid: boolean): ...
---@field registerSlash fun(tokens: string[], handler: fun(text: string))
---@field getMoney fun(): integer Current wallet total, in copper.
---@field instanceInfo fun(): InstanceInfo? Name, type and difficulty of the current zone.
---@field itemSellPrice fun(itemID: integer): integer? Vendor price of one item, in copper.
---@field transmogSourceInfo fun(sourceID: integer): table?
---@field activeQuestIDs fun(): integer[]
---@field questCompletionInfo fun(questID: integer): table
---@field currencyInfo fun(currencyType: integer): string? Localised name of a currency.
---@field ownedItemCount fun(itemID: integer): integer Grand total owned across bags and every bank,
---the warband bank included, so internal transfers leave it unchanged.
---@field getCursorItem fun(): (integer?, string?) Item held on the cursor: id and name, or nil.
---@field clearCursor fun() Release whatever the cursor is holding.
---@field achievementInfo fun(id: integer): string? Localised name of an achievement.
---@field mountInfo fun(id: integer): string? Localised name of a mount.
---@field petInfo fun(guid: string): (integer?, string?) Battle pet species ID and localised name.
---@field toyInfo fun(id: integer): string? Localised name of a toy.
---@field housingItemInfo fun(id: integer): (string?, integer?) Localised name and warband-owned count.
---@field openAchievement fun(id: integer)
---@field previewTransmog fun(itemID: integer)
---@field openTransmogCollection fun(sourceID: integer)
---@field itemName fun(itemID: integer): string?
---@field lootSelfFormats string[] Self-loot chat templates, most specific first.
---@field factionIncreaseFormats string[] Reputation-increase chat templates.
---@field uiParent table
---@field specialFrames string[]
---@field tooltip table
---@field minimap table
---@field db table SavedVariables root.

---Composition root. Wires the modules together and starts listening.
---@param env WowEnv
---@return table
function ns.main(env)
    local logger = ns.newLogger({ sink = env.print, prefix = "|cff33ff99" .. addonName .. "|r:" })
    local dispatcher = ns.newEventDispatcher({ createFrame = env.createFrame })

    local scanner = ns.newLockoutScanner({
        getNumSavedInstances = env.getNumSavedInstances,
        getSavedInstanceInfo = env.getSavedInstanceInfo,
        getSavedInstanceEncounterInfo = env.getSavedInstanceEncounterInfo,
        now = env.now,
    })
    local store = ns.newLockoutStore({ db = env.db, now = env.now })
    local lockoutTable = ns.newLockoutTable({ now = env.now, formatDate = env.formatDate })

    local classDisplay = ns.newClassDisplay({
        classColor = env.classColor,
        classIconCoords = env.classIconCoords,
    })
    local expansions = ns.newExpansionIndex({
        getNumTiers = env.getNumTiers,
        getCurrentTier = env.getCurrentTier,
        selectTier = env.selectTier,
        getTierInfo = env.getTierInfo,
        getInstanceByIndex = env.getInstanceByIndex,
    })

    local details = ns.newLockoutDetails({
        now = env.now,
        lockoutTable = lockoutTable,
        classDisplay = classDisplay,
        expansions = expansions,
    })

    local instanceWindow = ns.newDetailWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        name = "ChronieInstanceDetailWindow",
    })

    local characterWindow = ns.newDetailWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        name = "ChronieCharacterDetailWindow",
    })

    local tally = ns.newSegmentTally({
        lootFormats = env.lootSelfFormats,
        factionFormats = env.factionIncreaseFormats,
        itemSellPrice = env.itemSellPrice,
    })
    local currencyItems = ns.newCurrencyItems({ db = env.db })
    local questBaselines = {}

    local function snapshotQuest(questID)
        if questID and not questBaselines[questID] then
            questBaselines[questID] = env.questCompletionInfo(questID)
        end
    end

    local function snapshotActiveQuests()
        for _, questID in ipairs(env.activeQuestIDs()) do
            snapshotQuest(questID)
        end
    end

    local resultsWindow = ns.newResultsWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        name = "ChronieResultsWindow",
        formatMoney = ns.formatMoney,
        loadPoint = function()
            local saved = env.db.resultsWindow
            if not saved then
                return nil
            end
            return saved.point, saved.x, saved.y
        end,
        savePoint = function(point, x, y)
            env.db.resultsWindow = { point = point, x = x, y = y }
        end,
        openAchievement = env.openAchievement,
        previewTransmog = env.previewTransmog,
        openTransmogCollection = env.openTransmogCollection,
        itemName = env.itemName,
    })

    ---Only the logged-in character can be scanned, so identity is captured at save time.
    local function currentCharacter()
        return (env.unitName("player") or "?") .. "-" .. (env.realmName() or "?")
    end

    local segmentLog = ns.newSegmentLog({
        db = env.db,
        now = env.now,
        formatDate = env.formatDate,
    })

    local segmentTracker = ns.newSegmentTracker({
        tally = tally,
        segmentLog = segmentLog,
        now = env.now,
        instanceInfo = env.instanceInfo,
        getMoney = env.getMoney,
        -- Snapshot every tracked currency item's owned total as the segment opens, so the
        -- tally measures later changes against what was held on arrival rather than zero.
        currencyItemCounts = function()
            local counts = {}
            for _, itemID in ipairs(currencyItems.ids()) do
                counts[itemID] = env.ownedItemCount(itemID)
            end
            return counts
        end,
        character = currentCharacter,
        classFile = function()
            local _, classFile = env.unitClass("player")
            return classFile
        end,
        level = function()
            return env.unitLevel("player")
        end,
    })

    local segmentWindow = ns.newDetailWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        name = "ChronieSegmentWindow",
    })

    local segmentDetailWindow = ns.newResultsWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        name = "ChronieSegmentDetailWindow",
        title = function(record)
            return record.character .. " — " .. record.instance
        end,
        closable = true,
        specialFrames = env.specialFrames,
        frameStrata = "FULLSCREEN_DIALOG",
        toplevel = true,
        formatMoney = ns.formatMoney,
        loadPoint = function()
            return "CENTER", 260, 0
        end,
        savePoint = function() end,
        openAchievement = env.openAchievement,
        previewTransmog = env.previewTransmog,
        openTransmogCollection = env.openTransmogCollection,
        itemName = env.itemName,
    })

    local segmentTable = ns.newSegmentTable({
        classDisplay = classDisplay,
        formatMoney = ns.formatMoney,
        onSegmentSelected = function(record)
            segmentDetailWindow.update(record)
            segmentDetailWindow.show()
        end,
    })

    -- Read straight off the saved variables so a player on a non-default install can
    -- fix the paths in chronie.lua without touching addon code.
    local reportCommand = ns.newReportCommand(env.db.report)

    local reportWindow = ns.newReportWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        name = "ChronieReportWindow",
    })

    local currencyWindow = ns.newCurrencyWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        name = "ChronieCurrencyWindow",
        items = currencyItems,
        getCursorItem = env.getCursorItem,
        clearCursor = env.clearCursor,
        itemName = env.itemName,
        loadPoint = function()
            local saved = env.db.currencyWindow
            if not saved then
                return nil
            end
            return saved.point, saved.x, saved.y
        end,
        savePoint = function(point, x, y)
            env.db.currencyWindow = { point = point, x = x, y = y }
        end,
    })

    ---Only redraws when the panel is actually on screen, so a busy loot log does not
    ---churn hidden font strings.
    local function refreshResults()
        if resultsWindow.isShown() then
            resultsWindow.update(tally.summary())
        end
    end

    local window = ns.newLockoutWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        getRows = store.all,
        lockoutTable = lockoutTable,
        onRefreshRequested = env.requestRaidInfo,
        tooltip = env.tooltip,
        classDisplay = classDisplay,
        expansions = expansions,

        onInstanceSelected = function(row)
            instanceWindow.show(details.forInstance(details.descriptorOf(row), store.characters(), store.all()))
        end,

        onCharacterSelected = function(character)
            characterWindow.show(details.forCharacter(character, store.all()))
        end,
    })

    local function captureLockouts()
        store.save(currentCharacter(), scanner.scan())
        window.refresh()
    end

    local router = ns.newSlashRouter({
        onUnknown = function()
            logger.info("usage: /chronie locks | results | segments | currency | report")
        end,
    })
    router.add("locks", window.toggle)
    router.add("results", function()
        if resultsWindow.isShown() then
            resultsWindow.hide()
        else
            resultsWindow.update(tally.summary())
            resultsWindow.show()
        end
    end)
    local segmentFilters = { character = "", day = "", location = "" }
    local function segmentSpec()
        local all = segmentLog.all()
        local filtered = segmentTable.filter(all, segmentFilters)
        local spec = segmentTable.spec(filtered)
        if #all > 0 and #filtered == 0 then
            spec.sections[1].empty = "No segments match those filters."
        end
        spec.filters = {
            { key = "character", label = "Character", value = segmentFilters.character },
            { key = "day", label = "Day", value = segmentFilters.day },
            { key = "location", label = "Location", value = segmentFilters.location },
        }
        spec.onFilterChanged = function(key, value)
            segmentFilters[key] = value
            segmentWindow.show(segmentSpec())
        end
        return spec
    end

    local function toggleSegments()
        if segmentWindow.isShown() then
            segmentWindow.hide()
        else
            segmentWindow.show(segmentSpec())
        end
    end
    router.add("segments", toggleSegments)
    router.add("currency", currencyWindow.toggle)
    router.add("report", function()
        reportWindow.toggle(reportCommand.lines())
    end)

    local minimapButton = ns.newMinimapButton({
        createFrame = env.createFrame,
        minimap = env.minimap,
        tooltip = env.tooltip,
        loadPoint = function()
            local saved = env.db.minimapButton
            if not saved then
                return nil
            end
            return saved.point, saved.x, saved.y
        end,
        savePoint = function(point, x, y)
            env.db.minimapButton = { point = point, x = x, y = y }
        end,
        onClick = function()
            segmentWindow.show(segmentSpec())
        end,
    })
    minimapButton.show()

    dispatcher.on("PLAYER_LOGIN", function()
        -- Recorded even when this character has no lockouts at all, so it can still be
        -- listed as available for instances its siblings are saved to.
        local class, classFile = env.unitClass("player")
        store.remember(currentCharacter(), {
            class = class,
            classFile = classFile,
            level = env.unitLevel("player"),
        })
        env.requestRaidInfo()
    end)

    -- Fired after RequestRaidInfo, and whenever the client's lockout state changes
    -- (zoning out of an instance, a boss kill, a raid extension).
    dispatcher.on("UPDATE_INSTANCE_INFO", captureLockouts)
    dispatcher.on("BOSS_KILL", env.requestRaidInfo)

    -- Both events matter: PLAYER_ENTERING_WORLD covers load screens, while
    -- ZONE_CHANGED_NEW_AREA covers seamless outdoor boundaries such as a taxi flight
    -- between two neighbouring zones. Duplicate notifications are harmless because the
    -- tracker keeps the current segment when the location identity has not changed.
    local function syncSegment()
        env.requestRaidInfo()
        snapshotActiveQuests()
        segmentTracker.sync()
        resultsWindow.update(tally.summary())
        resultsWindow.show()
    end
    dispatcher.on("PLAYER_ENTERING_WORLD", syncSegment)
    dispatcher.on("ZONE_CHANGED_NEW_AREA", syncSegment)

    -- Logging out or reloading is the last chance to file a segment: SavedVariables are
    -- only written to disk on the way out, so an unfiled segment would never be exported.
    dispatcher.on("PLAYER_LOGOUT", segmentTracker.flush)

    -- Every one of these events folds something into the running tally and then wants the
    -- results panel redrawn. Wrapping the subscription keeps that redraw in one place, so a
    -- handler body states only the change it makes and can never forget to refresh.
    local function onTallyEvent(event, handler)
        dispatcher.on(event, function(...)
            handler(...)
            refreshResults()
        end)
    end

    onTallyEvent("PLAYER_MONEY", function()
        tally.money(env.getMoney())
    end)
    onTallyEvent("CHAT_MSG_LOOT", function(message)
        tally.loot(message)
    end)
    onTallyEvent("TRANSMOG_COLLECTION_SOURCE_ADDED", function(sourceID)
        local info = env.transmogSourceInfo(sourceID)
        if info and info.itemID then
            tally.transmog({
                id = info.itemID,
                sourceID = sourceID,
                appearanceID = info.visualID,
                newAppearance = info.newAppearance,
                at = env.now(),
            })
        end
    end)
    onTallyEvent("CHAT_MSG_COMBAT_FACTION_CHANGE", function(message)
        tally.reputation(message)
    end)
    -- The client hands the signed change straight to the event, so a spend arrives as a
    -- negative and only the localised name has to be looked up.
    onTallyEvent("CURRENCY_DISPLAY_UPDATE", function(currencyType, _, change)
        tally.currency(currencyType, change, env.currencyInfo(currencyType))
    end)
    -- Item-based currencies — vendor tokens, crest-like items and the like — never fire
    -- CURRENCY_DISPLAY_UPDATE; their quantity lives in item counts. Recounting each tracked
    -- item on every batched bag change and folding the difference in tracks both gains and
    -- spends. Because the count spans every storage the character can reach, including the
    -- warband bank, a deposit or withdrawal nets to zero and is never miscounted as either.
    onTallyEvent("BAG_UPDATE_DELTA", function()
        for _, itemID in ipairs(currencyItems.ids()) do
            tally.currencyItem(itemID, env.ownedItemCount(itemID), env.itemName(itemID))
        end
    end)
    onTallyEvent("ACHIEVEMENT_EARNED", function(id, alreadyEarned)
        tally.achievement(id, env.achievementInfo(id), env.now(), not alreadyEarned)
    end)
    onTallyEvent("PLAYER_LEVEL_UP", function(level)
        tally.levelUp(level, env.now())
    end)
    onTallyEvent("NEW_MOUNT_ADDED", function(id)
        tally.mount(id, env.mountInfo(id), env.now())
    end)
    onTallyEvent("NEW_PET_ADDED", function(guid)
        local speciesID, name = env.petInfo(guid)
        tally.pet(speciesID, name, env.now(), guid)
    end)
    onTallyEvent("NEW_TOY_ADDED", function(id)
        tally.toy(id, env.toyInfo(id), env.now())
    end)
    -- Housing decor is warband-wide, so the owned count decides first-time from duplicate:
    -- one copy means this segment collected it for the whole warband, more is an extra.
    onTallyEvent("HOUSING_DECOR_ADDED", function(id)
        local name, quantity = env.housingItemInfo(id)
        tally.housingItem(id, name, env.now(), (quantity or 1) <= 1)
    end)
    -- The client hands the experience gained straight to the event, the way currency does.
    onTallyEvent("HOUSING_XP_GAINED", function(amount)
        tally.housingXP(amount)
    end)
    onTallyEvent("HOUSING_LEVEL_UP", function(level)
        tally.housingLevelUp(level, env.now())
    end)
    dispatcher.on("QUEST_ACCEPTED", snapshotQuest)
    dispatcher.on("QUEST_LOG_UPDATE", snapshotActiveQuests)
    onTallyEvent("QUEST_TURNED_IN", function(id)
        local baseline = questBaselines[id]
        local characterFirst, accountFirst
        if baseline then
            characterFirst = not baseline.characterCompleted
            accountFirst = not baseline.accountCompleted
        end
        tally.quest(
            id,
            env.now(),
            baseline and baseline.name or nil,
            characterFirst,
            accountFirst
        )
        questBaselines[id] = nil
    end)

    env.registerSlash({ "/chronie" }, router.dispatch)

    return {
        window = window,
        instanceWindow = instanceWindow,
        characterWindow = characterWindow,
        details = details,
        store = store,
        scanner = scanner,
        router = router,
        logger = logger,
        tally = tally,
        resultsWindow = resultsWindow,
        segmentLog = segmentLog,
        segmentTracker = segmentTracker,
        segmentTable = segmentTable,
        segmentWindow = segmentWindow,
        segmentDetailWindow = segmentDetailWindow,
        minimapButton = minimapButton,
        reportCommand = reportCommand,
        reportWindow = reportWindow,
        currencyItems = currencyItems,
        currencyWindow = currencyWindow,
    }
end

-- Only auto-start inside the game; under test the harness calls ns.main itself.
if CreateFrame then
    local function registerSlash(tokens, handler)
        for index, token in ipairs(tokens) do
            _G["SLASH_CHRONIE" .. index] = token
        end
        SlashCmdList["CHRONIE"] = handler
    end

    -- SavedVariables only exist once the addon's variables have loaded.
    local bootstrap = CreateFrame("Frame")
    bootstrap:RegisterEvent("ADDON_LOADED")
    bootstrap:SetScript("OnEvent", function(self, _, loaded)
        if loaded ~= addonName then
            return
        end
        self:UnregisterAllEvents()

        ChronieDB = ChronieDB or {}

        ---Collects the client's globals into a list, dropping any this client build
        ---does not define so a missing template never becomes a nil hole.
        ---@param ... string?
        ---@return string[]
        local function templates(...)
            local list = {}
            for index = 1, select("#", ...) do
                local value = select(index, ...)
                if value then
                    list[#list + 1] = value
                end
            end
            return list
        end

        ns.app = ns.main({
            createFrame = CreateFrame,
            print = print,
            unitName = UnitName,
            unitClass = UnitClass,
            unitLevel = UnitLevel,
            realmName = GetRealmName,
            now = time,
            formatDate = date,
            getNumSavedInstances = GetNumSavedInstances,
            getSavedInstanceInfo = GetSavedInstanceInfo,
            getSavedInstanceEncounterInfo = GetSavedInstanceEncounterInfo,
            requestRaidInfo = RequestRaidInfo,
            classColor = function(classFile)
                local color = RAID_CLASS_COLORS[classFile]
                if not color then
                    return nil
                end
                return color.r, color.g, color.b
            end,
            classIconCoords = CLASS_ICON_TCOORDS,
            getNumTiers = EJ_GetNumTiers,
            getCurrentTier = EJ_GetCurrentTier,
            selectTier = EJ_SelectTier,
            getTierInfo = EJ_GetTierInfo,
            getInstanceByIndex = EJ_GetInstanceByIndex,
            registerSlash = registerSlash,
            getMoney = GetMoney,
            instanceInfo = function()
                local name, kind, difficultyId, difficulty = GetInstanceInfo()
                return { name = name, kind = kind, difficultyId = difficultyId, difficulty = difficulty }
            end,
            itemSellPrice = function(itemID)
                if not itemID then
                    return nil
                end
                return (select(11, GetItemInfo(itemID)))
            end,
            transmogSourceInfo = function(sourceID)
                local info = C_TransmogCollection.GetSourceInfo(sourceID)
                if not info then
                    return nil
                end
                local sources = C_TransmogCollection.GetAppearanceSources(info.visualID)
                local uiNew = C_TransmogCollection.IsNewAppearance(info.visualID)
                return {
                    itemID = info.itemID,
                    visualID = info.visualID,
                    newAppearance = ns.isNewTransmogAppearance(sources, uiNew),
                }
            end,
            activeQuestIDs = function()
                local ids = {}
                local entries = C_QuestLog.GetNumQuestLogEntries()
                for index = 1, entries do
                    local info = C_QuestLog.GetInfo(index)
                    if info and not info.isHeader and info.questID then
                        ids[#ids + 1] = info.questID
                    end
                end
                return ids
            end,
            questCompletionInfo = function(questID)
                return {
                    name = C_QuestLog.GetTitleForQuestID(questID),
                    characterCompleted = C_QuestLog.IsQuestFlaggedCompleted(questID),
                    accountCompleted = C_QuestLog.IsQuestFlaggedCompletedOnAccount(questID),
                }
            end,
            currencyInfo = function(currencyType)
                if not currencyType then
                    return nil
                end
                local info = C_CurrencyInfo.GetCurrencyInfo(currencyType)
                return info and info.name
            end,
            -- includeBank, includeUses, includeReagentBank, includeAccountBankTabs: every
            -- store the character owns, so moving the item between them never shifts the total.
            ownedItemCount = function(itemID)
                if not itemID then
                    return 0
                end
                return C_Item.GetItemCount(itemID, true, false, true, true) or 0
            end,
            getCursorItem = function()
                local kind, itemID = GetCursorInfo()
                if kind ~= "item" or not itemID then
                    return nil
                end
                return itemID, (GetItemInfo(itemID))
            end,
            clearCursor = ClearCursor,
            achievementInfo = function(id)
                return (select(2, GetAchievementInfo(id)))
            end,
            mountInfo = function(id)
                return (C_MountJournal.GetMountInfoByID(id))
            end,
            petInfo = function(guid)
                local speciesID, _, _, _, _, _, _, name = C_PetJournal.GetPetInfoByPetID(guid)
                return speciesID, name
            end,
            toyInfo = function(id)
                return (select(2, C_ToyBox.GetToyInfo(id)))
            end,
            housingItemInfo = function(id)
                if not id then
                    return nil
                end
                local info = C_HousingCatalog.GetCatalogEntryInfo(id)
                if not info then
                    return nil
                end
                return info.name, info.numOwned
            end,
            openAchievement = function(id)
                AchievementFrame_LoadUI()
                ShowUIPanel(AchievementFrame)
                AchievementFrame_SelectAchievement(id)
            end,
            previewTransmog = function(itemID)
                DressUpItemLink("item:" .. itemID)
            end,
            openTransmogCollection = function(sourceID)
                CollectionsJournal_LoadUI()
                ToggleCollectionsJournal(5)
                WardrobeCollectionFrame:OpenTransmogLink("transmogappearance:" .. sourceID)
            end,
            itemName = function(itemID)
                return (GetItemInfo(itemID))
            end,
            lootSelfFormats = templates(LOOT_ITEM_SELF_MULTIPLE, LOOT_ITEM_SELF),
            factionIncreaseFormats = templates(
                FACTION_STANDING_INCREASED,
                FACTION_STANDING_INCREASED_BONUS,
                FACTION_STANDING_INCREASED_ACCOUNT_WIDE
            ),
            uiParent = UIParent,
            specialFrames = UISpecialFrames,
            tooltip = GameTooltip,
            minimap = Minimap,
            db = ChronieDB,
        })
    end)
end
