local _, ns = ...

---Thin seam over the WoW event system: the only place that touches a Frame.
---@class EventDispatcher
---@field on fun(event: string, handler: fun(...): nil)

---@class EventDispatcherDeps
---@field createFrame fun(frameType: string): table Usually the global `CreateFrame`.

---@param deps EventDispatcherDeps
---@return EventDispatcher
function ns.newEventDispatcher(deps)
    local frame = deps.createFrame("Frame")
    ---@type table<string, fun(...): nil>
    local handlers = {}

    frame:SetScript("OnEvent", function(_, event, ...)
        local handler = handlers[event]
        if handler then
            handler(...)
        end
    end)

    return {
        ---@param event string
        ---@param handler fun(...): nil
        on = function(event, handler)
            handlers[event] = handler
            frame:RegisterEvent(event)
        end,
    }
end
