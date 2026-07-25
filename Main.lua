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
---@field instanceType fun(): string? IsInInstance's type: "party", "raid", "scenario", ...
---@field itemSellPrice fun(itemID: integer): integer? Vendor price of one item, in copper.
---@field transmogSourceVisual fun(sourceID: integer): integer?
---@field transmogAppearanceSources fun(visualID: integer): integer[]?
---@field transmogSourceCollected fun(sourceID: integer): boolean
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

    local results = ns.newInstanceResults({
        lootFormats = env.lootSelfFormats,
        factionFormats = env.factionIncreaseFormats,
        itemSellPrice = env.itemSellPrice,
        sourceVisual = env.transmogSourceVisual,
        appearanceSources = env.transmogAppearanceSources,
        isSourceCollected = env.transmogSourceCollected,
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
    })

    ---Only redraws when the panel is actually on screen, so a busy loot log does not
    ---churn hidden font strings.
    local function refreshResults()
        if resultsWindow.isShown() then
            resultsWindow.update(results.summary())
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

    ---Only the logged-in character can be scanned, so identity is captured at save time.
    local function currentCharacter()
        return (env.unitName("player") or "?") .. "-" .. (env.realmName() or "?")
    end

    local function captureLockouts()
        store.save(currentCharacter(), scanner.scan())
        window.refresh()
    end

    local router = ns.newSlashRouter({
        onUnknown = function()
            logger.info("usage: /wdp locks | results")
        end,
    })
    router.add("locks", window.toggle)
    router.add("results", function()
        if resultsWindow.isShown() then
            resultsWindow.hide()
        else
            resultsWindow.update(results.summary())
            resultsWindow.show()
        end
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

    -- Zoning is also the signal that an instance visit has begun or ended: start a
    -- fresh tally on the way in, hide the panel on the way out.
    dispatcher.on("PLAYER_ENTERING_WORLD", function()
        env.requestRaidInfo()
        if results.enter(env.instanceType(), env.getMoney()) then
            resultsWindow.update(results.summary())
            resultsWindow.show()
        else
            resultsWindow.hide()
        end
    end)

    dispatcher.on("PLAYER_MONEY", function()
        results.money(env.getMoney())
        refreshResults()
    end)
    dispatcher.on("CHAT_MSG_LOOT", function(message)
        results.loot(message)
        refreshResults()
    end)
    dispatcher.on("TRANSMOG_COLLECTION_SOURCE_ADDED", function(sourceID)
        results.transmogSource(sourceID)
        refreshResults()
    end)
    dispatcher.on("CHAT_MSG_COMBAT_FACTION_CHANGE", function(message)
        results.reputation(message)
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
        results = results,
        resultsWindow = resultsWindow,
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
            instanceType = function()
                local _, instanceType = IsInInstance()
                return instanceType
            end,
            itemSellPrice = function(itemID)
                if not itemID then
                    return nil
                end
                return (select(11, GetItemInfo(itemID)))
            end,
            transmogSourceVisual = function(sourceID)
                local info = C_TransmogCollection.GetSourceInfo(sourceID)
                return info and info.visualID
            end,
            transmogAppearanceSources = function(visualID)
                return C_TransmogCollection.GetAllAppearanceSources(visualID)
            end,
            transmogSourceCollected = function(sourceID)
                local info = C_TransmogCollection.GetSourceInfo(sourceID)
                return info ~= nil and info.isCollected == true
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
