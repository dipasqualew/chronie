local addonName, ns = ...

-- The Key Bindings panel builds its list out of globals: BINDING_HEADER_<header> titles
-- the section and BINDING_NAME_<name> labels the row inside it. Both refer to the tokens
-- in Bindings.xml, and without them the panel shows those raw tokens to the player. They
-- are declared here, at file scope, because the panel reads them whenever it is opened —
-- which may be long before or entirely without the addon having wired itself up.
BINDING_HEADER_CHRONIE = "Chronie"
BINDING_NAME_CHRONIE_CAPTURE = "Take a screenshot"

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
---@field getNumSavedWorldBosses fun(): integer? Absent on clients without world bosses.
---@field getSavedWorldBossInfo fun(index: integer): ... Name, worldBossID, seconds remaining.
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
---@field experienceState fun(): table? `{ level, xp, xpMax }`, or nil at the level cap.
---@field activeKeystone fun(): table? `{ level, mapId, affixes }` for the key in the slot.
---@field keystoneCompletion fun(): table? `{ level, mapId, durationMs, onTime, upgrades }`.
---@field itemSellPrice fun(itemID: integer): integer? Vendor price of one item, in copper.
---@field transmogSourceInfo fun(sourceID: integer): table?
---@field equipmentSets fun(): table<integer, EquipsetState> Every equipment set the character has.
---@field equippedItems fun(): table<integer, EquippedItem> What the character is wearing, by slot.
---@field activeQuestIDs fun(): integer[]
---@field questCompletionInfo fun(questID: integer): table
---@field currencyInfo fun(currencyType: integer): string? Localised name of a currency.
---@field factionState fun(faction: string): FactionStanding? Where the character stands with one
---faction, by its localised name: the level, and how far into it they are.
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
---@field playerGUID fun(): string? UnitGUID("player"), the client's own unique character id.
---@field mapState fun(): MapPosition? Where the player is standing, when the client says.
---@field screenshot fun() Take a screenshot. Asynchronous: the file lands a moment later,
---and the addon can never see it, so nothing may wait on or confirm it.
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
        getNumSavedWorldBosses = env.getNumSavedWorldBosses,
        getSavedWorldBossInfo = env.getSavedWorldBossInfo,
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

    local activityWindow = ns.newDetailWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        name = "ChronieActivityDetailWindow",
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
        factionState = env.factionState,
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

    ---Where one character's last-seen equipment sets are kept.
    ---
    ---Sets belong to a character but SavedVariables are the account's, so the store is
    ---keyed by character: two alts with a set each must not look to the ledger like one
    ---character whose set keeps being replaced. The table is created on first use and then
    ---mutated in place, because the client only persists what is still reachable from the
    ---saved root at logout.
    local function equipsetStore()
        env.db.equipsets = env.db.equipsets or {}
        local character = currentCharacter()
        env.db.equipsets[character] = env.db.equipsets[character] or {}
        return env.db.equipsets[character]
    end

    local equipsetLedger = ns.newEquipsetLedger({
        readSets = env.equipmentSets,
        readEquipped = env.equippedItems,
        -- Indexing through a proxy rather than holding the table: the character is not known
        -- until login, and the ledger is built before it.
        store = setmetatable({}, {
            __index = function(_, key)
                return equipsetStore()[key]
            end,
            __newindex = function(_, key, value)
                equipsetStore()[key] = value
            end,
        }),
        now = env.now,
    })

    ---Files whatever the character's equipment sets have done since the last look.
    ---
    ---The client says only "the sets changed", never which set or how, so the ledger keeps
    ---the last look and subtracts. This runs on the event and again whenever a segment
    ---opens, which is what makes an edit performed in a session where nothing was recorded —
    ---or a set deleted while the addon was not even loaded — still reach the ledger, filed
    ---against the segment the character next plays.
    local function syncEquipsets()
        for _, change in ipairs(equipsetLedger.sync(env.now())) do
            tally.equipsetChange(change)
        end
    end

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
        expansions = expansions,
        experienceState = env.experienceState,
    })

    local accountIdentity = ns.newAccountIdentity({
        db = env.db,
        now = env.now,
        playerGUID = env.playerGUID,
    })

    local entryLog = ns.newEntryLog({
        db = env.db,
        now = env.now,
        formatDate = env.formatDate,
        character = currentCharacter,
        author = accountIdentity.id,
        mapState = env.mapState,
        openSegment = segmentTracker.current,
    })

    ---Takes a Chronie screenshot: what the keybinding in Bindings.xml runs.
    ---
    ---The marker is written first and the shutter fired second, and only if the marker
    ---was actually written. Screenshot() is asynchronous and the addon cannot see the
    ---filesystem at all, so there is nothing to confirm afterwards — the desktop app pairs
    ---the file to the marker by the second in its name. Firing the shutter for an entry
    ---the log refused would leave an image with no marker to claim it, which reads to the
    ---desktop side as a photograph somebody else took.
    ---@return EntryRecord? entry nil when the log refused the press.
    local function capture()
        local entry = entryLog.record({ hasImage = true })
        if not entry then
            return nil
        end
        -- Without this the segment it points at may never be filed: standing somewhere
        -- taking a picture leaves every other counter at rest, and the tracker drops a
        -- segment that saw nothing.
        tally.entry()
        env.screenshot()
        return entry
    end

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

        onActivitySelected = function(row)
            activityWindow.show(details.forActivity(details.descriptorOf(row), store.characters(), store.all()))
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
            logger.info("usage: /chronie locks | results | segments | currency | report | events")
        end,
    })
    ---Names every event this client build refused, so a wrong or since-renamed event name
    ---shows up as a missing feature the player can actually see rather than silence.
    local function reportUnsupportedEvents()
        local missing = dispatcher.unsupported()
        if #missing == 0 then
            return
        end
        logger.info("this client rejected " .. #missing .. " event(s), so the matching "
            .. "tracking is off: " .. table.concat(missing, ", "))
    end

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
    router.add("events", function()
        if #dispatcher.unsupported() == 0 then
            logger.info("this client accepted every event the addon tracks.")
            return
        end
        reportUnsupportedEvents()
    end)
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
        -- Minted here rather than at the first capture, because this is the earliest
        -- moment the client will name the player at all, and an entry authored by nobody
        -- is not something a later release could repair.
        accountIdentity.id()
        reportUnsupportedEvents()
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
        -- After the tracker, never before: a change is filed against the open segment, and
        -- at login there is no open segment until sync() has made one.
        syncEquipsets()
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
    -- A first-time drop is not cached when its loot line arrives, so the tally parked it
    -- unpriced. This is the server answering the price query that parking triggered.
    onTallyEvent("GET_ITEM_INFO_RECEIVED", function(itemID)
        tally.itemInfoReceived(itemID)
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
    onTallyEvent("EQUIPMENT_SETS_CHANGED", syncEquipsets)
    onTallyEvent("CHAT_MSG_COMBAT_FACTION_CHANGE", function(message)
        tally.reputation(message)
    end)
    -- The client hands the signed change straight to the event, so a spend arrives as a
    -- negative and only the localised name has to be looked up. The quantity beside it is
    -- what the character holds now that the change has landed, which is the running total
    -- the panel shows next to the gain.
    onTallyEvent("CURRENCY_DISPLAY_UPDATE", function(currencyType, quantity, change)
        tally.currency(currencyType, change, env.currencyInfo(currencyType), quantity)
    end)
    -- Item-based currencies — vendor tokens, crest-like items and the like — never fire
    -- CURRENCY_DISPLAY_UPDATE; their quantity lives in item counts. Recounting each tracked
    -- item on every batched bag change and folding the difference in tracks both gains and
    -- spends. Because the count spans every storage the character can reach, including the
    -- warband bank, a deposit or withdrawal nets to zero and is never miscounted as either.
    onTallyEvent("BAG_UPDATE_DELAYED", function()
        for _, itemID in ipairs(currencyItems.ids()) do
            tally.currencyItem(itemID, env.ownedItemCount(itemID), env.itemName(itemID))
        end
    end)
    onTallyEvent("ACHIEVEMENT_EARNED", function(id, alreadyEarned)
        tally.achievement(id, env.achievementInfo(id), env.now(), not alreadyEarned)
    end)
    -- The client reports the standing, not the delta, so the tally is handed the whole
    -- state and works the gain out against the baseline it anchored when the segment began.
    local function foldExperience()
        local state = env.experienceState()
        if state then
            tally.experience(state.level, state.xp, state.xpMax)
        end
    end
    onTallyEvent("PLAYER_XP_UPDATE", foldExperience)
    -- A level-up moves the bar as well as the level, and it is folded from inside this one
    -- handler rather than by subscribing twice: the dispatcher keeps a single handler per
    -- event name, so a second subscription would quietly replace the level tracking here.
    onTallyEvent("PLAYER_LEVEL_UP", function(level)
        tally.levelUp(level, env.now())
        foldExperience()
    end)
    -- A boss fight that ended, won or lost. ENCOUNTER_END is the only event that reports
    -- wipes, and a raid night's wipe count is what separates progression from a farm clear.
    onTallyEvent("ENCOUNTER_END", function(id, name, difficultyId, groupSize, success)
        tally.encounter({
            id = id,
            name = name,
            at = env.now(),
            difficultyId = difficultyId,
            groupSize = groupSize,
            -- The client sends 1/0 rather than a boolean here.
            success = success == true or success == 1,
        })
    end)
    -- Neither challenge-mode event carries a payload; both are a signal to go and read the
    -- run's state off the client, which is why the level and the completion arrive through
    -- seams rather than through the handler's arguments.
    onTallyEvent("CHALLENGE_MODE_START", function()
        local keystone = env.activeKeystone()
        if keystone then
            tally.keystoneStart(keystone, env.now())
        end
    end)
    onTallyEvent("CHALLENGE_MODE_COMPLETED", function()
        local completion = env.keystoneCompletion()
        if completion then
            tally.keystoneComplete(completion, env.now())
        end
    end)
    onTallyEvent("CHALLENGE_MODE_RESET", tally.keystoneReset)
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
    --
    -- NOTE: these three names are unconfirmed. The 12.0 API listing spells most housing
    -- events HOUSE_* rather than HOUSING_*, so the client may well reject all three and
    -- leave housing untracked; `/chronie` reports whichever it refused. Registering them is
    -- safe either way now that one rejected event no longer aborts the rest of this wiring.
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
        activityWindow = activityWindow,
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
        accountIdentity = accountIdentity,
        entryLog = entryLog,
        capture = capture,
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
            -- Not every client build exposes the world-boss list; the scanner treats a
            -- missing pair as "this client has no world bosses" rather than erroring.
            getNumSavedWorldBosses = GetNumSavedWorldBosses,
            getSavedWorldBossInfo = GetSavedWorldBossInfo,
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
            -- UnitXPMax reads 0 at the level cap, where "percent of a level" has no meaning
            -- any more. Reporting nil there keeps the tally from dividing by it and from
            -- recording a capped character as having levelled.
            experienceState = function()
                local maximum = UnitXPMax("player") or 0
                if maximum <= 0 then
                    return nil
                end
                return {
                    level = UnitLevel("player"),
                    xp = UnitXP("player") or 0,
                    xpMax = maximum,
                }
            end,
            activeKeystone = function()
                local level, affixes = C_ChallengeMode.GetActiveKeystoneInfo()
                if not level or level <= 0 then
                    return nil
                end
                return {
                    level = level,
                    mapId = C_ChallengeMode.GetActiveChallengeMapID(),
                    affixes = affixes,
                }
            end,
            keystoneCompletion = function()
                local mapId, level, durationMs, onTime, upgrades = C_ChallengeMode.GetCompletionInfo()
                if not level then
                    return nil
                end
                return {
                    level = level,
                    mapId = mapId,
                    durationMs = durationMs,
                    onTime = onTime,
                    upgrades = upgrades,
                }
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
            ---Every equipment set the character has, as ids, names and item-per-slot.
            ---
            ---`GetEquipmentSetInfo` returns its fields positionally and the list has grown
            ---over the years, so only the two leading ones are taken: the name is the first
            ---and the id is the fourth, and a set the call says nothing about is skipped
            ---rather than recorded under a name of nil.
            equipmentSets = function()
                local sets = {}
                for _, setID in ipairs(C_EquipmentSet.GetEquipmentSetIDs() or {}) do
                    local name = C_EquipmentSet.GetEquipmentSetInfo(setID)
                    if name then
                        sets[setID] = {
                            name = name,
                            items = C_EquipmentSet.GetItemIDs(setID) or {},
                        }
                    end
                end
                return sets
            end,
            ---What the character is wearing, slot by slot, with each item's real worth.
            ---
            ---`GetCurrentItemLevel` is asked about the equipped item itself rather than
            ---about its id, which is the whole point: an item's id says what it started as,
            ---and only the item in the slot knows what upgrades, sockets and crafted quality
            ---turned it into. Slots run 1 to 19 — head through tabard — which is every slot
            ---an equipment set can name.
            equippedItems = function()
                local worn = {}
                for slot = 1, 19 do
                    local itemId = GetInventoryItemID("player", slot)
                    if itemId then
                        local location = ItemLocation:CreateFromEquipmentSlot(slot)
                        worn[slot] = {
                            id = itemId,
                            level = C_Item.GetCurrentItemLevel(location),
                            name = C_Item.GetItemNameByID(itemId),
                        }
                    end
                end
                return worn
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
            -- Chat is the only place a reputation gain is announced, and it names the faction
            -- rather than identifying it, so the standing has to be looked up by that name.
            -- Which of the client's reputation systems answers for a faction decides what its
            -- bar means; gathering all of their answers here keeps the choosing in
            -- ns.factionStanding, where it can be tested without a client.
            factionState = function(faction)
                if not faction then
                    return nil
                end
                local data = C_Reputation.GetFactionDataByName(faction)
                if not data then
                    return nil
                end
                local factionID = data.factionID
                local renown, friendship, paragon
                if factionID then
                    if C_Reputation.IsMajorFaction(factionID) then
                        renown = C_MajorFactionData.GetMajorFactionData(factionID)
                    end
                    friendship = C_GossipInfo.GetFriendshipReputation(factionID)
                    if C_Reputation.IsFactionParagon(factionID) then
                        local value, threshold = C_Reputation.GetFactionParagonInfo(factionID)
                        paragon = { value = value, threshold = threshold }
                    end
                end
                return ns.factionStanding({
                    faction = data,
                    renown = renown,
                    friendship = friendship,
                    paragon = paragon,
                    reactionLabel = data.reaction and _G["FACTION_STANDING_LABEL" .. data.reaction] or nil,
                })
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
            playerGUID = function()
                return UnitGUID("player")
            end,
            mapState = function()
                return ns.readMapPosition(C_Map)
            end,
            screenshot = Screenshot,
            -- Every way an item can land in the player's own bags, because each one is
            -- vendor value the segment should count. "You receive loot:" alone misses most
            -- of it: quest rewards, container contents and anything pushed straight to a
            -- bag arrive as "You receive item:", and a bonus roll has its own wording again.
            --
            -- Order matters and is load-bearing. parse() takes the first template that
            -- matches, and the singular "...: %s." pattern also matches a stacked line,
            -- swallowing the "x3" into the item capture and counting the stack as one. Each
            -- _MULTIPLE variant therefore has to be offered before its singular partner.
            lootSelfFormats = templates(
                LOOT_ITEM_SELF_MULTIPLE, LOOT_ITEM_SELF,
                LOOT_ITEM_PUSHED_SELF_MULTIPLE, LOOT_ITEM_PUSHED_SELF,
                LOOT_ITEM_BONUS_ROLL_SELF_MULTIPLE, LOOT_ITEM_BONUS_ROLL_SELF
            ),
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

        -- What the keybinding in Bindings.xml calls. Published only now, so a key pressed
        -- during login runs nothing rather than reaching a half-built addon.
        ChronieCapture = ns.app.capture
    end)
end
