local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newDetailWindow", function()
    local ns = loader.load()

    local NAME = "ChronieTestDetailWindow"

    local WHITE = { 1, 1, 1 }

    ---@param options table? `{ name = string?, specialFrames = string[]? }`
    ---@return table window, table frames created frames in order, table specialFrames
    local function newWindow(options)
        options = options or {}
        local createFrame, frames = fake.newCreateFrame()
        local specialFrames = options.specialFrames or {}
        local window = ns.newDetailWindow({
            createFrame = createFrame,
            uiParent = { name = "UIParent" },
            specialFrames = specialFrames,
            name = options.name or NAME,
        })
        return window, frames, specialFrames
    end

    ---@param cells string[][] one entry per row
    ---@return DetailSection
    local function section(cells)
        local rows = {}
        for index, row in ipairs(cells) do
            rows[index] = { cells = row, color = WHITE }
        end
        return {
            heading = "Characters",
            columns = { { title = "Character", width = 200 }, { title = "Status", width = 100 } },
            rows = rows,
            empty = "No characters recorded yet.",
        }
    end

    ---@param cells string[][]
    ---@return DetailSpec
    local function spec(cells)
        return { title = "Ulduar — 25 Player", sections = { section(cells) } }
    end

    ---Every text the player would actually read. A font string is only on screen if
    ---the frame owning it is shown too: the client hides a frame's regions along with
    ---it, which is how the renderer retires a recycled line it no longer needs.
    ---@param frames table[]
    ---@return string[]
    local function visibleTexts(frames)
        local texts = {}
        for _, frame in ipairs(frames) do
            if frame.shown then
                for _, fontString in ipairs(frame.fontStrings) do
                    if fontString.shown and fontString.text and fontString.text ~= "" then
                        texts[#texts + 1] = fontString.text
                    end
                end
            end
        end
        return texts
    end

    ---@param texts string[]
    ---@param wanted string
    ---@return boolean
    local function contains(texts, wanted)
        for _, text in ipairs(texts) do
            if text == wanted then
                return true
            end
        end
        return false
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newDetailWindow)
    end)

    describe("laziness", function()
        it("builds no frames when it is constructed", function()
            local _, frames = newWindow()

            assert.equal(0, #frames)
        end)

        it("registers nothing with the Escape-closes list until it is shown", function()
            local _, _, specialFrames = newWindow()

            assert.same({}, specialFrames)
        end)

        it("does not blow up when hidden before it was ever shown", function()
            local window, frames = newWindow()

            assert.has_no.errors(window.hide)
            assert.equal(0, #frames)
        end)

        it("builds its frame on the first show", function()
            local window, frames = newWindow()

            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))

            assert.is_true(#frames > 0)
            assert.equal(NAME, frames[1].frameName)
        end)
    end)

    describe("reusing the frame", function()
        it("does not create a second window frame on a repeated show", function()
            local window, frames = newWindow()
            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))
            local afterFirst = frames[1]

            window.show(spec({ { "Jaina-Draenor", "Locked" } }))

            local named = {}
            for _, frame in ipairs(frames) do
                if frame.frameName == NAME then
                    named[#named + 1] = frame
                end
            end
            assert.equal(1, #named)
            assert.equal(afterFirst, named[1])
        end)

        it("registers its name in the special frames list exactly once", function()
            local window, _, specialFrames = newWindow()

            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))
            window.hide()
            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))
            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))

            assert.same({ NAME }, specialFrames)
        end)

        it("appends to a list another window already claimed a slot in", function()
            local window, _, specialFrames = newWindow({ specialFrames = { "SomeOtherWindow" } })

            window.show(spec({}))

            assert.same({ "SomeOtherWindow", NAME }, specialFrames)
        end)
    end)

    describe("isShown", function()
        it("is false before the window has ever been built", function()
            local window = newWindow()

            assert.is_false(window.isShown())
        end)

        it("is true once the window has been shown", function()
            local window = newWindow()

            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))

            assert.is_true(window.isShown())
        end)

        it("is false again after the window is hidden", function()
            local window = newWindow()
            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))

            window.hide()

            assert.is_false(window.isShown())
        end)

        it("is true again when a hidden window is shown a second time", function()
            local window = newWindow()
            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))
            window.hide()

            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))

            assert.is_true(window.isShown())
        end)
    end)

    describe("rendering", function()
        it("renders filters and reports user edits", function()
            local window, frames = newWindow()
            local changed
            local filtered = spec({})
            filtered.filters = { { key = "character", label = "Character", value = "Thrall" } }
            filtered.onFilterChanged = function(key, value)
                changed = { key, value }
            end

            window.show(filtered)

            local edit
            for _, frame in ipairs(frames) do
                if frame.frameType == "EditBox" then
                    edit = frame
                end
            end
            assert.is_not_nil(edit)
            assert.equal("Thrall", edit.text)
            edit:SetText("Jaina")
            edit:run("OnTextChanged", true)
            assert.same({ "character", "Jaina" }, changed)
        end)

        it("runs a row's click action", function()
            local window, frames = newWindow()
            local clicked = 0
            local clickable = spec({ { "Thrall-Ragnaros", "Available" } })
            clickable.sections[1].rows[1].onClick = function()
                clicked = clicked + 1
            end

            window.show(clickable)

            for _, frame in ipairs(frames) do
                if frame.frameType == "Button" and frame.scripts.OnClick and frame.shown then
                    frame:run("OnClick")
                end
            end
            assert.equal(1, clicked)
        end)

        it("draws the spec's title", function()
            local window, frames = newWindow()

            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))

            assert.is_true(contains(visibleTexts(frames), "Ulduar — 25 Player"))
        end)

        it("retitles the window when a second spec is rendered", function()
            local window, frames = newWindow()
            window.show(spec({}))

            window.show({ title = "Thrall-Ragnaros", sections = { section({}) } })

            local texts = visibleTexts(frames)
            assert.is_true(contains(texts, "Thrall-Ragnaros"))
            assert.is_false(contains(texts, "Ulduar — 25 Player"))
        end)

        it("draws the section heading and its column titles", function()
            local window, frames = newWindow()

            window.show(spec({ { "Thrall-Ragnaros", "Available" } }))

            local texts = visibleTexts(frames)
            assert.is_true(contains(texts, "Characters"))
            assert.is_true(contains(texts, "Character"))
            assert.is_true(contains(texts, "Status"))
        end)

        it("draws every row's cells", function()
            local window, frames = newWindow()

            window.show(spec({
                { "Thrall-Ragnaros", "Available" },
                { "Jaina-Draenor", "Locked" },
            }))

            local texts = visibleTexts(frames)
            assert.is_true(contains(texts, "Thrall-Ragnaros"))
            assert.is_true(contains(texts, "Jaina-Draenor"))
        end)

        it("paints each row in the colour the spec asked for", function()
            local window, frames = newWindow()
            local locked = { 1, 0.4, 0.4 }

            window.show({
                title = "Ulduar",
                sections = {
                    {
                        heading = "Characters",
                        columns = { { title = "Character", width = 200 } },
                        rows = { { cells = { "Thrall-Ragnaros" }, color = locked } },
                    },
                },
            })

            for _, frame in ipairs(frames) do
                for _, fontString in ipairs(frame.fontStrings) do
                    if fontString.text == "Thrall-Ragnaros" then
                        assert.same(locked, fontString.color)
                    end
                end
            end
        end)

        it("shows the section's empty message when it has no rows", function()
            local window, frames = newWindow()

            window.show(spec({}))

            assert.is_true(contains(visibleTexts(frames), "No characters recorded yet."))
        end)

        it("falls back to a default message when the empty section supplies none", function()
            local window, frames = newWindow()

            window.show({
                title = "Ulduar",
                sections = { { columns = { { title = "Character", width = 200 } }, rows = {} } },
            })

            assert.is_true(contains(visibleTexts(frames), "Nothing to show."))
        end)

        -- Lines are pooled across renders, so anything the previous, longer spec drew
        -- has to be taken off screen rather than left behind under the new content.
        it("hides the leftover lines when a shorter spec is rendered", function()
            local window, frames = newWindow()
            window.show(spec({
                { "Aaa-Realm", "Available" },
                { "Bbb-Realm", "Available" },
                { "Ccc-Realm", "Available" },
                { "Ddd-Realm", "Available" },
            }))

            window.show(spec({ { "Aaa-Realm", "Available" } }))

            local texts = visibleTexts(frames)
            assert.is_true(contains(texts, "Aaa-Realm"))
            assert.is_false(contains(texts, "Bbb-Realm"))
            assert.is_false(contains(texts, "Ccc-Realm"))
            assert.is_false(contains(texts, "Ddd-Realm"))
        end)

        it("hides the leftover lines when a whole section disappears", function()
            local window, frames = newWindow()
            window.show({
                title = "Thrall-Ragnaros",
                sections = { section({ { "Aaa-Realm", "Available" } }), {
                    heading = "Dungeons",
                    columns = { { title = "Instance", width = 200 } },
                    rows = { { cells = { "Deadmines" }, color = WHITE } },
                } },
            })

            window.show(spec({ { "Aaa-Realm", "Available" } }))

            local texts = visibleTexts(frames)
            assert.is_false(contains(texts, "Dungeons"))
            assert.is_false(contains(texts, "Deadmines"))
        end)

        it("hides the trailing cells when the next spec has fewer columns", function()
            local window, frames = newWindow()
            window.show(spec({ { "Aaa-Realm", "Available" } }))

            window.show({
                title = "Ulduar",
                sections = {
                    {
                        heading = "Characters",
                        columns = { { title = "Character", width = 200 } },
                        rows = { { cells = { "Aaa-Realm" }, color = WHITE } },
                    },
                },
            })

            assert.is_false(contains(visibleTexts(frames), "Available"))
        end)

        it("reuses the pooled lines rather than creating fresh ones on every render", function()
            local window, frames = newWindow()
            window.show(spec({ { "Aaa-Realm", "Available" }, { "Bbb-Realm", "Locked" } }))
            local afterFirst = #frames

            window.show(spec({ { "Aaa-Realm", "Available" }, { "Bbb-Realm", "Locked" } }))

            assert.equal(afterFirst, #frames)
        end)

        it("brings the leftover lines back when a longer spec is rendered again", function()
            local window, frames = newWindow()
            window.show(spec({ { "Aaa-Realm", "Available" }, { "Bbb-Realm", "Locked" } }))
            window.show(spec({ { "Aaa-Realm", "Available" } }))

            window.show(spec({ { "Aaa-Realm", "Available" }, { "Bbb-Realm", "Locked" } }))

            assert.is_true(contains(visibleTexts(frames), "Bbb-Realm"))
        end)
    end)
end)
