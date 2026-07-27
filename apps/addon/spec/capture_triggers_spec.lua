local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newCaptureTriggers", function()
    local ns = loader.load()

    local NOW = 1700000000

    ---@param options table? `{ triggers, clock, cooldownSeconds }`
    ---@return CaptureTriggers triggers, table clock
    local function newTriggers(options)
        options = options or {}
        local clock = options.clock or fake.newClock(NOW)
        local triggers = ns.newCaptureTriggers({
            triggers = options.triggers or { "accountFirstAchievement" },
            now = clock.now,
            cooldownSeconds = options.cooldownSeconds,
        })
        return triggers, clock
    end

    ---@param overrides table?
    ---@return CaptureEvent
    local function achievement(overrides)
        local event = { kind = "achievement", id = 12345, accountFirst = true }
        for key, value in pairs(overrides or {}) do
            event[key] = value
        end
        return event
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newCaptureTriggers)
    end)

    describe("the allowlist", function()
        -- The one thing the issue asks for by name, and the default the addon ships with.
        it("captures an account-first achievement", function()
            local triggers = newTriggers()

            local decision = triggers.consider(achievement())

            assert.equal("accountFirstAchievement", decision.trigger)
        end)

        -- The whole reason the account-first flag is the trigger rather than the event:
        -- clearing an old raid fires thirty of these and none of them is a memory.
        it("leaves an achievement the account already had alone", function()
            local triggers = newTriggers()

            assert.is_nil(triggers.consider(achievement({ accountFirst = false })))
        end)

        it("captures every achievement for somebody who asked for that", function()
            local triggers = newTriggers({ triggers = { "achievement" } })

            local decision = triggers.consider(achievement({ accountFirst = false }))

            assert.equal("achievement", decision.trigger)
        end)

        -- Most specific first: allowing only the general rule must still photograph the
        -- account first, or "every achievement" would quietly mean "every one but those".
        it("falls back to the general rule for an account first", function()
            local triggers = newTriggers({ triggers = { "achievement" } })

            local decision = triggers.consider(achievement())

            assert.equal("achievement", decision.trigger)
        end)

        it("captures nothing at all for an empty allowlist", function()
            for _, list in ipairs({ {}, nil }) do
                local triggers = newTriggers({ triggers = list or {} })

                assert.is_nil(triggers.consider(achievement()))
            end
        end)

        it("ignores a trigger name that means nothing", function()
            local triggers = newTriggers({ triggers = { "photographEverything" } })

            assert.is_nil(triggers.consider(achievement()))
        end)

        it("ignores an event kind it has no rule for", function()
            local triggers = newTriggers({ triggers = { "accountFirstAchievement" } })

            assert.is_nil(triggers.consider({ kind = "reputation", id = 2600 }))
        end)

        for _, case in ipairs({
            { kind = "levelUp", id = 70, trigger = "levelUp" },
            { kind = "mount", id = 1234, trigger = "mount" },
            { kind = "pet", id = 42, trigger = "pet" },
            { kind = "toy", id = 999, trigger = "toy" },
            { kind = "keystone", id = 375, trigger = "keystone" },
            { kind = "transmog", id = 30001, trigger = "transmog" },
        }) do
            it("captures a " .. case.kind .. " when that rule is allowed", function()
                local triggers = newTriggers({ triggers = { case.trigger } })

                local decision = triggers.consider({ kind = case.kind, id = case.id })

                assert.equal(case.trigger, decision.trigger)
            end)

            it("leaves a " .. case.kind .. " alone when it is not", function()
                local triggers = newTriggers({ triggers = { "accountFirstAchievement" } })

                assert.is_nil(triggers.consider({ kind = case.kind, id = case.id }))
            end)
        end

        -- The same specific-then-general shape the achievement has, and worth its own case:
        -- emptying a bag at a vendor collects a dozen sources at once and one of them being
        -- a look nobody owned is the only part of that worth a photograph.
        it("tells an appearance new to the collection from another item wearing an old one", function()
            local triggers = newTriggers({ triggers = { "newAppearance" } })

            assert.equal("newAppearance", triggers.consider({
                kind = "transmog", id = 30001, newAppearance = true,
            }).trigger)
            assert.is_nil(triggers.consider({
                kind = "transmog", id = 30002, newAppearance = false,
            }))
        end)

        it("captures every transmog source for somebody who asked for that", function()
            local triggers = newTriggers({ triggers = { "transmog" } })

            assert.equal("transmog", triggers.consider({
                kind = "transmog", id = 30002, newAppearance = false,
            }).trigger)
            assert.equal("transmog", triggers.consider({
                kind = "transmog", id = 30001, newAppearance = true,
            }).trigger)
        end)

        it("tells a keystone that beat the timer from one that did not", function()
            local triggers = newTriggers({ triggers = { "keystoneOnTime" } })

            assert.equal("keystoneOnTime", triggers.consider({
                kind = "keystone", id = 375, onTime = true,
            }).trigger)
            assert.is_nil(triggers.consider({ kind = "keystone", id = 375, onTime = false }))
        end)
    end)

    describe("what the capture hangs off", function()
        -- The epic asks for the screenshot to be filed against the achievement, not just
        -- against the segment around it.
        it("names the achievement an achievement capture is of", function()
            local triggers = newTriggers()

            assert.equal(12345, triggers.consider(achievement({ id = 12345 })).achievement)
        end)

        -- Honest about what is known: there is no row downstream with a stable identity
        -- for these, so they hang off the segment and the trigger name and nothing else.
        it("names no achievement for a capture that is not of one", function()
            local triggers = newTriggers({ triggers = { "levelUp" } })

            assert.is_nil(triggers.consider({ kind = "levelUp", id = 70 }).achievement)
        end)

        -- Neither of these reaches an entry. They exist for ns.newCaptureBurst, which has to
        -- choose between several decisions belonging to one moment, and the rank is how it
        -- knows the account first among a raid clear's achievements is the one to keep.
        it("carries the kind the decision came out of", function()
            local triggers = newTriggers({ triggers = { "mount" } })

            assert.equal("mount", triggers.consider({ kind = "mount", id = 1234 }).kind)
        end)

        it("ranks the specific name above the general one", function()
            local specific = newTriggers({ triggers = { "accountFirstAchievement", "achievement" } })
            local general = newTriggers({ triggers = { "accountFirstAchievement", "achievement" } })

            assert.equal(1, specific.consider(achievement()).rank)
            assert.equal(2, general.consider(achievement({ accountFirst = false })).rank)
        end)

        -- The rank belongs to the name, not to the event that matched it. A player who
        -- allowed only the general rule gets rank 2 for both kinds of achievement, so a
        -- raid clear is decided by which arrived first rather than by an account first
        -- being handed a rank that says it is more specific than a rule it did not match.
        it("ranks two events that matched the same name equally", function()
            local first = newTriggers({ triggers = { "achievement" } })
            local plain = newTriggers({ triggers = { "achievement" } })

            assert.equal(2, first.consider(achievement()).rank)
            assert.equal(2, plain.consider(achievement({ accountFirst = false })).rank)
        end)

        it("ranks a kind with only one name at the top", function()
            local triggers = newTriggers({ triggers = { "mount" } })

            assert.equal(1, triggers.consider({ kind = "mount", id = 1234 }).rank)
        end)
    end)

    describe("the rate limit", function()
        -- Thirty achievements in a minute must not be thirty screenshots of one corridor.
        it("refuses a second capture inside the cooldown", function()
            local triggers = newTriggers()
            triggers.consider(achievement())
            triggers.taken()

            assert.is_nil(triggers.consider(achievement({ id = 2 })))
        end)

        it("allows one again once the cooldown has passed", function()
            local triggers, clock = newTriggers({ cooldownSeconds = 60 })
            triggers.consider(achievement())
            triggers.taken()

            clock.advance(59)
            assert.is_nil(triggers.consider(achievement({ id = 2 })))

            clock.advance(1)
            assert.is_table(triggers.consider(achievement({ id = 2 })))
        end)

        it("takes one picture of a raid clear rather than thirty", function()
            local triggers, clock = newTriggers()
            local taken = 0

            for id = 1, 30 do
                if triggers.consider(achievement({ id = id })) then
                    taken = taken + 1
                    triggers.taken()
                end
                clock.advance(2)
            end

            assert.equal(1, taken)
        end)

        -- consider() only proposes. The entry log has refusals of its own, and a minute of
        -- silence spent on a picture nobody took would lose the next thing worth one.
        it("does not start until a capture has actually been taken", function()
            local triggers = newTriggers()

            triggers.consider(achievement())

            assert.is_table(triggers.consider(achievement({ id = 2 })))
        end)

        it("survives a clock that jumps backwards", function()
            local triggers, clock = newTriggers()
            triggers.consider(achievement())
            triggers.taken()

            clock.set(NOW - 3600)

            assert.is_table(triggers.consider(achievement({ id = 2 })))
        end)
    end)

    describe("what is between the player and the world", function()
        it("takes no picture of a loading screen", function()
            local triggers = newTriggers()

            triggers.obscured("loading", true)

            assert.is_false(triggers.visible())
            assert.is_nil(triggers.consider(achievement()))
        end)

        it("takes one again once the loading screen has lifted", function()
            local triggers = newTriggers()
            triggers.obscured("loading", true)

            triggers.obscured("loading", false)

            assert.is_true(triggers.visible())
            assert.is_table(triggers.consider(achievement()))
        end)

        -- A cinematic that ends in a loading screen is one continuous stretch of seeing
        -- nothing, so lifting either one on its own must not declare the world back.
        it("stays hidden while any one obstruction is still up", function()
            local triggers = newTriggers()
            triggers.obscured("cinematic", true)
            triggers.obscured("loading", true)

            triggers.obscured("cinematic", false)

            assert.is_nil(triggers.consider(achievement()))

            triggers.obscured("loading", false)

            assert.is_table(triggers.consider(achievement()))
        end)

        it("is not confused by the same obstruction lifting twice", function()
            local triggers = newTriggers()
            triggers.obscured("loading", true)

            triggers.obscured("loading", false)
            triggers.obscured("loading", false)

            assert.is_true(triggers.visible())
        end)

        it("starts with the world on screen", function()
            assert.is_true(newTriggers().visible())
        end)

        -- Dropped rather than deferred: the picture that would come back is worthless, and
        -- a queued shutter would fire over whatever the player is looking at next.
        it("does not spend the rate limit on a capture it suppressed", function()
            local triggers = newTriggers()
            triggers.obscured("loading", true)
            triggers.consider(achievement())

            triggers.obscured("loading", false)

            assert.is_table(triggers.consider(achievement({ id = 2 })))
        end)
    end)
end)
