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
---@field chatLoggingTouched boolean Whether the probe turned `/chatlog` on itself.
---@field lines string[] What to say in chat, in order.

---@class LogProbeOptions
---@field includeChat boolean? Also probe the channels that write through the chat frame.

---Writes one uniquely tagged string down every channel this client build exposes, so the
---files it lands in can be read afterwards and the channel identified from the line itself.
---
---What 12.0.5.67823 answered, from a real client (issue #209):
---
---  * `C_Log` reaches `Logs\General.log`, tagged `[N]`, `[E]` or `[W]` by severity and sourced
---    `[Lua]` — `7/29 14:58:04.773  [N][Lua] CHRONIE_PROBE_…`.
---  * `LogPriority.Spam` writes nothing. It is under the client's threshold and is dropped, so
---    it stays probed but must never be the priority anything real is written at.
---  * `SendSystemMessage` reaches `Logs\WoWChatLog.txt`, and `print` and `AddMessage` do not.
---    Chat logging records chat *events*, not whatever was drawn in a chat frame.
---  * `C_CombatLogSecure` is not defined for addon code at all, despite being in the binary.
---
---The chat channels are opt-in because of that shape: the two silent ones write nothing to
---any file, and the one that does write is visible in the player's chat and flips `/chatlog`
---to get there. None of that is a price worth paying by default, and `C_Log` — which costs
---neither — is the channel anything real would use.
---@class LogProbe
---@field run fun(options: LogProbeOptions?): LogProbeResult

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
        ---@param options LogProbeOptions?
        ---@return LogProbeResult
        run = function(options)
            local includeChat = options ~= nil and options.includeChat == true
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

            attempt("combat_secure", deps.createCombatLogMessage)

            -- Everything below here is visible to the player, which is why it is opt-in.
            -- `chatLoggingKnown` is what keeps the closing advice honest. A build that
            -- protects the read but not the write would otherwise be told its logging was off
            -- and is now on — and a player who follows that and runs /chatlog would be
            -- switching off logging they had turned on themselves.
            local chatLoggingWasOn, chatLoggingTouched, chatLoggingKnown = false, false, true
            if includeChat then
                -- Read and set before any chat channel is touched: the client writes
                -- WoWChatLog.txt as it goes rather than backfilling it, so a line sent while
                -- the switch was off was never a candidate for the file.
                if deps.chatLoggingEnabled then
                    local ok, state = pcall(deps.chatLoggingEnabled)
                    chatLoggingKnown = ok
                    chatLoggingWasOn = ok and state == true
                end
                if not chatLoggingWasOn and deps.setChatLogging then
                    chatLoggingTouched = pcall(deps.setChatLogging, true)
                end

                attempt("chat_print", deps.print)
                attempt("chat_addmessage", deps.addChatMessage)
                attempt("chat_system", deps.sendSystemMessage)
            end

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

            -- Only the channels that did not run are named. A run where everything worked has
            -- nothing to say about any individual channel, and the point of this pass is that
            -- the probe stops shouting: the files are the result, not the chat frame.
            local lines = {
                ("log probe %s: %d called, %d raised, %d missing."):format(nonce, written, failed, absent),
            }
            for _, entry in ipairs(attempts) do
                if entry.status ~= "written" then
                    lines[#lines + 1] = ("  %s: %s (%s)"):format(entry.id, entry.status, entry.detail or "")
                end
            end
            if chatLoggingTouched and chatLoggingKnown then
                lines[#lines + 1] = "chat logging was off and is now on; /chatlog turns it back off."
            elseif chatLoggingTouched then
                lines[#lines + 1] = "chat logging is on; this client would not say whether it already was."
            end
            -- Verified on 12.0.5.67823: the tokens were in neither log while the client was
            -- running, nor after /reload, and were in both the moment it exited.
            lines[#lines + 1] = "quit the game fully — /reload does not flush the logs — then search"
            lines[#lines + 1] = "the Logs folder for: " .. PREFIX .. "_" .. nonce

            return {
                nonce = nonce,
                attempts = attempts,
                chatLoggingWasOn = chatLoggingWasOn,
                chatLoggingTouched = chatLoggingTouched,
                lines = lines,
            }
        end,
    }
end
