local loader = require("addon_loader")

describe("ns.newLogProbe", function()
    local ns = loader.load()

    local NOW = 20260729
    local NONCE = tostring(NOW)
    local PREFIX = "CHRONIE_PROBE"

    ---Every channel the module probes, in the order it probes them. The order is itself
    ---part of the contract: the chat channels have to be touched after chat logging is on.
    local CHANNEL_IDS = {
        "c_log_message",
        "c_log_error",
        "c_log_warning",
        "c_log_priority_warning",
        "c_log_priority_spam",
        "chat_print",
        "chat_addmessage",
        "chat_system",
        "combat_secure",
    }

    ---The channels that are handed the token and nothing else, paired with the dep each reads.
    local SIMPLE_CHANNELS = {
        { id = "c_log_message", dep = "logMessage" },
        { id = "c_log_error", dep = "logErrorMessage" },
        { id = "c_log_warning", dep = "logWarningMessage" },
        { id = "chat_print", dep = "print" },
        { id = "chat_addmessage", dep = "addChatMessage" },
        { id = "chat_system", dep = "sendSystemMessage" },
        { id = "combat_secure", dep = "createCombatLogMessage" },
    }

    ---The three channels that only reach a file if `/chatlog` was on before they were called.
    local CHAT_CHANNELS = { "chat_print", "chat_addmessage", "chat_system" }

    ---A stand-in for one client build, assembled entirely out of the seams the module is
    ---given. A build that does not define an API is one whose dep is simply absent; a
    ---protected namespace is one whose dep raises. Nothing is monkey patched, and nothing
    ---reaches around the module to observe it — every call it made is one the fake recorded.
    ---
    ---`options.absent` is a set of dep names to leave nil. `options.raising` maps a dep name
    ---to the message it errors with. `options.priorities` stands in for `Enum.LogPriority`
    ---and defaults to a client that has all three. `options.chatLogging` is whether
    ---`/chatlog` is already running before the probe touches anything.
    ---@param options table? `{ now, absent, raising, priorities, chatLogging }`
    ---@return LogProbe probe, table client `{ order, calls, chatLogging, setChatLoggingCalls }`
    local function newLogProbe(options)
        options = options or {}
        local absent = options.absent or {}
        local raising = options.raising or {}
        local client = {
            order = {},
            calls = {},
            setChatLoggingCalls = {},
            chatLogging = options.chatLogging == true,
        }

        ---A dep that records that it was called, with what, and then behaves as the build does.
        ---@param name string
        ---@return fun(...)?
        local function seam(name)
            if absent[name] then
                return nil
            end
            return function(...)
                client.order[#client.order + 1] = name
                local calls = client.calls[name] or {}
                calls[#calls + 1] = { ... }
                client.calls[name] = calls
                if raising[name] then
                    error(raising[name], 0)
                end
            end
        end

        local chatLoggingEnabled
        if not absent.chatLoggingEnabled then
            chatLoggingEnabled = function()
                client.order[#client.order + 1] = "chatLoggingEnabled"
                if raising.chatLoggingEnabled then
                    error(raising.chatLoggingEnabled, 0)
                end
                return client.chatLogging
            end
        end

        local setChatLogging
        if not absent.setChatLogging then
            setChatLogging = function(enabled)
                client.order[#client.order + 1] = "setChatLogging"
                client.setChatLoggingCalls[#client.setChatLoggingCalls + 1] = enabled
                if raising.setChatLogging then
                    error(raising.setChatLogging, 0)
                end
                client.chatLogging = enabled and true or false
            end
        end

        local priorities = options.priorities
        if priorities == nil then
            priorities = { Fatal = 0, Warning = 1, Spam = 2 }
        end

        local probe = ns.newLogProbe({
            now = function()
                return options.now or NOW
            end,
            logMessage = seam("logMessage"),
            logErrorMessage = seam("logErrorMessage"),
            logWarningMessage = seam("logWarningMessage"),
            logMessageWithPriority = seam("logMessageWithPriority"),
            logPriorities = priorities or nil,
            chatLoggingEnabled = chatLoggingEnabled,
            setChatLogging = setChatLogging,
            print = seam("print"),
            addChatMessage = seam("addChatMessage"),
            sendSystemMessage = seam("sendSystemMessage"),
            createCombatLogMessage = seam("createCombatLogMessage"),
        })
        return probe, client
    end

    ---@param result LogProbeResult
    ---@param id string
    ---@return LogProbeAttempt
    local function attemptFor(result, id)
        for _, entry in ipairs(result.attempts) do
            if entry.id == id then
                return entry
            end
        end
        error("no attempt recorded for " .. id, 2)
    end

    ---@param result LogProbeResult
    ---@return string[]
    local function ids(result)
        local list = {}
        for index, entry in ipairs(result.attempts) do
            list[index] = entry.id
        end
        return list
    end

    ---@param order string[]
    ---@param name string
    ---@return integer?
    local function indexOf(order, name)
        for index, entry in ipairs(order) do
            if entry == name then
                return index
            end
        end
        return nil
    end

    ---@param result LogProbeResult
    ---@return string
    local function joined(result)
        return table.concat(result.lines, "\n")
    end

    ---The single argument one channel was handed.
    ---@param client table
    ---@param name string
    ---@return any
    local function firstArgument(client, name)
        local calls = client.calls[name]
        assert.is_table(calls)
        return calls[1][1]
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newLogProbe)
    end)

    describe("what a run reports", function()
        it("answers with a nonce, an attempt per channel, the chat log state and lines to say", function()
            local probe = newLogProbe()

            local result = probe.run()

            assert.is_string(result.nonce)
            assert.same(CHANNEL_IDS, ids(result))
            assert.is_boolean(result.chatLoggingWasOn)
            assert.is_true(#result.lines > 0)
        end)

        it("takes the nonce from the clock it was given, so a run is reproducible", function()
            local probe = newLogProbe()

            assert.equal(NONCE, probe.run().nonce)
        end)

        it("gives two runs on different clocks different nonces", function()
            local first = newLogProbe({ now = 111 }).run()
            local second = newLogProbe({ now = 222 }).run()

            assert.equal("111", first.nonce)
            assert.equal("222", second.nonce)
        end)
    end)

    -- The property the whole feature rests on. The files are read back with a grep, so a
    -- token that does not carry the nonce cannot be found and a token shared by two channels
    -- names neither of them. Everything else the run reports is a claim; this is the evidence.
    describe("the tokens", function()
        it("names the prefix, the nonce and the channel, in that order", function()
            local result = newLogProbe().run()

            for _, id in ipairs(CHANNEL_IDS) do
                assert.equal(PREFIX .. "_" .. NONCE .. "_" .. id, attemptFor(result, id).token)
            end
        end)

        it("carries the nonce in every token, whatever happened to the channel", function()
            local result = newLogProbe({
                absent = { logMessage = true },
                raising = { print = "protected" },
            }).run()

            for _, entry in ipairs(result.attempts) do
                assert.is_truthy(entry.token:find(NONCE, 1, true))
            end
        end)

        it("hands no two channels the same token", function()
            local result = newLogProbe().run()
            local seen = {}

            for _, entry in ipairs(result.attempts) do
                assert.is_nil(seen[entry.token])
                seen[entry.token] = entry.id
            end

            assert.equal(#CHANNEL_IDS, #result.attempts)
        end)
    end)

    describe("a channel the build defines", function()
        for _, channel in ipairs(SIMPLE_CHANNELS) do
            it("calls " .. channel.dep .. " and files " .. channel.id .. " as written", function()
                local probe, client = newLogProbe()

                local entry = attemptFor(probe.run(), channel.id)

                assert.equal("written", entry.status)
                assert.is_nil(entry.detail)
                assert.equal(entry.token, firstArgument(client, channel.dep))
            end)
        end

        it("hands the token to the channel and nothing else", function()
            local probe, client = newLogProbe()

            probe.run()

            assert.equal(1, #client.calls.print)
            assert.equal(1, #client.calls.print[1])
        end)
    end)

    describe("a channel the build does not define", function()
        for _, channel in ipairs(SIMPLE_CHANNELS) do
            it("files " .. channel.id .. " as absent rather than raising", function()
                local probe = newLogProbe({ absent = { [channel.dep] = true } })

                assert.has_no.errors(probe.run)

                local entry = attemptFor(probe.run(), channel.id)
                assert.equal("absent", entry.status)
                assert.is_string(entry.detail)
                assert.is_true(#entry.detail > 0)
            end)
        end

        it("still probes every other channel", function()
            local result = newLogProbe({
                absent = { logMessage = true, sendSystemMessage = true },
            }).run()

            assert.same(CHANNEL_IDS, ids(result))
            assert.equal("written", attemptFor(result, "chat_print").status)
        end)
    end)

    -- Two of these sit in namespaces the client protects, so raising is an expected outcome
    -- rather than a fault, and one channel refusing must not cost the run the channels after
    -- it — the one that raised is very often not the one the player is trying to find.
    describe("a channel that raises", function()
        for _, channel in ipairs(SIMPLE_CHANNELS) do
            it("files " .. channel.id .. " as failed, with why", function()
                local probe = newLogProbe({ raising = { [channel.dep] = "attempted to call a protected function" } })

                assert.has_no.errors(probe.run)

                local entry = attemptFor(probe.run(), channel.id)
                assert.equal("failed", entry.status)
                assert.is_truthy(entry.detail:find("protected function", 1, true))
            end)
        end

        it("runs every later channel all the same", function()
            local probe, client = newLogProbe({ raising = { logMessage = "boom" } })

            local result = probe.run()

            assert.same(CHANNEL_IDS, ids(result))
            for _, id in ipairs(CHANNEL_IDS) do
                if id ~= "c_log_message" then
                    assert.equal("written", attemptFor(result, id).status)
                end
            end
            assert.is_table(client.calls.createCombatLogMessage)
        end)

        it("survives every channel on the build raising at once", function()
            local probe = newLogProbe({
                raising = {
                    logMessage = "a", logErrorMessage = "b", logWarningMessage = "c",
                    logMessageWithPriority = "d", print = "e", addChatMessage = "f",
                    sendSystemMessage = "g", createCombatLogMessage = "h",
                },
            })

            assert.has_no.errors(probe.run)

            local result = probe.run()
            assert.same(CHANNEL_IDS, ids(result))
            for _, entry in ipairs(result.attempts) do
                assert.equal("failed", entry.status)
            end
        end)
    end)

    describe("the priority channels", function()
        it("writes one token per survivable priority, through the priority the enum names", function()
            local probe, client = newLogProbe()

            local result = probe.run()

            assert.equal("written", attemptFor(result, "c_log_priority_warning").status)
            assert.equal("written", attemptFor(result, "c_log_priority_spam").status)
            assert.same({
                { 1, attemptFor(result, "c_log_priority_warning").token },
                { 2, attemptFor(result, "c_log_priority_spam").token },
            }, client.calls.logMessageWithPriority)
        end)

        -- The safety property. `Fatal` is the one priority a client is allowed to take the
        -- process down over, and the two survivable ones already answer the same question.
        -- A build offering it is not a reason to use it.
        it("never probes Fatal, even on a build whose enum has it", function()
            local probe, client = newLogProbe({ priorities = { Fatal = 0, Warning = 1, Spam = 2 } })

            local result = probe.run()

            for _, entry in ipairs(result.attempts) do
                assert.is_nil(entry.id:find("fatal", 1, true))
                assert.is_nil(entry.token:lower():find("fatal", 1, true))
            end
            for _, call in ipairs(client.calls.logMessageWithPriority) do
                assert.not_equal(0, call[1])
            end
            assert.equal(2, #client.calls.logMessageWithPriority)
        end)

        it("files both as absent when the build has no priority enum", function()
            local probe, client = newLogProbe({ priorities = false })

            local result = probe.run()

            assert.equal("absent", attemptFor(result, "c_log_priority_warning").status)
            assert.equal("absent", attemptFor(result, "c_log_priority_spam").status)
            assert.is_nil(client.calls.logMessageWithPriority)
        end)

        it("files both as absent when the enum is there but the function is not", function()
            local result = newLogProbe({ absent = { logMessageWithPriority = true } }).run()

            assert.equal("absent", attemptFor(result, "c_log_priority_warning").status)
            assert.equal("absent", attemptFor(result, "c_log_priority_spam").status)
        end)

        it("files a priority the enum omits as absent, and probes the one it has", function()
            local probe, client = newLogProbe({ priorities = { Warning = 1 } })

            local result = probe.run()

            assert.equal("written", attemptFor(result, "c_log_priority_warning").status)
            assert.equal("absent", attemptFor(result, "c_log_priority_spam").status)
            assert.equal(1, #client.calls.logMessageWithPriority)
        end)
    end)

    describe("chat logging", function()
        it("turns it on when it was off, and says it did", function()
            local probe, client = newLogProbe({ chatLogging = false })

            local result = probe.run()

            assert.is_false(result.chatLoggingWasOn)
            assert.same({ true }, client.setChatLoggingCalls)
            assert.is_truthy(joined(result):find("turns it back off", 1, true))
        end)

        -- Somebody who was already logging their chat for their own reasons must not find
        -- the probe touched a switch they own, nor be told to turn off something it did not turn on.
        it("leaves a switch the player already had on alone", function()
            local probe, client = newLogProbe({ chatLogging = true })

            local result = probe.run()

            assert.is_true(result.chatLoggingWasOn)
            assert.same({}, client.setChatLoggingCalls)
            assert.is_nil(joined(result):find("turns it back off", 1, true))
        end)

        -- The reason the order exists: the client writes WoWChatLog.txt as it goes and never
        -- backfills it, so a line printed before the switch went on was never a candidate for
        -- the file, and the run would report a channel as written that could never be found.
        it("switches it on before any chat channel is touched", function()
            local probe, client = newLogProbe({ chatLogging = false })

            probe.run()

            local switched = indexOf(client.order, "setChatLogging")
            assert.is_number(switched)
            for _, dep in ipairs({ "print", "addChatMessage", "sendSystemMessage" }) do
                assert.is_true(switched < indexOf(client.order, dep))
            end
        end)

        it("reads the switch before deciding to write to it", function()
            local probe, client = newLogProbe({ chatLogging = false })

            probe.run()

            assert.is_true(indexOf(client.order, "chatLoggingEnabled") < indexOf(client.order, "setChatLogging"))
        end)

        it("still probes the chat channels on a build that cannot switch it", function()
            local probe, client = newLogProbe({
                absent = { chatLoggingEnabled = true, setChatLogging = true },
            })

            assert.has_no.errors(probe.run)

            local result = probe.run()
            assert.is_false(result.chatLoggingWasOn)
            for _, id in ipairs(CHAT_CHANNELS) do
                assert.equal("written", attemptFor(result, id).status)
            end
            assert.is_table(client.calls.print)
        end)

        for _, case in ipairs({
            { label = "reading the switch raises", raising = { chatLoggingEnabled = "protected" } },
            { label = "writing the switch raises", raising = { setChatLogging = "protected" } },
            {
                label = "both raise",
                raising = { chatLoggingEnabled = "protected", setChatLogging = "protected" },
            },
        }) do
            describe("a build where " .. case.label, function()
                it("survives it", function()
                    local probe = newLogProbe({ raising = case.raising })

                    assert.has_no.errors(probe.run)
                end)

                it("probes every channel regardless", function()
                    local result = newLogProbe({ raising = case.raising }).run()

                    assert.same(CHANNEL_IDS, ids(result))
                    for _, id in ipairs(CHAT_CHANNELS) do
                        assert.equal("written", attemptFor(result, id).status)
                    end
                end)

                it("does not claim chat logging was already on", function()
                    assert.is_false(newLogProbe({ raising = case.raising }).run().chatLoggingWasOn)
                end)
            end)
        end

        it("tries the switch anyway when reading it raised, since off is the assumption", function()
            local probe, client = newLogProbe({ raising = { chatLoggingEnabled = "protected" } })

            probe.run()

            assert.same({ true }, client.setChatLoggingCalls)
        end)
    end)

    describe("what it tells the player", function()
        it("leads with the nonce and a tally of the run", function()
            local result = newLogProbe({ absent = { logMessage = true }, raising = { print = "boom" } }).run()

            assert.is_truthy(result.lines[1]:find(NONCE, 1, true))
        end)

        -- Without the exact string, the run produced nine tokens the player cannot find.
        it("spells out the string to search the Logs folder for", function()
            local result = newLogProbe().run()
            local text = joined(result)

            assert.is_truthy(text:find(PREFIX .. "_" .. NONCE, 1, true))
            assert.is_truthy(text:find("Logs", 1, true))
        end)

        it("says a line per channel, naming it and what became of it", function()
            local result = newLogProbe({
                absent = { logMessage = true },
                raising = { print = "protected" },
            }).run()
            local text = joined(result)

            for _, id in ipairs(CHANNEL_IDS) do
                assert.is_truthy(text:find(id, 1, true))
            end
            assert.is_truthy(text:find("c_log_message: absent", 1, true))
            assert.is_truthy(text:find("chat_print: failed", 1, true))
            assert.is_truthy(text:find("c_log_warning: called", 1, true))
        end)
    end)
end)
