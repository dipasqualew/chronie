local _, ns = ...

---Pure formatting of greeting text. No WoW API access, no side effects.
---@class Greeter
---@field greet fun(playerName: string): string

---@class GreeterDeps
---@field template string Format string with a single `%s` for the player name.

---@param deps GreeterDeps
---@return Greeter
function ns.newGreeter(deps)
    local template = deps.template

    return {
        ---@param playerName string
        ---@return string
        greet = function(playerName)
            if playerName == nil or playerName == "" then
                playerName = "stranger"
            end
            return template:format(playerName)
        end,
    }
end
