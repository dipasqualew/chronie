---Hand-written fakes for the slice of the WoW API the addon depends on.
---These are injected through the same seams the game uses (WowEnv /
---EventDispatcherDeps), so no monkey patching is needed anywhere.
local fake = {}

---Every client event the addon is allowed to subscribe to.
---
---The real RegisterEvent raises on a name the client does not define (patch 8.0.1), and
---because ns.main subscribes in a straight line one bad name used to abort every feature
---wired after it. A fake that accepts any string could never catch that, so this list is
---the guard: adding an event to the addon means adding it here, and adding it here means
---having checked the name against the live API listing rather than guessing at it.
---
---Verified against https://warcraft.wiki.gg/wiki/Events (patch 12.0.5).
fake.KNOWN_EVENTS = {
    -- Read out of the 12.0.5.67823 client's own event table, where it sits beside
    -- PLAYER_MONEY, and confirmed firing on a warband bank deposit on that build.
    "ACCOUNT_MONEY",
    "ACHIEVEMENT_EARNED",
    "BAG_UPDATE_DELAYED",
    -- Read out of the 12.0.5.67823 client's own event table, where the seven BARBER_SHOP_*
    -- events sit together. These are the two a look is worth taking at: the screen coming up,
    -- which is the first moment the client will enumerate a character at all, and an appearance
    -- being applied, which is the one moment the answer changes. See ns.newCharacterLook.
    "BARBER_SHOP_APPEARANCE_APPLIED",
    "BARBER_SHOP_OPEN",
    "BOSS_KILL",
    "CHALLENGE_MODE_COMPLETED",
    "CHALLENGE_MODE_RESET",
    "CHALLENGE_MODE_START",
    "CHAT_MSG_COMBAT_FACTION_CHANGE",
    "CHAT_MSG_LOOT",
    "CINEMATIC_START",
    "CINEMATIC_STOP",
    "CURRENCY_DISPLAY_UPDATE",
    "ENCOUNTER_END",
    "EQUIPMENT_SETS_CHANGED",
    "GET_ITEM_INFO_RECEIVED",
    "LOADING_SCREEN_DISABLED",
    "LOADING_SCREEN_ENABLED",
    "NEW_MOUNT_ADDED",
    "NEW_PET_ADDED",
    "NEW_TOY_ADDED",
    "PLAYER_ENTERING_WORLD",
    "PLAYER_LEVEL_UP",
    "PLAYER_LOGIN",
    "PLAYER_LOGOUT",
    "PLAYER_MONEY",
    "PLAYER_XP_UPDATE",
    "QUEST_ACCEPTED",
    "QUEST_LOG_UPDATE",
    "QUEST_TURNED_IN",
    -- Read out of the 12.0.5.67823 client's own event table, where all three sit together:
    -- SCREENSHOT_STARTED, SCREENSHOT_SUCCEEDED and SCREENSHOT_FAILED. The addon subscribes
    -- to the two that resolve a shot; the third says only that one has begun.
    -- Read out of the same 12.0.5 client's event table, where the eight SCENARIO_* names sit
    -- together. These two are the ones a delve announces itself through: the update that says
    -- a scenario's state has moved, and the completion that says it reached its end.
    "SCENARIO_COMPLETED",
    "SCENARIO_UPDATE",
    "SCREENSHOT_FAILED",
    "SCREENSHOT_SUCCEEDED",
    "TRANSMOG_COLLECTION_SOURCE_ADDED",
    -- Read out of the same 12.0.5.67823 client, beside TRANSMOG_DISPLAYED_OUTFIT_CHANGED and
    -- TRANSMOG_OUTFITS_CHANGED. This is the one for the sets the player saves themselves; the
    -- other two belong to the new Midnight outfit slots, which Chronie does not touch. See
    -- docs/transmog-sets.md.
    "TRANSMOG_CUSTOM_SETS_CHANGED",
    "UPDATE_INSTANCE_INFO",
    "ZONE_CHANGED_NEW_AREA",
}

---Names the addon subscribes to that could NOT be found in the API listing above.
---
---Housing landed in 12.0 and the listing spells most of its events `HOUSE_*` rather than
---`HOUSING_*`, so these three are very likely wrong and housing tracking is inert in the
---live client. They stay wired because the dispatcher now degrades one bad name instead of
---dying on it, and because the tally logic behind them is worth keeping tested. Move a name
---up into KNOWN_EVENTS once it has been confirmed against a real client, or correct it.
fake.UNVERIFIED_EVENTS = {
    "HOUSING_DECOR_ADDED",
    "HOUSING_LEVEL_UP",
    "HOUSING_XP_GAINED",
}

---@type table<string, boolean>
local knownEvents = {}
for _, event in ipairs(fake.KNOWN_EVENTS) do
    knownEvents[event] = true
end
for _, event in ipairs(fake.UNVERIFIED_EVENTS) do
    knownEvents[event] = true
end

---Whether this client build defines `event`, as the fake sees the world.
---@param event string
---@return boolean
function fake.isKnownEvent(event)
    return knownEvents[event] == true
end

---A stand-in for a FontString. Records the last text and colour it was given, the font
---template it was built from, and whether it is currently visible, which is all any
---assertion needs.
---
---The template is what tells a panel's own chrome from the rows it draws: a header is
---built in a heading font and a row in a small one, and every one of them declares a
---justification, so justification alone cannot separate the two.
---@param template string? the font template the caller asked for
---@return table
function fake.newFontString(template)
    local fontString = { shown = true, points = {}, scripts = {}, template = template }

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

---A stand-in for a Texture. Records the colour it was filled with and the box it was
---given, which is what a progress bar is: a track and a filled part of it, both sized —
---and the picture it was pointed at, which is what an icon is.
---@return table
function fake.newTexture(layer)
    local texture = { shown = true, layer = layer, points = {} }

    function texture:SetColorTexture(r, g, b, a)
        self.color = { r, g, b, a }
    end

    ---The client takes a file id or a path here and asks no questions about either, so the
    ---fake records whichever it was handed rather than judging it.
    function texture:SetTexture(picture)
        self.texture = picture
    end

    function texture:SetDesaturated(desaturated)
        self.desaturated = desaturated and true or false
    end

    function texture:SetSize(width, height)
        self.width = width
        self.height = height or width
    end

    function texture:SetPoint(...)
        self.points[#self.points + 1] = { ... }
    end

    function texture:ClearAllPoints()
        self.points = {}
    end

    function texture:SetWidth(width)
        self.width = width
    end

    function texture:SetHeight(height)
        self.height = height
    end

    function texture:Show()
        self.shown = true
    end

    function texture:Hide()
        self.shown = false
    end

    function texture:IsShown()
        return self.shown
    end

    return texture
end

---A stand-in for a WoW Frame. Records what the addon asked of it and lets the
---test drive the frame's scripts by hand.
---
---The layout setters are deliberately no-ops that only record: the addon's geometry
---is not behaviour worth asserting, but calling them must not blow up either.
---
---Pass `{ anyEvent = true }` to switch off event-name validation, for the dispatcher's own
---unit tests: those exercise routing mechanics with placeholder names like "A" and "B" and
---deliberately fire events nobody registered, neither of which is about real event names.
---Every other test wants the strict default, which is what catches an invented name.
---
---Pass `{ rejectEvents = { "SOME_EVENT" } }` to make RegisterEvent raise for those names
---however valid they look, standing in for a client build that does not define them. That
---is what proves one refused event no longer takes down everything wired after it.
---@param options table? `{ anyEvent = boolean?, rejectEvents = string[]? }`
---@return table
function fake.newFrame(options)
    options = options or {}
    local anyEvent = options.anyEvent
    local rejected = {}
    for _, event in ipairs(options.rejectEvents or {}) do
        rejected[event] = true
    end
    local frame = {
        scripts = {},
        registered = {},
        registeredOrder = {},
        fontStrings = {},
        textures = {},
        -- Frames created with this one as their parent, in creation order. A window whose
        -- rows live inside a scroll frame draws them on a child rather than on itself, so
        -- "what is on this panel" is a walk rather than one list; see fake.regionsOf.
        children = {},
        points = {},
        shown = true,
        width = 0,
        height = 0,
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

    ---Mirrors the live client: an event this build does not define raises rather than
    ---quietly doing nothing, so a wrong name fails a test instead of shipping.
    function frame:RegisterEvent(event)
        if rejected[event] or (not anyEvent and not fake.isKnownEvent(event)) then
            error("Attempted to register unknown event '" .. tostring(event) .. "'", 2)
        end
        self.registered[event] = (self.registered[event] or 0) + 1
        self.registeredOrder[#self.registeredOrder + 1] = event
    end

    ---Simulate the client firing an event at this frame. The client only delivers events
    ---the frame actually subscribed to, so firing an unregistered one would let a test
    ---prove a handler works when the addon never asked to hear about it.
    ---@param event string
    function frame:fire(event, ...)
        assert(anyEvent or self.registered[event],
            "the addon never registered '" .. tostring(event) .. "'")
        local onEvent = assert(self.scripts.OnEvent, "no OnEvent script was set")
        return onEvent(self, event, ...)
    end

    function frame:CreateFontString(_, _, template)
        local fontString = fake.newFontString(template)
        self.fontStrings[#self.fontStrings + 1] = fontString
        return fontString
    end

    function frame:CreateTexture(_, layer)
        local texture = fake.newTexture(layer)
        self.textures[#self.textures + 1] = texture
        return texture
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

    -- Keyboard focus is recorded rather than ignored, because "this box never took focus
    -- unless somebody deliberately asked for it" is the assertion the note prompt exists to
    -- satisfy: a focused EditBox swallows every keybind the player has.
    function frame:SetAutoFocus(enabled)
        self.autoFocus = enabled and true or false
    end

    function frame:SetFocus()
        self.focused = true
        self.focusCount = (self.focusCount or 0) + 1
    end

    function frame:ClearFocus()
        self.focused = false
    end

    function frame:HasFocus()
        return self.focused == true
    end

    function frame:SetMaxBytes(bytes)
        self.maxBytes = bytes
    end

    -- Visibility is the client's, not a flag: CreateFrame hands back a frame that is
    -- already shown, and Show and Hide run OnShow and OnHide on the transition and only on
    -- the transition. Both halves are load-bearing. A frame that started hidden let a build
    -- function install OnHide and then hide itself with half its widgets still unbuilt, and
    -- nothing noticed until the game ran it (#214); a Hide that fired unconditionally would
    -- report handlers the client never runs.
    function frame:Show()
        if self.shown then
            return
        end
        self.shown = true
        local onShow = self.scripts.OnShow
        if onShow then
            onShow(self)
        end
    end

    function frame:Hide()
        if not self.shown then
            return
        end
        self.shown = false
        local onHide = self.scripts.OnHide
        if onHide then
            onHide(self)
        end
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

    -- Recorded rather than ignored, unlike the rest of the geometry: a panel that scrolls has
    -- to compare how tall its content is against how tall the box holding it is, so a fake
    -- that forgot both would have the addon dividing by nothing.
    function frame:SetSize(width, height)
        self.width = width
        self.height = height or width
    end

    function frame:SetWidth(width)
        self.width = width
    end

    function frame:SetHeight(height)
        self.height = height
    end

    function frame:GetWidth()
        return self.width
    end

    function frame:GetHeight()
        return self.height
    end

    ---How far the content inside a ScrollFrame has been pushed up. Recorded because "the
    ---panel is scrolled to here" is the whole of what the wheel does.
    function frame:SetVerticalScroll(offset)
        self.verticalScroll = offset
    end

    function frame:GetVerticalScroll()
        return self.verticalScroll or 0
    end

    -- The picture a button wears, which is what says whether the size is pinned.
    function frame:SetNormalTexture(picture)
        self.normalTexture = picture
    end

    function frame:SetResizable(enabled)
        self.resizable = enabled and true or false
    end

    function frame:SetResizeBounds(minWidth, minHeight)
        self.resizeBounds = { minWidth, minHeight }
    end

    function frame:StartSizing(point)
        self.sizingFrom = point
    end

    -- Recorded because a frame with a backdrop of its own is a panel in its own right rather
    -- than part of the one it hangs off — which is what fake.regionsOf stops at.
    function frame:SetBackdrop(backdrop)
        self.backdrop = backdrop
    end

    for _, name in ipairs({
        "SetAllPoints",
        "SetFrameStrata",
        "SetToplevel",
        "SetBackdropColor",
        "SetBackdropBorderColor",
        "SetMovable",
        "EnableMouse",
        "RegisterForDrag",
        "SetClampedToScreen",
        "SetScrollChild",
        "EnableMouseWheel",
        "SetHighlightTexture",
        "RegisterForClicks",
        "SetJustifyH",
        "SetCursorPosition",
        "SetFontObject",
        "ClearAllPoints",
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
---@param options table? Forwarded to every frame it builds; see fake.newFrame.
function fake.newCreateFrame(options)
    local frames = {}
    local types = {}

    local function createFrame(frameType, name, parent, template)
        types[#types + 1] = frameType
        local frame = fake.newFrame(options)
        frame.frameType = frameType
        frame.frameName = name
        frame.parent = parent
        frame.template = template
        if type(parent) == "table" and type(parent.children) == "table" then
            parent.children[#parent.children + 1] = frame
        end
        frames[#frames + 1] = frame
        return frame
    end

    return createFrame, frames, types
end

---Every font string and texture hung off `frame`, its own first and then each child's, in
---creation order.
---
---A window that scrolls draws its rows on a frame inside a ScrollFrame rather than on the
---panel itself, so reading the panel's own two lists would find only the chrome. Depth-first
---from the frame keeps everything one pool handed out contiguous, which is what lets a test
---pair a bar's track with its fill by position.
---
---The walk stops at any child carrying a backdrop of its own. A menu that opens over a panel
---is parented to it but is not part of it, and reading the two as one list would have every
---row of the menu turn up as a phantom row of the body underneath.
---@param frame table
---@return table fontStrings, table textures
function fake.regionsOf(frame)
    local fontStrings, textures = {}, {}

    local function walk(current)
        for _, fontString in ipairs(current.fontStrings or {}) do
            fontStrings[#fontStrings + 1] = fontString
        end
        for _, texture in ipairs(current.textures or {}) do
            textures[#textures + 1] = texture
        end
        for _, child in ipairs(current.children or {}) do
            if not child.backdrop then
                walk(child)
            end
        end
    end

    walk(frame)
    return fontStrings, textures
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

---A fake `GetSavedWorldBossInfo` pair. Each entry accepts `{ name, worldBossID, reset }`,
---where `reset` is SECONDS REMAINING exactly as the real API reports it. Any field may be
---omitted so tests can exercise the degrade-to-default paths.
---@param entries table[]?
---@return fun(): integer getNumSavedWorldBosses
---@return fun(index: integer): ... getSavedWorldBossInfo
---@return table calls indexes the addon asked about, in order
function fake.newSavedWorldBosses(entries)
    entries = entries or {}
    local calls = {}

    local function getNumSavedWorldBosses()
        return #entries
    end

    local function getSavedWorldBossInfo(index)
        calls[#calls + 1] = index
        local entry = entries[index]
        if not entry then
            return nil
        end
        -- name, worldBossID, reset
        return entry.name, entry.worldBossID, entry.reset
    end

    return getNumSavedWorldBosses, getSavedWorldBossInfo, calls
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
---@return table journal `{ getNumTiers, getCurrentTier, selectTier, getTierInfo, getInstanceByIndex, getInstanceInfo }`
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

    ---The client's own second call about one instance, which is where the small button icon
    ---lives: the by-index call above does not carry it. The returns are placed exactly where
    ---the real API puts them — the sixth is `buttonSmallImage` — so a reader that took the
    ---banner beside it reads a number the fixtures can tell apart.
    ---@param instanceID integer
    function journal.getInstanceInfo(instanceID)
        local entry = tiers[current]
        if not entry or not instanceID then
            return nil
        end
        local index = instanceID - 1000
        local name = (entry.raids or {})[index] or (entry.dungeons or {})[index]
        if not name then
            return nil
        end
        -- name, description, bgImage, buttonImage, loreImage, buttonSmallImage
        return name, "", 900000 + index, 910000 + index, 920000 + index, 930000 + index
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

---A stand-in for `C_Timer.After`, with the passage of time left to the test.
---
---Nothing here runs on its own. A callback the addon schedules sits in the queue until the
---test says so, which is what lets a spec assert on the gap — that the shutter has *not*
---been pressed yet — as easily as on what happens after it.
---
---`settle` rather than `advance` is what the specs mostly reach for, and the reason is the
---clock's resolution. `now` is `time()`, whole seconds, because that is what the client
---gives the addon and what a screenshot's filename is named after; a half-second window
---cannot be expressed by moving it at all. So settling runs what is waiting and leaves the
---clock alone, which is also the truth in the game most of the time: the window opens and
---closes inside one second, and every entry involved is stamped with it.
---@param clock table From fake.newClock; what a delay is measured against.
---@return table `{ after, settle, run, pending }`
function fake.newScheduler(clock)
    ---@type table[]
    local queue = {}

    ---Runs everything in the queue that `accepts` says is due, oldest deadline first, and
    ---keeps going while running them puts more in — a burst that closes into a capture that
    ---schedules something else has to reach the end of that chain, not stop one link in. The
    ---cap is there so a callback that reschedules itself forever fails the test loudly
    ---instead of hanging the suite.
    ---@param accepts fun(deadline: number): boolean
    ---@return integer how many callbacks ran
    local function drain(accepts)
        local ran = 0
        for _ = 1, 100 do
            local soonest, index
            for position, entry in ipairs(queue) do
                if accepts(entry.at) and (not soonest or entry.at < soonest.at) then
                    soonest, index = entry, position
                end
            end
            if not soonest then
                return ran
            end
            table.remove(queue, index)
            soonest.callback()
            ran = ran + 1
        end
        error("fake scheduler drained 100 callbacks without emptying: something reschedules itself")
    end

    return {
        ---@param seconds number
        ---@param callback fun()
        after = function(seconds, callback)
            queue[#queue + 1] = { at = clock.now() + seconds, callback = callback }
        end,

        ---Every callback the addon is waiting on runs now, whatever its deadline said.
        ---@return integer how many ran
        settle = function()
            return drain(function()
                return true
            end)
        end,

        ---Only the callbacks the clock has actually reached, for a test that cares which.
        ---@return integer how many ran
        run = function()
            return drain(function(deadline)
                return deadline <= clock.now()
            end)
        end,

        ---@return integer how many callbacks are still waiting
        pending = function()
            return #queue
        end,
    }
end

---A stand-in for the client's `C_Map`, shaped the way the real one answers.
---
---Both of its refusals are modelled, because both are ordinary rather than exceptional.
---`uiMapID = nil` is a loading screen, where the client has no map to name. A map with no
---`x`/`y` is most of instanced content, where the client names the map perfectly happily
---and then declines to say where on it you are standing. The point, when there is one,
---comes back as a Vector2DMixin — an object you ask for the numbers, not a pair of them.
---@param options table? `{ uiMapID = integer?, x = number?, y = number? }`
---@return table cMap, table recorded
function fake.newMap(options)
    options = options or {}
    local asked = {}

    local cMap = {}

    function cMap.GetBestMapForUnit(unit)
        asked[#asked + 1] = { call = "GetBestMapForUnit", unit = unit }
        return options.uiMapID
    end

    function cMap.GetPlayerMapPosition(uiMapID, unit)
        asked[#asked + 1] = { call = "GetPlayerMapPosition", uiMapID = uiMapID, unit = unit }
        if options.x == nil or options.y == nil then
            return nil
        end
        local position = { x = options.x, y = options.y }
        function position:GetXY()
            return self.x, self.y
        end
        return position
    end

    return cMap, { asked = asked }
end

---A stand-in for the two client calls that name where the player is standing, which
---disagree with each other out in the open world and have to.
---
---`GetInstanceInfo` names the CONTINENT out there — "Northrend" for every zone on it —
---while `GetRealZoneText` names the zone the player is actually in. Inside an instance the
---two can differ the other way: the instance is "Utgarde Keep" and the zone around its door
---is "Howling Fjord". Leaving `zoneText` out, or setting it to `""`, models a loading
---screen, where the client has no zone to name yet.
---@param options table? `{ instanceName, kind, difficultyId, difficulty, zoneText }`
---@return table client `{ getInstanceInfo, getRealZoneText }`
function fake.newZone(options)
    options = options or {}

    local client = {}

    -- The real GetInstanceInfo returns several more values after these four; nothing in the
    -- addon reads them, so the fake stops where the contract does.
    function client.getInstanceInfo()
        return options.instanceName, options.kind, options.difficultyId, options.difficulty
    end

    function client.getRealZoneText()
        return options.zoneText
    end

    return client
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

---The top of `Enum.TransmogCollectionType` on build 12.0.5.67823, and the line the real client
---draws between two answers a fake used to blur into one.
---
---An id *inside* the enum that this build happens to have no rows for answers nothing:
---`GetCategoryInfo` returns nil and a caller skips the category. An id *outside* it is not a
---category at all, and the client does not answer nothing for it — it raises, out of the C
---function, with the usage string the whole family of `bad argument #1` errors carries. That is
---issue #271: a probe past the end of the enum is not a call that costs nothing, it is a call
---that takes the addon down, and a fake that returned nil for both could never have said so.
local LAST_TRANSMOG_ENUM_CATEGORY = 29

---What the client raises when asked about a category id that is not in the enum, in its own
---shape — the `Usage:` text is the client's own, read off the error the live game threw.
local function raiseUnknownTransmogCategory()
    error("bad argument #1 to 'GetCategoryInfo' (Usage: local name, isWeapon, canHaveIllusions,"
        .. " canMainHand, canOffHand, canRanged = C_TransmogCollection.GetCategoryInfo(category))", 2)
end

---A complete fake WowEnv plus the recordings the test asserts on.
---
---`options.db` may be shared between two `newEnv` calls to model two characters on
---one account writing into the same SavedVariables table.
---@param options table? `{ playerName, realmName, class, classFile, level, now, savedInstances,
---  savedWorldBosses, db,
---  tiers, money, warbandMoney, instanceType, instanceName, difficultyId, difficultyName,
---  itemPrices, transmogSources, currencies, achievements, mounts, pets, toys, housingItems,
---  activeQuests, questStates, lootFormats, factionFormats }`
---  `housingItems` maps an id to `{ name, quantity }`, quantity being the warband-owned count.
---  `pets` maps a battle pet GUID to `{ id, name, owned }`, owned being how many of that
---  species the account holds once the catch has landed — one for a species new to it.
---  `currencies` maps a currencyType to its localised name; `achievements` maps an id to its name.
---  `currencyItems` maps an item id to `{ name, count }`, count being the grand total owned.
---  `factions` maps a localised faction name to `{ standing, current, max }`.
---  `trackedCurrencies` is a list of item ids to pre-seed into the tracked-currency store.
---  `map` is `{ uiMapID, x, y }`, where the character is standing; `false` for nowhere.
---  `playerGUID` is the client's unique id for the logged-in character; `race` and `sex` are
---  what UnitRace and UnitSex say about them, and `customizations` is what a barber's screen
---  would enumerate — nil, as the real client answers everywhere else. See setCustomizations.
---  `censusMounts` maps a mount id to `{ name, spell, source, collected, ... }` and `censusTrees`
---  maps an achievement category to the rows inside it, both being what the account *holds*
---  rather than what it was watched collecting; `censusAppearances` maps a transmog category to
---  the rows `GetCategoryAppearances` answers with, which is only ever what the logged-in
---  character's class filter shows; `clientBuild` is the game this is a census of.
---  `censusFactions` maps a faction id to a row in `C_Reputation.GetFactionDataByID`'s shape,
---  plus an optional `renown` for a major faction, and is what a test hands over to say this
---  build has reputations to walk at all — absent, the census is simply not taken of them.
---  `reactionLabels` maps a reaction to what the client calls it, standing in for the
---  `FACTION_STANDING_LABELn` globals.
---  `cvars` maps a client setting to its value; `protectedCVars` names the ones this client
---  refuses to let an addon write, mapping each to "raise" or to any truthy value for a write
---  that is silently dropped. `combatLogging` is whether the client starts out logging.
---@return table env, table recorded
function fake.newEnv(options)
    options = options or {}
    -- rejectEvents lets a test boot the whole addon against a client that refuses a given
    -- event name, which is the only way to prove ns.main survives one.
    local createFrame, frames, types = fake.newCreateFrame({ rejectEvents = options.rejectEvents })
    local lines = {}
    local unitsAsked = {}
    local classAsked = {}
    local levelAsked = {}
    local raidInfoRequests = 0
    local slashRegistrations = {}
    local specialFrames = options.specialFrames or {}
    local db = options.db or {}
    local clock = options.clock or fake.newClock(options.now or 1000)
    local scheduler = fake.newScheduler(clock)
    local formatDate, formatDateCalls = fake.newFormatDate()
    local getNumSavedInstances, getSavedInstanceInfo, savedInstanceCalls,
        getSavedInstanceEncounterInfo, encounterCalls = fake.newSavedInstances(options.savedInstances)
    local getNumSavedWorldBosses, getSavedWorldBossInfo, worldBossCalls =
        fake.newSavedWorldBosses(options.savedWorldBosses)
    local tooltip, tooltipRecorded = fake.newTooltip()
    local journal, journalRecorded = fake.newEncounterJournal(options.tiers)
    local classColor, classIconCoords = fake.newClassLook()

    -- Mutable so a test can drive the wallet, the zone, and the collection across a
    -- sequence of events, the same way the client mutates them under the addon's feet.
    local money = options.money or 0
    -- The one pot the whole account shares, which is not any character's. Non-zero by default
    -- so a test that never mentions it still proves the pot reached SavedVariables — a zero
    -- would be indistinguishable from the store having refused the reading.
    local warbandMoney = options.warbandMoney or 500000
    local zone = {
        name = options.instanceName or "Deadmines",
        kind = options.instanceType,
        difficultyId = options.difficultyId or 1,
        difficulty = options.difficultyName or "Normal",
    }
    local itemPrices = options.itemPrices or {}
    local transmogSources = options.transmogSources or {}
    -- The character's equipment sets and what it is wearing, both mutable so a test can
    -- change them between two syncs and watch the ledger notice.
    local equipmentSets = options.equipmentSets or {}
    local equippedItems = options.equippedItems or {}
    -- The player's own transmog sets, already in the shape the client's three calls are
    -- reduced to in Main.lua. Mutable for the same reason the equipment sets are: a test
    -- changes it between two syncs and watches the snapshot notice.
    local transmogCustomSets = options.transmogCustomSets or {}
    -- What the barber's screen would enumerate about this character, and nil when they are not
    -- sitting in front of one — which is where a character is every moment but a handful.
    local playerCustomizations = options.customizations
    -- What the desktop app has asked the game to hold on to, and what the client does about
    -- it. `customSetWrites` is the record a test reads back: the writer's whole job is calls
    -- into the client, and only the calls can say whether it did it.
    local customSetRequests = options.customSetRequests or {}
    -- The walks the app has asked for, by the same road: a table of `{ id, domains }` the addon
    -- reads out of a source file of its own rather than out of SavedVariables.
    local censusRequests = options.censusRequests or {}
    local customSetWrites = { created = {}, modified = {} }
    local maxCustomSets = options.maxCustomSets
    local validCustomSetName = options.validCustomSetName
    -- The ids the fake hands out for sets it is asked to create, so a test can pin what comes
    -- back. `false` in this list models the client refusing to make one, which its own API
    -- documents by answering nothing.
    local newCustomSetIds = options.newCustomSetIds or {}
    local created = 0
    local currencyNames = options.currencies or {}
    -- Where the character stands with each faction, by localised name, already reduced to
    -- the shape ns.factionStanding returns: `{ standing, current, max }`. A faction with no
    -- entry models one the client cannot place.
    local factions = options.factions or {}
    -- What a walk of the client's own currency and reputation panes would come back with,
    -- already in the shape ns.readHoldings reduces them to. Empty by default, and mutable,
    -- so a test that says nothing about it models panes with nothing on them — the sweep
    -- writes nothing, and only what was watched being earned reaches the snapshot.
    local held = options.held or {}
    local achievementNames = options.achievements or {}
    local mountNames = options.mounts or {}
    -- What the account *holds*, for the census to walk — as opposed to `achievements` and
    -- `mounts` above, which are the names the addon looks up when it watches one being
    -- collected. Small on purpose: the walk is covered against fake domains in census_spec.lua,
    -- and what a booted addon has to prove is only that the client's real calls are wired to it.
    -- Keyed the way the client keys them: a mount by its id, an achievement by its category and
    -- then by the offset inside it, because the tree has no id list to be walked by.
    local censusMounts = options.censusMounts or {
        [6] = { name = "Swift Zhevra", spell = 37719, source = 4, collected = true },
        [9] = { name = "Kua'fon", spell = 253058, source = 2, collected = false },
    }
    local censusTrees = options.censusTrees or {
        [92] = {
            {
                id = 4842, name = "Herald of the Titans", points = 25,
                month = 8, day = 4, year = 9, completed = true, mine = true,
            },
            { id = 2144, name = "The Immortal", points = 25, completed = false },
        },
    }
    -- The appearances the census walk can reach, keyed by the client's own transmog category
    -- and holding the rows `GetCategoryAppearances` answers with. Only what a category *shows*
    -- this character: the client answers that call through the class filter, which is why the
    -- domain over it says it is only ever part of an answer.
    local censusAppearances = options.censusAppearances or {
        [1] = {
            { visualID = 1101, isCollected = true, isFavorite = true },
            { visualID = 1102, isCollected = false },
        },
        [11] = {
            { visualID = 1201, isCollected = true },
            -- A "hide helm" pseudo-look: collected as far as the client is concerned and not a
            -- look anybody owns, so the domain leaves it out.
            { visualID = 1202, isCollected = true, isHideVisual = true },
        },
    }
    -- The factions the census walk can reach by id, keyed by id and each in the shape
    -- `C_Reputation.GetFactionDataByID` answers in — which is deliberately *not* the shape
    -- `factions` above uses: that one is keyed by localised name and already reduced, because
    -- it stands in for a whole reader, and this one is the raw client row the real reader has
    -- to reduce itself.
    --
    -- Absent unless a test says otherwise, and that absence is load-bearing: see censusClients.
    local censusFactions = options.censusFactions
    -- What the client would call each reaction, standing in for the `FACTION_STANDING_LABELn`
    -- globals Main.lua reads them out of. Only the levels a test names, since a reaction with
    -- no label is a perfectly ordinary thing for a build to answer with.
    local reactionLabels = options.reactionLabels or {
        [4] = "Neutral", [5] = "Friendly", [6] = "Honored", [7] = "Revered", [8] = "Exalted",
    }
    -- Which game this is, as GetBuildInfo's version and build joined. A census taken against
    -- another one is a census of a different game, so this is what a test changes to model a
    -- patch having landed between two sessions.
    local clientBuild = options.clientBuild
    if clientBuild == nil then
        clientBuild = "12.0.5.67823"
    end
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
    -- The character's experience standing, mutable so a test can drive it the way the
    -- client does. nil models a capped character, where UnitXPMax reads zero.
    local experience = options.experience
    -- The keystone in the slot and the completion report, both nil until a test plants one.
    local activeKeystone = options.activeKeystone
    local keystoneCompletion = options.keystoneCompletion
    -- What the client would say about a delve, already in the shape ns.readDelve returns.
    -- nil until a test plants one, which is what every zone that is not a delve looks like.
    local delveState = options.delveState
    -- Where the client says the character is standing. Mutable, so one test can walk from
    -- a zone that reports a point into an instance that reports only a map.
    local mapPosition = options.map
    if mapPosition == nil then
        mapPosition = { uiMapID = 84, x = 0.55, y = 0.62 }
    end
    -- How many times the addon reached for the shutter. There is nothing else to observe:
    -- the real Screenshot() is asynchronous and writes a file the addon can never see.
    local screenshots = 0
    -- Everything the addon did to the dressing room, in the order it did it, because with a
    -- preview the order is the whole of the behaviour: stripping the model after fitting the
    -- item leaves the player looking at a naked character. `dressableItems` is the client's
    -- answer to whether it will put an item on a body at all — false models the link the
    -- client refuses, which opens no dressing room and so hands back no actor.
    local dressingRoom = {}
    local dressableItems = options.dressableItems ~= false
    local dressUpActor = {
        -- Colon methods, because the client's actor is an object rather than a table of
        -- closures, and a caller reaching for it with a dot would raise inside the client.
        Undress = function(_)
            dressingRoom[#dressingRoom + 1] = { call = "undress" }
        end,
        TryOn = function(_, link)
            dressingRoom[#dressingRoom + 1] = { call = "tryOn", link = link }
        end,
    }
    -- The client's own unique id for the logged-in character. `false` models every moment
    -- before the world has loaded, where the client will not name the player at all.
    local playerGUID = options.playerGUID
    if playerGUID == nil then
        playerGUID = "Player-970-0002FD1B"
    end
    -- The client's settings and whether it is writing a combat log. `cvars` starts as
    -- whatever the test planted, so a client that already has advanced logging ticked and one
    -- that does not are both reachable; `protectedCVars` names the ones this client refuses to
    -- let an addon write, which is the case the addon has to notice rather than assume away.
    local cvars = options.cvars or {}
    local protectedCVars = options.protectedCVars or {}
    local logging = options.combatLogging == true
    local setCVarCalls = {}

    ---What `GetNumCompletedAchievements` would answer: the whole tree, and then the account's
    ---own completed total.
    ---
    ---Counted off the same rows the walk reads, and skipping a guild's achievements exactly as
    ---`ns.achievementCensus` does, so that the census's own audit agrees with the client it just
    ---walked. A fake that disagreed would have every booted addon walking the tree again at
    ---every single loading screen, which is the behaviour the counter exists to prevent.
    ---@return integer total, integer completed
    local function completedAchievements()
        local total, completed = 0, 0
        for _, rows in pairs(censusTrees) do
            for _, row in ipairs(rows) do
                total = total + 1
                if row.completed and not row.guild then
                    completed = completed + 1
                end
            end
        end
        return total, completed
    end

    ---The keys of a table as a sorted list, which is what both of the client's enumerations
    ---hand over: the mount journal's ids, and the achievement tree's categories.
    ---@param source table
    ---@return integer[]
    local function sortedKeys(source)
        local keys = {}
        for key in pairs(source) do
            keys[#keys + 1] = key
        end
        table.sort(keys)
        return keys
    end

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
        after = scheduler.after,
        formatDate = formatDate,
        getNumSavedInstances = getNumSavedInstances,
        getSavedInstanceInfo = getSavedInstanceInfo,
        getSavedInstanceEncounterInfo = getSavedInstanceEncounterInfo,
        getNumSavedWorldBosses = getNumSavedWorldBosses,
        getSavedWorldBossInfo = getSavedWorldBossInfo,
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
        getInstanceInfo = journal.getInstanceInfo,
        registerSlash = function(tokens, handler)
            slashRegistrations[#slashRegistrations + 1] = { tokens = tokens, handler = handler }
        end,
        getMoney = function()
            return money
        end,
        -- The real seam guards C_Bank away and pcalls the read, so a client build without
        -- warband banks answers nil here. `setWarbandMoney(nil)` models that build.
        warbandMoney = function()
            return warbandMoney
        end,
        instanceInfo = function()
            return {
                name = zone.name,
                kind = zone.kind,
                difficultyId = zone.difficultyId,
                difficulty = zone.difficulty,
            }
        end,
        experienceState = function()
            if not experience then
                return nil
            end
            return {
                level = experience.level,
                xp = experience.xp,
                xpMax = experience.xpMax,
            }
        end,
        activeKeystone = function()
            return activeKeystone
        end,
        keystoneCompletion = function()
            return keystoneCompletion
        end,
        delveState = function()
            return delveState
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
        equipmentSets = function()
            return equipmentSets
        end,
        equippedItems = function()
            return equippedItems
        end,
        transmogCustomSets = function()
            return transmogCustomSets
        end,
        playerRace = function()
            return options.race
        end,
        playerSex = function()
            return options.sex
        end,
        -- Nil unless a test says otherwise, which is what the real client answers everywhere
        -- except the barber's chair — so the default here is the ordinary case rather than a
        -- convenience, and a test that wants the answers has to put the character in the chair.
        playerCustomizations = function()
            return playerCustomizations
        end,
        customSetRequests = function()
            return customSetRequests
        end,
        censusRequests = function()
            return censusRequests
        end,
        customSetClient = {
            create = function(name, icon, list)
                created = created + 1
                customSetWrites.created[#customSetWrites.created + 1] =
                    { name = name, icon = icon, list = list }
                local id = newCustomSetIds[created]
                if id == nil then
                    -- Numbered from a thousand so a set the fake invented can never be mistaken
                    -- for one a test wrote into `transmogCustomSets` by hand.
                    return 1000 + created
                end
                return id or nil
            end,
            modify = function(setID, list)
                customSetWrites.modified[#customSetWrites.modified + 1] =
                    { setId = setID, list = list }
            end,
            maxSets = function()
                return maxCustomSets
            end,
            validName = function(name)
                if validCustomSetName == nil then
                    return true
                end
                return validCustomSetName(name)
            end,
        },
        currencyInfo = function(currencyType)
            return currencyNames[currencyType]
        end,
        factionState = function(faction)
            return factions[faction]
        end,
        heldSweep = function()
            return {
                currencies = held.currencies or {},
                reputation = held.reputation or {},
            }
        end,
        -- Handed over as a bag rather than called, which is the seam's whole point: a build
        -- missing one of these leaves that domain out instead of raising, so a test can model
        -- one by removing a key here.
        --
        -- The reputation bundle is the one key that is only here when a test asked for it, and
        -- the reason is that a domain which always answered would change what `census.audit()`
        -- reports for every test in the suite: a pass that had never walked the reputations
        -- would be named as distrusted at every login, so a test about mounts would start
        -- turning on a reputation walk it never mentioned. `censusFactions` is a test saying
        -- "this build has reputations too", and everything else models the client as it was.
        censusClients = function()
            local clients = {
                mount = {
                    GetMountIDs = function()
                        return sortedKeys(censusMounts)
                    end,
                    -- Eleven returns, of which the domain reads six. The three between the
                    -- spell and the source — the icon, whether the mount is active, whether it
                    -- is usable here — are written out rather than skipped, or a fake would
                    -- agree with a domain that read the wrong positions.
                    GetMountInfoByID = function(id)
                        local mount = censusMounts[id]
                        if not mount then
                            return nil
                        end
                        return mount.name, mount.spell, "interface/icon", false, true,
                            mount.source, mount.favourite, mount.factionSpecific, mount.faction,
                            mount.hidden, mount.collected
                    end,
                },
                achievement = {
                    categories = function()
                        return sortedKeys(censusTrees)
                    end,
                    categoryCount = function(category)
                        return #(censusTrees[category] or {})
                    end,
                    byIndex = function(category, index)
                        local row = (censusTrees[category] or {})[index]
                        if not row then
                            return nil
                        end
                        return row.id, row.name, row.points, row.completed, row.month, row.day,
                            row.year, "description", 0, "interface/icon", "a reward",
                            row.guild, row.mine, row.by
                    end,
                    completedCount = completedAchievements,
                },
                -- The wardrobe, as the client answers about it: a category at a time, by id,
                -- with no transmog location — the second argument is optional, which is what
                -- lets the census ask without naming a slot of the player's.
                collection = {
                    -- Nothing for a category inside the enum this build has no rows for, and a
                    -- raise for an id past the end of it — see raiseUnknownTransmogCategory.
                    GetCategoryInfo = function(category)
                        if type(category) ~= "number" or category > LAST_TRANSMOG_ENUM_CATEGORY then
                            raiseUnknownTransmogCategory()
                        end
                        local rows = censusAppearances[category]
                        if not rows then
                            return nil
                        end
                        return "Category " .. category
                    end,
                    -- The *unfiltered* total, which is what the plan is drawn against: the list
                    -- below is the class filter's and can only be shorter.
                    GetCategoryTotal = function(category)
                        return #(censusAppearances[category] or {})
                    end,
                    GetCategoryAppearances = function(category)
                        return censusAppearances[category]
                    end,
                    -- The unfiltered collected count, the twin of the client's own
                    -- `GetFilteredCategoryCollectedCount`. Counted off the same rows the walk
                    -- reads and skipping the hidden visuals it skips, so that a fake cannot
                    -- have every login provoke a pass the real client would not.
                    GetCategoryCollectedCount = function(category)
                        local collected = 0
                        for _, row in ipairs(censusAppearances[category] or {}) do
                            if row.isCollected and not row.isHideVisual then
                                collected = collected + 1
                            end
                        end
                        return collected
                    end,
                },
            }
            if censusFactions then
                -- The four namespaces a standing has to be assembled out of, in the bag the
                -- pure readers take them in — the same bag Main.lua builds out of
                -- `C_Reputation`, `C_MajorFactionData` and `C_GossipInfo`. A row here answers
                -- by id and by id alone: this is the walk that reaches the legacy factions the
                -- reputation pane will not draw, so there is deliberately no pane to walk.
                clients.standing = {
                    reputation = {
                        GetFactionDataByID = function(factionID)
                            return censusFactions[factionID]
                        end,
                        IsMajorFaction = function(factionID)
                            return (censusFactions[factionID] or {}).renown ~= nil
                        end,
                        IsFactionParagon = function()
                            return false
                        end,
                    },
                    majorFaction = {
                        GetMajorFactionData = function(factionID)
                            return (censusFactions[factionID] or {}).renown
                        end,
                    },
                    gossip = {
                        GetFriendshipReputation = function()
                            return nil
                        end,
                    },
                    reactionLabel = function(reaction)
                        return reactionLabels[reaction]
                    end,
                }
            end
            return clients
        end,
        clientBuild = function()
            return clientBuild
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
            return pet.id, pet.name, pet.owned
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
        dressUpItem = function(link)
            dressingRoom[#dressingRoom + 1] = { call = "dressUp", link = link }
            return dressableItems
        end,
        dressUpActor = function()
            -- A client that opened no dressing room has no actor in it, which is the case the
            -- addon has to survive rather than the odd one out.
            if not dressableItems then
                return nil
            end
            return dressUpActor
        end,
        openTransmogCollection = function() end,
        playerGUID = function()
            return playerGUID or nil
        end,
        mapState = function()
            if not mapPosition then
                return nil
            end
            return { uiMapID = mapPosition.uiMapID, x = mapPosition.x, y = mapPosition.y }
        end,
        screenshot = function()
            screenshots = screenshots + 1
        end,
        loggingCombat = function(enable)
            if enable ~= nil then
                logging = enable and true or false
            end
            return logging
        end,
        -- A build that defines none of the logging APIs, which is the honest default: they are
        -- undocumented, and whether any given client has them is the very thing the probe is
        -- for. ns.newLogProbe reads every one of these as "absent" and says so.
        logChannels = function()
            return { now = function() return 0 end }
        end,
        getCVar = function(name)
            return cvars[name]
        end,
        -- Two ways a protected CVar refuses an addon, because clients have done both: some
        -- builds raise from insecure code, others quietly drop the write. "raise" picks the
        -- first, any other truthy value the second.
        setCVar = function(name, value)
            setCVarCalls[#setCVarCalls + 1] = { name = name, value = value }
            local protection = protectedCVars[name]
            if protection == "raise" then
                error("attempted to set a protected cvar: " .. name, 0)
            end
            if protection then
                return
            end
            cvars[name] = value
        end,
        itemName = function(itemID)
            local currencyItem = currencyItems[itemID]
            if currencyItem and currencyItem.name then
                return currencyItem.name
            end
            local source = itemPrices[itemID]
            return source and ("Item " .. itemID)
        end,
        -- The real client's self-loot templates, in the order Main.lua offers them:
        -- every _MULTIPLE variant ahead of its singular partner, or the singular pattern
        -- swallows the stack count. Verbatim from the enUS global strings.
        lootSelfFormats = options.lootFormats or {
            "You receive loot: %sx%d.",
            "You receive loot: %s.",
            "You receive item: %sx%d.",
            "You receive item: %s.",
            "You receive bonus loot: %sx%d.",
            "You receive bonus loot: %s.",
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
        ---Everything the addon has asked the client to run later — see fake.newScheduler.
        scheduler = scheduler,
        ---Let every delay the addon is waiting on elapse. What a test calls after firing an
        ---event whose photograph is taken half a second later.
        ---@return integer how many callbacks ran
        settle = scheduler.settle,
        specialFrames = specialFrames,
        formatDateCalls = formatDateCalls,
        slashRegistrations = slashRegistrations,
        tooltip = tooltipRecorded,
        savedInstanceCalls = savedInstanceCalls,
        worldBossCalls = worldBossCalls,
        encounterCalls = encounterCalls,
        journal = journalRecorded,
        ---Sit the character down in front of a barber, or stand them up again. Only there will
        ---the client enumerate what a character is made of, so this is the whole difference
        ---between a look that can carry answers and one that carries a race and nothing else.
        ---@param value table? Categories as C_BarberShop.GetAvailableCustomizations gives them.
        setCustomizations = function(value)
            playerCustomizations = value
        end,
        ---Drive the wallet the addon reads through env.getMoney.
        ---@param value integer
        setMoney = function(value)
            money = value
        end,
        ---Drive the warband bank's balance the addon reads through env.warbandMoney, as a
        ---deposit under any of the account's characters would. Nil models a client build that
        ---has no warband bank to ask.
        ---@param value integer?
        setWarbandMoney = function(value)
            warbandMoney = value
        end,
        ---Drive what the client's currency and reputation panes would say the character is
        ---holding, as spending a currency or earning a reputation between two zonings would.
        ---@param value table? `{ currencies, reputation }`; nil empties both panes.
        setHeld = function(value)
            held = value or {}
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
        ---Drive the character's experience standing, as earning experience would.
        ---Passing nil models reaching the level cap.
        ---@param value table? `{ level, xp, xpMax }`
        setExperience = function(value)
            experience = value
        end,
        ---Put a keystone in the slot, so CHALLENGE_MODE_START has a run to read.
        ---@param value table? `{ level, mapId, affixes }`
        setActiveKeystone = function(value)
            activeKeystone = value
        end,
        ---Plant the completion report CHALLENGE_MODE_COMPLETED sends the addon to fetch.
        ---@param value table? `{ level, mapId, durationMs, onTime, upgrades }`
        setKeystoneCompletion = function(value)
            keystoneCompletion = value
        end,
        ---Say what the client would about a delve, for the scenario events to read.
        ---Passing nil models every scenario that is not one.
        ---@param value DelveState?
        setDelveState = function(value)
            delveState = value
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
        ---Move the character, as walking or a loading screen would. Passing nil models a
        ---client that cannot name a map at all; a table with no x/y models instanced
        ---content, which names the map and refuses the point.
        ---@param value table? `{ uiMapID, x, y }`
        setMap = function(value)
            mapPosition = value
        end,
        ---@return integer how many times the addon took a screenshot
        screenshots = function()
            return screenshots
        end,
        ---Everything the addon did to the dressing room, oldest first: `{ call, link }` where
        ---call is "dressUp", "undress" or "tryOn".
        ---@return table[]
        dressingRoom = function()
            return dressingRoom
        end,
        ---@return boolean whether the client is writing a combat log
        isLogging = function()
            return logging
        end,
        ---@param name string
        ---@return string? what the client's setting reads as now
        cvar = function(name)
            return cvars[name]
        end,
        ---Every write the addon attempted, refused ones included.
        setCVarCalls = setCVarCalls,
        ---@return integer how many times the addon asked the client for raid info
        raidInfoRequests = function()
            return raidInfoRequests
        end,
        ---Every set the addon asked the client to make or to save over, in the order it asked.
        ---
        ---The only record there is of the one thing Chronie writes into a WoW account, so it
        ---keeps the whole call: a test that only counted them could not tell a set saved with
        ---the right thirteen slots from one saved empty.
        customSetWrites = customSetWrites,
    }
end

return fake
