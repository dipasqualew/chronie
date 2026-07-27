local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newScreenshotWatch", function()
    local ns = loader.load()

    local NOW = 1700000000
    local WINDOW = 5

    ---@param options table? `{ clock, windowSeconds }`
    ---@return ScreenshotWatch watch, table clock
    local function newWatch(options)
        options = options or {}
        local clock = options.clock or fake.newClock(NOW)
        local watch = ns.newScreenshotWatch({
            now = clock.now,
            windowSeconds = options.windowSeconds,
        })
        return watch, clock
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newScreenshotWatch)
    end)

    describe("who took the picture", function()
        -- The whole reason this module exists. SCREENSHOT_SUCCEEDED carries no payload, so
        -- a shot nobody was waiting for is the player pressing the key the client gave
        -- them, and that is the one Chronie is listening for.
        it("reads a shot nobody was waiting for as the player's own", function()
            local watch = newWatch()

            assert.is_false(watch.claim())
        end)

        it("reads the shot after its own shutter press as its own", function()
            local watch = newWatch()

            watch.fired()

            assert.is_true(watch.claim())
        end)

        -- One press, one event. A claim that stood after the event it was waiting for had
        -- arrived would credit Chronie with the player's very next photograph.
        it("only claims a press once", function()
            local watch = newWatch()
            watch.fired()

            watch.claim()

            assert.is_false(watch.claim())
        end)

        -- Two presses can be outstanding at once — the automatic capture that fires while
        -- an earlier shot is still being written — and collapsing them into a flag would
        -- hand the second event to the player as if they had taken it.
        it("claims two outstanding presses, in the order they were made", function()
            local watch = newWatch()

            watch.fired()
            watch.fired()

            assert.is_true(watch.claim())
            assert.is_true(watch.claim())
            assert.is_false(watch.claim())
        end)

        -- A shot that failed resolves its press exactly as a shot that succeeded does: the
        -- client is finished with it either way, and the press must not be left standing to
        -- swallow whatever the player photographs next.
        it("lets the press go when the shot it was waiting for failed", function()
            local watch = newWatch()
            watch.fired()

            watch.claim()

            assert.is_false(watch.claim())
        end)
    end)

    describe("a press whose event never came back", function()
        -- Screenshot() is asynchronous and nothing guarantees an event comes back for it.
        -- Inside the window the press is still the explanation for the shot that landed;
        -- past it, it is a press Chronie has given up on, and the shot belongs to whoever
        -- took it — which, absent anything else waiting, is the player.
        for _, case in ipairs({
            { elapsed = 0, claimed = true },
            { elapsed = 1, claimed = true },
            { elapsed = WINDOW - 1, claimed = true },
            { elapsed = WINDOW, claimed = false },
            { elapsed = WINDOW + 1, claimed = false },
            { elapsed = 3600, claimed = false },
        }) do
            local what = case.claimed and "still claims" or "has forgotten"
            it(what .. " a press made " .. case.elapsed .. " seconds ago", function()
                local watch, clock = newWatch({ windowSeconds = WINDOW })
                watch.fired()

                clock.advance(case.elapsed)

                assert.equal(case.claimed, watch.claim())
            end)
        end
    end)

    describe("the window", function()
        -- The default is what Main.lua gets, since it injects a clock and nothing else.
        it("gives a press five seconds when nobody says otherwise", function()
            local watch, clock = newWatch()
            watch.fired()

            clock.advance(4)
            assert.is_true(watch.claim())

            watch.fired()
            clock.advance(5)
            assert.is_false(watch.claim())
        end)

        -- Expiry happens on the way into a press as well as on the way into a claim, so an
        -- abandoned press cannot sit in front of a fresh one and take its event.
        it("throws an abandoned press away before recording the next one", function()
            local watch, clock = newWatch({ windowSeconds = WINDOW })
            watch.fired()

            clock.advance(WINDOW * 2)
            watch.fired()

            assert.is_true(watch.claim())
            assert.is_false(watch.claim())
        end)

        -- A clock that jumped backwards — a resync mid-session — must not make a press that
        -- is still perfectly fresh look ancient. The picture would be credited to the
        -- player, and Chronie would file a second marker beside the one it already wrote.
        it("survives a clock that jumps backwards", function()
            local watch, clock = newWatch({ windowSeconds = WINDOW })
            watch.fired()

            clock.set(NOW - 3600)

            assert.is_true(watch.claim())
        end)
    end)
end)
