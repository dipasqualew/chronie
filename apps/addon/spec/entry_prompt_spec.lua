local loader = require("addon_loader")
local fake = require("fake_wow")

---The offer to say something about what was just captured, with no frame anywhere near it.
---
---Every rule the toast leans on lives here — when the offer lapses, what a submitted note
---lands on, what happens when a second capture arrives while the first is still being typed
---into — and all of them are decided against a clock a test can move by hand. That is the
---whole reason the module holds no frame: the alternative is proving a twenty-second timeout
---by waiting twenty seconds.
describe("ns.newEntryPrompt", function()
    local ns = loader.load()

    local NOW = 1700000000
    local WINDOW = 20

    ---An entry of the shape ns.newEntryLog writes, which is all this module reads of one.
    ---@param overrides table?
    ---@return EntryRecord
    local function newEntry(overrides)
        local entry = {
            id = "account|" .. NOW .. "|1",
            at = NOW,
            stamp = "<stamp>",
            hasImage = true,
        }
        for key, value in pairs(overrides or {}) do
            entry[key] = value
        end
        return entry
    end

    ---@param options table? `{ clock, windowSeconds }`
    ---@return EntryPrompt prompt, table recorded, table clock
    local function newPrompt(options)
        options = options or {}
        local clock = options.clock or fake.newClock(NOW)
        local recorded = { shown = {}, hidden = {}, attached = {} }

        local prompt = ns.newEntryPrompt({
            now = clock.now,
            attach = function(entry, text)
                recorded.attached[#recorded.attached + 1] = { entry = entry, text = text }
            end,
            onShow = function(entry)
                recorded.shown[#recorded.shown + 1] = entry
            end,
            onHide = function(entry, annotated)
                recorded.hidden[#recorded.hidden + 1] = { entry = entry, annotated = annotated }
            end,
            windowSeconds = options.windowSeconds,
        })
        return prompt, recorded, clock
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newEntryPrompt)
    end)

    -- Nothing here has a frame to build, so a prompt with no handlers at all has to work:
    -- both hooks are optional and the module must not assume either is there.
    it("runs with no onShow and no onHide", function()
        local prompt = ns.newEntryPrompt({
            now = function()
                return NOW
            end,
            attach = function() end,
        })
        local entry = newEntry()

        assert.is_true(prompt.offer(entry))
        assert.equal(entry, prompt.engage())
        assert.equal(entry, prompt.submit("something"))
    end)

    describe("offering one", function()
        it("takes the entry and says so", function()
            local prompt, recorded = newPrompt()
            local entry = newEntry()

            assert.is_true(prompt.offer(entry))
            assert.same({ entry }, recorded.shown)
        end)

        -- The entry log refuses a capture for reasons of its own — a press in the same second,
        -- a world that has not loaded — and hands back nil for it. Nothing is offered on it.
        it("refuses nothing at all", function()
            local prompt, recorded = newPrompt()

            assert.is_false(prompt.offer(nil))
            assert.same({}, recorded.shown)
            assert.is_nil(prompt.pending())
        end)

        it("shows the entry it was handed rather than a copy of it", function()
            local prompt, recorded = newPrompt()
            local entry = newEntry()

            prompt.offer(entry)

            assert.equal(entry, recorded.shown[1])
        end)
    end)

    describe("what a note would attach to", function()
        it("is the entry that was offered", function()
            local prompt = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)

            assert.equal(entry, prompt.pending())
        end)

        it("is nothing before anything has been offered", function()
            local prompt = newPrompt()

            assert.is_nil(prompt.pending())
        end)

        -- The offer is gone the instant the clock says so, whether or not anything has ticked
        -- yet: a note submitted a moment after the window closed lands nowhere, and a toast
        -- still on screen because its OnUpdate has not run is not an offer.
        it("is nothing once the window has passed, even before anything ticked", function()
            local prompt, _, clock = newPrompt()
            prompt.offer(newEntry())

            clock.advance(WINDOW)

            assert.is_nil(prompt.pending())
        end)

        it("is still the entry one second short of the window", function()
            local prompt, _, clock = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)

            clock.advance(WINDOW - 1)

            assert.equal(entry, prompt.pending())
        end)

        it("honours a window somebody else chose", function()
            local prompt, _, clock = newPrompt({ windowSeconds = 5 })
            prompt.offer(newEntry())

            clock.advance(4)
            assert.is_table(prompt.pending())

            clock.advance(1)
            assert.is_nil(prompt.pending())
        end)
    end)

    describe("the tick that expires it", function()
        it("closes a lapsed offer and says nobody wrote anything", function()
            local prompt, recorded, clock = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)

            clock.advance(WINDOW)

            assert.is_false(prompt.tick())
            assert.same({ { entry = entry, annotated = false } }, recorded.hidden)
        end)

        it("leaves an offer inside its window alone", function()
            local prompt, recorded, clock = newPrompt()
            prompt.offer(newEntry())

            clock.advance(WINDOW - 1)

            assert.is_true(prompt.tick())
            assert.same({}, recorded.hidden)
        end)

        -- The toast's OnUpdate runs every frame, which is sixty times a second for as long as
        -- the toast is up and once more after it has gone.
        it("closes a lapsed offer exactly once however often it is called", function()
            local prompt, recorded, clock = newPrompt()
            prompt.offer(newEntry())
            clock.advance(WINDOW)

            for _ = 1, 10 do
                prompt.tick()
            end

            assert.equal(1, #recorded.hidden)
        end)

        it("says there is nothing open when nothing was ever offered", function()
            local prompt, recorded = newPrompt()

            assert.is_false(prompt.tick())
            assert.same({}, recorded.hidden)
        end)
    end)

    -- The one thing that stops the clock is somebody typing: taking the box away mid-sentence
    -- is worse than a toast that outstays its welcome.
    describe("engaging", function()
        it("answers the entry being annotated", function()
            local prompt = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)

            assert.equal(entry, prompt.engage())
        end)

        it("stops the clock, so the offer outlives its window", function()
            local prompt, recorded, clock = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)

            prompt.engage()
            clock.advance(WINDOW * 100)

            assert.equal(entry, prompt.pending())
            assert.is_true(prompt.tick())
            assert.same({}, recorded.hidden)
        end)

        it("lands a note written long after the window closed", function()
            local prompt, recorded, clock = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)
            prompt.engage()

            clock.advance(600)

            assert.equal(entry, prompt.submit("took a while to find the words"))
            assert.same({ { entry = entry, text = "took a while to find the words" } },
                recorded.attached)
        end)

        -- A click that arrives on a toast whose offer has already gone. There is nothing to
        -- annotate, and this is also the moment to take the toast away.
        it("answers nothing on a lapsed offer, and closes it", function()
            local prompt, recorded, clock = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)
            clock.advance(WINDOW)

            assert.is_nil(prompt.engage())
            assert.same({ { entry = entry, annotated = false } }, recorded.hidden)
            assert.is_nil(prompt.pending())
        end)

        it("answers nothing when nothing was offered, and hides nothing", function()
            local prompt, recorded = newPrompt()

            assert.is_nil(prompt.engage())
            assert.same({}, recorded.hidden)
        end)
    end)

    -- Clicking away leaves the toast on screen with nobody typing into it. Rather than throw
    -- away a half-written note or leave it up all evening, the clock starts again from here.
    describe("releasing", function()
        it("starts the window again from now", function()
            local prompt, _, clock = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)
            prompt.engage()
            clock.advance(600)

            prompt.release()

            clock.advance(WINDOW - 1)
            assert.equal(entry, prompt.pending())
            clock.advance(1)
            assert.is_nil(prompt.pending())
        end)

        it("leaves an offer nobody engaged on its original clock", function()
            local prompt, _, clock = newPrompt()
            prompt.offer(newEntry())
            clock.advance(WINDOW - 1)

            prompt.release()

            clock.advance(1)
            assert.is_nil(prompt.pending())
        end)

        it("does nothing at all when there is no offer", function()
            local prompt, recorded = newPrompt()

            prompt.release()

            assert.is_nil(prompt.pending())
            assert.same({}, recorded.hidden)
        end)
    end)

    describe("a second capture arriving", function()
        -- The note somebody is writing is about the picture they were offered, and moving the
        -- target would file it against the wrong one.
        it("does not steal the box from somebody mid-sentence", function()
            local prompt, recorded = newPrompt()
            local first = newEntry({ id = "first" })
            local second = newEntry({ id = "second" })
            prompt.offer(first)
            prompt.engage()

            assert.is_false(prompt.offer(second))
            assert.equal(first, prompt.pending())
            assert.same({ first }, recorded.shown)
        end)

        it("files the sentence against the entry it was written about", function()
            local prompt, recorded = newPrompt()
            local first = newEntry({ id = "first" })
            prompt.offer(first)
            prompt.engage()
            prompt.offer(newEntry({ id = "second" }))

            prompt.submit("about the first one")

            assert.same({ { entry = first, text = "about the first one" } }, recorded.attached)
        end)

        -- Nobody is typing, so there is nothing to protect: the newer capture is the one worth
        -- offering, and there is deliberately no queue of offers stacking up through a raid.
        it("replaces an offer nobody has engaged with", function()
            local prompt, recorded = newPrompt()
            local first = newEntry({ id = "first" })
            local second = newEntry({ id = "second" })
            prompt.offer(first)

            assert.is_true(prompt.offer(second))
            assert.equal(second, prompt.pending())
            assert.same({ first, second }, recorded.shown)
        end)

        it("gives the replacement a full window of its own", function()
            local prompt, _, clock = newPrompt()
            prompt.offer(newEntry({ id = "first" }))
            clock.advance(WINDOW - 1)
            local second = newEntry({ id = "second" })

            prompt.offer(second)

            clock.advance(WINDOW - 1)
            assert.equal(second, prompt.pending())
        end)
    end)

    describe("submitting a note", function()
        it("attaches it, answers the entry and says a note landed", function()
            local prompt, recorded = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)

            assert.equal(entry, prompt.submit("the sun coming up over Nagrand"))

            assert.same({ { entry = entry, text = "the sun coming up over Nagrand" } },
                recorded.attached)
            assert.same({ { entry = entry, annotated = true } }, recorded.hidden)
        end)

        -- Sanitised here rather than at the box, because every way in has to be sanitised the
        -- same way. What the store gets is what ns.entryText answered.
        it("attaches the cleaned text rather than what was typed", function()
            local prompt, recorded = newPrompt()
            prompt.offer(newEntry())

            prompt.submit("  |cffff0000two\nlines|r  ")

            assert.equal("two linesr", recorded.attached[1].text)
        end)

        it("closes the offer, so a second submit lands nowhere", function()
            local prompt, recorded = newPrompt()
            prompt.offer(newEntry())
            prompt.submit("the first thing")

            assert.is_nil(prompt.submit("the second thing"))
            assert.equal(1, #recorded.attached)
        end)

        -- A note nobody wrote: the empty string, spaces, and a colour code with nothing
        -- coloured are all the same thing, and none of them is worth writing down.
        for _, case in ipairs({
            { label = "nothing at all", text = nil },
            { label = "the empty string", text = "" },
            { label = "spaces", text = "   " },
            { label = "a newline and a tab", text = "\n\t" },
            { label = "a pipe", text = "|" },
            { label = "a texture and nothing else", text = "|TInterface\\Icons\\foo:16|t" },
        }) do
            it("attaches nothing for " .. case.label, function()
                local prompt, recorded = newPrompt()
                local entry = newEntry()
                prompt.offer(entry)

                assert.is_nil(prompt.submit(case.text))

                assert.same({}, recorded.attached)
                assert.same({ { entry = entry, annotated = false } }, recorded.hidden)
            end)
        end

        it("answers nothing for a note submitted after the window closed", function()
            local prompt, recorded, clock = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)
            clock.advance(WINDOW)

            assert.is_nil(prompt.submit("too late"))

            assert.same({}, recorded.attached)
            assert.same({ { entry = entry, annotated = false } }, recorded.hidden)
        end)

        it("answers nothing when nothing was offered, and hides nothing", function()
            local prompt, recorded = newPrompt()

            assert.is_nil(prompt.submit("about what, exactly"))

            assert.same({}, recorded.attached)
            assert.same({}, recorded.hidden)
        end)
    end)

    describe("dismissing", function()
        it("closes with nothing attached and says nobody wrote anything", function()
            local prompt, recorded = newPrompt()
            local entry = newEntry()
            prompt.offer(entry)

            prompt.dismiss()

            assert.same({}, recorded.attached)
            assert.same({ { entry = entry, annotated = false } }, recorded.hidden)
            assert.is_nil(prompt.pending())
        end)

        -- The re-entrancy guard Escape relies on. Escape reaches a focused box's
        -- OnEscapePressed, which dismisses; the hide that follows runs the frame's OnHide,
        -- which dismisses again. State goes first inside close, so the second call finds
        -- nothing pending and stops there rather than announcing a hide nobody caused.
        it("says nothing at all when there is nothing pending", function()
            local prompt, recorded = newPrompt()

            prompt.dismiss()

            assert.same({}, recorded.hidden)
        end)

        it("announces one hide for a dismiss that arrives twice", function()
            local prompt, recorded = newPrompt()
            prompt.offer(newEntry())

            prompt.dismiss()
            prompt.dismiss()

            assert.equal(1, #recorded.hidden)
        end)

        it("announces no second hide after a note was submitted", function()
            local prompt, recorded = newPrompt()
            prompt.offer(newEntry())
            prompt.submit("something worth keeping")

            prompt.dismiss()

            assert.equal(1, #recorded.hidden)
            assert.is_true(recorded.hidden[1].annotated)
        end)

        it("lets the next capture be offered", function()
            local prompt = newPrompt()
            prompt.offer(newEntry({ id = "first" }))
            prompt.engage()
            prompt.dismiss()
            local second = newEntry({ id = "second" })

            assert.is_true(prompt.offer(second))
            assert.equal(second, prompt.pending())
        end)
    end)

    -- The contract Main.lua's own wiring is built on: a memory that nobody wrote anything
    -- about is a row worth taking back out again, and this is the only moment that says so —
    -- so both halves of it have to be right, whichever way the offer closed.
    describe("the onHide contract", function()
        for _, case in ipairs({
            {
                label = "a note that landed",
                annotated = true,
                close = function(prompt)
                    prompt.submit("something worth keeping")
                end,
            },
            {
                label = "a note nobody typed",
                annotated = false,
                close = function(prompt)
                    prompt.submit("   ")
                end,
            },
            {
                label = "an offer somebody dismissed",
                annotated = false,
                close = function(prompt)
                    prompt.dismiss()
                end,
            },
            {
                label = "an offer that lapsed",
                annotated = false,
                close = function(prompt, clock)
                    clock.advance(WINDOW)
                    prompt.tick()
                end,
            },
            {
                label = "a click on an offer that had already lapsed",
                annotated = false,
                close = function(prompt, clock)
                    clock.advance(WINDOW)
                    prompt.engage()
                end,
            },
        }) do
            it("hands over the entry that was pending and " .. case.label, function()
                local prompt, recorded, clock = newPrompt()
                -- Not the entry the test happens to be holding: an earlier one was offered and
                -- replaced, so the wrong one is reachable and would be caught.
                prompt.offer(newEntry({ id = "an earlier one" }))
                local entry = newEntry({ id = "the one on offer" })
                prompt.offer(entry)
                recorded.hidden = {}

                case.close(prompt, clock)

                assert.equal(1, #recorded.hidden)
                assert.equal(entry, recorded.hidden[1].entry)
                assert.equal(case.annotated, recorded.hidden[1].annotated)
            end)
        end

        -- Booleans rather than nil-or-true, because the caller branches on it and a nil that
        -- reads as false by accident is a memory silently kept or silently thrown away.
        it("says whether a note landed as a boolean either way", function()
            local prompt, recorded = newPrompt()
            prompt.offer(newEntry())
            prompt.submit("kept")
            prompt.offer(newEntry())
            prompt.dismiss()

            assert.is_true(recorded.hidden[1].annotated)
            assert.is_false(recorded.hidden[2].annotated)
        end)

        -- The prompt's state is already clear by the time the hide is announced, which is what
        -- lets the handler discard the entry, look at what is pending, or dismiss straight back
        -- without going round again.
        it("has already forgotten the entry by the time it announces the hide", function()
            local clock = fake.newClock(NOW)
            local seen = {}
            local prompt
            prompt = ns.newEntryPrompt({
                now = clock.now,
                attach = function() end,
                onHide = function()
                    seen[#seen + 1] = { pending = prompt.pending() }
                    -- Exactly what a frame's OnHide does, and it must stop here.
                    prompt.dismiss()
                end,
            })
            prompt.offer(newEntry())

            prompt.dismiss()

            assert.equal(1, #seen)
            assert.is_nil(seen[1].pending)
        end)
    end)
end)
