local _, ns = ...

---A small, draggable HUD panel that renders the current segment's SegmentSummary.
---Deliberately thin: it lays out font strings and remembers where it was dragged, and
---nothing else.
---@class ResultsWindow
---@field show fun()
---@field hide fun()
---@field toggle fun()
---@field isShown fun(): boolean
---@field update fun(summary: SegmentSummary, view: SegmentView?) Repaint; builds the frame on
---first use. The view, when there is one, says which of several the panel is standing on,
---and is what the arrows in the header are drawn from.

---@class ResultsWindowDeps
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field uiParent table
---@field name string Unique global frame name.
---@field formatMoney fun(copper: integer): string
---@field loadPoint fun(): (string?, number?, number?) Saved point, x, y — or nil for the default spot.
---@field savePoint fun(point: string, x: number, y: number) Persist a dragged position.
---@field openAchievement fun(id: integer)?
---@field previewTransmog fun(itemID: integer)?
---@field openTransmogCollection fun(sourceID: integer)?
---@field itemName fun(itemID: integer): string?
---@field now fun(): integer? Current time, for saying how old an account-wide figure is.
---@field accountStanding fun(faction: string): StandingRollup? Where the account as a whole
---stands with a faction, so a grind already finished elsewhere says so.
---@field accountCurrency fun(id: integer): CurrencyRollup? What the whole account holds of a
---currency, so a gain can be read against the balance it lands on.
---@field character fun(): string? "Name-Realm" of whoever is playing, so the account rollup
---can leave out the character whose own numbers are already on the line above.
---@field tooltip table? The global GameTooltip. Given one, a faction opens the whole account's
---standings with it on hover; without one the panel simply has nothing to hover.
---@field title string|fun(summary: SegmentSummary): string?
---@field navigate fun(delta: integer)? Walk to another view: -1 towards the session total,
---+1 back through the segments already played. Given one, the header grows an arrow at each
---end; without one the panel shows whatever it is handed and nothing else.
---@field closable boolean?
---@field specialFrames string[]?
---@field frameStrata string?
---@field toplevel boolean?

local WIDTH = 268
local PADDING = 12
local LINE = 15
local COLUMN_GAP = 8
local VALUE_WIDTH = 92
local SUMMARY_VALUE_WIDTH = 140
-- The title sits on a strip of its own, closed by a hairline: the panel's whole shape is
-- flat colour and one-pixel edges, so the header is separated by a rule rather than a
-- carved border.
local HEADER_HEIGHT = 24
local RULE_HEIGHT = 1
-- A rule in the body takes a line to itself, breathing on both sides.
local RULE_LINE = 11
-- A reputation bar sits under the faction it belongs to, indented past its name so the
-- two read as one entry, and takes a whole line of its own so the standing fits on it.
local BAR_HEIGHT = 11
local BAR_INDENT = 10
-- Room for one arrow at each end of the header strip, which the title is then squeezed
-- between rather than drawn over.
local ARROW_WIDTH = 14

local TITLE_COLOR = { 1, 0.82, 0 }
-- An arrow with nowhere left to go is dimmed rather than taken away, so the header keeps
-- the same shape at the ends of the strip as it has in the middle of it.
local ARROW_COLOR = { 1, 0.82, 0 }
local ARROW_SPENT_COLOR = { 0.35, 0.35, 0.38 }
local HEADING_COLOR = { 0.93, 0.91, 0.85 }
local LABEL_COLOR = { 0.68, 0.68, 0.7 }
local VALUE_COLOR = { 1, 1, 1 }
local GOLD_COLOR = { 1, 0.82, 0 }
local REP_COLOR = { 0.4, 0.8, 0.4 }
-- Purple is the account's colour and green the character's, everywhere: an achievement
-- nobody on the account had earned before and an appearance new to the whole wardrobe are
-- both purple, and a character's own first and a variant of something already collected
-- are both green.
local ACCOUNT_COLOR = { 0.7, 0.45, 1 }
local CHARACTER_COLOR = { 0.35, 0.85, 0.45 }

local PANEL_COLOR = { 0.05, 0.05, 0.06, 0.94 }
local BORDER_COLOR = { 0, 0, 0, 1 }
local HEADER_COLOR = { 0.11, 0.11, 0.13, 1 }
local RULE_COLOR = { 1, 0.82, 0, 0.22 }
local BAR_BACK_COLOR = { 0.14, 0.14, 0.14, 0.9 }
local BAR_FILL_COLOR = { 0.24, 0.55, 0.29, 0.95 }

local ACCOUNT_HEX = "|cffb373ff"
local CHARACTER_HEX = "|cff59d973"
local COLOR_END = "|r"

-- FRIZQT__.TTF carries 253 codepoints — ASCII, Latin-1 and a short tail of punctuation —
-- and none of the arrows, triangles or check marks a panel like this wants. Read out of the
-- font's own cmap: `fonts/frizqt__.ttf`, file 615960, build 12.0.5.67823. So every icon here
-- is a texture escape instead, against paths confirmed present in that same build. The `·`
-- and `Δ` used below are in the font; anything beyond them has to become one of these.
local EXPAND_ICON = "|TInterface\\Buttons\\UI-PlusButton-Up:12:12:0:-1|t "
local COLLAPSE_ICON = "|TInterface\\Buttons\\UI-MinusButton-Up:12:12:0:-1|t "
local REVIEWED_ICON = "|TInterface\\RaidFrame\\ReadyCheck-Ready:12:12:0:-1|t "

---Groups a count's digits in threes. Lives in `AccountTooltip.lua` because the bar caption
---and the tooltip over it have to print the same number the same way.
---@param value number?
---@return string
local function group(value)
    return ns.groupDigits(value)
end

-- Which colour each kind of tooltip line is drawn in. Purple is the account's and green the
-- character's, the same as everywhere else on the panel, so the figure for the whole account
-- and the row belonging to whoever is playing are recognisable before either is read.
local TOOLTIP_ROLE_COLORS = {
    total = ACCOUNT_COLOR,
    you = CHARACTER_COLOR,
    other = VALUE_COLOR,
    note = LABEL_COLOR,
    blank = LABEL_COLOR,
}

---@param deps ResultsWindowDeps
---@return ResultsWindow
function ns.newResultsWindow(deps)
    local createFrame = deps.createFrame

    ---@type { label: table, value: table }[]
    local rows = {}
    ---@type { back: table, fill: table, text: table }[]
    local bars = {}
    ---@type table[] Hairlines drawn between blocks of the body.
    local rules = {}
    local frame, title
    ---@type table?, table?
    local backArrow, forwardArrow
    local latest, latestView
    local expanded = {
        transmogs = false,
        currencies = false,
        reputation = false,
        achievements = false,
        levelUps = false,
        mounts = false,
        pets = false,
        quests = false,
        toys = false,
        housingItems = false,
        housingLevelUps = false,
    }
    local reviewedTransmogs = {}
    local reviewedSegmentKey
    local lastTransmogCount = 0

    local function build()
        frame = createFrame("Frame", deps.name, deps.uiParent, "BackdropTemplate")
        frame:SetWidth(WIDTH)
        frame:SetHeight(90)
        frame:SetFrameStrata(deps.frameStrata or "MEDIUM")
        if deps.toplevel then
            frame:SetToplevel(true)
        end
        -- Flat colour and a one-pixel edge, rather than the client's carved dialog border:
        -- the panel is read at a glance while something else is happening on screen, and a
        -- dark rectangle with a hairline round it takes far less attention to see past than
        -- a tiled parchment does. WHITE8X8 is the client's own white pixel, tinted by the
        -- backdrop colours below, so the whole frame costs two textures.
        frame:SetBackdrop({
            bgFile = "Interface\\Buttons\\WHITE8X8",
            edgeFile = "Interface\\Buttons\\WHITE8X8",
            edgeSize = 1,
            insets = { left = 1, right = 1, top = 1, bottom = 1 },
        })
        frame:SetBackdropColor(PANEL_COLOR[1], PANEL_COLOR[2], PANEL_COLOR[3], PANEL_COLOR[4])
        frame:SetBackdropBorderColor(BORDER_COLOR[1], BORDER_COLOR[2], BORDER_COLOR[3], BORDER_COLOR[4])
        frame:SetMovable(true)
        frame:EnableMouse(true)
        frame:SetClampedToScreen(true)
        frame:RegisterForDrag("LeftButton")
        frame:SetScript("OnDragStart", frame.StartMoving)
        frame:SetScript("OnDragStop", function(self)
            self:StopMovingOrSizing()
            local point, _, _, x, y = self:GetPoint()
            deps.savePoint(point, x, y)
        end)

        local point, x, y = deps.loadPoint()
        frame:SetPoint(point or "CENTER", deps.uiParent, point or "CENTER", x or 0, y or 0)

        -- The header is a lighter strip closed by a gold hairline. Both sit on BORDER, the
        -- layer nothing else in the panel uses, which is what keeps the frame's own chrome
        -- out of the pooled bar textures underneath it.
        local strip = frame:CreateTexture(nil, "BORDER")
        strip:SetColorTexture(HEADER_COLOR[1], HEADER_COLOR[2], HEADER_COLOR[3], HEADER_COLOR[4])
        strip:SetPoint("TOPLEFT", 1, -1)
        strip:SetWidth(WIDTH - 2)
        strip:SetHeight(HEADER_HEIGHT)

        local underline = frame:CreateTexture(nil, "BORDER")
        underline:SetColorTexture(RULE_COLOR[1], RULE_COLOR[2], RULE_COLOR[3], RULE_COLOR[4])
        underline:SetPoint("TOPLEFT", 1, -1 - HEADER_HEIGHT)
        underline:SetWidth(WIDTH - 2)
        underline:SetHeight(RULE_HEIGHT)

        local middle = -1 - HEADER_HEIGHT / 2
        local arrows = 0

        -- The arrows are font strings with a mouse handler on them, the same as every
        -- clickable row in the body: the panel is text on a rectangle, and a button widget
        -- in the header would be the only piece of client chrome anywhere on it.
        if deps.navigate then
            arrows = ARROW_WIDTH
            backArrow = frame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
            backArrow:SetPoint("LEFT", frame, "TOPLEFT", PADDING - 2, middle)
            backArrow:SetWidth(ARROW_WIDTH)
            backArrow:SetWordWrap(false)
            backArrow:SetText("«")
            backArrow:EnableMouse(true)
            backArrow:SetScript("OnMouseUp", function()
                deps.navigate(-1)
            end)

            forwardArrow = frame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
            forwardArrow:SetPoint("RIGHT", frame, "TOPRIGHT",
                -PADDING + 2 - (deps.closable and HEADER_HEIGHT or 0), middle)
            forwardArrow:SetWidth(ARROW_WIDTH)
            forwardArrow:SetWordWrap(false)
            forwardArrow:SetText("»")
            forwardArrow:EnableMouse(true)
            forwardArrow:SetScript("OnMouseUp", function()
                deps.navigate(1)
            end)
        end

        title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
        title:SetPoint("LEFT", frame, "TOPLEFT", PADDING + arrows, middle)
        title:SetWordWrap(false)
        -- Clipped rather than wrapped, and clear of the close button when there is one: a
        -- long "Character — Instance" title must not run out under it.
        title:SetWidth(WIDTH - PADDING * 2 - arrows * 2 - (deps.closable and HEADER_HEIGHT or 0))
        title:SetText(type(deps.title) == "string" and deps.title or "Current Segment")
        title:SetTextColor(TITLE_COLOR[1], TITLE_COLOR[2], TITLE_COLOR[3])

        if deps.closable then
            local close = createFrame("Button", nil, frame, "UIPanelCloseButton")
            close:SetSize(HEADER_HEIGHT, HEADER_HEIGHT)
            close:SetPoint("TOPRIGHT", -2, -2)
            close:SetScript("OnClick", function()
                frame:Hide()
            end)
            if deps.specialFrames then
                table.insert(deps.specialFrames, deps.name)
            end
        end

        frame:Hide()
    end

    ---A label/value pair sharing one line. Word wrapping is disabled because every row
    ---has a fixed height; a long localized name is clipped inside its column instead of
    ---wrapping over the row below.
    ---@param index integer
    ---@return table label, table value
    local function rowAt(index)
        local row = rows[index]
        if not row then
            local label = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            local value = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            label:SetJustifyH("LEFT")
            value:SetJustifyH("RIGHT")
            label:SetWordWrap(false)
            value:SetWordWrap(false)
            row = { label = label, value = value }
            rows[index] = row
        end
        return row.label, row.value
    end

    ---A progress bar: an unfilled track, the filled part of it, and a caption centred over
    ---both. The caption is deliberately centred rather than left or right justified, which
    ---is what tells it apart from the label/value pairs every other row is made of.
    ---@param index integer
    ---@return table back, table fill, table text
    local function barAt(index)
        local bar = bars[index]
        if not bar then
            local back = frame:CreateTexture(nil, "BACKGROUND")
            local fill = frame:CreateTexture(nil, "ARTWORK")
            local text = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            back:SetColorTexture(BAR_BACK_COLOR[1], BAR_BACK_COLOR[2], BAR_BACK_COLOR[3], BAR_BACK_COLOR[4])
            fill:SetColorTexture(BAR_FILL_COLOR[1], BAR_FILL_COLOR[2], BAR_FILL_COLOR[3], BAR_FILL_COLOR[4])
            text:SetJustifyH("CENTER")
            text:SetWordWrap(false)
            bar = { back = back, fill = fill, text = text }
            bars[index] = bar
        end
        return bar.back, bar.fill, bar.text
    end

    ---Opens the client's own tooltip over the panel, drawn from content a pure module built.
    ---
    ---The owner is the panel rather than the row the pointer is on, and the anchor is the
    ---cursor rather than the row's edge. `SetOwner` wants a frame, and every row here is a
    ---font string — so anchoring to the cursor is what puts the tooltip beside the line being
    ---pointed at without inventing a hit-area frame per row to hang it off.
    ---@param content AccountTooltipContent?
    local function showTooltip(content)
        local tooltip = deps.tooltip
        if not tooltip or not content then
            return
        end
        tooltip:SetOwner(frame, "ANCHOR_CURSOR")
        tooltip:AddLine(content.title, TITLE_COLOR[1], TITLE_COLOR[2], TITLE_COLOR[3])
        for _, entry in ipairs(content.lines) do
            local color = TOOLTIP_ROLE_COLORS[entry.role] or VALUE_COLOR
            if entry.right then
                tooltip:AddDoubleLine(entry.left, entry.right,
                    color[1], color[2], color[3], color[1], color[2], color[3])
            else
                tooltip:AddLine(entry.left, color[1], color[2], color[3])
            end
        end
        tooltip:Show()
    end

    local function hideTooltip()
        if deps.tooltip then
            deps.tooltip:Hide()
        end
    end

    ---A hairline across the body, used where a run of dashes used to be. It sits on BORDER
    ---with the header's chrome, so the bars keep BACKGROUND and ARTWORK to themselves.
    ---@param index integer
    ---@return table
    local function ruleAt(index)
        local rule = rules[index]
        if not rule then
            rule = frame:CreateTexture(nil, "BORDER")
            rule:SetColorTexture(RULE_COLOR[1], RULE_COLOR[2], RULE_COLOR[3], RULE_COLOR[4])
            rules[index] = rule
        end
        return rule
    end

    ---@param summary SegmentSummary
    local function render(summary)
        -- A view names itself — "Session", the zone being played, a zone left an hour ago —
        -- and that name outranks anything the panel was built with, because it is the only
        -- thing on screen saying which of them is being looked at.
        if latestView and latestView.title then
            title:SetText(latestView.title)
        elseif type(deps.title) == "function" then
            title:SetText(deps.title(summary) or "Segment Details")
        end
        if backArrow and forwardArrow then
            local index = latestView and latestView.index or 1
            local count = latestView and latestView.count or 1
            local earlier = index > 1 and ARROW_COLOR or ARROW_SPENT_COLOR
            local later = index < count and ARROW_COLOR or ARROW_SPENT_COLOR
            backArrow:SetTextColor(earlier[1], earlier[2], earlier[3])
            forwardArrow:SetTextColor(later[1], later[2], later[3])
        end
        local y = -HEADER_HEIGHT - RULE_HEIGHT - PADDING
        local used = 0
        local usedBars = 0
        local usedRules = 0

        ---@param text string
        ---@param valueText string
        ---@param color number[]
        ---@param action fun(button: string)? Called when the line is clicked.
        ---@param requestedValueWidth number? Width reserved for unusually long summary values.
        ---@param labelColor number[]? Brighter for a category heading than for what is under it.
        local function line(text, valueText, color, action, requestedValueWidth, labelColor)
            used = used + 1
            local label, value = rowAt(used)
            local valueWidth = valueText ~= "" and (requestedValueWidth or VALUE_WIDTH) or 0
            local gap = valueWidth > 0 and COLUMN_GAP or 0
            label:SetWidth(WIDTH - PADDING * 2 - valueWidth - gap)
            value:SetWidth(valueWidth)
            label:SetPoint("TOPLEFT", PADDING, y)
            label:SetText(text)
            labelColor = labelColor or LABEL_COLOR
            label:SetTextColor(labelColor[1], labelColor[2], labelColor[3])
            label:Show()
            value:SetPoint("TOPRIGHT", -PADDING, y)
            value:SetText(valueText)
            value:SetTextColor(color[1], color[2], color[3])
            value:Show()
            label:EnableMouse(action ~= nil)
            value:EnableMouse(action ~= nil)
            label:SetScript("OnMouseUp", action and function(_, button) action(button) end or nil)
            value:SetScript("OnMouseUp", action and function(_, button) action(button) end or nil)
            -- Cleared on every line rather than only where one was set. Rows are pooled, so a
            -- font string that was a faction a moment ago would otherwise still open that
            -- faction's tooltip now that the same row is drawing a mount.
            label:SetScript("OnEnter", nil)
            label:SetScript("OnLeave", nil)
            value:SetScript("OnEnter", nil)
            value:SetScript("OnLeave", nil)
            y = y - LINE
        end

        ---Hangs a tooltip on the line just drawn.
        ---
        ---Separate from `line` rather than another argument to it, because only two of the
        ---panel's dozen kinds of row have one and both want the row already placed: the
        ---content is built here, at render, so a row with nothing to say never becomes a
        ---mouse-enabled dead spot on a frame the player drags by.
        ---@param content AccountTooltipContent?
        local function hover(content)
            if not deps.tooltip or not content then
                return
            end
            local label, value = rowAt(used)
            for _, region in ipairs({ label, value }) do
                region:EnableMouse(true)
                region:SetScript("OnEnter", function()
                    showTooltip(content)
                end)
                region:SetScript("OnLeave", hideTooltip)
            end
        end

        ---A progress bar occupying a line of its own, under the row it belongs to.
        ---@param current integer How far into the level the character is.
        ---@param max integer How long the level is; zero draws an empty track.
        ---@param caption string Drawn over the bar.
        local function bar(current, max, caption)
            usedBars = usedBars + 1
            local back, fill, text = barAt(usedBars)
            local width = WIDTH - PADDING * 2 - BAR_INDENT
            local fraction = max > 0 and math.min(current / max, 1) or 0
            back:SetPoint("TOPLEFT", PADDING + BAR_INDENT, y)
            back:SetWidth(width)
            back:SetHeight(BAR_HEIGHT)
            back:Show()
            fill:SetPoint("TOPLEFT", PADDING + BAR_INDENT, y)
            fill:SetHeight(BAR_HEIGHT)
            if fraction > 0 then
                -- Kept off zero once any progress exists at all: a sliver still reads as
                -- "started", where a bar of no width reads as an untouched level.
                fill:SetWidth(math.max(math.floor(width * fraction), 1))
                fill:Show()
            else
                fill:Hide()
            end
            text:SetPoint("TOPLEFT", PADDING + BAR_INDENT, y - 1)
            text:SetWidth(width)
            text:SetText(caption)
            text:Show()
            y = y - LINE
        end

        ---A hairline where a run of dashes used to be, taking a line of its own.
        local function rule()
            usedRules = usedRules + 1
            local drawn = ruleAt(usedRules)
            drawn:SetPoint("TOPLEFT", PADDING, y - (RULE_LINE - RULE_HEIGHT) / 2)
            drawn:SetWidth(WIDTH - PADDING * 2)
            drawn:SetHeight(RULE_HEIGHT)
            drawn:Show()
            y = y - RULE_LINE
        end

        ---A category heading: the disclosure icon, then the name, then whatever the block
        ---under it sums to. Clicking anywhere along it opens or closes the block.
        ---
        ---The icon leads rather than trails. Both states are the same declared size, so
        ---swapping one for the other cannot shift the heading beside it, and a column of
        ---them down the left edge is what makes the headings read as headings.
        ---@param text string
        ---@param key string Which flag in `expanded` this heading owns.
        ---@param valueText string
        ---@param requestedValueWidth number?
        local function heading(text, key, valueText, requestedValueWidth)
            line((expanded[key] and COLLAPSE_ICON or EXPAND_ICON) .. text, valueText, VALUE_COLOR,
                function()
                    expanded[key] = not expanded[key]
                    render(latest)
                end, requestedValueWidth, HEADING_COLOR)
        end

        ---How stale an account-wide figure is, as it reads on the end of a line. Empty for
        ---anything read in the last minute, which is the ordinary case for the character
        ---being played and not worth the width.
        ---@param at integer? When it was read.
        ---@return string
        local function staleness(at)
            local clock = deps.now
            if not clock or not at or at <= 0 then
                return ""
            end
            local age = ns.formatAge(clock() - at)
            return age == "now" and "" or (", " .. age)
        end

        ---Where the account as a whole stands with a faction this segment gained.
        ---
        ---Only drawn when some other character is further along, because that is the whole
        ---question it answers: whether grinding this faction here is worth anything when it
        ---may already be finished elsewhere. The character's own bar is directly above, so
        ---repeating its standing back at it would only take a line.
        ---@param gain ReputationGain
        local function accountStandingLine(gain)
            if not deps.accountStanding or not gain.faction then
                return
            end
            local rollup = deps.accountStanding(gain.faction)
            local best = rollup and rollup.best
            if not best or best.character == (deps.character and deps.character()) then
                return
            end
            -- A standing on another ladder is not a better standing, only a different one,
            -- and the store has already refused to rank the two against each other.
            if gain.rank and best.system == gain.system and best.rank and best.rank <= gain.rank then
                return
            end
            local who = best.character:match("^([^-]+)") or best.character
            line("    best " .. (best.standing or "standing"),
                who .. staleness(best.at), ACCOUNT_COLOR, nil, SUMMARY_VALUE_WIDTH)
        end

        -- Only what this hour of play produced. The balances it landed on — the wallet, what
        -- the account is worth between it and the warband bank, what any one currency has
        -- accumulated to — are still recorded and still shown, in the desktop app, which is
        -- where a question about a total belongs. Here they would be the two largest numbers
        -- on a panel that exists to say what just happened.
        line("Loot value", deps.formatMoney(summary.lootValue), GOLD_COLOR)
        line("Gold Δ", deps.formatMoney(summary.goldDiff), GOLD_COLOR)

        local achievements = summary.achievements or {}
        local currencies = summary.currencies or {}
        local levelUps = summary.levelUps or {}
        local mounts = summary.mounts or {}
        local pets = summary.pets or {}
        local quests = summary.quests or {}
        local reputation = summary.reputation or {}
        local toys = summary.toys or {}
        local transmogs = summary.transmogs or {}
        local housingItems = summary.housingItems or {}
        local housingLevelUps = summary.housingLevelUps or {}
        local housingXP = summary.housingXP or 0
        if #achievements + #currencies + #levelUps + #mounts + #pets + #quests
            + #reputation + #toys + #transmogs + #housingItems + #housingLevelUps + housingXP > 0 then
            rule()
        end

        -- Completed categories are deliberately rendered in heading order. Empty
        -- categories stay absent so the compact panel only reports things that happened.
        if #achievements > 0 then
            local accountAchievements, characterAchievements = 0, 0
            for _, event in ipairs(achievements) do
                if event.accountFirst == true then
                    accountAchievements = accountAchievements + 1
                elseif event.accountFirst == false then
                    characterAchievements = characterAchievements + 1
                end
            end
            local achievementValue = ACCOUNT_HEX .. accountAchievements .. " account" .. COLOR_END
                .. " / " .. CHARACTER_HEX .. characterAchievements .. " character" .. COLOR_END
            heading("Achievements", "achievements", achievementValue, SUMMARY_VALUE_WIDTH)
            if expanded.achievements then
                for _, event in ipairs(achievements) do
                    local current = event
                    local scope = "earned"
                    local color = REP_COLOR
                    if current.accountFirst == true then
                        scope = "account first"
                        color = ACCOUNT_COLOR
                    elseif current.accountFirst == false then
                        scope = "character first"
                        color = CHARACTER_COLOR
                    end
                    line("  " .. current.name, scope, color, function()
                        if deps.openAchievement then
                            deps.openAchievement(current.id)
                        end
                    end)
                end
            end
        end

        if #currencies > 0 then
            heading("Currency", "currencies",
                ((summary.currencyTotal or 0) >= 0 and "+" or "") .. (summary.currencyTotal or 0))
            if expanded.currencies then
                for _, gain in ipairs(currencies) do
                    -- What the segment earned, and only that. What the character is left
                    -- holding afterwards, and what the rest of the account holds beside it,
                    -- are one hover away rather than on the line: a balance is the largest
                    -- number here and the one that changes least, so it is answered when it
                    -- is asked for.
                    line("  " .. gain.name, (gain.amount >= 0 and "+" or "") .. group(gain.amount), REP_COLOR)
                    hover(ns.currencyTooltip({
                        name = gain.name,
                        gain = gain,
                        rollup = deps.accountCurrency and deps.accountCurrency(gain.id),
                        character = deps.character and deps.character(),
                        now = deps.now and deps.now(),
                    }))
                end
            end
        end

        if #levelUps > 0 then
            heading("Level ups", "levelUps", tostring(#levelUps))
            if expanded.levelUps then
                for _, event in ipairs(levelUps) do
                    line("  Level " .. event.level, "reached", REP_COLOR)
                end
            end
        end

        local function collection(name, key, events)
            if #events == 0 then
                return
            end
            heading(name, key, tostring(#events))
            if expanded[key] then
                for _, event in ipairs(events) do
                    line("  " .. event.name, "collected", REP_COLOR)
                end
            end
        end
        collection("Mounts", "mounts", mounts)
        collection("Pets", "pets", pets)

        if #quests > 0 then
            local accountQuests, characterQuests = 0, 0
            for _, event in ipairs(quests) do
                if event.accountFirst == true then
                    accountQuests = accountQuests + 1
                elseif event.characterFirst == true then
                    characterQuests = characterQuests + 1
                end
            end
            local questValue = ACCOUNT_HEX .. accountQuests .. " warband" .. COLOR_END
                .. " / " .. CHARACTER_HEX .. characterQuests .. " character" .. COLOR_END
            heading("Quests", "quests", questValue, SUMMARY_VALUE_WIDTH)
            if expanded.quests then
                for _, event in ipairs(quests) do
                    local scope = "completed"
                    local color = REP_COLOR
                    if event.accountFirst == true then
                        scope = "warband first"
                        color = ACCOUNT_COLOR
                    elseif event.characterFirst == true then
                        scope = "character first"
                        color = CHARACTER_COLOR
                    end
                    line("  " .. (event.name or ("Quest " .. event.id)), scope, color)
                end
            end
        end

        if #reputation > 0 then
            heading("Reputation", "reputation", "+" .. (summary.reputationTotal or 0))
            if expanded.reputation then
                for _, gain in ipairs(reputation) do
                    line("  " .. gain.faction, "+" .. group(gain.amount), REP_COLOR)
                    -- The whole account's standings with this faction, which the "best" line
                    -- below only reports when somebody else is ahead. Silence there means
                    -- "you are in front", and silence is not a thing anybody can read.
                    hover(ns.standingTooltip({
                        faction = gain.faction,
                        gain = gain,
                        rollup = deps.accountStanding and deps.accountStanding(gain.faction),
                        character = deps.character and deps.character(),
                        now = deps.now and deps.now(),
                    }))
                    -- Only factions the client could place get a bar. A gain parsed out of
                    -- chat for a faction the client will not name — an account-wide line
                    -- read on a character that has never met them — has nowhere to sit.
                    if gain.standing or (gain.max or 0) > 0 then
                        local current, max = gain.current or 0, gain.max or 0
                        local caption = gain.standing or ""
                        if max > 0 then
                            caption = (caption ~= "" and caption .. "  " or "")
                                .. group(current) .. " / " .. group(max)
                        end
                        bar(current, max, caption)
                    end
                    accountStandingLine(gain)
                end
            end
        end

        collection("Toys", "toys", toys)

        if #housingItems > 0 then
            local warband, additional = 0, 0
            for _, event in ipairs(housingItems) do
                if event.warbandFirst then
                    warband = warband + 1
                else
                    additional = additional + 1
                end
            end
            local housingValue = ACCOUNT_HEX .. warband .. " warband" .. COLOR_END
                .. " / " .. CHARACTER_HEX .. additional .. " extra" .. COLOR_END
            heading("Housing items", "housingItems", housingValue, SUMMARY_VALUE_WIDTH)
            if expanded.housingItems then
                for _, event in ipairs(housingItems) do
                    local scope = event.warbandFirst and "warband first" or "additional"
                    local color = event.warbandFirst and ACCOUNT_COLOR or CHARACTER_COLOR
                    line("  " .. event.name, scope, color)
                end
            end
        end

        if housingXP > 0 then
            line("Housing XP", "+" .. housingXP, REP_COLOR)
        end

        if #housingLevelUps > 0 then
            heading("Housing levels", "housingLevelUps", tostring(#housingLevelUps))
            if expanded.housingLevelUps then
                for _, event in ipairs(housingLevelUps) do
                    line("  Level " .. event.level, "reached", REP_COLOR)
                end
            end
        end

        if #transmogs > 0 then
            local appearances = 0
            for _, event in ipairs(transmogs) do
                if event.newAppearance then
                    appearances = appearances + 1
                end
            end
            local variants = #transmogs - appearances
            -- An appearance the wardrobe has never held is the account's, and coloured like
            -- one; a variant of something already collected is the character's own find.
            local transmogValue = ACCOUNT_HEX .. appearances .. " new" .. COLOR_END
            if variants > 0 then
                transmogValue = transmogValue .. " · " .. CHARACTER_HEX .. variants .. " variant"
                if variants ~= 1 then
                    transmogValue = transmogValue .. "s"
                end
                transmogValue = transmogValue .. COLOR_END
            end
            heading("Transmog", "transmogs", transmogValue, SUMMARY_VALUE_WIDTH)
            if expanded.transmogs then
                for index, event in ipairs(transmogs) do
                    local current = event
                    local itemName = deps.itemName and deps.itemName(current.id)
                    local kind = current.newAppearance and "new" or "variant"
                    local kindColor = current.newAppearance and ACCOUNT_COLOR or CHARACTER_COLOR
                    local reviewKey = tostring(current.sourceID or current.id) .. ":" .. tostring(index)
                    local prefix = reviewedTransmogs[reviewKey] and REVIEWED_ICON or ""
                    line("  " .. prefix .. (itemName or ("Item " .. current.id)), kind, kindColor, function(button)
                        reviewedTransmogs[reviewKey] = true
                        if button == "RightButton" and current.sourceID and deps.openTransmogCollection then
                            deps.openTransmogCollection(current.sourceID)
                        elseif deps.previewTransmog then
                            deps.previewTransmog(current.id)
                        end
                        render(latest)
                    end)
                end
            end
        end

        for index = used + 1, #rows do
            -- Taken off screen and taken out of the mouse's way in the same breath. A hidden
            -- font string cannot be pointed at or clicked, so leaving the handlers on would
            -- do no harm today — but the pool's invariant is that a row carries only what the
            -- line it is currently drawing put there, and a row that is only harmless because
            -- it happens to be hidden is the exception that makes the rule unreadable.
            for _, region in ipairs({ rows[index].label, rows[index].value }) do
                region:Hide()
                region:EnableMouse(false)
                region:SetScript("OnMouseUp", nil)
                region:SetScript("OnEnter", nil)
                region:SetScript("OnLeave", nil)
            end
        end

        for index = usedBars + 1, #bars do
            bars[index].back:Hide()
            bars[index].fill:Hide()
            bars[index].text:Hide()
        end

        for index = usedRules + 1, #rules do
            rules[index]:Hide()
        end

        frame:SetHeight(-y + PADDING)
    end

    return {
        ---@param summary SegmentSummary
        ---@param view SegmentView?
        update = function(summary, view)
            if not frame then
                build()
            end
            latestView = view
            -- Which segment the ticks against reviewed transmogs belong to. A filed record
            -- carries its own identity; a live tally has none, so the view it is being
            -- drawn as stands in — walking off the open segment and back onto it is a
            -- fresh look at the same list.
            local segmentKey = summary.id or summary.startedAt or (view and view.key)
            local transmogCount = #(summary.transmogs or {})
            if (segmentKey and reviewedSegmentKey and segmentKey ~= reviewedSegmentKey)
                or transmogCount < lastTransmogCount then
                reviewedTransmogs = {}
            end
            reviewedSegmentKey = segmentKey or reviewedSegmentKey
            lastTransmogCount = transmogCount
            latest = summary
            render(summary)
        end,

        show = function()
            if not frame then
                build()
            end
            frame:Show()
        end,

        hide = function()
            if frame then
                frame:Hide()
            end
        end,

        toggle = function()
            if not frame then
                build()
            end
            if frame:IsShown() then
                frame:Hide()
            else
                frame:Show()
            end
        end,

        isShown = function()
            return frame ~= nil and frame:IsShown() and true or false
        end,
    }
end
