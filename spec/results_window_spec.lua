local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newResultsWindow", function()
    local ns = loader.load()

    local NAME = "WdpWowTestResultsWindow"

    ---Build the window with fake frames and deps, recording what it loads and saves.
    ---`loadPoint` returns whatever the test planted, so both the default and the
    ---restored-position paths are drivable.
    ---@param options table? `{ name = string?, point = { string, number, number }? }`
    ---@return table window, table frames, table recorded `{ saved, loadCalls }`
    local function newWindow(options)
        options = options or {}
        local createFrame, frames = fake.newCreateFrame()
        local recorded = { saved = {}, loadCalls = 0, achievements = {}, previews = {}, collections = {} }
        local window = ns.newResultsWindow({
            createFrame = createFrame,
            uiParent = { name = "UIParent" },
            name = options.name or NAME,
            -- A visible sentinel around the copper amount, so a test can prove the row's
            -- value came from formatMoney(summary.gold) rather than any other field.
            formatMoney = function(copper)
                return "$" .. tostring(copper)
            end,
            loadPoint = function()
                recorded.loadCalls = recorded.loadCalls + 1
                local point = options.point
                if not point then
                    return nil
                end
                return point[1], point[2], point[3]
            end,
            savePoint = function(point, x, y)
                recorded.saved[#recorded.saved + 1] = { point = point, x = x, y = y }
            end,
            openAchievement = function(id)
                recorded.achievements[#recorded.achievements + 1] = id
            end,
            previewTransmog = function(id)
                recorded.previews[#recorded.previews + 1] = id
            end,
            openTransmogCollection = function(id)
                recorded.collections[#recorded.collections + 1] = id
            end,
            itemName = function(id)
                return "Named item " .. id
            end,
        })
        return window, frames, recorded
    end

    ---@param overrides table?
    ---@return SessionSummary
    local function summary(overrides)
        local base = {
            active = true,
            lootValue = 0,
            goldLooted = 0,
            itemValue = 0,
            goldDiff = 0,
            transmogs = {},
            currencyTotal = 0,
            currencies = {},
            reputationTotal = 0,
            reputation = {},
            achievements = {},
        }
        for key, value in pairs(overrides or {}) do
            base[key] = value
        end
        return base
    end

    ---The rendered label/value pairs, in order. The window distinguishes labels from
    ---values by justification (left vs right), and creates them label-then-value, so
    ---pairing them by their shown order reconstructs each on-screen line.
    ---@param frame table
    ---@return table[] `{ { label = string, value = string }, ... }`
    local function rowsOf(frame)
        local labels, values = {}, {}
        for _, fontString in ipairs(frame.fontStrings) do
            if fontString.shown and fontString.justify == "LEFT" then
                labels[#labels + 1] = fontString.text
            elseif fontString.shown and fontString.justify == "RIGHT" then
                values[#values + 1] = fontString.text
            end
        end
        local lines = {}
        for index, label in ipairs(labels) do
            lines[index] = { label = label, value = values[index] }
        end
        return lines
    end

    ---@param lines table[]
    ---@param label string
    ---@return string? the value paired with the first row carrying that label
    local function valueFor(lines, label)
        for _, line in ipairs(lines) do
            if line.label == label then
                return line.value
            end
        end
        return nil
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newResultsWindow)
    end)

    describe("laziness", function()
        it("builds no frame when it is constructed", function()
            local _, frames = newWindow()

            assert.equal(0, #frames)
        end)

        it("reports not shown before it has ever been built", function()
            local window = newWindow()

            assert.is_false(window.isShown())
        end)

        it("does not blow up when hidden before it was ever shown", function()
            local window, frames = newWindow()

            assert.has_no.errors(window.hide)
            assert.equal(0, #frames)
        end)

        it("builds its frame on the first show", function()
            local window, frames = newWindow()

            window.show()

            assert.equal(1, #frames)
            assert.equal(NAME, frames[1].frameName)
        end)

        it("builds its frame on the first update", function()
            local window, frames = newWindow()

            window.update(summary())

            assert.equal(1, #frames)
        end)

        it("builds its frame on the first toggle", function()
            local window, frames = newWindow()

            window.toggle()

            assert.equal(1, #frames)
        end)
    end)

    describe("show, hide and toggle", function()
        it("is shown once show is called", function()
            local window = newWindow()

            window.show()

            assert.is_true(window.isShown())
        end)

        it("is hidden again after hide", function()
            local window = newWindow()
            window.show()

            window.hide()

            assert.is_false(window.isShown())
        end)

        it("reuses the one frame across repeated shows", function()
            local window, frames = newWindow()

            window.show()
            window.hide()
            window.show()

            assert.equal(1, #frames)
        end)

        it("toggles from hidden to shown", function()
            local window = newWindow()

            window.toggle()

            assert.is_true(window.isShown())
        end)

        it("toggles from shown back to hidden", function()
            local window = newWindow()
            window.show()

            window.toggle()

            assert.is_false(window.isShown())
        end)
    end)

    describe("rendering the summary", function()
        it("renders the loot row through formatMoney", function()
            local window, frames = newWindow()

            window.update(summary({ lootValue = 1234 }))

            assert.equal("$1234", valueFor(rowsOf(frames[1]), "Loot value"))
        end)

        it("renders the net gold difference through formatMoney", function()
            local window, frames = newWindow()

            window.update(summary({ goldDiff = -500 }))

            assert.equal("$-500", valueFor(rowsOf(frames[1]), "Gold Δ"))
        end)

        it("renders the transmog event count", function()
            local window, frames = newWindow()

            window.update(summary({ transmogs = { { id = 1 }, { id = 2 }, { id = 3 } } }))

            assert.equal("0 new · 3 variants", valueFor(rowsOf(frames[1]), "▶ Transmog"))
        end)


        it("shows 'none' against reputation when nothing was earned", function()
            local window, frames = newWindow()

            window.update(summary({ reputation = {} }))

            assert.equal("none", valueFor(rowsOf(frames[1]), "Reputation"))
        end)

        it("renders one indented signed line per faction", function()
            local window, frames = newWindow()

            window.update(summary({
                reputation = {
                    { faction = "Argent Dawn", amount = 250 },
                    { faction = "Timbermaw Hold", amount = 10 },
                },
            }))

            local lines = rowsOf(frames[1])
            assert.equal("+250", valueFor(lines, "  Argent Dawn"))
            assert.equal("+10", valueFor(lines, "  Timbermaw Hold"))
        end)

        -- Rows are pooled and reused across renders, so a faction from a busier summary
        -- must be taken off screen when a later, quieter summary no longer lists it.
        it("hides leftover faction lines when a later summary has fewer", function()
            local window, frames = newWindow()
            window.update(summary({
                reputation = {
                    { faction = "Argent Dawn", amount = 250 },
                    { faction = "Timbermaw Hold", amount = 10 },
                },
            }))

            window.update(summary({ reputation = {} }))

            assert.is_nil(valueFor(rowsOf(frames[1]), "  Argent Dawn"))
            assert.is_nil(valueFor(rowsOf(frames[1]), "  Timbermaw Hold"))
        end)

        it("shows 'none' against currency when nothing changed", function()
            local window, frames = newWindow()

            window.update(summary({ currencies = {} }))

            assert.equal("none", valueFor(rowsOf(frames[1]), "Currency"))
        end)

        it("renders one indented signed line per currency", function()
            local window, frames = newWindow()

            window.update(summary({
                currencies = {
                    { id = 1, name = "Honor", amount = 7 },
                    { id = 2, name = "Valor", amount = -3 },
                },
            }))

            local lines = rowsOf(frames[1])
            assert.equal("+7", valueFor(lines, "  Honor"))
            assert.equal("-3", valueFor(lines, "  Valor"))
        end)

        it("shows 'none' against achievements when none were earned", function()
            local window, frames = newWindow()

            window.update(summary({ achievements = {} }))

            assert.equal("none", valueFor(rowsOf(frames[1]), "Achievements"))
        end)

        it("names each achievement earned", function()
            local window, frames = newWindow()

            window.update(summary({
                achievements = { { id = 1, name = "The Loremaster", at = 5000 } },
            }))

            assert.is_not_nil(valueFor(rowsOf(frames[1]), "  The Loremaster"))
        end)

        it("opens an achievement from its named row", function()
            local window, frames, recorded = newWindow()
            window.update(summary({
                achievements = { { id = 42, name = "Explore", accountFirst = true } },
            }))

            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "  Explore" then
                    fontString:run("OnMouseUp", "LeftButton")
                end
            end

            assert.same({ 42 }, recorded.achievements)
        end)

        it("expands quests from their count", function()
            local window, frames = newWindow()
            window.update(summary({ quests = { { id = 7848 } } }))

            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "▶ Quests" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end

            assert.equal("", valueFor(rowsOf(frames[1]), "  Quest 7848"))
        end)

        it("previews a transmog on left click and opens its source on right click", function()
            local window, frames, recorded = newWindow()
            window.update(summary({
                transmogs = { { id = 19019, sourceID = 11, newAppearance = true } },
            }))

            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "▶ Transmog" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end
            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "  Named item 19019" then
                    fontString:run("OnMouseUp", "LeftButton")
                    fontString:run("OnMouseUp", "RightButton")
                    break
                end
            end

            assert.same({ 19019 }, recorded.previews)
            assert.same({ 11 }, recorded.collections)
        end)
    end)

    describe("remembering its position", function()
        it("consults loadPoint when the frame is built", function()
            local window, _, recorded = newWindow()

            window.show()

            assert.equal(1, recorded.loadCalls)
        end)

        it("anchors to the saved point loadPoint returns", function()
            local window, frames = newWindow({ point = { "TOPRIGHT", 5, -5 } })

            window.show()

            local point = frames[1].points[1]
            assert.equal("TOPRIGHT", point[1])
            assert.equal(5, point[4])
            assert.equal(-5, point[5])
        end)

        it("falls back to the centre when loadPoint has no saved spot", function()
            local window, frames = newWindow()

            window.show()

            local point = frames[1].points[1]
            assert.equal("CENTER", point[1])
            assert.equal(0, point[4])
            assert.equal(0, point[5])
        end)

        -- OnDragStop is the only place the window learns where the player left it: it
        -- reads GetPoint after the drag and persists exactly those coordinates.
        it("saves the point GetPoint reports when a drag ends", function()
            local window, frames, recorded = newWindow()
            window.show()
            frames[1].placedPoint = { "BOTTOMLEFT", nil, "BOTTOMLEFT", 10, 20 }

            frames[1]:run("OnDragStop")

            assert.same({ { point = "BOTTOMLEFT", x = 10, y = 20 } }, recorded.saved)
        end)
    end)
end)
