local loader = require("addon_loader")

describe("ns.newLogProbe", function()
    local ns = loader.load()

    local NOW = 20260729
    local NONCE = tostring(NOW)
    local PREFIX = "CHRONIE_PROBE"

    ---The one way to ask for the channels that are visible to the player.
    local WITH_CHAT = { includeChat = true }

    ---The channels a plain `run()` probes, in the order it probes them. Every one of them is
    ---silent: nothing appears in the player's chat, and no switch of theirs is touched.
    local DEFAULT_CHANNEL_IDS = {
        "c_log_message",
        "c_log_error",
        "c_log_warning",
        "c_log_priority_warning",
        "c_log_priority_spam",
        "combat_secure",
    }

    ---The three opt-in channels, in probe order. They come after every silent one, because
    ---the only one of them that reaches a file needs chat logging on before it is called.
    local CHAT_CHANNEL_IDS = { "chat_print", "chat_addmessage", "chat_system" }

    ---The deps behind those three, in the same order.
    local CHAT_DEPS = { "print", "addChatMessage", "sendSystemMessage" }

    ---What `run({ includeChat = true })` probes: the silent six, then the chat three.
    local ALL_CHANNEL_IDS = {}
    for _, id in ipairs(DEFAULT_CHANNEL_IDS) do
        ALL_CHANNEL_IDS[#ALL_CHANNEL_IDS + 1] = id
    end
    for _, id in ipairs(CHAT_CHANNEL_IDS) do
        ALL_CHANNEL_IDS[#ALL_CHANNEL_IDS + 1] = id
    end

    ---The channels that are handed the token and nothing else, paired with the dep each reads.
    ---`chat` marks the ones that only exist on a run that asked for them.
    local SIMPLE_CHANNELS = {
        { id = "c_log_message", dep = "logMessage" },
        { id = "c_log_error", dep = "logErrorMessage" },
        { id = "c_log_warning", dep = "logWarningMessage" },
        { id = "combat_secure", dep = "createCombatLogMessage" },
        { id = "chat_print", dep = "print", chat = true },
        { id = "chat_addmessage", dep = "addChatMessage", chat = true },
        { id = "chat_system", dep = "sendSystemMessage", chat = true },
    }

    ---The options a run has to be given for `channel` to be probed at all.
    ---@param channel table
    ---@return LogProbeOptions?
    local function optionsFor(channel)
        if channel.chat then
            return WITH_CHAT
        end
        return nil
    end

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
    ---@return LogProbe probe, table client `{ order, calls, chatLogging, ... }`
    local function newLogProbe(options)
        options = options or {}
        local absent = options.absent or {}
        local raising = options.raising or {}
        local client = {
            order = {},
            calls = {},
            chatLoggingReads = 0,
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
                client.chatLoggingReads = client.chatLoggingReads + 1
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

    ---The closing advice, when the probe knows it found the switch off and turned it on. It
    ---is the only line that tells the player to run `/chatlog`, because it is the only case
    ---in which doing so puts their client back exactly as they left it.
    local ADVICE_KNOWN = "chat logging was off and is now on; /chatlog turns it back off."

    ---The closing advice when the read raised, so the prior state was never established. True
    ---whichever way it was, and it asks for nothing.
    local ADVICE_UNKNOWN = "chat logging is on; this client would not say whether it already was."

    ---The tally the run leads with, spelled the way the module spells it.
    ---@param written integer
    ---@param failed integer
    ---@param missing integer
    ---@return string
    local function header(written, failed, missing)
        return ("log probe %s: %d called, %d raised, %d missing."):format(NONCE, written, failed, missing)
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
            assert.same(DEFAULT_CHANNEL_IDS, ids(result))
            assert.is_boolean(result.chatLoggingWasOn)
            assert.is_boolean(result.chatLoggingTouched)
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

    -- The chat channels cost something — two of them write to no file at all, and the third
    -- is visible in the player's chat and flips a switch that belongs to them. So a run that
    -- did not ask for them must not merely skip reporting them: it must not go near them.
    describe("a run that did not ask for the chat channels", function()
        for _, case in ipairs({
            { label = "run()", options = nil },
            { label = "run({})", options = {} },
            { label = "run({ includeChat = false })", options = { includeChat = false } },
        }) do
            it("probes the six silent channels and no others, for " .. case.label, function()
                local probe = newLogProbe()

                assert.same(DEFAULT_CHANNEL_IDS, ids(probe.run(case.options)))
            end)
        end

        it("calls none of the three chat deps", function()
            local probe, client = newLogProbe()

            probe.run()

            for _, dep in ipairs(CHAT_DEPS) do
                assert.is_nil(client.calls[dep])
            end
        end)

        it("neither reads nor writes the chat logging switch", function()
            local probe, client = newLogProbe({ chatLogging = false })

            local result = probe.run()

            assert.equal(0, client.chatLoggingReads)
            assert.same({}, client.setChatLoggingCalls)
            assert.is_false(result.chatLoggingWasOn)
            assert.is_false(result.chatLoggingTouched)
        end)

        -- Reporting a switch it never read would be a guess, and one that happens to be wrong
        -- for exactly the player who cares: the one already logging their own chat.
        it("does not report the switch as on even when the player has it on", function()
            local probe, client = newLogProbe({ chatLogging = true })

            local result = probe.run()

            assert.equal(0, client.chatLoggingReads)
            assert.is_false(result.chatLoggingWasOn)
            assert.is_false(result.chatLoggingTouched)
        end)

        it("says nothing to the player about chat logging", function()
            local result = newLogProbe({ chatLogging = false }).run()

            assert.is_nil(joined(result):find("chat logging", 1, true))
            assert.is_nil(joined(result):find("turns it back off", 1, true))
        end)
    end)

    describe("a run that asked for the chat channels", function()
        it("probes the silent channels first and the chat channels after them", function()
            local probe = newLogProbe()

            assert.same(ALL_CHANNEL_IDS, ids(probe.run(WITH_CHAT)))
        end)

        it("calls all three chat deps", function()
            local probe, client = newLogProbe()

            probe.run(WITH_CHAT)

            for _, dep in ipairs(CHAT_DEPS) do
                assert.is_table(client.calls[dep])
            end
        end)

        -- `C_CombatLogSecure` is silent, so it belongs with the silent channels: a player who
        -- did not opt in still gets it probed, and one who did must not have it deferred to
        -- the far side of a switch it has no use for.
        it("probes combat_secure before any chat channel", function()
            local probe, client = newLogProbe()

            probe.run(WITH_CHAT)

            local secure = indexOf(client.order, "createCombatLogMessage")
            assert.is_number(secure)
            for _, dep in ipairs(CHAT_DEPS) do
                assert.is_true(secure < indexOf(client.order, dep))
            end
        end)
    end)

    -- The property the whole feature rests on. The files are read back with a grep, so a
    -- token that does not carry the nonce cannot be found and a token shared by two channels
    -- names neither of them. Everything else the run reports is a claim; this is the evidence.
    describe("the tokens", function()
        it("names the prefix, the nonce and the channel, in that order", function()
            local result = newLogProbe().run(WITH_CHAT)

            for _, id in ipairs(ALL_CHANNEL_IDS) do
                assert.equal(PREFIX .. "_" .. NONCE .. "_" .. id, attemptFor(result, id).token)
            end
        end)

        it("carries the nonce in every token, whatever happened to the channel", function()
            local result = newLogProbe({
                absent = { logMessage = true },
                raising = { print = "protected" },
            }).run(WITH_CHAT)

            for _, entry in ipairs(result.attempts) do
                assert.is_truthy(entry.token:find(NONCE, 1, true))
            end
        end)

        it("hands no two channels the same token", function()
            local result = newLogProbe().run(WITH_CHAT)
            local seen = {}

            for _, entry in ipairs(result.attempts) do
                assert.is_nil(seen[entry.token])
                seen[entry.token] = entry.id
            end

            assert.equal(#ALL_CHANNEL_IDS, #result.attempts)
        end)
    end)

    describe("a channel the build defines", function()
        for _, channel in ipairs(SIMPLE_CHANNELS) do
            it("calls " .. channel.dep .. " and files " .. channel.id .. " as written", function()
                local probe, client = newLogProbe()

                local entry = attemptFor(probe.run(optionsFor(channel)), channel.id)

                assert.equal("written", entry.status)
                assert.is_nil(entry.detail)
                assert.equal(entry.token, firstArgument(client, channel.dep))
            end)
        end

        it("hands the token to the channel and nothing else", function()
            local probe, client = newLogProbe()

            probe.run(WITH_CHAT)

            assert.equal(1, #client.calls.print)
            assert.equal(1, #client.calls.print[1])
        end)
    end)

    describe("a channel the build does not define", function()
        for _, channel in ipairs(SIMPLE_CHANNELS) do
            it("files " .. channel.id .. " as absent rather than raising", function()
                local probe = newLogProbe({ absent = { [channel.dep] = true } })
                local options = optionsFor(channel)

                assert.has_no.errors(function()
                    probe.run(options)
                end)

                local entry = attemptFor(probe.run(options), channel.id)
                assert.equal("absent", entry.status)
                assert.is_string(entry.detail)
                assert.is_true(#entry.detail > 0)
            end)
        end

        it("still probes every other channel", function()
            local result = newLogProbe({
                absent = { logMessage = true, sendSystemMessage = true },
            }).run(WITH_CHAT)

            assert.same(ALL_CHANNEL_IDS, ids(result))
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
                local options = optionsFor(channel)

                assert.has_no.errors(function()
                    probe.run(options)
                end)

                local entry = attemptFor(probe.run(options), channel.id)
                assert.equal("failed", entry.status)
                assert.is_truthy(entry.detail:find("protected function", 1, true))
            end)
        end

        it("runs every later channel all the same", function()
            local probe, client = newLogProbe({ raising = { logMessage = "boom" } })

            local result = probe.run(WITH_CHAT)

            assert.same(ALL_CHANNEL_IDS, ids(result))
            for _, id in ipairs(ALL_CHANNEL_IDS) do
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

            assert.has_no.errors(function()
                probe.run(WITH_CHAT)
            end)

            local result = probe.run(WITH_CHAT)
            assert.same(ALL_CHANNEL_IDS, ids(result))
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

            local result = probe.run(WITH_CHAT)

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

    describe("chat logging, on a run that asked for the chat channels", function()
        -- The only case that may ask the player to run /chatlog: the probe read the switch,
        -- found it off, and turned it on, so switching it back off restores exactly what it
        -- found.
        it("turns it on when it was off, says it did, and reports having touched it", function()
            local probe, client = newLogProbe({ chatLogging = false })

            local result = probe.run(WITH_CHAT)

            assert.is_false(result.chatLoggingWasOn)
            assert.is_true(result.chatLoggingTouched)
            assert.same({ true }, client.setChatLoggingCalls)
            assert.is_number(indexOf(result.lines, ADVICE_KNOWN))
            assert.is_nil(indexOf(result.lines, ADVICE_UNKNOWN))
        end)

        -- Somebody who was already logging their chat for their own reasons must not find
        -- the probe touched a switch they own, nor be told to turn off something it did not
        -- turn on.
        it("leaves a switch the player already had on alone", function()
            local probe, client = newLogProbe({ chatLogging = true })

            local result = probe.run(WITH_CHAT)

            assert.is_true(result.chatLoggingWasOn)
            assert.is_false(result.chatLoggingTouched)
            assert.same({}, client.setChatLoggingCalls)
            assert.is_nil(indexOf(result.lines, ADVICE_KNOWN))
            assert.is_nil(indexOf(result.lines, ADVICE_UNKNOWN))
        end)

        -- The reason the order exists: the client writes WoWChatLog.txt as it goes and never
        -- backfills it, so a line printed before the switch went on was never a candidate for
        -- the file, and the run would report a channel as written that could never be found.
        it("switches it on before any chat channel is touched", function()
            local probe, client = newLogProbe({ chatLogging = false })

            probe.run(WITH_CHAT)

            local switched = indexOf(client.order, "setChatLogging")
            assert.is_number(switched)
            for _, dep in ipairs(CHAT_DEPS) do
                assert.is_true(switched < indexOf(client.order, dep))
            end
        end)

        it("reads the switch before deciding to write to it", function()
            local probe, client = newLogProbe({ chatLogging = false })

            probe.run(WITH_CHAT)

            assert.is_true(indexOf(client.order, "chatLoggingEnabled") < indexOf(client.order, "setChatLogging"))
        end)

        it("reads the switch before any chat channel is touched", function()
            local probe, client = newLogProbe({ chatLogging = true })

            probe.run(WITH_CHAT)

            local read = indexOf(client.order, "chatLoggingEnabled")
            assert.is_number(read)
            for _, dep in ipairs(CHAT_DEPS) do
                assert.is_true(read < indexOf(client.order, dep))
            end
        end)

        it("still probes the chat channels on a build that cannot switch it", function()
            local probe, client = newLogProbe({
                absent = { chatLoggingEnabled = true, setChatLogging = true },
            })

            assert.has_no.errors(function()
                probe.run(WITH_CHAT)
            end)

            local result = probe.run(WITH_CHAT)
            assert.is_false(result.chatLoggingWasOn)
            assert.is_false(result.chatLoggingTouched)
            for _, id in ipairs(CHAT_CHANNEL_IDS) do
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

                    assert.has_no.errors(function()
                        probe.run(WITH_CHAT)
                    end)
                end)

                it("probes every channel regardless", function()
                    local result = newLogProbe({ raising = case.raising }).run(WITH_CHAT)

                    assert.same(ALL_CHANNEL_IDS, ids(result))
                    for _, id in ipairs(CHAT_CHANNEL_IDS) do
                        assert.equal("written", attemptFor(result, id).status)
                    end
                end)

                it("does not claim chat logging was already on", function()
                    assert.is_false(newLogProbe({ raising = case.raising }).run(WITH_CHAT).chatLoggingWasOn)
                end)
            end)
        end

        it("tries the switch anyway when reading it raised, since off is the assumption", function()
            local probe, client = newLogProbe({ raising = { chatLoggingEnabled = "protected" } })

            local result = probe.run(WITH_CHAT)

            assert.same({ true }, client.setChatLoggingCalls)
            assert.is_true(result.chatLoggingTouched)
        end)

        -- A build that protects the read but not the write leaves the prior state unknown.
        -- Saying it "was off and is now on" would be a guess, and the player who acts on it —
        -- by running /chatlog — switches off logging that may well have been their own.
        it("says only what is true either way when reading the switch raised", function()
            local result = newLogProbe({ raising = { chatLoggingEnabled = "protected" } }).run(WITH_CHAT)

            assert.is_number(indexOf(result.lines, ADVICE_UNKNOWN))
            assert.is_nil(indexOf(result.lines, ADVICE_KNOWN))
        end)

        it("never tells the player to switch off logging it cannot say it turned on", function()
            local result = newLogProbe({ raising = { chatLoggingEnabled = "protected" } }).run(WITH_CHAT)
            local text = joined(result)

            assert.is_nil(text:find("turns it back off", 1, true))
            assert.is_nil(text:find("/chatlog", 1, true))
        end)

        it("says the unknown line whether the switch it could not read was on or off", function()
            for _, state in ipairs({ true, false }) do
                local result = newLogProbe({
                    chatLogging = state,
                    raising = { chatLoggingEnabled = "protected" },
                }).run(WITH_CHAT)

                assert.is_number(indexOf(result.lines, ADVICE_UNKNOWN))
                assert.is_nil(indexOf(result.lines, ADVICE_KNOWN))
            end
        end)

        -- Claiming to have flipped a switch that refused would send the player off to turn
        -- off something that is still exactly as they left it.
        for _, case in ipairs({
            { label = "a switch that raised when written", options = { raising = { setChatLogging = "protected" } } },
            { label = "a switch the build cannot write", options = { absent = { setChatLogging = true } } },
            {
                label = "a switch it could neither read nor write",
                options = { raising = { chatLoggingEnabled = "protected", setChatLogging = "protected" } },
            },
        }) do
            it("says nothing about chat logging when it did not touch " .. case.label, function()
                local result = newLogProbe(case.options).run(WITH_CHAT)

                assert.is_false(result.chatLoggingTouched)
                assert.is_nil(indexOf(result.lines, ADVICE_KNOWN))
                assert.is_nil(indexOf(result.lines, ADVICE_UNKNOWN))
                assert.is_nil(joined(result):find("chat logging", 1, true))
            end)
        end
    end)

    -- The probe's result is the files, not the chat frame. What it says is a header, the
    -- channels that did not run, and how to go and look; a clean run has nothing in the
    -- middle to say.
    describe("what it tells the player", function()
        it("leads with the nonce and a tally of the run", function()
            local result = newLogProbe({
                absent = { logMessage = true },
                raising = { logErrorMessage = "boom" },
            }).run()

            assert.equal(header(4, 1, 1), result.lines[1])
        end)

        it("counts the chat channels into the tally when they were asked for", function()
            local result = newLogProbe().run(WITH_CHAT)

            assert.equal(header(9, 0, 0), result.lines[1])
        end)

        it("says nothing about any individual channel when every one of them ran", function()
            local result = newLogProbe().run()

            assert.equal(3, #result.lines)
            assert.equal(header(6, 0, 0), result.lines[1])
            for _, id in ipairs(ALL_CHANNEL_IDS) do
                assert.is_nil(joined(result):find(id, 1, true))
            end
        end)

        it("names the one channel that did not run and no others", function()
            local result = newLogProbe({ absent = { logMessage = true } }).run()

            assert.equal(4, #result.lines)
            assert.is_truthy(result.lines[2]:find("c_log_message: absent", 1, true))
            for _, id in ipairs(ALL_CHANNEL_IDS) do
                if id ~= "c_log_message" then
                    assert.is_nil(joined(result):find(id, 1, true))
                end
            end
        end)

        it("names a channel that raised, with what it raised", function()
            local result = newLogProbe({ raising = { createCombatLogMessage = "protected" } }).run()

            assert.equal(4, #result.lines)
            assert.is_truthy(result.lines[2]:find("combat_secure: failed", 1, true))
            assert.is_truthy(result.lines[2]:find("protected", 1, true))
        end)

        -- Without the exact string, the run produced six tokens the player cannot find, and
        -- looking for them before the client has exited finds nothing whatever they type.
        it("ends by saying to quit the game and what to search the Logs folder for", function()
            local result = newLogProbe().run()
            local tail = result.lines[#result.lines - 1] .. "\n" .. result.lines[#result.lines]

            assert.is_truthy(tail:find("quit", 1, true))
            assert.is_truthy(tail:find("/reload", 1, true))
            assert.is_truthy(tail:find("Logs", 1, true))
            assert.is_truthy(tail:find(PREFIX .. "_" .. NONCE, 1, true))
        end)

        it("keeps those two lines last even when a channel and the chat switch had news", function()
            local result = newLogProbe({ absent = { logMessage = true }, chatLogging = false }).run(WITH_CHAT)

            assert.equal(5, #result.lines)
            assert.equal(header(8, 0, 1), result.lines[1])
            assert.is_truthy(result.lines[2]:find("c_log_message: absent", 1, true))
            assert.equal(ADVICE_KNOWN, result.lines[3])
            assert.is_truthy(result.lines[5]:find(PREFIX .. "_" .. NONCE, 1, true))
        end)

        it("keeps them last after the advice given when the switch could not be read", function()
            local result = newLogProbe({ raising = { chatLoggingEnabled = "protected" } }).run(WITH_CHAT)

            assert.equal(4, #result.lines)
            assert.equal(header(9, 0, 0), result.lines[1])
            assert.equal(ADVICE_UNKNOWN, result.lines[2])
            assert.is_truthy(result.lines[4]:find(PREFIX .. "_" .. NONCE, 1, true))
        end)
    end)
end)
