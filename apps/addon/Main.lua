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
---@field after fun(seconds: number, callback: fun()) Runs `callback` once, that many seconds
---from now. The client's own scheduler, and the only clock in here with a resolution finer
---than `now`'s whole second.
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
---@field transmogCustomSets fun(): CustomSetState[] Every transmog set the player saved in game.
---@field playerRace fun(): integer? The client's raceID for the player, out of UnitRace.
---@field playerSex fun(): integer? UnitSex("player"): 1 nobody, 2 male, 3 female.
---@field playerCustomizations fun(): table? Every option the character was made of, as the
---barber's screen enumerates them — and nothing at all anywhere else. See ns.newCharacterLook.
---@field customSetRequests fun(): CustomSetRequest[] What the app left in the addon's own folder.
---@field customSetClient CustomSetClient The four calls that change the player's own wardrobe.
---@field activeQuestIDs fun(): integer[]
---@field questCompletionInfo fun(questID: integer): table
---@field currencyInfo fun(currencyType: integer): string? Localised name of a currency.
---@field factionState fun(faction: string): FactionStanding? Where the character stands with one
---faction, by its localised name: the level, and how far into it they are.
---@field heldSweep fun(): HeldSweep Everything the character is holding, read off the client's
---currency and reputation panes rather than out of what the addon watched it earn.
---@field ownedItemCount fun(itemID: integer): integer Grand total owned across bags and every bank,
---the warband bank included, so internal transfers leave it unchanged.
---@field getCursorItem fun(): (integer?, string?) Item held on the cursor: id and name, or nil.
---@field clearCursor fun() Release whatever the cursor is holding.
---@field achievementInfo fun(id: integer): string? Localised name of an achievement.
---@field mountInfo fun(id: integer): string? Localised name of a mount.
---@field petInfo fun(guid: string): (integer?, string?, integer?) Species ID, name, owned count.
---@field toyInfo fun(id: integer): string? Localised name of a toy.
---@field housingItemInfo fun(id: integer): (string?, integer?) Localised name and warband-owned count.
---@field openAchievement fun(id: integer)
---@field previewTransmog fun(itemID: integer)
---@field openTransmogCollection fun(sourceID: integer)
---@field itemName fun(itemID: integer): string?
---@field playerGUID fun(): string? UnitGUID("player"), the client's own unique character id.
---@field mapState fun(): MapPosition? Where the player is standing, when the client says.
---@field screenshot fun() Take a screenshot. Asynchronous: the file lands a moment later,
---and the addon can never see it, so nothing may wait on or confirm it. What says it
---landed is SCREENSHOT_SUCCEEDED, which the client fires for the player's own screenshot
---key just the same — see ns.newScreenshotWatch for how the two are told apart.
---@field loggingCombat fun(enable: boolean?): boolean Client LoggingCombat: starts or stops
---combat logging when passed a value, and reports the current state either way.
---@field getCVar fun(name: string): string? Reads a client setting.
---@field setCVar fun(name: string, value: string): any Writes one. Protected settings ignore
---this or raise, which is why nothing may assume the write took.
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

    ---Only the logged-in character can be scanned, so identity is captured at save time.
    local function currentCharacter()
        return (env.unitName("player") or "?") .. "-" .. (env.realmName() or "?")
    end

    -- Account-wide, and read by the panel while a segment is still running, so it is built
    -- before the window that asks it questions.
    local holdings = ns.newHoldingsStore({ db = env.db, now = env.now })

    ---Reads the warband bank's balance into the account's holdings.
    ---
    ---A client build with no warband bank hands back nil, which the store leaves standing
    ---rather than writing down as a balance of zero.
    local function readWarbandGold()
        holdings.recordWarband(env.warbandMoney and env.warbandMoney())
    end

    ---Files everything the character is holding, rather than only what it was watched
    ---earning.
    ---
    ---A segment only ever knows about a currency the client announced a change to and a
    ---faction it announced a gain with, so on its own the snapshot starts as holes and
    ---fills in one currency per character over weeks of play. This walks the client's own
    ---panes instead and hands the lot to the same `record` a finished segment goes through
    ---— nothing downstream can tell the two apart, and nothing downstream needs to.
    ---
    ---It only ever adds: a pane the client will not answer for leaves whatever was last
    ---written standing rather than clearing it.
    local function sweepHoldings()
        if not env.heldSweep then
            return
        end
        holdings.record(currentCharacter(), env.heldSweep())
    end

    -- Declared before the panel and filled in after the log and the tracker they read from,
    -- because the panel is built first and its picker has to reach them.
    ---@type SegmentViews
    local segmentViews
    ---Draws whichever view was picked off the panel's own list.
    local renderResults
    local resultsWindow

    resultsWindow = ns.newResultsWindow({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        name = "ChronieResultsWindow",
        views = function()
            return segmentViews.list()
        end,
        select = function(key)
            segmentViews.select(key)
            renderResults()
        end,
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
        now = env.now,
        character = currentCharacter,
        accountStanding = holdings.standing,
        accountCurrency = holdings.currency,
        tooltip = env.tooltip,
    })

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

    ---Where one character's last-seen transmog sets are kept.
    ---
    ---Keyed by character for the same reason the equipment sets above are, and with one extra
    ---reason of its own: the sets themselves are the account's, but *whether Chronie has ever
    ---looked* is a fact about a character, and an unkeyed snapshot would let the last alt to
    ---log out speak for every one of them. Keyed, a character that has never been played since
    ---Chronie was installed simply says nothing, which is the truth.
    local function customSetStore()
        env.db.customSets = env.db.customSets or {}
        local character = currentCharacter()
        env.db.customSets[character] = env.db.customSets[character] or {}
        return env.db.customSets[character]
    end

    local customSetSnapshot = ns.newCustomSetSnapshot({
        readSets = env.transmogCustomSets,
        -- The same proxy the equipment sets use, and for the same reason: the character is not
        -- known until login and this is built before it.
        store = setmetatable({}, {
            __index = function(_, key)
                return customSetStore()[key]
            end,
            __newindex = function(_, key, value)
                customSetStore()[key] = value
            end,
        }),
        now = env.now,
    })

    ---Files what the player's own transmog sets look like now.
    ---
    ---Unlike the equipment sets beside it this reports nothing and is watched by nobody: the
    ---snapshot is for the app to read out of SavedVariables at logout, not for the panel to
    ---show. Nothing in game needs telling — the player is looking at their own wardrobe.
    local function syncCustomSets()
        customSetSnapshot.sync(env.now())
    end

    ---Where one character's last-seen appearance is kept.
    ---
    ---Keyed by character because this is the one thing in the file that genuinely is a
    ---character's own rather than the account's: the sets above belong to the account and are
    ---keyed only so that "has Chronie looked" stays a fact about a character, while a race and
    ---a hairstyle belong to the one person wearing them.
    local function characterLookStore()
        env.db.characterLook = env.db.characterLook or {}
        local character = currentCharacter()
        env.db.characterLook[character] = env.db.characterLook[character] or {}
        return env.db.characterLook[character]
    end

    local characterLook = ns.newCharacterLook({
        readRace = env.playerRace,
        readSex = env.playerSex,
        readChoices = env.playerCustomizations,
        -- The same proxy the two above use, and for the same reason: the character is not known
        -- until login and this is built before it.
        store = setmetatable({}, {
            __index = function(_, key)
                return characterLookStore()[key]
            end,
            __newindex = function(_, key, value)
                characterLookStore()[key] = value
            end,
        }),
        now = env.now,
    })

    ---Files who the character is, so the app can draw the reader's own alts rather than a
    ---stranger.
    ---
    ---Reports nothing and is watched by nobody, the same as the wardrobe snapshot: this is for
    ---the app to read out of SavedVariables, and the player is already looking at themselves.
    local function syncCharacterLook()
        characterLook.sync(env.now())
    end

    ---Where the record of what the app has already asked for is kept.
    ---
    ---Account-wide rather than per character, unlike the snapshot above, because the thing it
    ---is a record of is account-wide: a custom set belongs to the account, so a request carried
    ---out on one character has been carried out for all of them. Keyed by character it would be
    ---done once per alt, and the player would find the same outfit saved over their wardrobe
    ---every time they logged a new one in.
    local function customSetRequestStore()
        env.db.customSetRequests = env.db.customSetRequests or {}
        return env.db.customSetRequests
    end

    local customSetWriter = ns.newCustomSetWriter({
        readRequests = env.customSetRequests,
        readSets = env.transmogCustomSets,
        client = env.customSetClient,
        store = setmetatable({}, {
            __index = function(_, key)
                return customSetRequestStore()[key]
            end,
            __newindex = function(_, key, value)
                customSetRequestStore()[key] = value
            end,
        }),
        now = env.now,
    })

    ---Carries out whatever the app left in the addon's own folder, and says so.
    ---
    ---Out loud, because this is the one thing Chronie does that changes something in the game
    ---rather than writing something down about it. A player whose wardrobe gained a set should
    ---be told which, by name, in the moment it happened — finding it later and wondering is
    ---exactly the experience an app writing to somebody's account has to avoid.
    local function applyCustomSetRequests()
        for _, outcome in ipairs(customSetWriter.run(env.now())) do
            logger.info(ns.customSetOutcomeText(outcome))
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
        holdings = holdings,
    })

    -- What the panel can be pointed at: the session's total, the segment being played, and
    -- every segment already finished this session. The default is the open segment, which is
    -- what it showed before there was anything else to show.
    segmentViews = ns.newSegmentViews({
        liveSummary = tally.summary,
        liveLocation = function()
            local open = segmentTracker.current()
            return open and open.instance
        end,
        liveStart = function()
            local open = segmentTracker.current()
            return open and open.startedAt
        end,
        segments = segmentLog.all,
        character = currentCharacter,
        now = env.now,
    })

    function renderResults()
        local view = segmentViews.selected()
        resultsWindow.update(view.summary, view)
    end

    local accountIdentity = ns.newAccountIdentity({
        db = env.db,
        now = env.now,
        playerGUID = env.playerGUID,
    })

    -- ns.settings is what the desktop app wrote into this installed copy; the bundle's own
    -- src/Settings.lua is the defaults for a copy nothing has configured.
    local combatLogging = ns.newCombatLogging({
        settings = ns.settings,
        loggingCombat = env.loggingCombat,
        getCVar = env.getCVar,
        setCVar = env.setCVar,
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

    -- The offer to say something about what was just captured, and the toast that carries
    -- it. Wired to each other in both directions and declared in this order because of it:
    -- the prompt shows and hides the toast, the toast reports what the player did to the
    -- prompt. The toast is reached through an upvalue rather than being built first,
    -- because the prompt is the half with the rules and nothing should be tempted to give
    -- the frame any.
    local entryToast
    local entryPrompt = ns.newEntryPrompt({
        now = env.now,
        attach = entryLog.annotate,
        onShow = function(entry)
            entryToast.show(entry)
        end,
        onHide = function(entry, annotated)
            entryToast.hide()
            -- A memory is its text, and nothing else: an entry with no picture and nothing
            -- said is a record of nothing, so what survives somebody opening the box and
            -- thinking better of it is nothing rather than an empty tile in the gallery. A
            -- photograph is the opposite — the picture is the record, and the sentence about
            -- it was only ever an offer — so this asks which of the two it was.
            if not annotated and not entry.hasImage then
                entryLog.discard(entry)
            end
        end,
    })

    entryToast = ns.newEntryToast({
        createFrame = env.createFrame,
        uiParent = env.uiParent,
        specialFrames = env.specialFrames,
        onEngage = entryPrompt.engage,
        onSubmit = entryPrompt.submit,
        onDismiss = entryPrompt.dismiss,
        onRelease = entryPrompt.release,
        tick = entryPrompt.tick,
    })

    -- ns.settings again: which things are worth a photograph is the player's list, not
    -- Chronie's, and it reaches the addon down the same channel combat logging does.
    local captureTriggers = ns.newCaptureTriggers({
        triggers = ns.settings.captureTriggers,
        now = env.now,
    })

    -- Which of the screenshots the client reports are Chronie's own. Everything else is one
    -- the player took with the client's own screenshot key, which is the whole reason the
    -- addon listens: see the SCREENSHOT_SUCCEEDED handler below.
    local screenshotWatch = ns.newScreenshotWatch({ now = env.now })

    ---Takes a Chronie screenshot: the shutter the addon presses for itself.
    ---
    ---The marker is written first and the shutter fired second, and only if the marker
    ---was actually written. Screenshot() is asynchronous and the addon cannot see the
    ---filesystem at all, so there is nothing to confirm afterwards — the desktop app pairs
    ---the file to the marker by the second in its name. Firing the shutter for an entry
    ---the log refused would leave an image with no marker to claim it, which reads to the
    ---desktop side as a photograph somebody else took.
    ---@param options EntryOptions? What fired it, when something other than a person did.
    ---@return EntryRecord? entry nil when the log refused it.
    local function capture(options)
        options = options or {}
        options.hasImage = true
        local entry = entryLog.record(options)
        if not entry then
            return nil
        end
        -- Without this the segment it points at may never be filed: standing somewhere
        -- taking a picture leaves every other counter at rest, and the tracker drops a
        -- segment that saw nothing.
        tally.entry()
        -- Claimed before the shutter, never after: the event can be back before the next
        -- line of this function runs, and an unclaimed success is recorded as the player's.
        screenshotWatch.fired()
        env.screenshot()
        -- Offered for every capture, the automatic ones included: a picture Chronie took
        -- by itself is exactly the kind that wants a sentence saying why it was worth
        -- taking. The offer is passive and expires on its own, so a player who is busy
        -- does nothing and loses nothing.
        entryPrompt.offer(entry)
        return entry
    end

    ---Marks a moment with nothing but what somebody had to say about it.
    ---
    ---The same record a photograph makes with the picture left out, written by the same log
    ---and offered by the same prompt: a memory is `capture` without the shutter. That is the
    ---whole design and it is worth being explicit about, because the alternative — a second
    ---capture path, a second prompt and a second store for text-without-an-image — is two of
    ---everything to keep in step, which is the drift `ns.segmentSchema` exists to prevent for
    ---event lists.
    ---
    ---Two ways in, and they differ only in where the sentence comes from. Given text, the
    ---memory is complete the moment it is written and no toast appears; given nothing, the
    ---entry is filed against this instant and the prompt offers the box, which is what makes
    ---`/chronie note` usable while the thing worth remembering is still happening.
    ---
    ---The moment, the map and the segment are stamped when this is called rather than when
    ---the sentence is finished, and that is the point of filing first: the entry belongs to
    ---where the player was standing when they decided to write it, not to wherever they
    ---happen to be twenty seconds later.
    ---@param text string? What the player already typed, when they typed it up front.
    ---@return EntryRecord? entry nil when nothing was written down.
    local function remember(text)
        local note = ns.entryText(text)

        local entry = entryLog.record()
        if not entry then
            return nil
        end
        -- The same reason a capture does this: an evening spent standing somewhere writing
        -- notes leaves every other counter at rest, and the tracker drops a segment that saw
        -- nothing — taking the segment the memory links to down with it.
        --
        -- Counted now rather than once the memory is known to have survived, and the entry
        -- discarded below does not give it back. That is the lesser of the two wrongs on offer.
        -- The tally credits whichever segment is open when it is called, and by the time a
        -- memory is abandoned the player may have moved on — so counting it late would either
        -- credit the wrong segment or, if the original has been flushed and dropped in the
        -- meantime, leave a surviving memory pointing at a segment that was never filed. A
        -- segment filed thin because somebody began a note and thought better of it is a fair
        -- description of the evening; a memory linked to nothing is a broken row.
        tally.entry()

        if note then
            entryLog.annotate(entry, note)
            return entry
        end

        -- Refused because somebody is mid-sentence on an earlier entry. There is no box to
        -- put this one in and no text to keep it alive, so it goes back out again rather than
        -- sitting in the file forever as a memory of nothing.
        if not entryPrompt.offer(entry) then
            entryLog.discard(entry)
            return nil
        end
        -- Opened focused, which nothing else in the addon does. The rule the toast is built
        -- around is that it never takes keyboard focus *on its own*, because a box that
        -- focuses itself behind a screenshot swallows every keybind the player has mid-pull.
        -- Asking for a memory by name is the deliberate act that rule makes room for: there
        -- is no picture here, the box is the entire reason the command was typed, and the
        -- player's hands were already in a chat box a moment ago. Making them go and find the
        -- toast to click it would be a worse feature, not a safer one.
        entryToast.engage()
        return entry
    end

    ---One photograph per moment, taken once the moment has finished announcing itself.
    ---
    ---The limiter is started only once a capture has actually happened. The entry log has
    ---refusals of its own — a press in the same second, a world that has not finished
    ---loading — and spending a minute of silence on a picture that was never taken would
    ---lose the next thing that was genuinely worth one.
    local captureBurst = ns.newCaptureBurst({
        after = env.after,
        capture = function(decision)
            -- Asked again rather than trusted from when the decision was made. Half a
            -- second is long enough for the world to have gone away — a keystone that ends
            -- on time completes the run and then drops a loading screen over the teleport
            -- out — and the picture that comes back from behind one is a black rectangle.
            -- Nothing is queued for later: the moment has gone, and the limiter is left
            -- untouched so the next real one is not silenced by a shot never taken.
            if not captureTriggers.visible() then
                return
            end
            local entry = capture({ trigger = decision.trigger, achievement = decision.achievement })
            if entry then
                captureTriggers.taken()
            end
        end,
    })

    ---Offers something worth remembering to the burst, if the player's rules say it is one.
    ---
    ---Everything that can be settled at the instant the event fired is settled here, while
    ---it is still true: the allowlist, the rate limit and whether the world was on screen.
    ---What the burst is left holding is a decision that was good when it was made, and all
    ---it adds is which one of them the moment gets photographed for.
    ---@param event CaptureEvent
    local function autoCapture(event)
        local decision = captureTriggers.consider(event)
        if decision then
            captureBurst.offer(decision)
        end
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
            renderResults()
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
            logger.info("usage: /chronie locks | results | segments | currency | report | log "
                .. "| events | note [text]")
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
            renderResults()
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
    -- The one way into a memory, and a slash command rather than a key on purpose. Chronie
    -- binds none (see the note at the foot of chronie.toc), and the chat box is somewhere a
    -- player can already type a sentence without a frame of Chronie's having to steal focus
    -- to let them — which is the failure the whole prompt was specified around.
    --
    -- `/chronie note` on its own is the same offer a screenshot gets: the moment is filed now
    -- and the toast waits to be clicked. `/chronie note <text>` is the impatient form, done
    -- in one line. Neither says anything back on success, because the toast or the memory
    -- itself is the acknowledgement; the only thing worth a word is having written nothing.
    router.add("note", function(argument)
        if not remember(argument) then
            logger.info("nothing was written down — try /chronie note <what happened>.")
        end
    end)
    -- Asks the client rather than repeating what login decided, so this stays true after
    -- somebody has changed either switch by hand since.
    router.add("log", function()
        logger.info(combatLogging.describe(combatLogging.state()))
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
        -- Once at login, so a character that plays without ever opening a bank still leaves
        -- the pot's balance behind it. ACCOUNT_MONEY keeps it current from here.
        readWarbandGold()
        -- Minted here rather than at the first capture, because this is the earliest
        -- moment the client will name the player at all, and an entry authored by nobody
        -- is not something a later release could repair.
        accountIdentity.id()
        -- Logging does not survive a session: whatever was on last time is off again now,
        -- so the setting has to be re-asserted at every login rather than once ever. Said
        -- out loud only when it was asked for, because a player who has not turned it on
        -- does not need a line about it every time they log in.
        local logging = combatLogging.apply()
        if logging.requested then
            logger.info(combatLogging.describe(logging))
        end
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
        -- Belt and braces on the loading screen. LOADING_SCREEN_DISABLED is the event that
        -- says it has lifted, but a flag left stuck up would silence automatic capture for
        -- the rest of the session, and this fires on the far side of every load screen
        -- there is.
        captureTriggers.obscured("loading", false)
        env.requestRaidInfo()
        snapshotActiveQuests()
        segmentTracker.sync()
        -- After the tracker, never before: a change is filed against the open segment, and
        -- at login there is no open segment until sync() has made one.
        syncEquipsets()
        -- Read here rather than at PLAYER_LOGIN, which is the earliest the character can be
        -- named but not the earliest the panes are populated: a currency list the server has
        -- not sent yet reads as empty, and an empty read at login would be indistinguishable
        -- from a character that genuinely holds nothing. This fires on the far side of every
        -- loading screen there is, login included, and again at every zone boundary, which
        -- costs a walk of two short lists and keeps the snapshot current through the session
        -- rather than only at its ends.
        sweepHoldings()
        -- Beside the sweep and for its reason: the wardrobe the server sends at login has
        -- often not arrived by PLAYER_LOGIN, and reading it here means the far side of every
        -- load screen rather than one moment that may be too early. The event above keeps it
        -- current in between, so this is only ever catching up on what happened out of sight.
        syncCustomSets()
        -- Beside it, and reading the half of a look that is readable anywhere: the race and the
        -- sex, which are what say which body the app draws this character on. The other half
        -- needs the barber's chair and is picked up by the events below.
        syncCharacterLook()
        -- After the read and never before it: the writer decides create-or-replace by looking
        -- at what the account already has, and a stale list would make a second copy of a set
        -- the player already owns.
        applyCustomSetRequests()
        renderResults()
        resultsWindow.show()
    end
    dispatcher.on("PLAYER_ENTERING_WORLD", syncSegment)
    dispatcher.on("ZONE_CHANGED_NEW_AREA", syncSegment)

    -- The event covers every change the player makes while Chronie is watching. The read
    -- inside syncSegment covers the ones it was not: a set saved on another character, or
    -- before the addon was ever installed.
    dispatcher.on("TRANSMOG_CUSTOM_SETS_CHANGED", syncCustomSets)

    -- The barber's chair, which is the only place in the game a character will say what they
    -- are made of. Both moments are worth a look: the screen opening is when the client will
    -- answer for a character who has never been read, and an appearance being applied is the
    -- one moment the answer changes. Everywhere else the read comes back empty and the last
    -- one stands — see ns.newCharacterLook.
    dispatcher.on("BARBER_SHOP_OPEN", syncCharacterLook)
    dispatcher.on("BARBER_SHOP_APPEARANCE_APPLIED", syncCharacterLook)

    -- What is between the player and the world. Events fire happily during a load screen
    -- and a cinematic, and the picture that comes back from either is worth nothing, so an
    -- automatic capture is dropped rather than taken while one of these is up. Tracked by
    -- name because they overlap — a cinematic that ends in a load screen is one continuous
    -- stretch of not being able to see anything.
    --
    -- The event that lifts an obstruction is subscribed first and the one that raises it
    -- only if that worked. On a client build that defines one of a pair and not the other,
    -- an obstruction that can go up and never come down would silence automatic capture for
    -- the rest of the session, which is a far worse failure than not suppressing at all.
    for _, obstruction in ipairs({
        { reason = "loading", up = "LOADING_SCREEN_ENABLED", down = "LOADING_SCREEN_DISABLED" },
        { reason = "cinematic", up = "CINEMATIC_START", down = "CINEMATIC_STOP" },
    }) do
        local reason = obstruction.reason
        local lifts = dispatcher.on(obstruction.down, function()
            captureTriggers.obscured(reason, false)
        end)
        if lifts then
            dispatcher.on(obstruction.up, function()
                captureTriggers.obscured(reason, true)
            end)
        end
    end

    -- The player photographing something themselves, with the client's own screenshot key.
    --
    -- This is how a picture the player took becomes a Chronie entry, and it is why the
    -- addon has no capture key of its own: every player already has one bound, it works
    -- while both hands are busy, and the client tells anyone listening that it fired. The
    -- entry is written when the file lands rather than when the key went down, which is the
    -- closest the addon can stand to the moment the client stamped the filename it will be
    -- paired with.
    --
    -- Nothing here asks whether the world was on screen. That question belongs to the
    -- automatic triggers, which decide for themselves and can be wrong about a black
    -- rectangle nobody wanted; a player pressing the key during a cinematic means it.
    dispatcher.on("SCREENSHOT_SUCCEEDED", function()
        if screenshotWatch.claim() then
            -- One of Chronie's own, which already has its marker and its offer. Recording
            -- it again here is the double entry this watch exists to prevent.
            return
        end
        local entry = entryLog.record({ hasImage = true })
        if not entry then
            return
        end
        -- The same two things a capture Chronie asked for gets, and for the same reasons:
        -- the segment has to survive being an evening where nothing else happened, and the
        -- sentence about a picture is worth most in the seconds after it was taken.
        tally.entry()
        entryPrompt.offer(entry)
    end)

    -- A shot that never landed: the disk is full, or the client gave up on it. There is
    -- nothing to record, and the only thing that matters is letting the claim go, so the
    -- player's next screenshot is judged on its own rather than mistaken for this one.
    dispatcher.on("SCREENSHOT_FAILED", function()
        screenshotWatch.claim()
    end)

    -- Logging out or reloading is the last chance to file a segment: SavedVariables are
    -- only written to disk on the way out, so an unfiled segment would never be exported.
    -- The warband pot is re-read on the way past for the same reason — this is the freshest
    -- moment there is, and the number the file carries is the one every other character's
    -- rollup will read until one of them logs in again.
    dispatcher.on("PLAYER_LOGOUT", function()
        readWarbandGold()
        segmentTracker.flush()
        -- After the flush, so the walk's complete reading is the one left standing where the
        -- two overlap. This is the freshest the snapshot will ever be — whatever it says here
        -- is what every other character's rollup reads until this one is played again.
        sweepHoldings()
        -- And the last chance for an offer to resolve, which matters for exactly one shape of
        -- entry. An engaged prompt has no deadline — the clock is not paused, it is gone — so a
        -- memory whose box still holds focus is a row with no note that nothing will ever come
        -- back to expire. Left alone it is written to disk as a memory of nothing. Nobody loses
        -- anything to this: text that was never submitted was never a note, and a photograph is
        -- a record with or without one.
        entryPrompt.dismiss()
    end)

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
    -- The warband pot changing under any of the account's characters. It carries no arguments
    -- — the balance has to be gone and read — and the read inside the handler is already the
    -- new one, which is what lets this be treated as PLAYER_MONEY's opposite number.
    onTallyEvent("ACCOUNT_MONEY", readWarbandGold)
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
            -- From inside the tally's own handler, the way the achievement is, so the thing
            -- that counts and the thing that photographs cannot drift apart.
            autoCapture({
                kind = "transmog",
                id = info.itemID,
                newAppearance = info.newAppearance,
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
        local accountFirst = not alreadyEarned
        tally.achievement(id, env.achievementInfo(id), env.now(), accountFirst)
        -- Fired from inside the handler the tally already has, rather than from a second
        -- subscription to the same event: two listeners for one event is how the thing that
        -- counts and the thing that photographs drift apart. Deliberately not delayed — the
        -- toast on screen is part of the memory, not something to race.
        autoCapture({ kind = "achievement", id = id, accountFirst = accountFirst })
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
        autoCapture({ kind = "levelUp", id = level })
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
            autoCapture({ kind = "keystone", id = completion.mapId, onTime = completion.onTime })
        end
    end)
    onTallyEvent("CHALLENGE_MODE_RESET", tally.keystoneReset)
    onTallyEvent("NEW_MOUNT_ADDED", function(id)
        tally.mount(id, env.mountInfo(id), env.now())
        autoCapture({ kind = "mount", id = id })
    end)
    -- A battle pet is the one collectible the game lets a player own several of, so the
    -- owned count decides first-of-its-species from duplicate the way it does for housing
    -- decor. A client that would not say leaves the flag off rather than claiming either.
    onTallyEvent("NEW_PET_ADDED", function(guid)
        local speciesID, name, owned = env.petInfo(guid)
        local speciesFirst
        if owned then
            speciesFirst = owned <= 1
        end
        tally.pet(speciesID, name, env.now(), guid, speciesFirst)
        autoCapture({ kind = "pet", id = speciesID })
    end)
    onTallyEvent("NEW_TOY_ADDED", function(id)
        tally.toy(id, env.toyInfo(id), env.now())
        autoCapture({ kind = "toy", id = id })
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
        holdings = holdings,
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
        combatLogging = combatLogging,
        capture = capture,
        remember = remember,
        captureTriggers = captureTriggers,
        screenshotWatch = screenshotWatch,
        entryPrompt = entryPrompt,
        entryToast = entryToast,
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

        ---The four namespaces a standing has to be assembled out of, in the bag the pure
        ---readers take them in. A fresh table each call, because the sweep adds the
        ---currency pane to its own copy and nothing else should inherit it.
        ---@return table
        local function reputationClients()
            return {
                reputation = C_Reputation,
                majorFaction = C_MajorFactionData,
                gossip = C_GossipInfo,
                reactionLabel = function(reaction)
                    return _G["FACTION_STANDING_LABEL" .. reaction]
                end,
            }
        end

        ns.app = ns.main({
            createFrame = CreateFrame,
            print = print,
            unitName = UnitName,
            unitClass = UnitClass,
            unitLevel = UnitLevel,
            realmName = GetRealmName,
            now = time,
            -- Wrapped rather than handed over as a bare reference, so the seam is a plain
            -- two-argument function a fake can be written against without knowing that the
            -- client spells it on a namespace table.
            after = function(seconds, callback)
                C_Timer.After(seconds, callback)
            end,
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
            -- The warband bank's own gold. Read on build 12.0.5.67823 as answering anywhere,
            -- with no banker and no bank frame in sight — `C_Bank.CanViewBank` reads false at
            -- the very moment this returns the real balance, so the read is deliberately not
            -- gated on it. Guarded instead on the API existing at all, because a client build
            -- without warband banks has no C_Bank and calling into one raises.
            warbandMoney = function()
                if not C_Bank or not C_Bank.FetchDepositedMoney then
                    return nil
                end
                local accountBank = Enum and Enum.BankType and Enum.BankType.Account
                if not accountBank then
                    return nil
                end
                local ok, amount = pcall(C_Bank.FetchDepositedMoney, accountBank)
                if not ok then
                    return nil
                end
                return amount
            end,
            -- Both calls, because GetInstanceInfo alone names the continent out in the open
            -- world. ns.readLocation decides which answer a segment is filed under.
            instanceInfo = function()
                return ns.readLocation({
                    getInstanceInfo = GetInstanceInfo,
                    getRealZoneText = GetRealZoneText,
                })
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
            ---Every transmog set the player saved in game, and the appearances in each.
            ---
            ---Three calls per set, because the client hands back ids and nothing else:
            ---`GetCustomSets` names them, `GetCustomSetInfo` says what one is called and what
            ---picture it wears, and `GetCustomSetItemTransmogInfoList` says what is in it.
            ---Both of the latter are documented as possibly returning nothing, so both are
            ---allowed to; a set that will not describe itself is still recorded under its id,
            ---because the id is what the app matches on and a set the player can see in their
            ---own wardrobe should not vanish from the list for being shy.
            ---
            ---The appearance list is walked with `ipairs` — Blizzard's own WardrobeCustomSets
            ---does the same — and so is indexed from one, while every other part of the client
            ---numbers these slots from zero as `TransmogSlot`. The index less one is therefore
            ---what gets written down, so that "11" means the main hand here exactly as it does
            ---everywhere else.
            ---
            ---Guarded on the namespace because custom sets arrived with Midnight. On an older
            ---client this reports no sets rather than raising, which leaves the app showing a
            ---player nothing instead of showing them an error about a feature their game has
            ---not got.
            transmogCustomSets = function()
                local collection = C_TransmogCollection
                if not (collection and collection.GetCustomSets) then
                    return {}
                end
                local sets = {}
                for _, setID in ipairs(collection.GetCustomSets() or {}) do
                    local name, icon = collection.GetCustomSetInfo(setID)
                    local slots = {}
                    for index, info in ipairs(collection.GetCustomSetItemTransmogInfoList(setID) or {}) do
                        slots[#slots + 1] = {
                            slot = index - 1,
                            appearance = info.appearanceID,
                            secondary = info.secondaryAppearanceID,
                            illusion = info.illusionID,
                        }
                    end
                    sets[#sets + 1] = { id = setID, name = name, icon = icon, slots = slots }
                end
                return sets
            end,
            ---Which race the player is, as the client numbers races.
            ---
            ---The third return and not the first: the first is the localised name, which is a
            ---different string on a German client and is not something to key a body on.
            playerRace = function()
                return select(3, UnitRace("player"))
            end,
            ---And which sex, in the client's own numbering rather than the tables': `UnitSex`
            ---answers 1 for a unit that has none, 2 male and 3 female, while every DB2 column
            ---with an opinion writes 0 male and 1 female. The client's number is what gets
            ---written down, because translating it here would be this addon claiming to know
            ---what a table it never opens says — the app does that translation, next to the
            ---table it does it for.
            playerSex = function()
                return UnitSex("player")
            end,
            ---Every option the character was made of, as the barber's own screen enumerates
            ---them: categories, each holding options, each naming which of its choices is the
            ---one on the character.
            ---
            ---**This answers nothing anywhere except the barber's chair**, which is not a
            ---limitation of this function but of the game — read off the 12.0.5 client's own
            ---`C_BarberShop` function table, where `GetAvailableCustomizations` is the only
            ---call that will enumerate a character's own customization at all. So the addon
            ---takes it when it is offered and keeps the last answer the rest of the time.
            ---
            ---Guarded on the namespace, which is how everything else in here treats a client
            ---API: a build without it reports nothing rather than raising, and nothing is
            ---already the ordinary answer.
            playerCustomizations = function()
                local barber = C_BarberShop
                if not (barber and barber.GetAvailableCustomizations) then
                    return nil
                end
                return barber.GetAvailableCustomizations()
            end,
            ---What the desktop app has asked the game to hold on to.
            ---
            ---Read out of `src/CustomSetRequests.lua`, which the app writes and the client
            ---never does — see that file for why it is not SavedVariables. A hand-installed
            ---addon has the shipped copy, which asks for nothing.
            customSetRequests = function()
                local asked = ns.customSetRequests
                return type(asked) == "table" and asked.requests or {}
            end,
            ---The four calls that change the player's own transmog sets.
            ---
            ---The only writes Chronie makes into a WoW account. All four are ordinary
            ---collection calls: unprotected, free, and needing no transmogrifier, which is the
            ---one fact the whole two-way sync rests on — see `docs/transmog-sets.md`, where it
            ---was read out of the client's own API documentation rather than assumed.
            ---
            ---Guarded on the namespace the way the reader beside it is. On a client without
            ---custom sets the writer is handed calls that do nothing and report nothing, which
            ---comes out as "could not save" rather than as an error in the player's face.
            customSetClient = {
                create = function(name, icon, list)
                    local collection = C_TransmogCollection
                    if not (collection and collection.NewCustomSet) then
                        return nil
                    end
                    return collection.NewCustomSet(name, icon, list)
                end,
                modify = function(setID, list)
                    local collection = C_TransmogCollection
                    if collection and collection.ModifyCustomSet then
                        collection.ModifyCustomSet(setID, list)
                    end
                end,
                maxSets = function()
                    local collection = C_TransmogCollection
                    if not (collection and collection.GetNumMaxCustomSets) then
                        return nil
                    end
                    return collection.GetNumMaxCustomSets()
                end,
                validName = function(name)
                    local collection = C_TransmogCollection
                    if not (collection and collection.IsValidCustomSetName) then
                        return nil
                    end
                    return collection.IsValidCustomSetName(name)
                end,
            },
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
            -- Three namespaces answer that question and ns.readFactionState knows which to
            -- believe; all this does is hand it the client tables to ask.
            factionState = function(faction)
                return ns.readFactionState(reputationClients(), faction)
            end,
            -- The same tables, plus the currency pane, asked to name everything rather than
            -- one thing. This is what makes an account total the account's: a character is
            -- otherwise only ever recorded holding what it was watched earning.
            heldSweep = function()
                local clients = reputationClients()
                clients.currency = C_CurrencyInfo
                return ns.readHoldings(clients)
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
                if not speciesID then
                    return nil, name
                end
                -- The event has already landed by the time this runs, so the pet being
                -- announced is inside the count: one means it is the first of its species,
                -- more means another of something already owned.
                local owned = C_PetJournal.GetNumCollectedInfo(speciesID)
                return speciesID, name, owned
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
            loggingCombat = LoggingCombat,
            -- C_CVar is the modern home of both; the bare globals are still defined and are
            -- what older clients have, so each is taken from whichever this build offers.
            getCVar = C_CVar and C_CVar.GetCVar or GetCVar,
            setCVar = C_CVar and C_CVar.SetCVar or SetCVar,
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
    end)
end
