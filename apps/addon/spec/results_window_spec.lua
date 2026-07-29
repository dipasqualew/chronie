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
    ---`options.views` switches the picker on the way Main.lua does: it is the list drawn
    ---from, either as a plain array or as a function returning one, which is what a test that
    ---changes the list between two opens needs. Every key a row is clicked with lands in
    ---`recorded.selected`, and `recorded.viewReads` counts how often the list was read.
    ---The picker needs both a list and a way to choose from it, so either half can be
    ---withheld on its own — `views = false`, or `select = false` — because the detail window
    ---is handed neither and must come out of it a panel with a plain title.
    ---@param options table? `{ name = string?, point = { string, number, number }?,
    ---views = SegmentView[]|fun(): SegmentView[]|boolean?, select = boolean?,
    ---title = string|fun(summary: SegmentSummary): string? }`
    ---@return table window, table frames, table recorded `{ saved, loadCalls, selected, tooltip }`
    local function newWindow(options)
        options = options or {}
        local createFrame, frames = fake.newCreateFrame()
        local tooltip, tooltipRecorded = fake.newTooltip()
        local recorded = {
            saved = {},
            loadCalls = 0,
            achievements = {},
            previews = {},
            collections = {},
            selected = {},
            viewReads = 0,
            tooltip = tooltipRecorded,
        }
        local strip = options.views
        -- Wired independently of the strip, so "a list nobody can choose from" and "a chooser
        -- with no list" are both reachable; a case says `select = false` to withhold it, and
        -- `select = true` to have it without a strip.
        local chooser = options.select
        if chooser == nil then
            chooser = strip ~= nil
        end
        local window = ns.newResultsWindow({
            title = options.title,
            -- The detail window is closable and the HUD is not, and the button that makes it
            -- so is the one thing in the header the title has to keep clear of.
            closable = options.closable,
            views = strip and function()
                recorded.viewReads = recorded.viewReads + 1
                if type(strip) == "function" then
                    return strip()
                end
                return strip
            end or nil,
            select = chooser and function(key)
                recorded.selected[#recorded.selected + 1] = key
            end or nil,
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
            accountCurrency = options.accountCurrency,
            -- Given unless a case deliberately withholds it, because a client build that
            -- never handed the panel a tooltip is its own case rather than the ordinary one.
            tooltip = options.tooltip ~= false and tooltip or nil,
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

    ---The panel's own left margin: what the header's title is hung off, and what every
    ---label in the body below it is hung off too.
    local PADDING = 12

    ---The font template every row of the body and every row of the list is drawn in. The
    ---header's title is the one font string on the panel built in anything else, which is
    ---what keeps it out of the rows below it now that it is justified like them.
    local ROW_FONT = "GameFontHighlightSmall"

    ---The rendered label/value pairs, in order. The window distinguishes labels from
    ---values by justification (left vs right), and creates them label-then-value, so
    ---pairing them by their shown order reconstructs each on-screen line.
    ---@param frame table
    ---@return table[] `{ { label = string, value = string }, ... }`
    local function rowsOf(frame)
        local labels, values = {}, {}
        for _, fontString in ipairs(frame.fontStrings) do
            local row = fontString.shown and fontString.template == ROW_FONT
            if row and fontString.justify == "LEFT" then
                labels[#labels + 1] = fontString.text
            elseif row and fontString.justify == "RIGHT" then
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

    ---The header's title, which is the whole of the header now that the arrows either side
    ---of it are gone. It is the one font string the panel builds in a heading font, which is
    ---what keeps it out of `rowsOf` and `barsOf` even though it is justified the same way
    ---every label in the body is.
    ---@param frame table
    ---@return table?
    local function titleOf(frame)
        for _, fontString in ipairs(frame.fontStrings) do
            if fontString.template ~= ROW_FONT then
                return fontString
            end
        end
        return nil
    end

    ---The picker's own frame, once something has built it. It is a second frame parented to
    ---the panel, and that is what finds it: the panel builds a close button of its own when it
    ---is closable, so counting frames would not survive the detail window's shape.
    ---@param frames table[]
    ---@return table?
    local function pickerOf(frames)
        for _, frame in ipairs(frames) do
            if frame.frameType == "Frame" and frame.parent == frames[1] then
                return frame
            end
        end
        return nil
    end

    ---The picker's two columns, in the order they were drawn — rows taken off screen included,
    ---so a test can prove a leftover one was hidden rather than only that it is not in the
    ---list any more. Both halves of a row are clickable, so both have to be reachable.
    ---@param frames table[]
    ---@return table[] labels, table[] details
    local function columnsOf(frames)
        local labels, details = {}, {}
        for _, fontString in ipairs(pickerOf(frames).fontStrings) do
            if fontString.justify == "LEFT" then
                labels[#labels + 1] = fontString
            elseif fontString.justify == "RIGHT" then
                details[#details + 1] = fontString
            end
        end
        return labels, details
    end

    ---Opens the list, or shuts it again. The title is the picker's button, so this is the
    ---whole of how a player reaches it.
    ---@param frame table the panel's own frame
    local function clickTitle(frame)
        titleOf(frame):run("OnMouseUp", "LeftButton")
    end

    ---Where a region was last put down its frame. Points accumulate as a pooled row is
    ---redrawn, so the last one is where it actually ended up. The panel is laid out
    ---downwards, which makes further down the frame a smaller number.
    ---@param region table
    ---@return number
    local function topOf(region)
        return region.points[#region.points][3]
    end

    ---The list as ns.newSegmentViews.list hands it over: the session first, then the evening
    ---in the order it happened — the segments already filed, oldest first, and the one being
    ---played last. One of them is an alt's, because an evening survives hopping characters
    ---and the label says so when it does.
    ---@param current string? the key the panel is standing on; the open segment by default
    ---@return SegmentView[]
    local function offered(current)
        local listed = {
            { kind = "session", key = "session", title = "Session · 3 segments",
                label = "Session", detail = "3 segments" },
            { kind = "record", key = "record:a", title = "Alt — Deadmines · 20m ago",
                label = "Alt — Deadmines", detail = "8m · 20m ago" },
            { kind = "live", key = "live", title = "Westfall",
                label = "Westfall", detail = "12m · playing" },
        }
        for _, view in ipairs(listed) do
            view.current = view.key == (current or "live")
        end
        return listed
    end

    ---What is left of that list once the dungeon has fallen out of the evening: the session
    ---and nothing else, which is what the pool has to shrink back to.
    ---@return SegmentView[]
    local function sessionOnly()
        return { {
            kind = "session", key = "session", title = "Session · 1 segment",
            label = "Session", detail = "1 segment", current = true,
        } }
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
            if fontString.shown and fontString.template == ROW_FONT
                and (fontString.text or ""):find(name, 1, true) then
                fontString:run("OnMouseUp", "LeftButton")
                return
            end
        end
        error("no row saying " .. name .. " to click")
    end

    ---Rests the pointer on the first row saying `name`, and takes it off again if asked.
    ---@param frame table
    ---@param name string
    ---@param options table? `{ leave = boolean }`
    ---@return table the font string the pointer was over
    local function pointAt(frame, name, options)
        for _, fontString in ipairs(frame.fontStrings) do
            if fontString.shown and fontString.template == ROW_FONT and fontString.justify == "LEFT"
                and (fontString.text or ""):find(name, 1, true) then
                fontString:run("OnEnter")
                if options and options.leave then
                    fontString:run("OnLeave")
                end
                return fontString
            end
        end
        error("no row saying " .. name .. " to point at")
    end

    ---@param frame table
    ---@param name string
    ---@return boolean whether the row saying `name` has a tooltip on it at all
    local function pointable(frame, name)
        for _, fontString in ipairs(frame.fontStrings) do
            if fontString.shown and fontString.template == ROW_FONT and fontString.justify == "LEFT"
                and (fontString.text or ""):find(name, 1, true) then
                return fontString.scripts.OnEnter ~= nil
            end
        end
        error("no row saying " .. name .. " on screen")
    end

    ---The tooltip as it reads: the title first, then `left` or `left → right` per line.
    ---@param recorded table
    ---@return string[]
    local function tooltipLines(recorded)
        local out = {}
        for _, line in ipairs(recorded.tooltip.lines) do
            out[#out + 1] = line.right and (line.text .. " → " .. line.right) or line.text
        end
        return out
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

            -- Naming the holder as "you" rather than leaving the line off: an absent line is
            -- the one answer a player cannot read, because it looks exactly like the panel not
            -- knowing. No staleness beside it, because that reading is a moment old.
            it("names this character as the holder when it is the one out in front", function()
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

                assert.equal("you", valueFor(rowsOf(frames[1]), "    best Renown 8"))
            end)

            -- The store's best was filed at somebody's logout; this segment has been earning
            -- since. A character that overtook the account's best while it was being played
            -- holds the crown, and the line has to say the standing it is holding it at.
            it("states the reading taken this session over the one the store had filed", function()
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

                assert.equal("you", valueFor(rowsOf(frames[1]), "    best Renown 8"))
            end)

            it("states this character's own standing for a faction no other has been seen with", function()
                local window, frames = newWindow({ accountStanding = standingSource(nil) })
                window.update(summary(gained()))

                expand(frames[1], "Reputation")

                assert.equal("you", valueFor(rowsOf(frames[1]), "    best Renown 8"))
            end)

            -- The line reports the account's highest known standing, and a faction the client
            -- would neither name nor place has no standing to be highest. Drawing "best
            -- standing" over nothing would report knowing something it does not.
            it("says nothing at all about a faction the client could not place", function()
                local window, frames = newWindow({ accountStanding = standingSource(nil) })
                window.update(summary({
                    reputationTotal = 250,
                    reputation = { { faction = "Dream Wardens", amount = 250 } },
                }))

                expand(frames[1], "Reputation")

                local labels = {}
                for _, row in ipairs(rowsOf(frames[1])) do
                    labels[#labels + 1] = row.label
                end
                assert.is_nil((table.concat(labels, "\n")):match("best"))
            end)

            -- The "best" line above names the account's highest standing and who holds it, in
            -- one line. The rest of that answer — every character seen with the faction, how
            -- far each got, how stale each reading is — is one hover away.
            describe("on hover", function()
                it("opens the account's standings over the faction pointed at", function()
                    local window, frames, recorded = newWindow({
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

                    pointAt(frames[1], "Dream Wardens")

                    assert.equal(1, recorded.tooltip.shown)
                    assert.equal("Dream Wardens", recorded.tooltip.lines[1].text)
                    assert.same({
                        "Dream Wardens",
                        "Best → Renown 22 · Alt",
                        " ",
                        "Alt · 3d ago → Renown 22",
                        "Main (you) → Renown 8  500 / 2,500",
                    }, tooltipLines(recorded))
                end)

                it("closes it again when the pointer moves off", function()
                    local window, frames, recorded = newWindow({ accountStanding = standingSource(nil) })
                    window.update(summary(gained()))
                    expand(frames[1], "Reputation")

                    pointAt(frames[1], "Dream Wardens", { leave = true })

                    assert.equal(1, recorded.tooltip.hidden)
                end)

                it("anchors to the cursor, so the line pointed at is the one answered", function()
                    local window, frames, recorded = newWindow({ accountStanding = standingSource(nil) })
                    window.update(summary(gained()))
                    expand(frames[1], "Reputation")

                    pointAt(frames[1], "Dream Wardens")

                    assert.equal("ANCHOR_CURSOR", recorded.tooltip.anchor)
                    assert.equal(frames[1], recorded.tooltip.owner)
                end)

                -- A row nothing can be said about must not become a dead spot on a frame the
                -- player drags by: mouse-enabling it would swallow the drag for no answer.
                it("leaves a faction the client could not place alone", function()
                    local window, frames = newWindow({ accountStanding = function() return nil end })
                    window.update(summary({
                        reputationTotal = 40,
                        reputation = { { faction = "Argent Dawn", amount = 40 } },
                    }))

                    expand(frames[1], "Reputation")

                    assert.is_false(pointable(frames[1], "Argent Dawn"))
                end)

                -- Rows are pooled, so the font string that was a faction a moment ago is a
                -- mount now, and must not still open that faction's tooltip.
                it("takes the tooltip off a row reused for something else", function()
                    local window, frames = newWindow({ accountStanding = standingSource(nil) })
                    window.update(summary(gained()))
                    expand(frames[1], "Reputation")
                    local row = pointAt(frames[1], "Dream Wardens")

                    window.update(summary({ reputation = {}, mounts = { { name = "Invincible" } } }))

                    assert.is_nil(row.scripts.OnEnter)
                end)

                it("draws nothing at all on a build that handed it no tooltip", function()
                    local window, frames = newWindow({
                        tooltip = false,
                        accountStanding = standingSource(nil),
                    })
                    window.update(summary(gained()))
                    expand(frames[1], "Reputation")

                    assert.is_false(pointable(frames[1], "Dream Wardens"))
                end)
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

        -- The holding a gain landed on is a balance rather than something the segment did, so
        -- it stays off the line the way the wallet does. It is a hover away rather than gone:
        -- see "on hover" below.
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

        describe("what the account is holding of a currency, on hover", function()
            ---@param characters table[]?
            ---@param accountWide boolean?
            ---@return function
            local function currencySource(characters, accountWide)
                return function(id)
                    assert.equal(1, id)
                    if not characters then
                        return nil
                    end
                    local total = 0
                    for _, held in ipairs(characters) do
                        total = total + held.total
                    end
                    return {
                        id = id,
                        name = "Honor",
                        total = total,
                        accountWide = accountWide or false,
                        characters = characters,
                        oldest = NOW,
                    }
                end
            end

            ---@return table
            local function earned()
                return {
                    currencyTotal = 7,
                    currencies = { { id = 1, name = "Honor", amount = 7, total = 12450 } },
                }
            end

            it("adds up what every character is holding", function()
                local window, frames, recorded = newWindow({
                    accountCurrency = currencySource({
                        { character = "Alt-Ravencrest", name = "Honor", total = 1910, at = NOW - 2 * 24 * 60 * 60 },
                    }),
                })
                window.update(summary(earned()))
                expand(frames[1], "Currency")

                pointAt(frames[1], "Honor")

                assert.same({
                    "Honor",
                    "Account → 14,360",
                    " ",
                    "Main (you) → 12,450",
                    "Alt · 2d ago → 1,910",
                }, tooltipLines(recorded))
            end)

            it("counts a warband-wide pot once rather than once per character", function()
                local window, frames, recorded = newWindow({
                    accountCurrency = currencySource({
                        { character = "Main-Ravencrest", name = "Honor", total = 12000, at = NOW - 24 * 60 * 60 },
                        { character = "Alt-Ravencrest", name = "Honor", total = 12000, at = NOW - 24 * 60 * 60 },
                    }, true),
                })
                window.update(summary(earned()))
                expand(frames[1], "Currency")

                pointAt(frames[1], "Honor")

                assert.same({
                    "Honor",
                    "Warband → 12,450",
                    "One pot the whole account shares.",
                }, tooltipLines(recorded))
            end)

            it("leaves a currency nobody has ever reported holding alone", function()
                local window, frames = newWindow({ accountCurrency = currencySource(nil) })
                window.update(summary({
                    currencyTotal = 7,
                    currencies = { { id = 1, name = "Honor", amount = 7 } },
                }))

                expand(frames[1], "Currency")

                assert.is_false(pointable(frames[1], "Honor"))
            end)
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
            -- Built with the picker on and standing on a dated view, so the header's own
            -- string — a title carrying a separator behind the icon that opens the list — and
            -- every row of the list itself are swept too.
            local window, frames = newWindow({ views = offered("record:a") })
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
            }), { kind = "record", key = "record:1", title = "Deadmines · 12m ago" })
            for _, heading in ipairs({
                "Achievements", "Currency", "Level ups", "Mounts", "Pets", "Quests",
                "Reputation", "Toys", "Housing items", "Housing levels", "Transmog",
            }) do
                clickContaining(frames[1], heading)
            end
            -- Reviewing one marks it, which is the state the missing glyph appeared in.
            clickContaining(frames[1], "Named item 19019")
            -- And the list open behind it, which is a second frame full of names the addon
            -- built rather than took off the client.
            clickTitle(frames[1])

            for _, drawn in ipairs({ frames[1], pickerOf(frames) }) do
                for _, fontString in ipairs(drawn.fontStrings) do
                    if fontString.shown then
                        assert.is_nil(undrawable(fontString.text),
                            "undrawable character in " .. tostring(fontString.text))
                    end
                end
            end
        end)
    end)

    describe("the header the list hangs from", function()
        ---One view off the list, as ns.newSegmentViews hands it over.
        ---@param overrides table?
        ---@return SegmentView
        local function view(overrides)
            local base = { kind = "live", key = "live", title = "Deadmines" }
            for key, value in pairs(overrides or {}) do
                base[key] = value
            end
            return base
        end

        -- The view's name is the only thing on screen saying which of several is being
        -- looked at, so it outranks whatever the panel was built with.
        it("says what the view it is standing on is called", function()
            local window, frames = newWindow({ title = "Current Segment" })

            window.update(summary(), view({ title = "Session · 3 segments" }))

            assert.equal("Session · 3 segments", titleOf(frames[1]).text)
        end)

        it("still says what it was built with while it is handed no view", function()
            local window, frames = newWindow({ title = "Current Segment" })

            window.update(summary())

            assert.equal("Current Segment", titleOf(frames[1]).text)
        end)

        -- The header used to be an arrow, the name, and another arrow, which left the name
        -- centred between them and the only control on the strip drifting about as the name
        -- under it changed length. With the arrows gone the name starts at the panel's own
        -- left margin — the same one every label in the body starts at — and the icon that
        -- opens the list is the first thing on the line rather than something to hunt for.
        it("hangs the title off the left margin rather than centring it", function()
            local window, frames = newWindow({ views = offered(), title = "Current Segment" })

            window.update(summary())

            local title = titleOf(frames[1])
            assert.equal("LEFT", title.justify)
            assert.equal(PADDING, title.points[1][4])
        end)

        -- There is nothing left in the header for a long name to run into, so it may have the
        -- whole strip, less the close button on a panel that has one.
        for _, case in ipairs({
            { what = "the HUD, which has nothing beside the title", closable = false, width = 244 },
            { what = "a window with a close button to keep clear of", closable = true, width = 220 },
        }) do
            it("gives the title the width of " .. case.what, function()
                local window, frames = newWindow({ closable = case.closable })

                window.update(summary())

                assert.equal(case.width, titleOf(frames[1]).width)
            end)
        end

        -- The body is read out of the frame by justification and by texture layer, and the
        -- title is justified exactly the way every label in the body is. Told apart by
        -- anything less than the font it is built in, it would show up as a phantom row in
        -- every other test in this file.
        it("keeps the title out of the rows, the bars and the rules the body is made of", function()
            local plain, plainFrames = newWindow()
            local named, namedFrames = newWindow({ views = offered() })
            local drawn = summary({
                lootValue = 1234,
                reputationTotal = 250,
                reputation = {
                    { faction = "Argent Dawn", amount = 250, standing = "Honored", current = 1, max = 2 },
                },
            })

            plain.update(drawn)
            named.update(drawn, view())
            expand(plainFrames[1], "Reputation")
            expand(namedFrames[1], "Reputation")

            assert.same(rowsOf(plainFrames[1]), rowsOf(namedFrames[1]))
            assert.same(barsOf(plainFrames[1]), barsOf(namedFrames[1]))
            assert.equal(#rulesOf(plainFrames[1]), #rulesOf(namedFrames[1]))
        end)
    end)

    describe("the picker the title opens", function()
        local GOLD = { 1, 0.82, 0 }
        -- The colour every heading in the body is drawn in: bright enough to read as a thing
        -- that can be clicked, plain enough that the gold row is the one the eye lands on.
        local PLAIN = { 0.93, 0.91, 0.85 }

        ---Opens the list, shuts it, and opens it again on a strip that has changed underneath —
        ---which is what a segment falling out of the evening does while the panel is on screen.
        ---@param first SegmentView[]
        ---@param second SegmentView[]
        ---@return table frames, table recorded
        local function reopenOn(first, second)
            local listed = first
            local window, frames, recorded = newWindow({
                views = function()
                    return listed
                end,
            })
            window.update(summary())
            clickTitle(frames[1])
            clickTitle(frames[1])
            listed = second
            clickTitle(frames[1])
            return frames, recorded
        end

        -- The panel predates having more than one view and the detail window still has exactly
        -- one, so the picker is something the HUD gets and the other callers do not. Both
        -- halves are needed for it to be anything: a list nobody can choose from is a menu that
        -- does not work, and a chooser with no list has nothing to put on screen.
        for _, case in ipairs({
            { what = "neither a list nor a way to choose from it", views = false, select = false },
            { what = "a list but no way to choose from it", views = offered(), select = false },
            { what = "a way to choose but no list to choose from", views = false, select = true },
        }) do
            it("leaves the title a title given " .. case.what, function()
                local window, frames = newWindow({ views = case.views, select = case.select })

                window.update(summary())

                local title = titleOf(frames[1])
                assert.equal("Current Segment", title.text)
                assert.is_nil(title.scripts.OnMouseUp)
                assert.equal(1, #frames)
            end)
        end

        -- A player who never opens the list never pays for it, which is the same bargain the
        -- panel itself is built on: nothing exists until something asks for it.
        it("builds the list on the first click of the title and not before", function()
            local window, frames = newWindow({ views = offered() })
            window.update(summary())
            assert.equal(1, #frames)

            clickTitle(frames[1])

            assert.equal(2, #frames)
            assert.equal(frames[1], pickerOf(frames).parent)
            assert.is_true(pickerOf(frames).shown)
        end)

        -- In the order they were handed over, which is the order the evening happened in:
        -- the session on top, then the oldest segment, and the one being played at the
        -- bottom. A menu that sorted them for itself would disagree with the module that
        -- built the list about what "the last one" means.
        it("names the session and every segment, with what tells them apart beside it", function()
            local window, frames = newWindow({ views = offered() })
            window.update(summary())

            clickTitle(frames[1])

            assert.same({
                { label = "Session", value = "3 segments" },
                { label = "Alt — Deadmines", value = "8m · 20m ago" },
                { label = "Westfall", value = "12m · playing" },
            }, rowsOf(pickerOf(frames)))
        end)

        -- The whole point of the issue this was built for: the session total is one choice and
        -- the individual segments are another list, rather than the two being one strip walked
        -- end to end. A hairline between them is what says so, and it has to sit between them
        -- rather than merely exist.
        it("rules a line between the session and the segments under it", function()
            local window, frames = newWindow({ views = offered() })
            window.update(summary())

            clickTitle(frames[1])

            local rules = rulesOf(pickerOf(frames))
            local labels = columnsOf(frames)
            assert.equal(1, #rules)
            assert.is_true(topOf(labels[1]) > topOf(rules[1]))
            assert.is_true(topOf(rules[1]) > topOf(labels[2]))
        end)

        -- A menu that named the same three things whatever was on screen would leave the
        -- player clicking the row they are already standing on.
        for _, case in ipairs({
            { what = "the session total", key = "session", lit = 1 },
            { what = "a segment already filed", key = "record:a", lit = 2 },
            { what = "the segment being played", key = "live", lit = 3 },
        }) do
            it("draws the row for " .. case.what .. " in gold while that is the view on screen", function()
                local window, frames = newWindow({ views = offered(case.key) })
                window.update(summary())

                clickTitle(frames[1])

                local labels = columnsOf(frames)
                for index, label in ipairs(labels) do
                    assert.same(index == case.lit and GOLD or PLAIN, label.color)
                end
            end)
        end

        -- Both halves of a row, because a row is one thing to a player and two font strings to
        -- the panel, and a list where the metadata was dead to the touch would be a list where
        -- half of every row does nothing.
        for _, case in ipairs({
            { what = "its name", column = "label" },
            { what = "the metadata beside it", column = "detail" },
        }) do
            it("stands the panel on the segment picked by " .. case.what, function()
                local window, frames, recorded = newWindow({ views = offered() })
                window.update(summary())
                clickTitle(frames[1])
                local labels, details = columnsOf(frames)

                local clicked = case.column == "label" and labels[2] or details[2]
                clicked:run("OnMouseUp", "LeftButton")

                assert.same({ "record:a" }, recorded.selected)
                -- And the list closes behind the choice: it has been made.
                assert.is_false(pickerOf(frames).shown)
            end)
        end

        it("closes the list again when the title is clicked a second time", function()
            local window, frames = newWindow({ views = offered() })
            window.update(summary())
            clickTitle(frames[1])

            clickTitle(frames[1])

            assert.is_false(pickerOf(frames).shown)
            -- And no second frame for it: the list is built once and redrawn afterwards.
            assert.equal(2, #frames)
        end)

        -- The title is the picker's button, and a button has to say which way it goes. It
        -- carries the same disclosure icon every openable block in the body does — a texture
        -- escape rather than a character, because the client's font has no triangle in it.
        for _, case in ipairs({
            { what = "closed", clicks = 0, icon = "|TInterface\\Buttons\\UI-PlusButton-Up:12:12:0:-1|t " },
            { what = "open", clicks = 1, icon = "|TInterface\\Buttons\\UI-MinusButton-Up:12:12:0:-1|t " },
        }) do
            it("marks the title with the icon for a list that is " .. case.what, function()
                local window, frames = newWindow({ views = offered(), title = "Current Segment" })
                window.update(summary())

                for _ = 1, case.clicks do
                    clickTitle(frames[1])
                end

                assert.equal(case.icon .. "Current Segment", titleOf(frames[1]).text)
            end)
        end

        -- A menu left open behind a hidden HUD is a menu that reappears over whatever the
        -- player opened the panel for next.
        for _, case in ipairs({
            { what = "hidden", close = function(window) window.hide() end },
            { what = "toggled away", close = function(window) window.toggle() end },
        }) do
            it("shuts the list when the panel itself is " .. case.what, function()
                local window, frames = newWindow({ views = offered() })
                window.update(summary())
                window.show()
                clickTitle(frames[1])

                case.close(window)

                assert.is_false(pickerOf(frames).shown)
            end)
        end

        -- The strip grows while the panel is on screen, and a segment that closed since the
        -- last look is exactly the row somebody opening this is reaching for. Keeping the first
        -- list read would offer them everything except what they came for.
        it("reads the strip fresh on every open rather than keeping the first one", function()
            local frames, recorded = reopenOn(offered(), sessionOnly())

            assert.same({ { label = "Session", value = "1 segment" } }, rowsOf(pickerOf(frames)))
            -- Three clicks: open, close, open. The read happens on the way open and nowhere else.
            assert.equal(2, recorded.viewReads)
        end)

        -- And it shrinks too, once the silence in front of the last dungeon is long enough.
        -- Rows are pooled, so the ones a shorter list no longer needs have to come off screen
        -- and take their clicks with them. A hidden font string cannot be clicked today, but a
        -- row still carrying a handler for a segment it is no longer drawing is a trap waiting
        -- for the pool to hand it out again.
        it("takes the rows a shorter strip no longer needs off screen, clicks and all", function()
            local frames = reopenOn(offered(), sessionOnly())

            local labels, details = columnsOf(frames)
            assert.equal(3, #labels)
            for index = 2, 3 do
                for _, region in ipairs({ labels[index], details[index] }) do
                    assert.is_false(region.shown)
                    assert.is_nil(region.scripts.OnMouseUp)
                end
            end
        end)

        -- The hairline separates the session from the segments, and a list with no segments on
        -- it has nothing to separate the session from.
        it("takes the hairline away when the session is the only thing on offer", function()
            local frames = reopenOn(offered(), sessionOnly())

            assert.same({}, rulesOf(pickerOf(frames)))
        end)

        -- The body is read out of the panel's own frame by justification and by texture layer,
        -- and the picker is a second frame full of font strings justified exactly the same way
        -- with a hairline drawn on the same layer. Drawn onto the panel instead, it would show
        -- up as a phantom row in every other test in this file.
        it("keeps the picker out of the rows, the bars and the rules the body is made of", function()
            local plain, plainFrames = newWindow()
            local picked, pickedFrames = newWindow({ views = offered() })
            local drawn = summary({
                lootValue = 1234,
                reputationTotal = 250,
                reputation = {
                    { faction = "Argent Dawn", amount = 250, standing = "Honored", current = 1, max = 2 },
                },
            })

            plain.update(drawn)
            picked.update(drawn)
            clickTitle(pickedFrames[1])
            expand(plainFrames[1], "Reputation")
            expand(pickedFrames[1], "Reputation")

            assert.same(rowsOf(plainFrames[1]), rowsOf(pickedFrames[1]))
            assert.same(barsOf(plainFrames[1]), barsOf(pickedFrames[1]))
            assert.equal(#rulesOf(plainFrames[1]), #rulesOf(pickedFrames[1]))
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
