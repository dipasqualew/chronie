local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newEventDispatcher", function()
    local ns = loader.load()

    ---@return table dispatcher, table frame the fake frame it was built on
    local function newDispatcher()
        local createFrame, frames = fake.newCreateFrame()
        local dispatcher = ns.newEventDispatcher({ createFrame = createFrame })
        return dispatcher, frames[1]
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newEventDispatcher)
    end)

    it("creates exactly one Frame through the injected createFrame", function()
        local createFrame, frames, types = fake.newCreateFrame()

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
