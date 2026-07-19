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
---@field registerSlash fun(tokens: string[], handler: fun(text: string))
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

    local details = ns.newLockoutDetails({ now = env.now, lockoutTable = lockoutTable })

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

    local window = ns.newLockoutWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        getRows = store.all,
        lockoutTable = lockoutTable,
        onRefreshRequested = env.requestRaidInfo,
        tooltip = env.tooltip,

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
            logger.info("usage: /wdp locks")
        end,
    })
    router.add("locks", window.toggle)

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
    dispatcher.on("PLAYER_ENTERING_WORLD", env.requestRaidInfo)

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
            registerSlash = registerSlash,
            uiParent = UIParent,
            specialFrames = UISpecialFrames,
            tooltip = GameTooltip,
            db = WdpWowDB,
        })
    end)
end
