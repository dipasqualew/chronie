local _, ns = ...

---Thin seam over the WoW event system: the only place that touches a Frame.
---@class EventDispatcher
---@field on fun(event: string, handler: fun(...): nil): boolean True when the client accepted the event.
---@field unsupported fun(): string[] Events this client build rejected, in registration order.

---@class EventDispatcherDeps
---@field createFrame fun(frameType: string): table Usually the global `CreateFrame`.

---@param deps EventDispatcherDeps
---@return EventDispatcher
function ns.newEventDispatcher(deps)
    local frame = deps.createFrame("Frame")
    ---@type table<string, fun(...): nil>
    local handlers = {}
    ---@type string[]
    local rejected = {}

    frame:SetScript("OnEvent", function(_, event, ...)
        local handler = handlers[event]
        if handler then
            handler(...)
        end
    end)

    return {
        ---Subscribes to a client event.
        ---
        ---**One handler per event, and the second one wins.** Subscribing twice to the same
        ---name silently unsubscribes whatever was there before, which reads as the earlier
        ---feature quietly ceasing to work rather than as an error anywhere. Two things that
        ---both want the same event are two calls in one handler body, not two calls here.
        ---
        ---Since patch 8.0.1 RegisterEvent *raises* on an event this client build does not
        ---define, and every subscription here runs in a straight line from the composition
        ---root. Letting that error escape would abort the rest of ns.main, so a single
        ---misspelled or since-renamed event name would silently take down every feature
        ---wired after it. Isolating each registration keeps the blast radius to the one
        ---event: its handler is simply never installed, and the name is recorded so the
        ---caller can say out loud which features this client cannot support.
        ---@param event string
        ---@param handler fun(...): nil
        ---@return boolean accepted
        on = function(event, handler)
            local accepted = pcall(function()
                frame:RegisterEvent(event)
            end)
            if not accepted then
                rejected[#rejected + 1] = event
                return false
            end
            handlers[event] = handler
            return true
        end,

        ---@return string[]
        unsupported = function()
            local list = {}
            for index, event in ipairs(rejected) do
                list[index] = event
            end
            return list
        end,
    }
end
