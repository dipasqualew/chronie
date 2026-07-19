---Hand-written fakes for the slice of the WoW API the addon depends on.
---These are injected through the same seams the game uses (WowEnv /
---EventDispatcherDeps), so no monkey patching is needed anywhere.
local fake = {}

---A stand-in for a WoW Frame. Records what the addon asked of it and lets the
---test drive the frame's scripts by hand.
---@return table
function fake.newFrame()
    local frame = {
        scripts = {},
        registered = {},
        registeredOrder = {},
    }

    function frame:SetScript(name, handler)
        self.scripts[name] = handler
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

    return frame
end

---A `createFrame` fake that hands back frames and remembers them.
---@return fun(frameType: string): table createFrame
---@return table frames created frames, in creation order
---@return table types frame types requested, in creation order
function fake.newCreateFrame()
    local frames = {}
    local types = {}

    local function createFrame(frameType)
        types[#types + 1] = frameType
        local frame = fake.newFrame()
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
---@param entries table[]?
---@return fun(): integer getNumSavedInstances
---@return fun(index: integer): ... getSavedInstanceInfo
---@return table calls indexes the addon asked about, in order
function fake.newSavedInstances(entries)
    entries = entries or {}
    local calls = {}

    local function getNumSavedInstances()
        return #entries
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
            entry.numEncounters or 0,
            entry.encounterProgress or 0
    end

    return getNumSavedInstances, getSavedInstanceInfo, calls
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
---@param options table? `{ playerName, realmName, now, savedInstances, db }`
---@return table env, table recorded
function fake.newEnv(options)
    options = options or {}
    local createFrame, frames, types = fake.newCreateFrame()
    local lines = {}
    local unitsAsked = {}
    local raidInfoRequests = 0
    local slashRegistrations = {}
    local specialFrames = options.specialFrames or {}
    local db = options.db or {}
    local clock = options.clock or fake.newClock(options.now or 1000)
    local formatDate, formatDateCalls = fake.newFormatDate()
    local getNumSavedInstances, getSavedInstanceInfo =
        fake.newSavedInstances(options.savedInstances)

    local env = {
        createFrame = createFrame,
        print = function(message)
            lines[#lines + 1] = message
        end,
        unitName = function(unit)
            unitsAsked[#unitsAsked + 1] = unit
            return options.playerName
        end,
        realmName = function()
            return options.realmName
        end,
        now = clock.now,
        formatDate = formatDate,
        getNumSavedInstances = getNumSavedInstances,
        getSavedInstanceInfo = getSavedInstanceInfo,
        requestRaidInfo = function()
            raidInfoRequests = raidInfoRequests + 1
        end,
        registerSlash = function(tokens, handler)
            slashRegistrations[#slashRegistrations + 1] = { tokens = tokens, handler = handler }
        end,
        uiParent = options.uiParent or { name = "UIParent" },
        specialFrames = specialFrames,
        db = db,
    }

    return env, {
        lines = lines,
        frames = frames,
        frameTypes = types,
        unitsAsked = unitsAsked,
        db = db,
        clock = clock,
        specialFrames = specialFrames,
        formatDateCalls = formatDateCalls,
        slashRegistrations = slashRegistrations,
        ---@return integer how many times the addon asked the client for raid info
        raidInfoRequests = function()
            return raidInfoRequests
        end,
    }
end

return fake
