local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newResultsWindow", function()
    local ns = loader.load()

    local NAME = "ChronieTestResultsWindow"

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
    ---@return SegmentSummary
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
            levelUps = {},
            mounts = {},
            pets = {},
            quests = {},
            toys = {},
            housingItems = {},
            housingXP = 0,
            housingLevelUps = {},
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

    ---The progress bars on screen, in creation order. A bar is a track, the filled part of
    ---it and a caption centred over both; the caption is the one font string the window
    ---centres, which is what keeps it out of the label/value rows above.
    ---@param frame table
    ---@return table[] `{ { caption = string, filled = number, width = number }, ... }`
    local function barsOf(frame)
        local captions = {}
        for _, fontString in ipairs(frame.fontStrings) do
            if fontString.shown and fontString.justify == "CENTER" then
                captions[#captions + 1] = fontString.text
            end
        end
        -- Bars are pooled as a track/fill pair each, handed out in order, so the pair at
        -- 2n-1 and 2n is the nth bar and the ones still on screen come first.
        local drawn = {}
        for index = 1, math.floor(#frame.textures / 2) do
            local back, fill = frame.textures[index * 2 - 1], frame.textures[index * 2]
            if back.shown then
                drawn[#drawn + 1] = {
                    caption = captions[#drawn + 1],
                    width = back.width,
                    filled = fill.shown and fill.width or 0,
                }
            end
        end
        return drawn
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

            assert.equal("0 new · 3 variants", valueFor(rowsOf(frames[1]), "Transmog +"))
        end)


        it("hides reputation until some was earned", function()
            local window, frames = newWindow()

            window.update(summary({ reputation = {} }))

            assert.is_nil(valueFor(rowsOf(frames[1]), "Reputation +"))
        end)

        it("renders one indented signed line per faction", function()
            local window, frames = newWindow()

            window.update(summary({
                reputationTotal = 260,
                reputation = {
                    { faction = "Argent Dawn", amount = 250 },
                    { faction = "Timbermaw Hold", amount = 10 },
                },
            }))

            assert.equal("+260", valueFor(rowsOf(frames[1]), "Reputation +"))
            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "Reputation +" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end
            local lines = rowsOf(frames[1])
            assert.equal("+250", valueFor(lines, "  Argent Dawn"))
            assert.equal("+10", valueFor(lines, "  Timbermaw Hold"))
        end)

        -- Rows are pooled and reused across renders, so a faction from a busier summary
        -- must be taken off screen when a later, quieter summary no longer lists it.
        it("hides leftover faction lines when a later summary has fewer", function()
            local window, frames = newWindow()
            window.update(summary({
                reputationTotal = 260,
                reputation = {
                    { faction = "Argent Dawn", amount = 250 },
                    { faction = "Timbermaw Hold", amount = 10 },
                },
            }))

            window.update(summary({ reputation = {} }))

            assert.is_nil(valueFor(rowsOf(frames[1]), "  Argent Dawn"))
            assert.is_nil(valueFor(rowsOf(frames[1]), "  Timbermaw Hold"))
        end)

        ---Expand a heading by clicking it, the way a player reaches the detail under it.
        ---@param frame table
        ---@param heading string
        local function expand(frame, heading)
            for _, fontString in ipairs(frame.fontStrings) do
                if fontString.text == heading then
                    fontString:run("OnMouseUp", "LeftButton")
                    return
                end
            end
            error("no row labelled " .. heading .. " to expand")
        end

        it("draws a bar under each faction, filled to where the character stands", function()
            local window, frames = newWindow()
            window.update(summary({
                reputationTotal = 250,
                reputation = {
                    {
                        faction = "Argent Dawn",
                        amount = 250,
                        standing = "Honored",
                        current = 6000,
                        max = 12000,
                    },
                },
            }))

            expand(frames[1], "Reputation +")

            local bars = barsOf(frames[1])
            assert.equal(1, #bars)
            assert.equal("Honored  6,000 / 12,000", bars[1].caption)
            assert.equal(bars[1].width / 2, bars[1].filled)
        end)

        it("draws a full bar for a faction with nothing left to earn", function()
            local window, frames = newWindow()
            window.update(summary({
                reputationTotal = 40,
                reputation = {
                    { faction = "Argent Dawn", amount = 40, standing = "Exalted", current = 1, max = 1 },
                },
            }))

            expand(frames[1], "Reputation +")

            local bars = barsOf(frames[1])
            assert.equal("Exalted  1 / 1", bars[1].caption)
            assert.equal(bars[1].width, bars[1].filled)
        end)

        it("draws an empty bar rather than none at the start of a level", function()
            local window, frames = newWindow()
            window.update(summary({
                reputationTotal = 40,
                reputation = {
                    { faction = "Argent Dawn", amount = 40, standing = "Revered", current = 0, max = 21000 },
                },
            }))

            expand(frames[1], "Reputation +")

            local bars = barsOf(frames[1])
            assert.equal(1, #bars)
            assert.equal(0, bars[1].filled)
        end)

        it("draws no bar for a faction the client could not place", function()
            local window, frames = newWindow()
            window.update(summary({
                reputationTotal = 40,
                reputation = { { faction = "Argent Dawn", amount = 40 } },
            }))

            expand(frames[1], "Reputation +")

            assert.same({}, barsOf(frames[1]))
            assert.equal("+40", valueFor(rowsOf(frames[1]), "  Argent Dawn"))
        end)

        -- Bars are pooled the same way rows are, so one drawn for a busier summary has to
        -- come off screen when a later, quieter one no longer has a faction for it.
        it("takes leftover bars off screen when a later summary has fewer factions", function()
            local window, frames = newWindow()
            window.update(summary({
                reputationTotal = 60,
                reputation = {
                    { faction = "Argent Dawn", amount = 40, standing = "Honored", current = 1, max = 2 },
                    { faction = "Timbermaw Hold", amount = 20, standing = "Friendly", current = 1, max = 4 },
                },
            }))
            expand(frames[1], "Reputation +")

            window.update(summary({ reputation = {} }))

            assert.same({}, barsOf(frames[1]))
        end)

        it("hides currency until one changed", function()
            local window, frames = newWindow()

            window.update(summary({ currencies = {} }))

            assert.is_nil(valueFor(rowsOf(frames[1]), "Currency +"))
        end)

        it("renders one indented signed line per currency", function()
            local window, frames = newWindow()

            window.update(summary({
                currencyTotal = 4,
                currencies = {
                    { id = 1, name = "Honor", amount = 7 },
                    { id = 2, name = "Valor", amount = -3 },
                },
            }))

            assert.equal("+4", valueFor(rowsOf(frames[1]), "Currency +"))
            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "Currency +" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end
            local lines = rowsOf(frames[1])
            assert.equal("+7", valueFor(lines, "  Honor"))
            assert.equal("-3", valueFor(lines, "  Valor"))
        end)

        it("shows what the character holds beside what the segment earned", function()
            local window, frames = newWindow()
            window.update(summary({
                currencyTotal = 7,
                currencies = { { id = 1, name = "Honor", amount = 7, total = 12450 } },
            }))

            expand(frames[1], "Currency +")

            assert.equal("+7 (12,450)", valueFor(rowsOf(frames[1]), "  Honor"))
        end)

        it("shows a spend against the holding it left behind", function()
            local window, frames = newWindow()
            window.update(summary({
                currencyTotal = -300,
                currencies = { { id = 1, name = "Honor", amount = -300, total = 1200 } },
            }))

            expand(frames[1], "Currency +")

            assert.equal("-300 (1,200)", valueFor(rowsOf(frames[1]), "  Honor"))
        end)

        it("hides achievements until one was earned", function()
            local window, frames = newWindow()

            window.update(summary({ achievements = {} }))

            assert.is_nil(valueFor(rowsOf(frames[1]), "Achievements +"))
        end)

        it("expands level ups with the level reached", function()
            local window, frames = newWindow()
            window.update(summary({ levelUps = { { level = 42, at = 5000 } } }))

            assert.equal("1", valueFor(rowsOf(frames[1]), "Level ups +"))
            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "Level ups +" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end

            assert.equal("reached", valueFor(rowsOf(frames[1]), "  Level 42"))
        end)

        it("summarises housing items as warband firsts against extras while collapsed", function()
            local window, frames = newWindow()

            window.update(summary({
                housingItems = {
                    { id = 1, name = "Sturdy Oak Chair", warbandFirst = true },
                    { id = 2, name = "Sturdy Oak Chair", warbandFirst = false },
                    { id = 3, name = "Iron Sconce", warbandFirst = true },
                },
            }))

            local value = valueFor(rowsOf(frames[1]), "Housing items +")
            assert.is_not_nil(value)
            assert.truthy(value:find("2 warband"))
            assert.truthy(value:find("1 extra"))
        end)

        it("expands housing items with their warband scope", function()
            local window, frames = newWindow()
            window.update(summary({
                housingItems = {
                    { id = 1, name = "Sturdy Oak Chair", warbandFirst = true },
                    { id = 2, name = "Iron Sconce", warbandFirst = false },
                },
            }))
            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "Housing items +" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end

            local lines = rowsOf(frames[1])
            assert.equal("warband first", valueFor(lines, "  Sturdy Oak Chair"))
            assert.equal("additional", valueFor(lines, "  Iron Sconce"))
        end)

        it("hides housing experience until some was gained", function()
            local window, frames = newWindow()

            window.update(summary({ housingXP = 0 }))

            assert.is_nil(valueFor(rowsOf(frames[1]), "Housing XP"))
        end)

        it("renders the housing experience total when gained", function()
            local window, frames = newWindow()

            window.update(summary({ housingXP = 250 }))

            assert.equal("+250", valueFor(rowsOf(frames[1]), "Housing XP"))
        end)

        it("expands housing levels with the level reached", function()
            local window, frames = newWindow()
            window.update(summary({ housingLevelUps = { { level = 3, at = 5000 } } }))

            assert.equal("1", valueFor(rowsOf(frames[1]), "Housing levels +"))
            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "Housing levels +" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end

            assert.equal("reached", valueFor(rowsOf(frames[1]), "  Level 3"))
        end)

        it("shows completed category headings alphabetically after a divider", function()
            local window, frames = newWindow()

            window.update(summary({
                achievements = { { id = 1, name = "First" } },
                currencies = { { id = 2, name = "Valor", amount = 1 } },
                currencyTotal = 1,
                mounts = { { id = 3, name = "Alabaster Hyena" } },
                pets = { { id = 4, name = "Darkmoon Rabbit" } },
                quests = { { id = 5, name = "A Quest" } },
                reputation = { { faction = "Argent Dawn", amount = 2 } },
                reputationTotal = 2,
                toys = { { id = 6, name = "Train Set" } },
                transmogs = { { id = 7, newAppearance = true } },
            }))

            local lines = rowsOf(frames[1])
            local labels = {}
            for _, entry in ipairs(lines) do
                labels[#labels + 1] = entry.label
            end
            assert.same({
                "Loot value", "Gold Δ", "------------------------",
                "Achievements +", "Currency +", "Mounts +", "Pets +",
                "Quests +", "Reputation +", "Toys +", "Transmog +",
            }, labels)
        end)

        it("expands newly collected mounts, pets and toys by name", function()
            local window, frames = newWindow()
            window.update(summary({
                mounts = { { id = 1, name = "Alabaster Hyena" } },
                pets = { { id = 2, name = "Darkmoon Rabbit" } },
                toys = { { id = 3, name = "Katy's Stampwhistle" } },
            }))

            for _, heading in ipairs({ "Mounts +", "Pets +", "Toys +" }) do
                for _, fontString in ipairs(frames[1].fontStrings) do
                    if fontString.text == heading then
                        fontString:run("OnMouseUp", "LeftButton")
                        break
                    end
                end
            end

            local lines = rowsOf(frames[1])
            assert.equal("collected", valueFor(lines, "  Alabaster Hyena"))
            assert.equal("collected", valueFor(lines, "  Darkmoon Rabbit"))
            assert.equal("collected", valueFor(lines, "  Katy's Stampwhistle"))
        end)

        it("names each achievement earned", function()
            local window, frames = newWindow()

            window.update(summary({
                achievements = { { id = 1, name = "The Loremaster", at = 5000 } },
            }))
            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "Achievements +" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end

            assert.is_not_nil(valueFor(rowsOf(frames[1]), "  The Loremaster"))
        end)

        it("keeps long achievement and quest names out of the status column", function()
            local window, frames = newWindow()
            local longAchievement = "  An Extremely Long Achievement Name That Cannot Fit Beside Its Status"
            local longQuest = "  An Extremely Long Quest Name That Cannot Fit Beside Its Status"

            window.update(summary({
                achievements = {
                    { id = 1, name = longAchievement:sub(3), accountFirst = false },
                },
                quests = {
                    { id = 2, name = longQuest:sub(3), characterFirst = true },
                },
            }))
            for _, heading in ipairs({ "Achievements +", "Quests +" }) do
                for _, fontString in ipairs(frames[1].fontStrings) do
                    if fontString.text == heading then
                        fontString:run("OnMouseUp", "LeftButton")
                        break
                    end
                end
            end

            local labels = {}
            local values = {}
            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == longAchievement or fontString.text == longQuest then
                    labels[#labels + 1] = fontString
                elseif fontString.text == "character first" then
                    values[#values + 1] = fontString
                end
            end

            assert.equal(2, #labels)
            assert.equal(2, #values)
            for index = 1, 2 do
                assert.is_false(labels[index].wordWrap)
                assert.is_false(values[index].wordWrap)
                assert.equal(136, labels[index].width)
                assert.equal(92, values[index].width)
            end
        end)

        it("summarises account-first and character-first achievements while collapsed", function()
            local window, frames = newWindow()

            window.update(summary({
                achievements = {
                    { id = 1, name = "Account", accountFirst = true },
                    { id = 2, name = "Character", accountFirst = false },
                    { id = 3, name = "Another character", accountFirst = false },
                },
            }))

            assert.equal(
                "|cffb373ff1 account|r / |cff59d9732 character|r",
                valueFor(rowsOf(frames[1]), "Achievements +")
            )
            assert.is_nil(valueFor(rowsOf(frames[1]), "  Account"))
        end)

        it("opens an achievement from its named row", function()
            local window, frames, recorded = newWindow()
            window.update(summary({
                achievements = { { id = 42, name = "Explore", accountFirst = true } },
            }))

            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "Achievements +" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end
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
                if fontString.text == "Quests +" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end

            assert.equal("completed", valueFor(rowsOf(frames[1]), "  Quest 7848"))
        end)

        it("summarises and labels quest first-completion scope", function()
            local window, frames = newWindow()
            window.update(summary({
                quests = {
                    {
                        id = 1,
                        name = "Warband discovery",
                        accountFirst = true,
                        characterFirst = true,
                    },
                    {
                        id = 2,
                        name = "Alt discovery",
                        accountFirst = false,
                        characterFirst = true,
                    },
                },
            }))

            assert.equal(
                "|cffb373ff1 warband|r / |cff59d9731 character|r",
                valueFor(rowsOf(frames[1]), "Quests +")
            )
            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "Quests +" then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end
            local lines = rowsOf(frames[1])
            assert.equal("warband first", valueFor(lines, "  Warband discovery"))
            assert.equal("character first", valueFor(lines, "  Alt discovery"))
        end)

        it("previews a transmog on left click and opens its source on right click", function()
            local window, frames, recorded = newWindow()
            window.update(summary({
                transmogs = { { id = 19019, sourceID = 11, newAppearance = true } },
            }))

            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "Transmog +" then
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
            assert.equal("new", valueFor(rowsOf(frames[1]), "  ✓ Named item 19019"))
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
