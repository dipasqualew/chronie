local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newCaptureBurst", function()
    local ns = loader.load()

    local NOW = 1700000000

    ---@param options table? `{ windowSeconds, clock }`
    ---@return CaptureBurst burst, table taken, table scheduler, table clock
    local function newBurst(options)
        options = options or {}
        local clock = options.clock or fake.newClock(NOW)
        local scheduler = fake.newScheduler(clock)
        ---Every photograph the burst asked for, in order. The whole observable behaviour of
        ---this module is how long this list is and what is in it.
        local taken = {}
        local burst = ns.newCaptureBurst({
            after = scheduler.after,
            capture = function(decision)
                taken[#taken + 1] = decision
            end,
            windowSeconds = options.windowSeconds,
        })
        return burst, taken, scheduler, clock
    end

    ---A decision shaped the way ns.newCaptureTriggers hands them over.
    ---@param overrides table?
    ---@return CaptureDecision
    local function decision(overrides)
        local made = { trigger = "achievement", kind = "achievement", rank = 1 }
        for key, value in pairs(overrides or {}) do
            made[key] = value
        end
        return made
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newCaptureBurst)
    end)

    describe("collapsing a moment", function()
        -- The acceptance criterion. A boss kill that earns the boss, the wing and the meta
        -- all at once is one photograph of the corridor, not four of it.
        it("takes one photograph however many decisions the moment offers", function()
            local burst, taken, scheduler = newBurst()

            for id = 1, 4 do
                burst.offer(decision({ achievement = id }))
            end
            scheduler.settle()

            assert.equal(1, #taken)
        end)

        it("photographs nothing until the window has closed", function()
            local burst, taken = newBurst()

            burst.offer(decision())

            assert.equal(0, #taken)
        end)

        -- The window is what the addon waits on, and it is measured in a resolution the
        -- addon's own clock does not have. Asserting on it here is the only place that can.
        it("waits the default half second", function()
            local burst, _, scheduler, clock = newBurst()

            burst.offer(decision())

            assert.equal(0, scheduler.run())
            clock.advance(0.5)
            assert.equal(1, scheduler.run())
        end)

        it("waits however long it was told to", function()
            local burst, _, scheduler, clock = newBurst({ windowSeconds = 2 })

            burst.offer(decision())

            clock.advance(1)
            assert.equal(0, scheduler.run())
            clock.advance(1)
            assert.equal(1, scheduler.run())
        end)

        -- A trickle must not postpone the picture indefinitely: the window belongs to the
        -- moment, so the second offer does not buy the first another half second.
        it("does not restart the window when another decision arrives", function()
            local burst, taken, scheduler, clock = newBurst()
            burst.offer(decision({ achievement = 1 }))

            clock.advance(0.4)
            burst.offer(decision({ achievement = 2 }))
            clock.advance(0.1)

            assert.equal(1, scheduler.run())
            assert.equal(1, #taken)
        end)

        it("opens a fresh window for the next moment", function()
            local burst, taken, scheduler = newBurst()
            burst.offer(decision({ achievement = 1 }))
            scheduler.settle()

            burst.offer(decision({ achievement = 2 }))
            scheduler.settle()

            assert.equal(2, #taken)
            assert.equal(2, taken[2].achievement)
        end)

        -- Taking a photograph is not instant — an entry is written and a prompt offered —
        -- and a decision arriving during that belongs to the next moment rather than to the
        -- one that has already been photographed.
        it("does not fold a decision into a window that has already fired", function()
            local clock = fake.newClock(NOW)
            local scheduler = fake.newScheduler(clock)
            local taken = {}
            local burst
            burst = ns.newCaptureBurst({
                after = scheduler.after,
                capture = function(made)
                    taken[#taken + 1] = made
                    if #taken == 1 then
                        burst.offer(decision({ achievement = 99 }))
                    end
                end,
            })

            burst.offer(decision({ achievement = 1 }))
            scheduler.settle()

            assert.equal(2, #taken)
            assert.equal(99, taken[2].achievement)
        end)

        it("ignores being offered nothing", function()
            local burst, taken, scheduler = newBurst()

            assert.is_false(burst.offer(nil))
            scheduler.settle()

            assert.equal(0, #taken)
            assert.equal(0, scheduler.pending())
        end)
    end)

    describe("which decision the moment is filed against", function()
        it("keeps the one that opened the window", function()
            local burst, taken, scheduler = newBurst()

            burst.offer(decision({ achievement = 1 }))
            burst.offer(decision({ achievement = 2 }))
            scheduler.settle()

            assert.equal(1, taken[1].achievement)
        end)

        -- A raid clear where the third achievement is the one nobody on the account had.
        -- Both rules are allowed, the plain one arrives first, and the picture should still
        -- be filed as the account first — that is the memory, the other twenty-nine are not.
        it("lets a more specific decision of the same kind displace the holder", function()
            local burst, taken, scheduler = newBurst()

            burst.offer(decision({ trigger = "achievement", rank = 2, achievement = 1 }))
            local displaced = burst.offer(decision({
                trigger = "accountFirstAchievement",
                rank = 1,
                achievement = 2,
            }))
            scheduler.settle()

            assert.is_true(displaced)
            assert.equal(1, #taken)
            assert.equal("accountFirstAchievement", taken[1].trigger)
            assert.equal(2, taken[1].achievement)
        end)

        it("leaves the holder alone when a less specific one of the same kind arrives", function()
            local burst, taken, scheduler = newBurst()

            burst.offer(decision({ trigger = "accountFirstAchievement", rank = 1 }))
            local displaced = burst.offer(decision({ trigger = "achievement", rank = 2 }))
            scheduler.settle()

            assert.is_false(displaced)
            assert.equal("accountFirstAchievement", taken[1].trigger)
        end)

        -- Rank is an index into one kind's own candidate list. Comparing a mount's against
        -- an achievement's would be comparing two different rulers, so arrival order decides.
        it("does not let one kind outrank another", function()
            local burst, taken, scheduler = newBurst()

            burst.offer(decision({ trigger = "keystone", kind = "keystone", rank = 2 }))
            burst.offer(decision({ trigger = "mount", kind = "mount", rank = 1 }))
            scheduler.settle()

            assert.equal("keystone", taken[1].trigger)
        end)

        it("says what the open window is holding", function()
            local burst, _, scheduler = newBurst()

            assert.is_nil(burst.pending())
            burst.offer(decision({ achievement = 7 }))
            assert.equal(7, burst.pending().achievement)

            scheduler.settle()
            assert.is_nil(burst.pending())
        end)
    end)
end)
