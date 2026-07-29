local loader = require("addon_loader")
local fake = require("fake_wow")

---The frame half of the note offer: geometry, scripts, and nothing that decides anything.
---
---Every rule about which entry a note lands on lives in ns.newEntryPrompt and is tested
---there against a clock. What is left here is worth its own file because it is where the
---client's own behaviour bites — a frame that arrives shown, an Escape that arrives through
---UISpecialFrames, a box that must never take focus by itself.
describe("ns.newEntryToast", function()
    local ns = loader.load()

    local NAME = "ChronieTestEntryToast"

    ---An entry of the shape ns.newEntryLog writes, which is all this module reads of one.
    ---@param overrides table?
    ---@return EntryRecord
    local function newEntry(overrides)
        local entry = {
            id = "account|1700000000|1",
            at = 1700000000,
            stamp = "<stamp>",
            hasImage = true,
        }
        for key, value in pairs(overrides or {}) do
            entry[key] = value
        end
        return entry
    end

    ---@param options table? `{ name, specialFrames, engaged }`, `engaged = false` for a
    ---prompt that says the offer has already gone.
    ---@return EntryToast toast, table recorded, table frames, table specialFrames
    local function newToast(options)
        options = options or {}
        local createFrame, frames = fake.newCreateFrame()
        local specialFrames = options.specialFrames or {}
        local recorded = { engaged = 0, submitted = {}, dismissed = 0, released = 0, ticks = 0 }

        local toast = ns.newEntryToast({
            createFrame = createFrame,
            uiParent = { name = "UIParent" },
            specialFrames = specialFrames,
            name = options.name or NAME,
            onEngage = function()
                recorded.engaged = recorded.engaged + 1
                if options.engaged == false then
                    return nil
                end
                return options.engaged or newEntry()
            end,
            onSubmit = function(text)
                recorded.submitted[#recorded.submitted + 1] = text
            end,
            onDismiss = function()
                recorded.dismissed = recorded.dismissed + 1
            end,
            onRelease = function()
                recorded.released = recorded.released + 1
            end,
            tick = function()
                recorded.ticks = recorded.ticks + 1
            end,
        })
        return toast, recorded, frames, specialFrames
    end

    ---The toast's own frame and the edit box inside it, picked out by what they are rather
    ---than by the order they were built in, so a widget added to the build does not quietly
    ---move what every assertion below is reading.
    ---@param frames table
    ---@return table frame, table? box
    local function widgets(frames)
        for _, candidate in ipairs(frames) do
            if candidate.frameType == "EditBox" then
                return frames[1], candidate
            end
        end
        return frames[1]
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newEntryToast)
    end)

    -- The first offer of a session is the one that builds the frame, and the client hands
    -- back a frame that is already on screen — so anything the build does to hide it runs
    -- the OnHide it just installed, against widgets that do not exist yet. Both halves of
    -- that show up here: the Lua error, and a dismissal reported for an offer the player
    -- has not even seen, which for a memory nobody photographed throws the entry away.
    it("shows the very first offer without reporting it dismissed", function()
        local toast, recorded = newToast()

        toast.show(newEntry())

        assert.equal(0, recorded.dismissed)
        assert.is_true(toast.isShown())
    end)

    -- The other side of the same claim, so the fix cannot be to stop announcing hides: a
    -- toast that really was up and really went away is a dismissal, and it leaves nothing
    -- behind for the next offer to inherit.
    it("reports a dismissal and empties the box when a shown toast goes away", function()
        local toast, recorded, frames = newToast()
        toast.show(newEntry())
        local _, box = widgets(frames)
        toast.engage()
        box:SetText("half a sentence")

        toast.hide()

        assert.equal(1, recorded.dismissed)
        assert.equal("", box:GetText())
        assert.is_false(box:IsShown())
        assert.is_false(box:HasFocus())
    end)

    -- The picture is optional: the same toast offers a note on a capture and on a moment
    -- nobody photographed, and the player is told which of the two they are looking at.
    for _, case in ipairs({
        { label = "a capture", hasImage = true, title = "Screenshot taken." },
        { label = "a moment nobody photographed", hasImage = false, title = "Moment marked." },
    }) do
        it("names the offer after " .. case.label, function()
            local toast, _, frames = newToast()

            toast.show(newEntry({ hasImage = case.hasImage }))

            local frame = widgets(frames)
            assert.equal(case.title, frame.fontStrings[1].text)
        end)
    end

    -- The failure mode the whole feature was specified around. This appears while the player
    -- is doing something else — a screenshot is most often taken mid-fight — and a box that
    -- arrives focused swallows every keybind they have, including the interrupt they were
    -- about to press. Clicking is the only way in, and the hint has to say so.
    it("offers the note without taking the keyboard", function()
        local toast, _, frames = newToast()

        toast.show(newEntry())

        local frame, box = widgets(frames)
        assert.equal("Click to add a note.", frame.fontStrings[2].text)
        assert.is_false(box:IsShown())
        assert.is_false(box:HasFocus())
        assert.is_false(box.autoFocus)
    end)

    describe("engaging", function()
        it("asks the prompt, then shows and focuses the box", function()
            local toast, recorded, frames = newToast()
            toast.show(newEntry())

            toast.engage()

            local _, box = widgets(frames)
            assert.equal(1, recorded.engaged)
            assert.is_true(box:IsShown())
            assert.is_true(box:HasFocus())
        end)

        -- A click that lands on a toast whose offer has already lapsed. There is nothing to
        -- write a note about, so no box appears and the keyboard stays with the player.
        it("shows nothing when the prompt says the offer has gone", function()
            local toast, _, frames = newToast({ engaged = false })
            toast.show(newEntry())

            toast.engage()

            local _, box = widgets(frames)
            assert.is_false(box:IsShown())
            assert.is_false(box:HasFocus())
        end)

        -- Nothing reaches engage but a click on the toast, so a toast that was never built
        -- or is no longer on screen must not conjure one — least of all ask the prompt to
        -- stop a clock that is not running.
        it("ignores a click on a toast nobody can see", function()
            local toast, recorded, frames = newToast()

            toast.engage()

            assert.equal(0, recorded.engaged)
            assert.same({}, frames)

            toast.show(newEntry())
            toast.hide()
            toast.engage()

            assert.equal(0, recorded.engaged)
        end)
    end)

    -- A second capture arrives while the box still holds what nobody finished typing about
    -- the first. The note belongs to the entry it was written about, so the new offer starts
    -- from an empty box rather than inheriting the old sentence.
    it("offers the next capture with an empty box", function()
        local toast, _, frames = newToast()
        toast.show(newEntry({ id = "first" }))
        local _, box = widgets(frames)
        toast.engage()
        box:SetText("half a sentence")

        toast.show(newEntry({ id = "second" }))

        assert.equal("", box:GetText())
        assert.is_false(box:IsShown())
        assert.is_false(box:HasFocus())
    end)

    describe("what the player can do to the box", function()
        it("hands over what was typed on Enter, and lets the keyboard go", function()
            local toast, recorded, frames = newToast()
            toast.show(newEntry())
            local _, box = widgets(frames)
            toast.engage()
            box:SetText("the sun coming up over Nagrand")

            box:run("OnEnterPressed")

            assert.same({ "the sun coming up over Nagrand" }, recorded.submitted)
            assert.is_false(box:HasFocus())
        end)

        it("dismisses on Escape out of a focused box", function()
            local toast, recorded, frames = newToast()
            toast.show(newEntry())
            local _, box = widgets(frames)
            toast.engage()

            box:run("OnEscapePressed")

            assert.equal(1, recorded.dismissed)
            assert.is_false(box:HasFocus())
        end)

        -- Clicking away leaves the toast on screen with nobody typing into it, which is what
        -- the prompt restarts its expiry clock from.
        it("says so when the box loses focus without a note", function()
            local toast, recorded, frames = newToast()
            toast.show(newEntry())
            local _, box = widgets(frames)
            toast.engage()

            box:run("OnEditFocusLost")

            assert.equal(1, recorded.released)
        end)
    end)

    -- Escape gets two routes on purpose, and this is the one that works when the box is not
    -- focused: the client closes a frame it finds in UISpecialFrames, and the toast's OnHide
    -- turns that into a dismissal the addon hears about.
    it("puts its frame in the list Escape closes", function()
        local toast, _, _, specialFrames = newToast()

        toast.show(newEntry())

        assert.same({ NAME }, specialFrames)
    end)
end)
