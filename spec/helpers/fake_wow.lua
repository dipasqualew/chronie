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

---A complete fake WowEnv plus the recordings the test asserts on.
---@param options table? `{ playerName = string? }`
---@return table env, table recorded `{ lines, frames, frameTypes, unitsAsked }`
function fake.newEnv(options)
    options = options or {}
    local createFrame, frames, types = fake.newCreateFrame()
    local lines = {}
    local unitsAsked = {}

    local env = {
        createFrame = createFrame,
        print = function(message)
            lines[#lines + 1] = message
        end,
        unitName = function(unit)
            unitsAsked[#unitsAsked + 1] = unit
            return options.playerName
        end,
    }

    return env, {
        lines = lines,
        frames = frames,
        frameTypes = types,
        unitsAsked = unitsAsked,
    }
end

return fake
