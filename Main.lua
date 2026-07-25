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
---@field currencyInfo fun(currencyType: integer): string? Localised name of a currency.
---@field achievementInfo fun(id: integer): string? Localised name of an achievement.
---@field openAchievement fun(id: integer)
---@field previewTransmog fun(itemID: integer)
---@field openTransmogCollection fun(sourceID: integer)
---@field itemName fun(itemID: integer): string?
---@field lootSelfFormats string[] Self-loot chat templates, most specific first.
---@field factionIncreaseFormats string[] Reputation-increase chat templates.
---@field uiParent table
---@field specialFrames string[]
---@field tooltip table
---@field db table SavedVariables root.

---Composition root. Wires the modules together and starts listening.
---@param env WowEnv
---@return table
function ns.main(env)
    local logger = ns.newLogger({ sink = env.print, prefix = "|cff33ff99" .. addonName .. "|r:" })
    local greeter = ns.newGreeter({ template = "Hello World, %s!" })
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
        name = "WdpWowInstanceDetailWindow",
    })

    local characterWindow = ns.newDetailWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        name = "WdpWowCharacterDetailWindow",
    })

    local tally = ns.newSessionTally({
        lootFormats = env.lootSelfFormats,
        factionFormats = env.factionIncreaseFormats,
        itemSellPrice = env.itemSellPrice,
    })

    local resultsWindow = ns.newResultsWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        name = "WdpWowResultsWindow",
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

    local sessionLog = ns.newSessionLog({
        db = env.db,
        now = env.now,
        formatDate = env.formatDate,
    })

    local sessionTracker = ns.newSessionTracker({
        tally = tally,
        sessionLog = sessionLog,
        now = env.now,
        instanceInfo = env.instanceInfo,
        getMoney = env.getMoney,
        character = currentCharacter,
        classFile = function()
            local _, classFile = env.unitClass("player")
            return classFile
        end,
    })

    local sessionTable = ns.newSessionTable({
        classDisplay = classDisplay,
        formatMoney = ns.formatMoney,
    })

    local sessionWindow = ns.newDetailWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        name = "WdpWowSessionWindow",
    })

    -- Read straight off the saved variables so a player on a non-default install can
    -- fix the paths in wdp-wow.lua without touching addon code.
    local reportCommand = ns.newReportCommand(env.db.report)

    local reportWindow = ns.newReportWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        name = "WdpWowReportWindow",
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
            logger.info("usage: /wdp locks | results | sessions | report")
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
    router.add("sessions", function()
        if sessionWindow.isShown() then
            sessionWindow.hide()
        else
            sessionWindow.show(sessionTable.spec(sessionLog.all()))
        end
    end)
    router.add("report", function()
        reportWindow.toggle(reportCommand.lines())
    end)

    dispatcher.on("PLAYER_LOGIN", function()
        logger.info(greeter.greet(env.unitName("player")))
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

    -- Zoning is the signal that one session has ended and another begun: the tracker
    -- files the finished session (dropping it if nothing happened) and opens a fresh one
    -- for wherever the player now is. Every zone has a session, so the panel is always on.
    dispatcher.on("PLAYER_ENTERING_WORLD", function()
        env.requestRaidInfo()
        sessionTracker.sync()
        resultsWindow.update(tally.summary())
        resultsWindow.show()
    end)

    -- Logging out or reloading is the last chance to file a session: SavedVariables are
    -- only written to disk on the way out, so an unfiled session would never be exported.
    dispatcher.on("PLAYER_LOGOUT", sessionTracker.flush)

    dispatcher.on("PLAYER_MONEY", function()
        tally.money(env.getMoney())
        refreshResults()
    end)
    dispatcher.on("CHAT_MSG_LOOT", function(message)
        tally.loot(message)
        refreshResults()
    end)
    dispatcher.on("TRANSMOG_COLLECTION_SOURCE_ADDED", function(sourceID)
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
        refreshResults()
    end)
    dispatcher.on("CHAT_MSG_COMBAT_FACTION_CHANGE", function(message)
        tally.reputation(message)
        refreshResults()
    end)
    -- The client hands the signed change straight to the event, so a spend arrives as a
    -- negative and only the localised name has to be looked up.
    dispatcher.on("CURRENCY_DISPLAY_UPDATE", function(currencyType, _, change)
        tally.currency(currencyType, change, env.currencyInfo(currencyType))
        refreshResults()
    end)
    dispatcher.on("ACHIEVEMENT_EARNED", function(id, alreadyEarned)
        tally.achievement(id, env.achievementInfo(id), env.now(), not alreadyEarned)
        refreshResults()
    end)
    dispatcher.on("QUEST_TURNED_IN", function(id)
        tally.quest(id, env.now())
        refreshResults()
    end)

    env.registerSlash({ "/wdp" }, router.dispatch)

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
        sessionLog = sessionLog,
        sessionTracker = sessionTracker,
        sessionTable = sessionTable,
        sessionWindow = sessionWindow,
        reportCommand = reportCommand,
        reportWindow = reportWindow,
    }
end

-- Only auto-start inside the game; under test the harness calls ns.main itself.
if CreateFrame then
    local function registerSlash(tokens, handler)
        for index, token in ipairs(tokens) do
            _G["SLASH_WDPWOW" .. index] = token
        end
        SlashCmdList["WDPWOW"] = handler
    end

    -- SavedVariables only exist once the addon's variables have loaded.
    local bootstrap = CreateFrame("Frame")
    bootstrap:RegisterEvent("ADDON_LOADED")
    bootstrap:SetScript("OnEvent", function(self, _, loaded)
        if loaded ~= addonName then
            return
        end
        self:UnregisterAllEvents()

        WdpWowDB = WdpWowDB or {}

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
                return {
                    itemID = info.itemID,
                    visualID = info.visualID,
                    newAppearance = C_TransmogCollection.IsNewAppearance(info.visualID),
                }
            end,
            currencyInfo = function(currencyType)
                if not currencyType then
                    return nil
                end
                local info = C_CurrencyInfo.GetCurrencyInfo(currencyType)
                return info and info.name
            end,
            achievementInfo = function(id)
                return (select(2, GetAchievementInfo(id)))
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
            db = WdpWowDB,
        })
    end)
end
