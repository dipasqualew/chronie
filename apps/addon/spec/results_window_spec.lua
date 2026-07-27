local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newResultsWindow", function()
    local ns = loader.load()

    local NAME = "ChronieTestResultsWindow"
    local NOW = 1700000000
    local CHARACTER = "Main-Ravencrest"

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
            now = function()
                return options.now or NOW
            end,
            character = function()
                return options.character or CHARACTER
            end,
            accountStanding = options.accountStanding,
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
        -- 2n-1 and 2n is the nth bar and the ones still on screen come first. The panel's own
        -- chrome — the header strip and the hairlines between blocks — is drawn on BORDER,
        -- which is what keeps it out of this pairing.
        local pooled = {}
        for _, texture in ipairs(frame.textures) do
            if texture.layer == "BACKGROUND" or texture.layer == "ARTWORK" then
                pooled[#pooled + 1] = texture
            end
        end
        local drawn = {}
        for index = 1, math.floor(#pooled / 2) do
            local back, fill = pooled[index * 2 - 1], pooled[index * 2]
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

    ---The hairlines the panel draws between blocks, which is what replaced a row of dashes.
    ---They share the BORDER layer with the header's own chrome, so the two the header always
    ---draws are skipped and what is left is the body's.
    ---@param frame table
    ---@return table[] textures still on screen
    local function rulesOf(frame)
        local drawn = {}
        for _, texture in ipairs(frame.textures) do
            if texture.layer == "BORDER" and texture.shown then
                drawn[#drawn + 1] = texture
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

    ---A category heading is its disclosure icon and then its name, so it is found by what it
    ---says rather than by the markup in front of it.
    ---@param lines table[]
    ---@param name string
    ---@return string? the value paired with the first row whose label contains that name
    local function valueForHeading(lines, name)
        for _, line in ipairs(lines) do
            if line.label:find(name, 1, true) then
                return line.value
            end
        end
        return nil
    end

    ---Clicks the first row saying `name`, the way a player reaches what is under a heading.
    ---@param frame table
    ---@param name string
    local function expand(frame, name)
        for _, fontString in ipairs(frame.fontStrings) do
            if fontString.shown and (fontString.text or ""):find(name, 1, true) then
                fontString:run("OnMouseUp", "LeftButton")
                return
            end
        end
        error("no row saying " .. name .. " to click")
    end

    ---The characters beyond ASCII that the panel is allowed to put on screen.
    ---
    ---Every row is drawn in FRIZQT__.TTF, and that font carries 253 codepoints: ASCII,
    ---Latin-1 and a short tail of punctuation. Anything outside them draws as an empty box.
    ---These seven were read out of the font's own cmap — `fonts/frizqt__.ttf`, file 615960,
    ---build 12.0.5.67823 — and U+2713 CHECK MARK, which a reviewed transmog used to be
    ---ticked with, is not in it. Icons belong in `|T...|t` texture escapes, which are ASCII.
    local DRAWABLE = { "·", "Δ", "»", "«", "—", "–", "…", "•" }

    ---@param text string?
    ---@return string? the first byte of a character the game's font cannot draw
    local function undrawable(text)
        local rest = text or ""
        for _, glyph in ipairs(DRAWABLE) do
            rest = rest:gsub(glyph, "")
        end
        return rest:match("[\128-\255]")
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

        -- A balance is not something the segment did, and the desktop app already reports
        -- every one of them against the character it belongs to. The panel is for what just
        -- happened, and the wallet would be the largest number on it.
        it("says nothing about the wallet the difference landed on", function()
            local window, frames = newWindow()

            window.update(summary({ goldDiff = -500, wallet = 12000 }))

            local lines = rowsOf(frames[1])
            assert.is_nil(valueFor(lines, "Wallet"))
            assert.is_nil(valueFor(lines, "    account"))
            assert.is_nil(valueFor(lines, "    warband bank"))
        end)

        it("renders the transmog event count", function()
            local window, frames = newWindow()

            window.update(summary({ transmogs = { { id = 1 }, { id = 2 }, { id = 3 } } }))

            -- Purple for what is new to the account's wardrobe, green for a variant of
            -- something it already had, the same two colours achievements are counted in.
            assert.equal(
                "|cffb373ff0 new|r · |cff59d9733 variants|r",
                valueForHeading(rowsOf(frames[1]), "Transmog")
            )
        end)


        it("hides reputation until some was earned", function()
            local window, frames = newWindow()

            window.update(summary({ reputation = {} }))

            assert.is_nil(valueForHeading(rowsOf(frames[1]), "Reputation"))
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

            assert.equal("+260", valueForHeading(rowsOf(frames[1]), "Reputation"))
            expand(frames[1], "Reputation")
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

            expand(frames[1], "Reputation")

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

            expand(frames[1], "Reputation")

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

            expand(frames[1], "Reputation")

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

            expand(frames[1], "Reputation")

            assert.same({}, barsOf(frames[1]))
            assert.equal("+40", valueFor(rowsOf(frames[1]), "  Argent Dawn"))
        end)

        describe("what the rest of the account has already done with the faction", function()
            ---@param best table?
            ---@return function
            local function standingSource(best)
                return function(faction)
                    assert.equal("Dream Wardens", faction)
                    return best and { faction = faction, best = best, characters = { best } } or nil
                end
            end

            ---@param overrides table?
            ---@return table
            local function gained(overrides)
                local gain = {
                    faction = "Dream Wardens",
                    amount = 250,
                    standing = "Renown 8",
                    current = 500,
                    max = 2500,
                    rank = 8,
                    system = "renown",
                }
                for key, value in pairs(overrides or {}) do
                    gain[key] = value
                end
                return { reputationTotal = 250, reputation = { gain } }
            end

            it("says which character has got furthest, and how stale that is", function()
                local window, frames = newWindow({
                    accountStanding = standingSource({
                        character = "Alt-Ravencrest",
                        standing = "Renown 22",
                        rank = 22,
                        system = "renown",
                        at = NOW - 3 * 24 * 60 * 60,
                    }),
                })
                window.update(summary(gained()))

                expand(frames[1], "Reputation")

                assert.equal("Alt, 3d ago", valueFor(rowsOf(frames[1]), "    best Renown 22"))
            end)

            it("stays quiet when this character is the one out in front", function()
                local window, frames = newWindow({
                    accountStanding = standingSource({
                        character = "Main-Ravencrest",
                        standing = "Renown 8",
                        rank = 8,
                        system = "renown",
                        at = NOW,
                    }),
                })
                window.update(summary(gained()))

                expand(frames[1], "Reputation")

                assert.is_nil(valueFor(rowsOf(frames[1]), "    best Renown 8"))
            end)

            it("stays quiet when the character ahead is not actually ahead", function()
                local window, frames = newWindow({
                    accountStanding = standingSource({
                        character = "Alt-Ravencrest",
                        standing = "Renown 4",
                        rank = 4,
                        system = "renown",
                        at = NOW,
                    }),
                })
                window.update(summary(gained()))

                expand(frames[1], "Reputation")

                assert.is_nil(valueFor(rowsOf(frames[1]), "    best Renown 4"))
            end)

            it("says nothing about a faction no other character has been seen with", function()
                local window, frames = newWindow({ accountStanding = standingSource(nil) })
                window.update(summary(gained()))

                expand(frames[1], "Reputation")

                local labels = {}
                for _, row in ipairs(rowsOf(frames[1])) do
                    labels[#labels + 1] = row.label
                end
                assert.is_nil((table.concat(labels, "\n")):match("best"))
            end)
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
            expand(frames[1], "Reputation")

            window.update(summary({ reputation = {} }))

            assert.same({}, barsOf(frames[1]))
        end)

        it("hides currency until one changed", function()
            local window, frames = newWindow()

            window.update(summary({ currencies = {} }))

            assert.is_nil(valueForHeading(rowsOf(frames[1]), "Currency"))
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

            assert.equal("+4", valueForHeading(rowsOf(frames[1]), "Currency"))
            expand(frames[1], "Currency")
            local lines = rowsOf(frames[1])
            assert.equal("+7", valueFor(lines, "  Honor"))
            assert.equal("-3", valueFor(lines, "  Valor"))
        end)

        -- The holding a gain landed on is a balance rather than something the segment did,
        -- and it goes the same way the wallet went: the desktop app has it, against the
        -- character it belongs to and beside what the rest of the account holds.
        it("says only what the segment earned, not what it is now holding", function()
            local window, frames = newWindow()
            window.update(summary({
                currencyTotal = 7,
                currencies = { { id = 1, name = "Honor", amount = 7, total = 12450 } },
            }))

            expand(frames[1], "Currency")

            local lines = rowsOf(frames[1])
            assert.equal("+7", valueFor(lines, "  Honor"))
            assert.is_nil(valueFor(lines, "    account"))
        end)

        it("shows a spend as the spend it was", function()
            local window, frames = newWindow()
            window.update(summary({
                currencyTotal = -300,
                currencies = { { id = 1, name = "Honor", amount = -300, total = 1200 } },
            }))

            expand(frames[1], "Currency")

            assert.equal("-300", valueFor(rowsOf(frames[1]), "  Honor"))
        end)

        it("hides achievements until one was earned", function()
            local window, frames = newWindow()

            window.update(summary({ achievements = {} }))

            assert.is_nil(valueForHeading(rowsOf(frames[1]), "Achievements"))
        end)

        it("expands level ups with the level reached", function()
            local window, frames = newWindow()
            window.update(summary({ levelUps = { { level = 42, at = 5000 } } }))

            assert.equal("1", valueForHeading(rowsOf(frames[1]), "Level ups"))
            expand(frames[1], "Level ups")

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

            local value = valueForHeading(rowsOf(frames[1]), "Housing items")
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
            expand(frames[1], "Housing items")

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

            assert.equal("1", valueForHeading(rowsOf(frames[1]), "Housing levels"))
            expand(frames[1], "Housing levels")

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
                -- Without the disclosure icon in front of it, which is markup rather than
                -- something the heading says.
                labels[#labels + 1] = (entry.label:gsub("|T.-|t ", ""))
            end
            assert.same({
                "Loot value", "Gold Δ",
                "Achievements", "Currency", "Mounts", "Pets",
                "Quests", "Reputation", "Toys", "Transmog",
            }, labels)
        end)

        -- What used to be a row of hyphens pretending to be a rule. It is a texture now, so
        -- it is not a row at all, which is why the labels above run straight from the money
        -- into the categories.
        it("separates the money from the categories with a drawn rule", function()
            local window, frames = newWindow()

            window.update(summary({ mounts = { { id = 1, name = "Alabaster Hyena" } } }))

            -- The header's strip and its underline, and then the one between the blocks.
            assert.equal(3, #rulesOf(frames[1]))
            for _, row in ipairs(rowsOf(frames[1])) do
                assert.is_nil(row.label:match("%-%-%-"))
            end
        end)

        it("draws no rule when nothing at all happened", function()
            local window, frames = newWindow()

            window.update(summary())

            assert.equal(2, #rulesOf(frames[1]))
        end)

        it("expands newly collected mounts, pets and toys by name", function()
            local window, frames = newWindow()
            window.update(summary({
                mounts = { { id = 1, name = "Alabaster Hyena" } },
                pets = { { id = 2, name = "Darkmoon Rabbit" } },
                toys = { { id = 3, name = "Katy's Stampwhistle" } },
            }))

            for _, heading in ipairs({ "Mounts", "Pets", "Toys" }) do
                expand(frames[1], heading)
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
            expand(frames[1], "Achievements")

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
            for _, heading in ipairs({ "Achievements", "Quests" }) do
                expand(frames[1], heading)
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
                assert.equal(144, labels[index].width)
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
                valueForHeading(rowsOf(frames[1]), "Achievements")
            )
            assert.is_nil(valueFor(rowsOf(frames[1]), "  Account"))
        end)

        it("opens an achievement from its named row", function()
            local window, frames, recorded = newWindow()
            window.update(summary({
                achievements = { { id = 42, name = "Explore", accountFirst = true } },
            }))

            expand(frames[1], "Achievements")
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

            expand(frames[1], "Quests")

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
                valueForHeading(rowsOf(frames[1]), "Quests")
            )
            expand(frames[1], "Quests")
            local lines = rowsOf(frames[1])
            assert.equal("warband first", valueFor(lines, "  Warband discovery"))
            assert.equal("character first", valueFor(lines, "  Alt discovery"))
        end)

        it("previews a transmog on left click and opens its source on right click", function()
            local window, frames, recorded = newWindow()
            window.update(summary({
                transmogs = { { id = 19019, sourceID = 11, newAppearance = true } },
            }))

            expand(frames[1], "Transmog")
            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.text == "  Named item 19019" then
                    fontString:run("OnMouseUp", "LeftButton")
                    fontString:run("OnMouseUp", "RightButton")
                    break
                end
            end

            assert.same({ 19019 }, recorded.previews)
            assert.same({ 11 }, recorded.collections)
            -- Reviewed, and so ticked: the tick is a texture escape rather than a character,
            -- because the client's font has no check mark to draw.
            local reviewed
            for _, row in ipairs(rowsOf(frames[1])) do
                if row.label:find("Named item 19019", 1, true) then
                    reviewed = row
                end
            end
            assert.is_not_nil(reviewed)
            assert.equal("new", reviewed.value)
            assert.truthy(reviewed.label:find("|TInterface", 1, true))
        end)

        ---Clicks the first row whose text contains `needle`, which is how a heading is
        ---reached without spelling out the icon markup its label is built from.
        ---@param frame table
        ---@param needle string
        local function clickContaining(frame, needle)
            for _, fontString in ipairs(frame.fontStrings) do
                if fontString.shown and (fontString.text or ""):find(needle, 1, true) then
                    fontString:run("OnMouseUp", "LeftButton")
                    return
                end
            end
            error("no row containing " .. needle .. " to click")
        end

        -- A tick, a bullet or an arrow that the client's font has no glyph for draws as an
        -- empty box, which is what a reviewed transmog used to be marked with (issue #83).
        -- Everything on screen at once, expanded, is what makes this one assertion cover the
        -- whole panel rather than the one row the bug was reported against.
        it("draws every row in characters the game's font actually has", function()
            local window, frames = newWindow()
            window.update(summary({
                lootValue = 1234,
                goldDiff = -500,
                achievements = { { id = 1, name = "The Loremaster", accountFirst = true } },
                currencies = { { id = 2, name = "Valor", amount = 7 } },
                currencyTotal = 7,
                levelUps = { { level = 42 } },
                mounts = { { id = 3, name = "Alabaster Hyena" } },
                pets = { { id = 4, name = "Darkmoon Rabbit" } },
                quests = { { id = 5, name = "A Quest", accountFirst = true } },
                reputation = {
                    { faction = "Argent Dawn", amount = 2, standing = "Honored", current = 1, max = 2 },
                },
                reputationTotal = 2,
                toys = { { id = 6, name = "Train Set" } },
                transmogs = { { id = 19019, sourceID = 11, newAppearance = true } },
                housingItems = { { id = 7, name = "Iron Sconce", warbandFirst = true } },
                housingXP = 250,
                housingLevelUps = { { level = 3 } },
            }))
            for _, heading in ipairs({
                "Achievements", "Currency", "Level ups", "Mounts", "Pets", "Quests",
                "Reputation", "Toys", "Housing items", "Housing levels", "Transmog",
            }) do
                clickContaining(frames[1], heading)
            end
            -- Reviewing one marks it, which is the state the missing glyph appeared in.
            clickContaining(frames[1], "Named item 19019")

            for _, fontString in ipairs(frames[1].fontStrings) do
                if fontString.shown then
                    assert.is_nil(undrawable(fontString.text),
                        "undrawable character in " .. tostring(fontString.text))
                end
            end
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
