local _, ns = ...

---@class SlashRouter
---@field add fun(subcommand: string, handler: fun(argument: string))
---@field dispatch fun(text: string)

---@class SlashRouterDeps
---@field onUnknown fun(subcommand: string) Called for anything unrouted, including "".

---Routes "/wdp <subcommand> <argument>". Registration with the client lives in
---Main.lua; this half is pure string handling so it can be tested directly.
---@param deps SlashRouterDeps
---@return SlashRouter
function ns.newSlashRouter(deps)
    local onUnknown = deps.onUnknown
    ---@type table<string, fun(argument: string)>
    local handlers = {}

    return {
        ---@param subcommand string
        ---@param handler fun(argument: string)
        add = function(subcommand, handler)
            handlers[subcommand:lower()] = handler
        end,

        ---@param text string
        dispatch = function(text)
            text = (text or ""):gsub("^%s+", ""):gsub("%s+$", "")
            local subcommand, argument = text:match("^(%S+)%s*(.*)$")
            subcommand = (subcommand or ""):lower()

            local handler = handlers[subcommand]
            if handler then
                handler(argument or "")
            else
                onUnknown(subcommand)
            end
        end,
    }
end
