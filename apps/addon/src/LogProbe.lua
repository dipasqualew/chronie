local _, ns = ...

---One attempt to get a string out of the client and onto disk.
---@class LogProbeAttempt
---@field id string Channel name, and the tail of the token written through it.
---@field token string The exact string handed to the channel.
---@field status "written"|"absent"|"failed" Whether the call was made, and whether it returned.
---@field detail string? Why an absent or failed channel did not run.

---@class LogProbeResult
---@field nonce string Ties one run's tokens together; what the player greps for.
---@field attempts LogProbeAttempt[]
---@field chatLoggingWasOn boolean Whether `/chatlog` was already on before the probe touched it.
---@field lines string[] What to say in chat, in order.

---Writes one uniquely tagged string down every channel this client build exposes, so the
---files it lands in can be read afterwards and the channel identified from the line itself.
---
---This exists because the question it answers cannot be settled from outside the game.
---`C_Log`, `SendSystemMessage` and `C_CombatLogSecure.CreateCombatLogMessage` are all
---registered in the 12.0.5 client binary and none of them is documented anywhere; whether
---they reach a file on a retail build, and which file, is control flow rather than anything
---a reader of the binary can see. One tagged write per channel turns that into a grep.
---
---Every call is wrapped: these are undocumented APIs and two of them sit in namespaces the
---client protects, so raising is an expected outcome to be recorded rather than a fault.
---@class LogProbe
---@field run fun(): LogProbeResult

---@class LogProbeDeps
---@field now fun(): integer Seeds the nonce.
---@field logMessage fun(message: string)? `C_Log.LogMessage`
---@field logErrorMessage fun(message: string)? `C_Log.LogErrorMessage`
---@field logWarningMessage fun(message: string)? `C_Log.LogWarningMessage`
---@field logMessageWithPriority fun(priority: integer, message: string)? `C_Log.LogMessageWithPriority`
---@field logPriorities table<string, integer>? `Enum.LogPriority`
---@field chatLoggingEnabled fun(): boolean? Reads `/chatlog`'s current state.
---@field setChatLogging fun(enabled: boolean)? Turns `/chatlog` on.
---@field print fun(message: string)? The client's own `print`.
---@field addChatMessage fun(message: string)? `DEFAULT_CHAT_FRAME:AddMessage`
---@field sendSystemMessage fun(message: string)? `SendSystemMessage`
---@field createCombatLogMessage fun(message: string)? `C_CombatLogSecure.CreateCombatLogMessage`

local PREFIX = "CHRONIE_PROBE"

---`Fatal` is deliberately not probed. This is a logging system carrying a severity enum of
---exactly `Fatal`, `Warning`, `Spam`, and a fatal-priority write is the one that is allowed
---to take the process down with it. The two survivable priorities answer the same question —
---does a C_Log write reach a file — and finding out about the third on somebody's live
---client, mid-session, is not worth what it would cost if the answer is yes.
local PROBED_PRIORITIES = { "Warning", "Spam" }

---@param deps LogProbeDeps
---@return LogProbe
function ns.newLogProbe(deps)
    local now = deps.now

    return {
        ---@return LogProbeResult
        run = function()
            local nonce = tostring(now())
            ---@type LogProbeAttempt[]
            local attempts = {}

            ---Runs one channel and files what happened to it. A channel the build does not
            ---define is `absent`; one that raises is `failed`; one that returns is `written`,
            ---which claims only that the call completed — whether anything reached a file is
            ---the whole point of going and looking afterwards.
            ---@param id string
            ---@param call fun(token: string)?
            local function attempt(id, call)
                local token = table.concat({ PREFIX, nonce, id }, "_")
                if type(call) ~= "function" then
                    attempts[#attempts + 1] = {
                        id = id,
                        token = token,
                        status = "absent",
                        detail = "this client build does not define it",
                    }
                    return
                end
                local ok, err = pcall(call, token)
                attempts[#attempts + 1] = {
                    id = id,
                    token = token,
                    status = ok and "written" or "failed",
                    detail = (not ok) and tostring(err) or nil,
                }
            end

            -- Chat logging first, and before any of the chat channels are touched: the client
            -- writes WoWChatLog.txt as it goes rather than backfilling it, so a line printed
            -- while the switch was off is a line that was never a candidate for the file.
            local chatLoggingWasOn = false
            if deps.chatLoggingEnabled then
                local ok, state = pcall(deps.chatLoggingEnabled)
                chatLoggingWasOn = ok and state == true
            end
            if not chatLoggingWasOn and deps.setChatLogging then
                pcall(deps.setChatLogging, true)
            end

            attempt("c_log_message", deps.logMessage)
            attempt("c_log_error", deps.logErrorMessage)
            attempt("c_log_warning", deps.logWarningMessage)

            local priorities = deps.logPriorities
            for _, name in ipairs(PROBED_PRIORITIES) do
                local value = priorities and priorities[name]
                local call
                if value ~= nil and deps.logMessageWithPriority then
                    call = function(token)
                        deps.logMessageWithPriority(value, token)
                    end
                end
                attempt("c_log_priority_" .. name:lower(), call)
            end

            -- The control. If chat logging is on and this one does not turn up in a file, the
            -- grep itself is wrong and nothing else the run says can be trusted.
            attempt("chat_print", deps.print)
            attempt("chat_addmessage", deps.addChatMessage)
            attempt("chat_system", deps.sendSystemMessage)
            attempt("combat_secure", deps.createCombatLogMessage)

            local written, failed, absent = 0, 0, 0
            for _, entry in ipairs(attempts) do
                if entry.status == "written" then
                    written = written + 1
                elseif entry.status == "failed" then
                    failed = failed + 1
                else
                    absent = absent + 1
                end
            end

            local lines = {
                ("log probe %s: %d called, %d raised, %d missing."):format(nonce, written, failed, absent),
            }
            for _, entry in ipairs(attempts) do
                if entry.status == "written" then
                    lines[#lines + 1] = ("  %s: called"):format(entry.id)
                else
                    lines[#lines + 1] = ("  %s: %s (%s)"):format(entry.id, entry.status, entry.detail or "")
                end
            end
            if not chatLoggingWasOn then
                lines[#lines + 1] = "chat logging was off and is now on; /chatlog turns it back off."
            end
            lines[#lines + 1] = "now /reload, then search the Logs folder for: " .. PREFIX .. "_" .. nonce
            lines[#lines + 1] = "each line ends in the channel that wrote it."

            return {
                nonce = nonce,
                attempts = attempts,
                chatLoggingWasOn = chatLoggingWasOn,
                lines = lines,
            }
        end,
    }
end
