local _, ns = ...

---@class Logger
---@field info fun(message: string)

---@class LoggerDeps
---@field sink fun(message: string) Where the line goes, e.g. `print`.
---@field prefix string Shown before every message.

---@param deps LoggerDeps
---@return Logger
function ns.newLogger(deps)
    local sink = deps.sink
    local prefix = deps.prefix

    return {
        ---@param message string
        info = function(message)
            sink(prefix .. " " .. message)
        end,
    }
end
