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
    ---`options.set` is the membership every transmog row's appearance is said to belong to —
    ---a table, or a function of the source id for a case where one row is in a set and the
    ---next is not. `set = false` withholds the lookup entirely, which is the build that has
    ---no set support wired at all and must draw the rows exactly as it always did.
    ---@param options table? `{ name = string?, point = { string, number, number }?,
    ---views = SegmentView[]|fun(): SegmentView[]|boolean?, select = boolean?,
    ---set = TransmogSetMembership|fun(sourceID: integer?): TransmogSetMembership?|boolean?,
    ---shift = boolean?,
    ---title = string|fun(summary: SegmentSummary): string? }`
    ---@return table window, table frames, table recorded `{ saved, loadCalls, selected, tooltip }`
    local function newWindow(options)
        options = options or {}
        local createFrame, frames = fake.newCreateFrame()
        local tooltip, tooltipRecorded = fake.newTooltip()
        -- Held here rather than read off the options, because shift is the one thing about a
        -- click that a test cannot express by clicking: the same panel has to answer both
        -- ways, one click after the other, the way a player's hand does.
        local shift = options.shift and true or false
        local recorded = {
            saved = {},
            sizes = {},
            sizeLoads = 0,
            loadCalls = 0,
            achievements = {},
            previews = {},
            collections = {},
            setPreviews = {},
            setCollections = {},
            setLookups = {},
            selected = {},
            viewReads = 0,
            tooltip = tooltipRecorded,
            ---Hold shift down, or let it up again, between two clicks on the same row.
            ---@param down boolean?
            holdShift = function(down)
                shift = down and true or false
            end,
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
            -- Withheld outright on `options.sized = false`, which is the shape a caller that
            -- does not want a box remembered is built in: the panel still resizes, it simply
            -- has nowhere to write the answer down.
            loadSize = options.sized ~= false and function()
                recorded.sizeLoads = recorded.sizeLoads + 1
                local box = options.size
                if not box then
                    return nil
                end
                return box.width, box.height, box.locked
            end or nil,
            saveSize = options.sized ~= false and function(width, height, locked)
                recorded.sizes[#recorded.sizes + 1] = { width = width, height = height, locked = locked }
            end or nil,
            openAchievement = function(id)
                recorded.achievements[#recorded.achievements + 1] = id
            end,
            previewTransmog = function(id)
                recorded.previews[#recorded.previews + 1] = id
            end,
            openTransmogCollection = function(id)
                recorded.collections[#recorded.collections + 1] = id
            end,
            -- The set the appearance belongs to, asked per row per repaint. Every source it
            -- was asked about is kept, because "the panel looked this up at all" is half of
            -- what separates a row drawn with a set from one drawn without.
            transmogSet = options.set ~= false and function(sourceID)
                recorded.setLookups[#recorded.setLookups + 1] = sourceID
                if type(options.set) == "function" then
                    return options.set(sourceID)
                end
                return options.set or nil
            end or nil,
            -- Withheld together by `options.setActions = false`, which is the panel on a build
            -- that can say what set a piece belongs to but was given no way to act on one.
            -- Main wires the pair with the lookup, so this is about the panel staying whole
            -- rather than about a client that exists.
            previewTransmogSet = options.setActions ~= false and function(itemID, sources)
                recorded.setPreviews[#recorded.setPreviews + 1] = { id = itemID, sources = sources }
            end or nil,
            openTransmogSet = options.setActions ~= false and function(setID)
                recorded.setCollections[#recorded.setCollections + 1] = setID
            end or nil,
            shiftDown = function()
                return shift
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

    ---Everything drawn on a panel, its own regions and every child frame's. The rows live
    ---inside the viewport that scrolls them rather than on the panel itself, so reading the
    ---panel's own two lists would find nothing but the header.
    ---@param frame table
    ---@return table fontStrings, table textures
    local function regionsOf(frame)
        return fake.regionsOf(frame)
    end

    ---The rendered label/value pairs, in order. The window distinguishes labels from
    ---values by justification (left vs right), and creates them label-then-value, so
    ---pairing them by their shown order reconstructs each on-screen line.
    ---@param frame table
    ---@return table[] `{ { label = string, value = string }, ... }`
    local function rowsOf(frame)
        local labels, values = {}, {}
        for _, fontString in ipairs((regionsOf(frame))) do
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
        local fontStrings, textures = regionsOf(frame)
        local captions = {}
        for _, fontString in ipairs(fontStrings) do
            if fontString.shown and fontString.justify == "CENTER" then
                captions[#captions + 1] = fontString.text
            end
        end
        -- Bars are pooled as a track/fill pair each, handed out in order, so the pair at
        -- 2n-1 and 2n is the nth bar and the ones still on screen come first. The panel's own
        -- chrome — the header strip and the hairlines between blocks — is drawn on BORDER,
        -- which is what keeps it out of this pairing.
        local pooled = {}
        for _, texture in ipairs(textures) do
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
        local _, textures = regionsOf(frame)
        local drawn = {}
        for _, texture in ipairs(textures) do
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
        for _, fontString in ipairs((regionsOf(frame))) do
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

    ---The viewport the body is drawn inside: the scroll frame the panel names after itself,
    ---and the frame within it the rows are actually hung off.
    ---@param frames table[]
    ---@return table scroll, table content
    local function viewportOf(frames)
        for _, frame in ipairs(frames) do
            if frame.frameName == NAME .. "Body" then
                return frame, frame.children[1]
            end
        end
        error("the panel built no viewport")
    end

    ---The two buttons that size the panel. They are told apart by what they answer to: the
    ---lock is clicked, and the grip is pressed and let go of, because a drag is not a click.
    ---@param frames table[]
    ---@return table lock, table grip
    local function handlesOf(frames)
        local lock, grip
        for _, frame in ipairs(frames) do
            if frame.frameType == "Button" and frame.parent == frames[1] then
                if frame.scripts.OnMouseDown then
                    grip = frame
                elseif frame.scripts.OnClick and frame.scripts.OnEnter then
                    lock = frame
                end
            end
        end
        return assert(lock, "no lock button"), assert(grip, "no resize grip")
    end

    ---The picker's two columns, in the order they were drawn — rows taken off screen included,
    ---so a test can prove a leftover one was hidden rather than only that it is not in the
    ---list any more. Both halves of a row are clickable, so both have to be reachable.
    ---@param frames table[]
    ---@return table[] labels, table[] details
    local function columnsOf(frames)
        local labels, details = {}, {}
        for _, fontString in ipairs((regionsOf(pickerOf(frames)))) do
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
        for _, fontString in ipairs((regionsOf(frame))) do
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
        for _, fontString in ipairs((regionsOf(frame))) do
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
        for _, fontString in ipairs((regionsOf(frame))) do
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

        -- The panel is the first frame built and everything else — the buttons that size it,
        -- the viewport its rows are drawn inside — hangs off it, so it is the panel being
        -- there at all that says the build ran, rather than any count of what it brought.
        it("builds its frame on the first show", function()
            local window, frames = newWindow()

            window.show()

            assert.equal(NAME, frames[1].frameName)
        end)

        it("builds its frame on the first update", function()
            local window, frames = newWindow()

            window.update(summary())

            assert.equal(NAME, frames[1].frameName)
        end)

        it("builds its frame on the first toggle", function()
            local window, frames = newWindow()

            window.toggle()

            assert.equal(NAME, frames[1].frameName)
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
            local built = #frames
            window.hide()
            window.show()

            assert.equal(built, #frames)
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
            -- The store keys its standings on the faction's own id rather than on the
            -- localised name a chat line used, so this stand-in answers for 2574 and for
            -- nothing else. A panel that asked it by the name would be handed nil and would
            -- draw no "best" line at all, which is what every case below would then fail on.
            local WARDENS = 2574

            ---@param best table?
            ---@param asked table? Collects, once each, what the panel asked the store about.
            ---A row is asked more than once — the "best" line and the hover put the same
            ---question twice — and how often is the panel's own business rather than a fact
            ---worth pinning down; *what* it asks with is the whole point.
            ---@return function
            local function standingSource(best, asked)
                local seen = {}
                return function(factionID)
                    local key = tostring(factionID)
                    if asked and not seen[key] then
                        seen[key] = true
                        asked[#asked + 1] = factionID
                    end
                    if factionID ~= WARDENS or not best then
                        return nil
                    end
                    return {
                        id = factionID,
                        faction = "Dream Wardens",
                        accountWide = false,
                        best = best,
                        characters = { best },
                    }
                end
            end

            ---@param overrides table?
            ---@return table
            local function gained(overrides)
                local gain = {
                    faction = "Dream Wardens",
                    id = WARDENS,
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

            -- Said outright because it is the whole of #254 as the panel sees it. The gain
            -- carries both — the name the chat line announced and the id the client answered
            -- with — and only one of them is what the account's standings are filed under.
            it("asks the store by the faction's id, not by the name the chat line used", function()
                local asked = {}
                local window, frames = newWindow({
                    accountStanding = standingSource(nil, asked),
                })
                window.update(summary(gained()))

                expand(frames[1], "Reputation")

                assert.same({ WARDENS }, asked)
            end)

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
            for _, fontString in ipairs((regionsOf(frames[1]))) do
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
            for _, fontString in ipairs((regionsOf(frames[1]))) do
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
            for _, fontString in ipairs((regionsOf(frames[1]))) do
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

        describe("a transmog row that belongs to one of Blizzard's sets", function()
            local ITEM = 19019
            local SOURCE = 11
            local SET = 1783
            local SOURCES = { 101, 102 }
            ---The row as it is labelled once `itemName` has named the item, which is what a
            ---test points at and clicks. The reviewed tick lands in front of it after the
            ---first click, so it is matched as a substring rather than compared whole.
            local ROW = "Named item 19019"
            ---The set icon, exactly as the panel draws it: a texture escape, and a trailing
            ---space of its own separating it from the fraction.
            local SET_ICON = "|TInterface\\Icons\\INV_Chest_Cloth_17:12:12:0:-1|t "

            ---@param overrides table?
            ---@return TransmogSetMembership
            local function membership(overrides)
                local base = {
                    setID = SET,
                    name = "Bloodfang Armor",
                    collected = 3,
                    total = 8,
                    sources = SOURCES,
                }
                for key, value in pairs(overrides or {}) do
                    base[key] = value
                end
                return base
            end

            ---A segment with one collected appearance in it. `sourceID = false` files the drop
            ---without one, which is what a client that would not resolve the source leaves
            ---behind — and a nil written into an overrides table cannot say that, being
            ---indistinguishable from a key nobody wrote.
            ---@param overrides table? Fields of the transmog event the row is drawn from.
            ---@return SegmentSummary
            local function dropped(overrides)
                local event = { id = ITEM, sourceID = SOURCE, newAppearance = true }
                for key, value in pairs(overrides or {}) do
                    event[key] = value
                end
                if event.sourceID == false then
                    event.sourceID = nil
                end
                return summary({ transmogs = { event } })
            end

            ---The two font strings making up the row saying `name` — the label and the value
            ---beside it. Paired by position among the rows on screen, the same way `rowsOf`
            ---does it, because the panel creates them label-then-value per line.
            ---@param frame table
            ---@param name string
            ---@return table label, table value
            local function regionsFor(frame, name)
                local labels, values = {}, {}
                -- Through `regionsOf` rather than off the panel's own font strings: the body
                -- is drawn inside the viewport that scrolls it, so the panel frame itself
                -- carries none of these rows.
                for _, fontString in ipairs((regionsOf(frame))) do
                    local row = fontString.shown and fontString.template == ROW_FONT
                    if row and fontString.justify == "LEFT" then
                        labels[#labels + 1] = fontString
                    elseif row and fontString.justify == "RIGHT" then
                        values[#values + 1] = fontString
                    end
                end
                for index, label in ipairs(labels) do
                    if (label.text or ""):find(name, 1, true) then
                        return label, values[index]
                    end
                end
                error("no row saying " .. name .. " on screen")
            end

            ---Clicks the row saying `name` with one particular button. Looked up afresh every
            ---time, because a click repaints the panel and the row is pooled.
            ---@param frame table
            ---@param name string
            ---@param button string
            local function clickRow(frame, name, button)
                local label = regionsFor(frame, name)
                label:run("OnMouseUp", button)
            end

            ---Opens the block and hands back the panel's frame, which is every one of these
            ---tests' first two lines: a transmog row is not drawn until the heading over it
            ---has been clicked.
            ---@param options table?
            ---@param overrides table? Fields of the transmog event the row is drawn from.
            ---@return table frame, table recorded
            local function showing(options, overrides)
                local window, frames, recorded = newWindow(options)
                window.update(dropped(overrides))
                expand(frames[1], "Transmog")
                return frames[1], recorded
            end

            -- The fraction is the whole point of the feature: a dropped shoulder is one thing
            -- and the fifth of eight is another. It is drawn after the word the row already
            -- carried rather than instead of it, because "new" and "variant" answer a
            -- different question — whether the account had ever seen this look — and the set
            -- says nothing about that.
            for _, case in ipairs({
                {
                    what = "a new appearance part way into its set",
                    set = {},
                    newAppearance = true,
                    expected = "new |cffadadb3" .. SET_ICON .. "3/8|r",
                },
                {
                    what = "a variant of something the account already had",
                    set = {},
                    newAppearance = false,
                    expected = "variant |cffadadb3" .. SET_ICON .. "3/8|r",
                },
                -- The gold the client uses for a completed collection everywhere else. The
                -- grey above is a set still being worked on, and the two hexes are the only
                -- thing on the row saying which of the two a player is looking at.
                {
                    what = "the piece that finished the set",
                    set = { collected = 8 },
                    newAppearance = true,
                    expected = "new |cffffd100" .. SET_ICON .. "8/8|r",
                },
            }) do
                it("draws the set's fraction beside " .. case.what, function()
                    local frame = showing(
                        { set = membership(case.set) },
                        { newAppearance = case.newAppearance }
                    )

                    assert.equal(case.expected, valueFor(rowsOf(frame), "  " .. ROW))
                end)
            end

            -- The regression that matters most. Most appearances in the game belong to no set
            -- at all, so this is what nearly every transmog row in nearly every segment looks
            -- like, and the set feature must be invisible on all of them: same word, same
            -- width, same everything it was drawn with before sets existed.
            for _, case in ipairs({
                { what = "the appearance belongs to no set the client knows of", options = {} },
                { what = "the build never wired a set lookup at all", options = { set = false } },
                -- Reached through the same nil the module itself refuses on: a row the client
                -- would not resolve a source for has nothing to look a set up by.
                { what = "the drop was filed with no source id", options = {}, sourceID = false },
            }) do
                it("draws the row exactly as it always was when " .. case.what, function()
                    local frame = showing(case.options, { sourceID = case.sourceID })

                    assert.equal("new", valueFor(rowsOf(frame), "  " .. ROW))
                end)
            end

            -- Ninety-two pixels hold "variant" and nothing else. A row carrying a word, an
            -- icon and a fraction needs the wider column the summary headings use, or the
            -- numbers — the only part that is news — are the part clipped off the end.
            for _, case in ipairs({
                { what = "widens the value column for a row carrying a fraction", set = true, width = 140 },
                { what = "leaves an ordinary row on the narrow column", set = false, width = 92 },
            }) do
                it(case.what, function()
                    local frame = showing({ set = case.set and membership() or nil })

                    local _, value = regionsFor(frame, ROW)
                    assert.equal(case.width, value.width)
                end)
            end

            it("looks the set up by the source id the drop was filed with", function()
                local _, recorded = showing({ set = membership() })

                assert.same({ SOURCE }, recorded.setLookups)
            end)

            -- The fraction moves every time another piece is collected, including on another
            -- character an hour later, so the row asks again on every repaint rather than
            -- keeping the answer it was first drawn with.
            it("asks again every time the row is repainted", function()
                local window, frames, recorded = newWindow({ set = membership() })
                window.update(dropped())
                expand(frames[1], "Transmog")

                window.update(dropped())

                assert.same({ SOURCE, SOURCE }, recorded.setLookups)
            end)

            describe("on hover", function()
                it("opens the set the appearance belongs to", function()
                    local frame, recorded = showing({ set = membership({ label = "Heroic" }) })

                    pointAt(frame, ROW)

                    assert.same({
                        "Bloodfang Armor",
                        "Heroic",
                        "Collected → 3 / 8",
                        "",
                        "Shift-click to try on the whole set",
                        "Shift-right-click to open it in Collections",
                    }, tooltipLines(recorded))
                end)

                it("closes it again when the pointer moves off", function()
                    local frame, recorded = showing({ set = membership() })

                    pointAt(frame, ROW, { leave = true })

                    assert.equal(1, recorded.tooltip.hidden)
                end)

                -- A row with nothing to say must not become a dead spot on a frame the player
                -- drags the panel by: mouse-enabling it swallows the drag for no answer.
                it("leaves a row that belongs to no set alone", function()
                    local frame = showing()

                    assert.is_false(pointable(frame, ROW))
                end)
            end)

            -- Four actions on one row, told apart by the button and by shift. Each case
            -- asserts on all four recordings rather than only its own, because the failure
            -- worth catching is a click doing the plausible wrong one of two things — opening
            -- the set where the piece was asked for — and only the empty lists say so.
            for _, case in ipairs({
                {
                    what = "a plain left click tries the piece that dropped on",
                    button = "LeftButton", shift = false,
                    previews = { ITEM },
                },
                {
                    what = "a plain right click opens the piece in the wardrobe",
                    button = "RightButton", shift = false,
                    collections = { SOURCE },
                },
                {
                    what = "a shifted left click tries the whole set on",
                    button = "LeftButton", shift = true,
                    setPreviews = { { id = ITEM, sources = SOURCES } },
                },
                {
                    what = "a shifted right click opens the set in Collections",
                    button = "RightButton", shift = true,
                    setCollections = { SET },
                },
            }) do
                it(case.what, function()
                    local frame, recorded = showing({ set = membership(), shift = case.shift })

                    clickRow(frame, ROW, case.button)

                    assert.same(case.previews or {}, recorded.previews)
                    assert.same(case.collections or {}, recorded.collections)
                    assert.same(case.setPreviews or {}, recorded.setPreviews)
                    assert.same(case.setCollections or {}, recorded.setCollections)
                end)
            end

            -- Shift over a row that has no set has asked for something that does not exist,
            -- and the piece clicked is the nearest true answer. A click that silently did
            -- nothing reads to a player as the panel being broken.
            for _, case in ipairs({
                {
                    what = "tries the piece on for a shifted left click",
                    button = "LeftButton",
                    previews = { ITEM },
                },
                {
                    what = "opens the piece for a shifted right click",
                    button = "RightButton",
                    collections = { SOURCE },
                },
            }) do
                it("falls back to the piece and " .. case.what, function()
                    local frame, recorded = showing({ shift = true })

                    clickRow(frame, ROW, case.button)

                    assert.same(case.previews or {}, recorded.previews)
                    assert.same(case.collections or {}, recorded.collections)
                    assert.same({}, recorded.setPreviews)
                    assert.same({}, recorded.setCollections)
                end)
            end

            -- The same fallback, reached from the other side: there is a set on the row, and
            -- no way to act on it. The panel resolves which of the two set actions a button
            -- would take *before* it classifies the click, precisely so that a shifted click
            -- cannot enter a set branch and find nothing to do there — the row would draw its
            -- fraction and then answer no click at all, which is the worst of both.
            for _, case in ipairs({
                -- A build wired for the fraction but not for the actions.
                {
                    what = "the panel was given no way to act on a set",
                    options = { setActions = false, set = true },
                    button = "LeftButton",
                    previews = { ITEM },
                },
                {
                    what = "the panel was given no way to open a set",
                    options = { setActions = false, set = true },
                    button = "RightButton",
                    collections = { SOURCE },
                },
                -- A set the client counted pieces for but named no sources of. It can still be
                -- opened in the journal, so only the left click falls back: there is nothing
                -- to put on a body, and a dressing room opened over an empty set is the naked
                -- character `ns.newTransmogPreview` exists to avoid.
                {
                    what = "the set the client named has no sources to wear",
                    options = { set = "sourceless" },
                    button = "LeftButton",
                    previews = { ITEM },
                },
            }) do
                it("falls back to the piece when " .. case.what, function()
                    local set = membership(case.options.set == "sourceless" and { sources = {} } or nil)
                    local frame, recorded = showing({
                        shift = true,
                        set = set,
                        setActions = case.options.setActions,
                    })

                    clickRow(frame, ROW, case.button)

                    assert.same(case.previews or {}, recorded.previews)
                    assert.same(case.collections or {}, recorded.collections)
                    assert.same({}, recorded.setPreviews)
                    assert.same({}, recorded.setCollections)
                end)
            end

            -- The half of the sourceless set that does still work. Withholding the whole set
            -- row on a client that would not enumerate it would take away the fraction too,
            -- which is the part the player can actually use.
            it("still opens a set the client named no sources for", function()
                local frame, recorded = showing({ shift = true, set = membership({ sources = {} }) })

                clickRow(frame, ROW, "RightButton")

                assert.same({ SET }, recorded.setCollections)
                assert.same({}, recorded.collections)
            end)

            -- Shift is read when the row is clicked, not when it was drawn. A panel that
            -- sampled the key at repaint would answer with whatever was held the last time
            -- something else happened, which is almost never what the hand on the keyboard
            -- is doing now.
            it("answers the same row both ways as shift goes down between two clicks", function()
                local frame, recorded = showing({ set = membership() })

                clickRow(frame, ROW, "LeftButton")
                recorded.holdShift(true)
                clickRow(frame, ROW, "LeftButton")

                assert.same({ ITEM }, recorded.previews)
                assert.same({ { id = ITEM, sources = SOURCES } }, recorded.setPreviews)
            end)
        end)

        ---Clicks the first row whose text contains `needle`, which is how a heading is
        ---reached without spelling out the icon markup its label is built from.
        ---@param frame table
        ---@param needle string
        local function clickContaining(frame, needle)
            for _, fontString in ipairs((regionsOf(frame))) do
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
                for _, fontString in ipairs((regionsOf(drawn))) do
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
            { what = "the HUD, which has only the lock beside the title", closable = false, width = 220 },
            { what = "a window with a close button as well", closable = true, width = 196 },
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
                assert.is_nil(pickerOf(frames))
            end)
        end

        -- A player who never opens the list never pays for it, which is the same bargain the
        -- panel itself is built on: nothing exists until something asks for it.
        it("builds the list on the first click of the title and not before", function()
            local window, frames = newWindow({ views = offered() })
            window.update(summary())
            assert.is_nil(pickerOf(frames))

            clickTitle(frames[1])

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
            local built = #frames

            clickTitle(frames[1])

            assert.is_false(pickerOf(frames).shown)
            -- And nothing new built for it: the list is built once and redrawn afterwards.
            assert.equal(built, #frames)
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

    describe("the box it sits in", function()
        -- What the panel opens at, and where its body starts: under the header strip, the
        -- hairline closing it, and the frame's own one-pixel edge above both.
        local DEFAULT_WIDTH = 268
        local DEFAULT_HEIGHT = 320
        local BODY_TOP = 26
        local LINE = 15
        local LOCKED_ICON = "Interface\\Buttons\\LockButton-Locked-Up"
        local UNLOCKED_ICON = "Interface\\Buttons\\LockButton-Unlocked-Up"

        ---A summary carrying `count` level ups, which is the cheapest way to make the body
        ---longer than the box it is drawn in: one expanded line each and no bars or hovers.
        ---@param count integer
        ---@return SegmentSummary
        local function long(count)
            local levelUps = {}
            for index = 1, count do
                levelUps[index] = { level = index }
            end
            return summary({ levelUps = levelUps })
        end

        -- The whole point. A panel as tall as whatever the evening had produced, anchored at
        -- its centre the way a HUD dragged into place is, grew in both directions at once: a
        -- drop landing pushed the rows already being read half a line up the screen.
        it("keeps the frame the size it is however much there is to show", function()
            local window, frames = newWindow()
            window.update(summary())
            local _, content = viewportOf(frames)
            local wasContent = content.height

            window.update(long(30))
            expand(frames[1], "Level ups")

            assert.equal(DEFAULT_WIDTH, frames[1].width)
            assert.equal(DEFAULT_HEIGHT, frames[1].height)
            -- And the growing happened somewhere: it is the thing inside the box that got
            -- taller, which is what there now is to scroll.
            assert.is_true(content.height > wasContent)
        end)

        it("opens at the box it was left in", function()
            local window, frames, recorded = newWindow({ size = { width = 320, height = 420 } })

            window.show()

            assert.equal(1, recorded.sizeLoads)
            assert.equal(320, frames[1].width)
            assert.equal(420, frames[1].height)
        end)

        -- A saved box narrower than the panel can draw itself in is a file written by an
        -- older build, or by hand. It is floored rather than obeyed.
        it("refuses a saved box smaller than the panel's own minimum", function()
            local window, frames = newWindow({ size = { width = 10, height = 10 } })

            window.show()

            assert.equal(200, frames[1].width)
            assert.equal(120, frames[1].height)
        end)

        it("saves the box the corner was let go at", function()
            local window, frames, recorded = newWindow()
            window.show()
            local _, grip = handlesOf(frames)

            grip:run("OnMouseDown")
            frames[1]:run("OnSizeChanged", 300, 400)
            grip:run("OnMouseUp")

            assert.equal("BOTTOMRIGHT", frames[1].sizingFrom)
            assert.same({ { width = 300, height = 400, locked = false } }, recorded.sizes)
        end)

        it("relays out the body at the width it was dragged to", function()
            local window, frames = newWindow()
            window.update(summary())

            frames[1]:run("OnSizeChanged", 400, 400)

            -- The title is clipped rather than wrapped, so what it may have is a number, and
            -- the rows below it are hung off the same width.
            assert.equal(400 - 24 - 24, titleOf(frames[1]).width)
            local _, content = viewportOf(frames)
            assert.equal(400, content.width)
        end)

        describe("the lock in the header", function()
            it("starts unlocked, with the panel resizable and the grip in its corner", function()
                local window, frames = newWindow()

                window.show()

                local lock, grip = handlesOf(frames)
                assert.is_true(frames[1].resizable)
                assert.is_true(grip.shown)
                assert.equal(UNLOCKED_ICON, lock.normalTexture)
            end)

            it("pins the size and takes the grip away when it is clicked", function()
                local window, frames, recorded = newWindow()
                window.show()
                local lock, grip = handlesOf(frames)

                lock:run("OnClick")

                assert.is_false(frames[1].resizable)
                assert.is_false(grip.shown)
                assert.equal(LOCKED_ICON, lock.normalTexture)
                assert.same({ { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, locked = true } },
                    recorded.sizes)
            end)

            it("gives the grip back when it is clicked again", function()
                local window, frames = newWindow()
                window.show()
                local lock, grip = handlesOf(frames)
                lock:run("OnClick")

                lock:run("OnClick")

                assert.is_true(frames[1].resizable)
                assert.is_true(grip.shown)
                assert.equal(UNLOCKED_ICON, lock.normalTexture)
            end)

            it("opens locked when that is how it was left", function()
                local window, frames = newWindow({ size = { width = 300, height = 400, locked = true } })

                window.show()

                local lock, grip = handlesOf(frames)
                assert.is_false(frames[1].resizable)
                assert.is_false(grip.shown)
                assert.equal(LOCKED_ICON, lock.normalTexture)
            end)

            -- A padlock in a corner is a thing people guess at, and the sentence beside it is
            -- also the whole of what a client that failed to load the picture has to go on.
            it("says which way round it is when the pointer rests on it", function()
                local window, frames, recorded = newWindow()
                window.show()
                local lock = handlesOf(frames)

                lock:run("OnEnter")

                assert.equal("Size unlocked", recorded.tooltip.lines[1].text)
                lock:run("OnLeave")
                assert.equal(1, recorded.tooltip.hidden)
            end)

            it("locks without complaint when there is nowhere to write it down", function()
                local window, frames = newWindow({ sized = false })
                window.show()
                local lock = handlesOf(frames)

                assert.has_no.errors(function()
                    lock:run("OnClick")
                end)
                assert.is_false(frames[1].resizable)
            end)
        end)

        describe("scrolling what does not fit", function()
            ---Opens a panel whose body is twice the height of the box holding it. The
            ---viewport's own height is planted by hand: the fake does no anchor arithmetic,
            ---so how tall the box came out is the test's to say rather than the frame's.
            ---@return table window, table[] frames, table scroll, table content
            local function overflowing()
                local window, frames = newWindow()
                window.update(summary())
                local scroll, content = viewportOf(frames)
                scroll:SetHeight(math.floor(content.height / 2))
                return window, frames, scroll, content
            end

            it("moves the body up the box when the wheel is turned down", function()
                local _, _, scroll, content = overflowing()

                scroll:run("OnMouseWheel", -1)

                assert.equal(content.height - scroll.height, scroll.verticalScroll)
            end)

            it("stops at the last line rather than scrolling past it", function()
                local _, _, scroll, content = overflowing()

                scroll:run("OnMouseWheel", -1)
                scroll:run("OnMouseWheel", -1)

                assert.equal(content.height - scroll.height, scroll.verticalScroll)
            end)

            it("stops at the first line rather than scrolling above it", function()
                local _, _, scroll = overflowing()
                scroll:run("OnMouseWheel", -1)

                scroll:run("OnMouseWheel", 1)
                scroll:run("OnMouseWheel", 1)

                assert.equal(0, scroll.verticalScroll)
            end)

            -- A block closing under a viewport already scrolled to the bottom used to leave
            -- the panel parked past its own last line, looking at nothing.
            it("pulls back inside the body when a redraw makes it shorter", function()
                local window, frames = newWindow()
                window.update(long(30))
                expand(frames[1], "Level ups")
                local scroll, content = viewportOf(frames)
                scroll:SetHeight(60)
                scroll:run("OnMouseWheel", -20)
                assert.is_true(scroll.verticalScroll > 0)

                expand(frames[1], "Level ups")

                assert.equal(math.max(content.height - 60, 0), scroll.verticalScroll)
            end)

            -- An evening's worth of segments is a longer list than the panel it hangs out of,
            -- and a menu that ran off the bottom of the screen would put the oldest of them
            -- where nobody can reach them.
            it("stops the list at the panel's own bottom edge", function()
                local many = { { kind = "session", key = "session", label = "Session", detail = "" } }
                for index = 1, 40 do
                    many[index + 1] = {
                        kind = "record",
                        key = "record:" .. index,
                        label = "Segment " .. index,
                        detail = "8m",
                    }
                end
                local window, frames = newWindow({ views = many })
                window.update(summary())

                clickTitle(frames[1])

                assert.equal(DEFAULT_HEIGHT - BODY_TOP, pickerOf(frames).height)
            end)

            it("leaves a list that fits at the height of the list", function()
                local window, frames = newWindow({ views = offered() })
                window.update(summary())

                clickTitle(frames[1])

                -- Padding, the hairline splitting the session off, three rows, padding — and
                -- the picker's own edge above and below all of it.
                assert.equal(12 + 11 + 3 * LINE + 12 + 2, pickerOf(frames).height)
            end)
        end)
    end)
end)
