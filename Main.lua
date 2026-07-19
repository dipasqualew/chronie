local addonName, ns = ...

---Everything the addon needs from the outside world, in one injectable bag.
---@class WowEnv
---@field createFrame fun(frameType: string): table
---@field print fun(message: string)
---@field unitName fun(unit: string): string?

---Composition root. Wires the modules together and starts listening.
---@param env WowEnv
---@return { dispatcher: EventDispatcher, logger: Logger, greeter: Greeter }
function ns.main(env)
    local logger = ns.newLogger({ sink = env.print, prefix = "|cff33ff99" .. addonName .. "|r:" })
    local greeter = ns.newGreeter({ template = "Hello World, %s!" })
    local dispatcher = ns.newEventDispatcher({ createFrame = env.createFrame })

    dispatcher.on("PLAYER_LOGIN", function()
        logger.info(greeter.greet(env.unitName("player")))
    end)

    return { dispatcher = dispatcher, logger = logger, greeter = greeter }
end

-- Only auto-start inside the game; under test the harness calls ns.main itself.
if CreateFrame then
    ns.app = ns.main({
        createFrame = function(frameType)
            return CreateFrame(frameType)
        end,
        print = print,
        unitName = UnitName,
    })
end
