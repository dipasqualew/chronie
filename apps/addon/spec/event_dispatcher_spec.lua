local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newEventDispatcher", function()
    local ns = loader.load()

    -- anyEvent: these tests are about routing mechanics, so they use placeholder event
    -- names and fire events nobody registered. Name validation belongs to the integration
    -- tests, where the names are the addon's real ones.
    ---@return table dispatcher, table frame the fake frame it was built on
    local function newDispatcher()
        local createFrame, frames = fake.newCreateFrame({ anyEvent = true })
        local dispatcher = ns.newEventDispatcher({ createFrame = createFrame })
        return dispatcher, frames[1]
    end

    ---A dispatcher on a client build that does not define `rejectEvents`, so
    ---RegisterEvent raises for those names exactly as the live client's does.
    ---@param rejectEvents string[]
    ---@return table dispatcher, table frame the fake frame it was built on
    local function newRefusingDispatcher(rejectEvents)
        local createFrame, frames = fake.newCreateFrame({ anyEvent = true, rejectEvents = rejectEvents })
        local dispatcher = ns.newEventDispatcher({ createFrame = createFrame })
        return dispatcher, frames[1]
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newEventDispatcher)
    end)

    it("creates exactly one Frame through the injected createFrame", function()
        local createFrame, frames, types = fake.newCreateFrame({ anyEvent = true })

        ns.newEventDispatcher({ createFrame = createFrame })

        assert.equal(1, #frames)
        assert.same({ "Frame" }, types)
    end)

    it("installs an OnEvent script on the frame", function()
        local _, frame = newDispatcher()

        assert.is_function(frame.scripts.OnEvent)
    end)

    it("registers the event on the frame when a handler is added", function()
        local dispatcher, frame = newDispatcher()

        dispatcher.on("PLAYER_LOGIN", function() end)

        assert.equal(1, frame.registered.PLAYER_LOGIN)
        assert.same({ "PLAYER_LOGIN" }, frame.registeredOrder)
    end)

    it("calls the handler when its event fires", function()
        local dispatcher, frame = newDispatcher()
        local calls = 0
        dispatcher.on("PLAYER_LOGIN", function()
            calls = calls + 1
        end)

        frame:fire("PLAYER_LOGIN")

        assert.equal(1, calls)
    end)

    it("passes the event payload to the handler, without the event name", function()
        local dispatcher, frame = newDispatcher()
        local received
        dispatcher.on("CHAT_MSG_SAY", function(...)
            received = { n = select("#", ...), ... }
        end)

        frame:fire("CHAT_MSG_SAY", "hello", "Thrall", 42)

        assert.same({ n = 3, "hello", "Thrall", 42 }, received)
    end)

    it("passes no arguments when the event carries no payload", function()
        local dispatcher, frame = newDispatcher()
        local argCount
        dispatcher.on("PLAYER_LOGIN", function(...)
            argCount = select("#", ...)
        end)

        frame:fire("PLAYER_LOGIN")

        assert.equal(0, argCount)
    end)

    it("preserves nil holes in the payload", function()
        local dispatcher, frame = newDispatcher()
        local received
        dispatcher.on("SOME_EVENT", function(...)
            received = { n = select("#", ...), ... }
        end)

        frame:fire("SOME_EVENT", nil, "tail")

        assert.equal(2, received.n)
        assert.is_nil(received[1])
        assert.equal("tail", received[2])
    end)

    it("ignores events that have no registered handler", function()
        local dispatcher, frame = newDispatcher()
        local calls = 0
        dispatcher.on("PLAYER_LOGIN", function()
            calls = calls + 1
        end)

        assert.has_no.errors(function()
            frame:fire("BANK_FRAME_OPENED", "payload")
        end)
        assert.equal(0, calls)
    end)

    it("ignores every event when nothing was registered at all", function()
        local _, frame = newDispatcher()

        assert.has_no.errors(function()
            frame:fire("PLAYER_LOGIN")
        end)
    end)

    it("routes each event only to its own handler", function()
        local dispatcher, frame = newDispatcher()
        local seen = {}
        dispatcher.on("A", function()
            seen[#seen + 1] = "a"
        end)
        dispatcher.on("B", function()
            seen[#seen + 1] = "b"
        end)

        frame:fire("B")
        frame:fire("A")
        frame:fire("B")

        assert.same({ "b", "a", "b" }, seen)
    end)

    it("replaces the handler when on is called again for the same event", function()
        local dispatcher, frame = newDispatcher()
        local seen = {}
        dispatcher.on("PLAYER_LOGIN", function()
            seen[#seen + 1] = "first"
        end)
        dispatcher.on("PLAYER_LOGIN", function()
            seen[#seen + 1] = "second"
        end)

        frame:fire("PLAYER_LOGIN")

        assert.same({ "second" }, seen)
    end)

    describe("an event this client build does not define", function()
        it("reports success when the client accepts the event", function()
            local dispatcher = newDispatcher()

            assert.is_true(dispatcher.on("PLAYER_LOGIN", function() end))
        end)

        it("reports failure when the client refuses the event", function()
            local dispatcher = newRefusingDispatcher({ "MISSING_EVENT" })

            assert.is_false(dispatcher.on("MISSING_EVENT", function() end))
        end)

        it("raises nothing of its own when the client refuses the event", function()
            local dispatcher = newRefusingDispatcher({ "MISSING_EVENT" })

            assert.has_no.errors(function()
                dispatcher.on("MISSING_EVENT", function() end)
            end)
        end)

        it("leaves the event unregistered on the frame", function()
            local dispatcher, frame = newRefusingDispatcher({ "MISSING_EVENT" })

            dispatcher.on("MISSING_EVENT", function() end)

            assert.is_nil(frame.registered.MISSING_EVENT)
            assert.same({}, frame.registeredOrder)
        end)

        -- The handler must not be installed even so: a client that refused the name will
        -- never deliver the event, and half-wiring it would hide the refusal.
        it("installs no handler for a refused event", function()
            local dispatcher, frame = newRefusingDispatcher({ "MISSING_EVENT" })
            local calls = 0
            dispatcher.on("MISSING_EVENT", function()
                calls = calls + 1
            end)

            frame:fire("MISSING_EVENT")

            assert.equal(0, calls)
        end)

        -- The regression this whole seam exists for: ns.main subscribes in a straight
        -- line, so a raise from one RegisterEvent used to abort every subscription after
        -- it. One refused name may cost its own event and nothing else.
        it("keeps subscribing after a refused event, and the later handler still fires", function()
            local dispatcher, frame = newRefusingDispatcher({ "MISSING_EVENT" })
            local calls = 0

            dispatcher.on("MISSING_EVENT", function() end)
            local accepted = dispatcher.on("PLAYER_LOGIN", function()
                calls = calls + 1
            end)
            frame:fire("PLAYER_LOGIN")

            assert.is_true(accepted)
            assert.equal(1, frame.registered.PLAYER_LOGIN)
            assert.equal(1, calls)
        end)

        it("keeps subscribing through several refusals in a row", function()
            local dispatcher, frame = newRefusingDispatcher({ "FIRST_MISSING", "SECOND_MISSING" })
            local seen = {}

            dispatcher.on("FIRST_MISSING", function() end)
            dispatcher.on("PLAYER_LOGIN", function()
                seen[#seen + 1] = "login"
            end)
            dispatcher.on("SECOND_MISSING", function() end)
            dispatcher.on("PLAYER_LOGOUT", function()
                seen[#seen + 1] = "logout"
            end)
            frame:fire("PLAYER_LOGIN")
            frame:fire("PLAYER_LOGOUT")

            assert.same({ "login", "logout" }, seen)
            assert.same({ "PLAYER_LOGIN", "PLAYER_LOGOUT" }, frame.registeredOrder)
        end)
    end)

    describe("unsupported", function()
        it("is empty before anything is subscribed at all", function()
            local dispatcher = newDispatcher()

            assert.same({}, dispatcher.unsupported())
        end)

        it("is empty when the client accepted every event", function()
            local dispatcher = newDispatcher()

            dispatcher.on("PLAYER_LOGIN", function() end)
            dispatcher.on("PLAYER_LOGOUT", function() end)

            assert.same({}, dispatcher.unsupported())
        end)

        it("names the refused event", function()
            local dispatcher = newRefusingDispatcher({ "MISSING_EVENT" })

            dispatcher.on("MISSING_EVENT", function() end)

            assert.same({ "MISSING_EVENT" }, dispatcher.unsupported())
        end)

        it("lists every refused event in registration order", function()
            local dispatcher = newRefusingDispatcher({ "FIRST_MISSING", "SECOND_MISSING" })

            dispatcher.on("SECOND_MISSING", function() end)
            dispatcher.on("PLAYER_LOGIN", function() end)
            dispatcher.on("FIRST_MISSING", function() end)

            assert.same({ "SECOND_MISSING", "FIRST_MISSING" }, dispatcher.unsupported())
        end)

        it("records a refused event once per subscription attempt", function()
            local dispatcher = newRefusingDispatcher({ "MISSING_EVENT" })

            dispatcher.on("MISSING_EVENT", function() end)
            dispatcher.on("MISSING_EVENT", function() end)

            assert.same({ "MISSING_EVENT", "MISSING_EVENT" }, dispatcher.unsupported())
        end)

        -- The caller is handed a report to print, not the dispatcher's own bookkeeping;
        -- emptying or appending to it must not change what the next call says.
        it("hands back a copy, so mutating it cannot corrupt a later call", function()
            local dispatcher = newRefusingDispatcher({ "MISSING_EVENT" })
            dispatcher.on("MISSING_EVENT", function() end)

            local first = dispatcher.unsupported()
            first[1] = "TAMPERED"
            first[2] = "ALSO_TAMPERED"

            assert.same({ "MISSING_EVENT" }, dispatcher.unsupported())
        end)
    end)

    it("keeps dispatchers isolated from one another", function()
        local first, firstFrame = newDispatcher()
        local second, secondFrame = newDispatcher()
        local firstCalls, secondCalls = 0, 0
        first.on("PLAYER_LOGIN", function()
            firstCalls = firstCalls + 1
        end)
        second.on("PLAYER_LOGIN", function()
            secondCalls = secondCalls + 1
        end)

        firstFrame:fire("PLAYER_LOGIN")

        assert.equal(1, firstCalls)
        assert.equal(0, secondCalls)
        assert.is_nil(secondFrame.registered.OTHER)
    end)
end)
