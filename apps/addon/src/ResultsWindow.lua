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
---and is what names the header.

---@class ResultsWindowDeps
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field uiParent table
---@field name string Unique global frame name.
---@field formatMoney fun(copper: integer): string
---@field loadPoint fun(): (string?, number?, number?) Saved point, x, y — or nil for the default spot.
---@field savePoint fun(point: string, x: number, y: number) Persist a dragged position.
---@field loadSize fun(): (number?, number?, boolean?)? Saved width, height, and whether the size is
---locked — or nil for the default box, unlocked. A panel built without this is still resizable; it
---simply forgets the box between sessions.
---@field saveSize fun(width: number, height: number, locked: boolean)? Persist a dragged size, or
---the lock being turned on or off.
---@field openAchievement fun(id: integer)?
---@field openMount fun(mountID: integer)? The mount's own page in the collections journal, for
---a click on the row that says it was collected.
---@field openPet fun(speciesID: integer, guid: string?)? The same journal on its pets tab: the
---very pet caught where the client filed a guid for it, the species otherwise.
---@field previewTransmog fun(itemID: integer)?
---@field openTransmogCollection fun(sourceID: integer)?
---@field previewTransmogSet fun(itemID: integer, sources: integer[])? The whole set on the body
---at once, for the shifted click.
---@field openTransmogSet fun(setID: integer)? The set's own page in the collections journal, for
---the shifted right click.
---@field transmogSet fun(sourceID: integer?): TransmogSetMembership? Which set a collected
---appearance belongs to and how far into it the account is. Nil for the appearances that belong
---to none, which is most of them, and the row is drawn exactly as it always was.
---@field shiftDown fun(): boolean? Whether shift is held at the moment of a click. Injected
---rather than read off the client here, because it is the only thing that tells the panel's
---four transmog actions apart and a test cannot hold a key down.
---@field itemName fun(itemID: integer): string?
---@field now fun(): integer? Current time, for saying how old an account-wide figure is.
---@field accountStanding fun(factionID: integer): StandingRollup? Where the account as a whole
---stands with a faction, so a gain can say who holds the highest standing anybody has reached
---with it — and whether a grind is already finished elsewhere.
---@field accountCurrency fun(id: integer): CurrencyRollup? What the whole account holds of a
---currency, so a gain can be read against the balance it lands on.
---@field character fun(): string? "Name-Realm" of whoever is playing, so the reading the
---client just gave for them replaces the stale one their last logout filed. Left out where the
---panel is drawing a filed record rather than the segment being played: nobody is at the
---keyboard of a segment that ended an hour ago.
---@field tooltip table? The global GameTooltip. Given one, a faction opens the whole account's
---standings with it on hover; without one the panel simply has nothing to hover.
---@field title string|fun(summary: SegmentSummary): string?
---@field views fun(): SegmentView[]? Everything the panel could be pointed at, read when the
---picker is opened rather than held, because a segment closes while the panel is on screen.
---@field select fun(key: string)? Point the panel at one of them. Given both this and
---`views`, the title becomes the picker's button; given neither, it is only a title.
---@field closable boolean?
---@field specialFrames string[]?
---@field frameStrata string?
---@field toplevel boolean?

local WIDTH = 268
-- The box the panel starts in, and the smallest one it can be dragged down to. The panel
-- used to be exactly as tall as whatever the evening had produced — which, anchored at its
-- centre the way a HUD dragged into place is, grew in both directions at once: a drop
-- landing pushed the rows already being read half a line up the screen. So the box is the
-- player's, set once, and the content moves inside it instead.
local DEFAULT_HEIGHT = 320
local MIN_WIDTH = 200
local MIN_HEIGHT = 120
local PADDING = 12
local LINE = 15
local COLUMN_GAP = 8
local VALUE_WIDTH = 92
local SUMMARY_VALUE_WIDTH = 140
-- The column a transmog row's set fraction sits in. An icon and "12/28" is the whole of what
-- it ever holds, so it is cut to that rather than borrowing the summary headings' width: the
-- word that used to sit there is gone, and every pixel the fraction does not need is one the
-- item's own name gets — which is the thing on that row anybody is actually reading.
local SET_VALUE_WIDTH = 58
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
-- The right-hand column of the picker, which carries when a segment happened. "12 segments"
-- is the widest thing it ever holds; a row's own is "just now" or "3h ago" or "playing", and
-- the name beside it is what the eye is actually running down, so the column is cut to what
-- it holds rather than left with room it does not use.
local PICKER_DETAIL_WIDTH = 64
-- Where the body starts: under the header strip, its closing hairline, and the frame's own
-- one-pixel edge above both.
local BODY_TOP = 1 + HEADER_HEIGHT + RULE_HEIGHT
-- Three lines a notch, which is what makes a wheel feel like it is turning a page rather
-- than nudging one row at a time.
local SCROLL_STEP = LINE * 3
-- The bar down the right edge that says how much is off screen: as thin as the panel's own
-- chrome, and never shorter than something the eye can find.
local THUMB_WIDTH = 3
local THUMB_MIN = 16
local GRIP_SIZE = 16

local TITLE_COLOR = { 1, 0.82, 0 }
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
local THUMB_COLOR = { 1, 0.82, 0, 0.35 }

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
-- What says the piece that dropped is part of a set, drawn in front of the fraction of that
-- set the account holds. `interface/icons/inv_chest_cloth_17.blp` is the wardrobe's own icon
-- and is in the 12.0.5 listfile; unlike the three above it is a full-bleed 64×64 icon rather
-- than an alpha'd UI glyph, which at this size is what makes it read as a mark beside the
-- numbers rather than as another piece of chrome.
local SET_ICON = "|TInterface\\Icons\\INV_Chest_Cloth_17:12:12:0:-1|t "
-- The fraction carries its own colour inside a value string the row has already coloured by
-- whether the appearance was new or a variant, so it has to be written in rather than set.
-- Gold once the set is finished, the panel's label grey while it is not: the completed one is
-- the only state worth catching an eye that is not looking for it.
local SET_HEX = "|cffadadb3"
local SET_COMPLETE_HEX = "|cffffd100"

-- The client's own padlock, the pair the default UI locks its bars with, and its own corner
-- grabber, the one every resizable chat window has had in its bottom right since the game
-- shipped. Both are what a player already reads as "this can be pinned down" and "this can
-- be pulled" without being told, which is the whole reason for using the client's rather
-- than drawing something of our own.
local LOCKED_ICON = "Interface\\Buttons\\LockButton-Locked-Up"
local UNLOCKED_ICON = "Interface\\Buttons\\LockButton-Unlocked-Up"
local GRIP_ICON = "Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up"
local GRIP_HIGHLIGHT_ICON = "Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight"
local BUTTON_HIGHLIGHT = "Interface\\Buttons\\UI-Common-MouseHilight"

---A viewport: a fixed box with something taller inside it, wheeled up and down.
---
---The bar down the right edge is drawn rather than taken from the client, because the panel
---is flat colour and one-pixel edges and Blizzard's carved slider is three textures of chrome
---for a control nobody here drags. The wheel is how this is scrolled; the bar only says how
---much is off screen and whereabouts in it the eye has got to.
---@param createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@param parent table The frame the viewport fills, from `top` down to its bottom edge.
---@param name string? Global name for the scroll frame; two must not share one.
---@param top number How far below the parent's top edge the viewport starts.
---@return table viewport `{ content = table, to = fun(offset: number), refresh = fun() }`
local function newViewport(createFrame, parent, name, top)
    local scroll = createFrame("ScrollFrame", name, parent)
    scroll:SetPoint("TOPLEFT", 0, -top)
    scroll:SetPoint("BOTTOMRIGHT", 0, 1)

    local content = createFrame("Frame", nil, scroll)
    content:SetSize(1, 1)
    scroll:SetScrollChild(content)

    -- On the parent rather than on the scroll frame: a child of a ScrollFrame is scrolled
    -- with everything else in it, and a scroll bar that scrolled away is no use to anybody.
    local thumb = parent:CreateTexture(nil, "OVERLAY")
    thumb:SetColorTexture(THUMB_COLOR[1], THUMB_COLOR[2], THUMB_COLOR[3], THUMB_COLOR[4])
    thumb:SetWidth(THUMB_WIDTH)
    thumb:Hide()

    local offset = 0
    local viewport = { content = content }

    ---Puts the content at `wanted`, as far as it will go, and redraws the bar saying where
    ---that is. Deliberately clamped here rather than at the wheel, because the content
    ---growing or the box shrinking under an already-scrolled viewport is the other way to
    ---end up parked past the last line.
    ---@param wanted number
    function viewport.to(wanted)
        local visible = scroll:GetHeight() or 0
        local whole = content:GetHeight() or 0
        local range = math.max(whole - visible, 0)
        offset = math.max(0, math.min(wanted, range))
        scroll:SetVerticalScroll(offset)

        if range <= 0 or visible <= 0 then
            thumb:Hide()
            return
        end
        local size = math.max(math.floor(visible * visible / whole), THUMB_MIN)
        local travel = math.max(visible - size, 0)
        thumb:SetHeight(size)
        thumb:ClearAllPoints()
        thumb:SetPoint("TOPRIGHT", parent, "TOPRIGHT", -1, -top - travel * (offset / range))
        thumb:Show()
    end

    ---Re-clamps where it already is, for after a redraw changed how much there is to see.
    function viewport.refresh()
        viewport.to(offset)
    end

    scroll:EnableMouseWheel(true)
    scroll:SetScript("OnMouseWheel", function(_, delta)
        viewport.to(offset - delta * SCROLL_STEP)
    end)

    return viewport
end

---Turns a row's mouse input on or off — both halves of it, because a click and a hover are
---two flags rather than one.
---
---Every row on this panel is a font string rather than a frame, and the client keeps a
---region's click flag and its motion flag apart: `EnableMouse` is what a click needs, and
---OnEnter and OnLeave are motion, which is the second flag. A row that had only the first was
---clickable and could not be pointed at — which is what a faction whose account-wide standings
---never opened on hover looks like from the keyboard.
---
---`SetMouseMotionEnabled` is asked for rather than assumed, the same rule `ns.callable` keeps
---for every client call this addon makes: a build without it is left with exactly the behaviour
---it already had rather than with a Lua error out of a repaint.
---@param region table
---@param enabled boolean
local function takesMouse(region, enabled)
    region:EnableMouse(enabled)
    if region.SetMouseMotionEnabled then
        region:SetMouseMotionEnabled(enabled)
    end
end

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
    ---The box the panel is in and whether the player has pinned it there. Held rather than
    ---read back off the frame, because the frame does not exist until something opens the
    ---panel and the saved box has to be known before it is built.
    local width, height, locked = WIDTH, DEFAULT_HEIGHT, false
    ---The body: the viewport the rows are drawn inside, the frame they are drawn on, and the
    ---two controls that size the whole thing.
    local viewport, body, lockButton, grip
    ---The picker: the frame it is drawn on, the rows pooled on it, and whether it is open.
    ---Built on the first click rather than with the panel, because a player who never opens
    ---it never pays for it.
    ---@type table?
    local picker
    ---@type table?
    local pickerViewport
    ---@type table?
    local pickerBody
    ---@type { label: table, value: table }[]
    local pickerRows = {}
    ---@type table?
    local pickerRule
    local pickerOpen = false
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

    ---Whether this panel has anything to pick between. The panel predates having more than
    ---one view and the detail window still has exactly one, so the picker is something the
    ---HUD gets and the other callers do not.
    ---@return boolean
    local function hasPicker()
        return deps.views ~= nil and deps.select ~= nil
    end

    ---Declared here and filled in below the row pools they draw with, because the header
    ---is built before them and has to hang the click on something.
    local togglePicker
    ---Both are laid out from the panel's own width, and both have to be redrawn while a
    ---corner is being dragged — so the resize handler, which is installed with the frame,
    ---needs them long before the pools they draw with exist.
    local render, drawPicker

    ---Re-hangs everything sized off the panel itself. The rows are not among them: they are
    ---laid out from scratch on every render anyway, which is what a resize asks for.
    local function applyWidth()
        -- The strip, its hairline and the two header buttons are anchored to the frame's own
        -- corners and follow it without being told. The title cannot be: it is clipped rather
        -- than wrapped, so what it may have is a number, and the number is the strip less its
        -- margins and less the controls at the far end of it.
        title:SetWidth(width - PADDING * 2 - HEADER_HEIGHT - (deps.closable and HEADER_HEIGHT or 0))
        body:SetWidth(width)
    end

    ---Turns resizing on or off. The grip goes away with it, so a pinned panel has nothing in
    ---its corner to catch a click meant for the last row of the body.
    local function applyLock()
        frame:SetResizable(not locked)
        lockButton:SetNormalTexture(locked and LOCKED_ICON or UNLOCKED_ICON)
        if locked then
            grip:Hide()
        else
            grip:Show()
        end
    end

    local function saveSize()
        if deps.saveSize then
            deps.saveSize(math.floor(width), math.floor(height), locked)
        end
    end

    local function build()
        frame = createFrame("Frame", deps.name, deps.uiParent, "BackdropTemplate")
        if deps.loadSize then
            local savedWidth, savedHeight, savedLock = deps.loadSize()
            width = math.max(savedWidth or WIDTH, MIN_WIDTH)
            height = math.max(savedHeight or DEFAULT_HEIGHT, MIN_HEIGHT)
            locked = savedLock and true or false
        end
        frame:SetSize(width, height)
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
        -- Pinned to both top corners rather than given a width, so the strip follows a panel
        -- being dragged wider without anything having to tell it to.
        strip:SetPoint("TOPLEFT", 1, -1)
        strip:SetPoint("TOPRIGHT", -1, -1)
        strip:SetHeight(HEADER_HEIGHT)

        local underline = frame:CreateTexture(nil, "BORDER")
        underline:SetColorTexture(RULE_COLOR[1], RULE_COLOR[2], RULE_COLOR[3], RULE_COLOR[4])
        underline:SetPoint("TOPLEFT", 1, -1 - HEADER_HEIGHT)
        underline:SetPoint("TOPRIGHT", -1, -1 - HEADER_HEIGHT)
        underline:SetHeight(RULE_HEIGHT)

        local middle = -1 - HEADER_HEIGHT / 2

        title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
        title:SetPoint("LEFT", frame, "TOPLEFT", PADDING, middle)
        title:SetWordWrap(false)
        -- Left, so the icon that opens the list is against the panel's own edge and the name
        -- of the view starts where every label in the body below it starts. Centred — which
        -- is what GameFontNormal is — the two would drift about the strip as the name under
        -- the pointer changed length, and the one control in the header would move with them.
        title:SetJustifyH("LEFT")
        -- Clipped rather than wrapped, and clear of the buttons at the other end of the strip:
        -- a long "Character — Instance" title must not run out under them. `applyWidth` below
        -- is what says how much of the strip that leaves.
        title:SetText(type(deps.title) == "string" and deps.title or "Current Segment")
        title:SetTextColor(TITLE_COLOR[1], TITLE_COLOR[2], TITLE_COLOR[3])
        -- The title is the picker's button. A button widget would be the only piece of
        -- client chrome on the panel, and the header has room for the name of the thing
        -- being looked at or for a control beside it, not comfortably for both — so the
        -- name is the control, marked with the same disclosure icon every openable block
        -- in the body carries.
        if hasPicker() then
            title:EnableMouse(true)
            title:SetScript("OnMouseUp", togglePicker)
        end

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

        viewport = newViewport(createFrame, frame, deps.name .. "Body", BODY_TOP)
        body = viewport.content

        -- Built after the viewport, and deliberately: siblings of a frame stack in the order
        -- they were created, so the two controls made below sit over the body rather than
        -- under it. The grip in particular shares its corner with the body's last row.
        --
        -- Sizing a panel is something you do once and then want left alone, so there has to be
        -- a way to take the grip out of that corner again. The switch is in the header because
        -- the header is the one part of the panel nothing ever covers, and it sits inside the
        -- close button so the button that shuts the window stays where the client always puts
        -- it.
        lockButton = createFrame("Button", nil, frame)
        lockButton:SetSize(HEADER_HEIGHT, HEADER_HEIGHT)
        lockButton:SetPoint("TOPRIGHT", -2 - (deps.closable and HEADER_HEIGHT or 0), -2)
        lockButton:SetHighlightTexture(BUTTON_HIGHLIGHT, "ADD")
        lockButton:SetScript("OnClick", function()
            locked = not locked
            applyLock()
            saveSize()
        end)
        -- A padlock is a picture, and a picture in a corner is a thing people guess at. The
        -- tooltip is what turns the guess into a sentence, and it is also the whole of what a
        -- client that failed to load the texture would still have to go on.
        lockButton:SetScript("OnEnter", function()
            local tip = deps.tooltip
            if not tip then
                return
            end
            tip:SetOwner(lockButton, "ANCHOR_RIGHT")
            tip:AddLine(locked and "Size locked" or "Size unlocked",
                TITLE_COLOR[1], TITLE_COLOR[2], TITLE_COLOR[3])
            tip:AddLine(locked and "Click to allow resizing." or "Click to pin this size.",
                LABEL_COLOR[1], LABEL_COLOR[2], LABEL_COLOR[3])
            tip:Show()
        end)
        lockButton:SetScript("OnLeave", function()
            if deps.tooltip then
                deps.tooltip:Hide()
            end
        end)

        grip = createFrame("Button", nil, frame)
        grip:SetSize(GRIP_SIZE, GRIP_SIZE)
        grip:SetPoint("BOTTOMRIGHT", -2, 2)
        grip:SetNormalTexture(GRIP_ICON)
        grip:SetHighlightTexture(GRIP_HIGHLIGHT_ICON, "ADD")
        grip:SetScript("OnMouseDown", function()
            frame:StartSizing("BOTTOMRIGHT")
        end)
        grip:SetScript("OnMouseUp", function()
            frame:StopMovingOrSizing()
            saveSize()
        end)

        applyWidth()
        frame:SetResizable(true)
        frame:SetResizeBounds(MIN_WIDTH, MIN_HEIGHT)
        applyLock()

        -- Installed last, and only last: the client fires this on the SetSize above as well as
        -- on every frame of a drag, and a handler that ran before the body existed would take
        -- the panel down on the way up.
        frame:SetScript("OnSizeChanged", function(_, newWidth, newHeight)
            width = newWidth or width
            height = newHeight or height
            applyWidth()
            if latest then
                render(latest)
            end
            if pickerOpen then
                drawPicker()
            end
        end)

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
            local label = body:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            local value = body:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
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
            local back = body:CreateTexture(nil, "BACKGROUND")
            local fill = body:CreateTexture(nil, "ARTWORK")
            local text = body:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
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
            rule = body:CreateTexture(nil, "BORDER")
            rule:SetColorTexture(RULE_COLOR[1], RULE_COLOR[2], RULE_COLOR[3], RULE_COLOR[4])
            rules[index] = rule
        end
        return rule
    end

    ---A row of the picker: what the view is called on the left, the metadata that tells it
    ---from the one above it on the right. Pooled the way the body's rows are, and for the
    ---same reason — a segment closing adds a row to a list that is redrawn every time it
    ---is opened.
    ---@param index integer
    ---@return table label, table value
    local function pickerRowAt(index)
        local row = pickerRows[index]
        if not row then
            local label = pickerBody:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            local value = pickerBody:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            label:SetJustifyH("LEFT")
            value:SetJustifyH("RIGHT")
            label:SetWordWrap(false)
            value:SetWordWrap(false)
            label:EnableMouse(true)
            value:EnableMouse(true)
            row = { label = label, value = value }
            pickerRows[index] = row
        end
        return row.label, row.value
    end

    ---The list the title opens: the session on top, then every segment on offer under it.
    ---
    ---Read fresh on every open rather than kept, because the strip grows while the panel is
    ---on screen — a segment that closed since the last look is exactly the row somebody
    ---opening this is reaching for.
    function drawPicker()
        local views = deps.views()
        local y = -PADDING
        local used = 0
        local separated = false
        picker:SetWidth(width)
        pickerBody:SetWidth(width)

        for _, view in ipairs(views) do
            -- The whole point of the issue this was built for: the session total is one
            -- choice and the individual segments are another list, rather than the two
            -- being the same strip walked end to end. A hairline is what says so.
            if view.kind ~= "session" and not separated then
                separated = true
                pickerRule:SetPoint("TOPLEFT", PADDING, y - (RULE_LINE - RULE_HEIGHT) / 2)
                pickerRule:SetWidth(width - PADDING * 2)
                pickerRule:SetHeight(RULE_HEIGHT)
                pickerRule:Show()
                y = y - RULE_LINE
            end

            used = used + 1
            local label, value = pickerRowAt(used)
            local color = view.current and TITLE_COLOR or HEADING_COLOR
            label:SetWidth(width - PADDING * 2 - PICKER_DETAIL_WIDTH - COLUMN_GAP)
            label:SetPoint("TOPLEFT", PADDING, y)
            label:SetText(view.label or view.title or "")
            label:SetTextColor(color[1], color[2], color[3])
            label:Show()
            value:SetWidth(PICKER_DETAIL_WIDTH)
            value:SetPoint("TOPRIGHT", -PADDING, y)
            value:SetText(view.detail or "")
            value:SetTextColor(LABEL_COLOR[1], LABEL_COLOR[2], LABEL_COLOR[3])
            value:Show()

            local key = view.key
            for _, region in ipairs({ label, value }) do
                region:SetScript("OnMouseUp", function()
                    deps.select(key)
                    togglePicker()
                end)
            end
            y = y - LINE
        end

        if not separated then
            pickerRule:Hide()
        end
        for index = used + 1, #pickerRows do
            for _, region in ipairs({ pickerRows[index].label, pickerRows[index].value }) do
                region:Hide()
                region:SetScript("OnMouseUp", nil)
            end
        end
        -- An evening's worth of segments is a longer list than the panel it hangs out of, and
        -- a menu that ran off the bottom of the screen would put the oldest of them where
        -- nobody can reach them. So it stops at the panel's own bottom edge and scrolls
        -- inside that, the same way the body under it does.
        local content = -y + PADDING
        pickerBody:SetHeight(math.max(content, 1))
        picker:SetHeight(math.min(content + 2, math.max(height - BODY_TOP, LINE)))
        pickerViewport.refresh()
    end

    ---Builds the picker's own frame, once.
    ---
    ---A frame of its own rather than rows drawn into the panel: the list covers the body
    ---while it is open, and a panel that had to redraw its own contents around a menu would
    ---be two layouts in one function. It sits on DIALOG so it is over the body it covers,
    ---and it is dark with the same hairline edge the panel has, because it is the panel's
    ---own header opening downwards rather than a window in its own right.
    local function buildPicker()
        picker = createFrame("Frame", nil, frame, "BackdropTemplate")
        picker:SetWidth(width)
        picker:SetHeight(LINE)
        picker:SetPoint("TOPLEFT", frame, "TOPLEFT", 0, -HEADER_HEIGHT - RULE_HEIGHT)
        picker:SetFrameStrata("DIALOG")
        picker:SetToplevel(true)
        picker:SetBackdrop({
            bgFile = "Interface\\Buttons\\WHITE8X8",
            edgeFile = "Interface\\Buttons\\WHITE8X8",
            edgeSize = 1,
            insets = { left = 1, right = 1, top = 1, bottom = 1 },
        })
        picker:SetBackdropColor(HEADER_COLOR[1], HEADER_COLOR[2], HEADER_COLOR[3], 1)
        picker:SetBackdropBorderColor(BORDER_COLOR[1], BORDER_COLOR[2], BORDER_COLOR[3], BORDER_COLOR[4])
        -- Mouse-enabled with nothing to do: it is what stops a click meant for a menu row
        -- landing on the panel underneath and dragging the whole HUD across the screen.
        picker:EnableMouse(true)
        pickerViewport = newViewport(createFrame, picker, nil, 1)
        pickerBody = pickerViewport.content
        pickerRule = pickerBody:CreateTexture(nil, "BORDER")
        pickerRule:SetColorTexture(RULE_COLOR[1], RULE_COLOR[2], RULE_COLOR[3], RULE_COLOR[4])
        picker:Hide()
    end

    ---@param summary SegmentSummary
    function render(summary)
        -- A view names itself — "Session", the zone being played, a zone left an hour ago —
        -- and that name outranks anything the panel was built with, because it is the only
        -- thing on screen saying which of them is being looked at.
        local named
        if latestView and latestView.title then
            named = latestView.title
        elseif type(deps.title) == "function" then
            named = deps.title(summary) or "Segment Details"
        else
            -- What the header was built with, spelled out again rather than left standing,
            -- because the icon below is prepended to it and a title left alone would keep
            -- whichever icon the last repaint put there.
            named = type(deps.title) == "string" and deps.title or "Current Segment"
        end
        if hasPicker() then
            -- Whatever it is called, prefixed by the same icon every openable block in the
            -- body carries, because the title is the thing that opens the list.
            named = (pickerOpen and COLLAPSE_ICON or EXPAND_ICON) .. named
        end
        title:SetText(named)
        -- Down the body rather than down the frame: the rows are drawn on the thing inside the
        -- viewport, which is as tall as they make it and is what the wheel moves.
        local y = -PADDING
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
            label:SetWidth(width - PADDING * 2 - valueWidth - gap)
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
            takesMouse(label, action ~= nil)
            takesMouse(value, action ~= nil)
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
                takesMouse(region, true)
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
            local track = width - PADDING * 2 - BAR_INDENT
            local fraction = max > 0 and math.min(current / max, 1) or 0
            back:SetPoint("TOPLEFT", PADDING + BAR_INDENT, y)
            back:SetWidth(track)
            back:SetHeight(BAR_HEIGHT)
            back:Show()
            fill:SetPoint("TOPLEFT", PADDING + BAR_INDENT, y)
            fill:SetHeight(BAR_HEIGHT)
            if fraction > 0 then
                -- Kept off zero once any progress exists at all: a sliver still reads as
                -- "started", where a bar of no width reads as an untouched level.
                fill:SetWidth(math.max(math.floor(track * fraction), 1))
                fill:Show()
            else
                fill:Hide()
            end
            text:SetPoint("TOPLEFT", PADDING + BAR_INDENT, y - 1)
            text:SetWidth(track)
            text:SetText(caption)
            text:Show()
            y = y - LINE
        end

        ---A hairline where a run of dashes used to be, taking a line of its own.
        local function rule()
            usedRules = usedRules + 1
            local drawn = ruleAt(usedRules)
            drawn:SetPoint("TOPLEFT", PADDING, y - (RULE_LINE - RULE_HEIGHT) / 2)
            drawn:SetWidth(width - PADDING * 2)
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

        ---The highest standing with a faction this segment gained that anybody on the account
        ---is known to hold, and who is holding it.
        ---
        ---Always drawn, the character being played included. It used to appear only when
        ---somebody else was further along, which left an absent line carrying the meaning "you
        ---are the furthest" — on screen that is indistinguishable from the panel knowing
        ---nothing about the faction at all, and a player cannot read the difference. Naming the
        ---holder outright costs one line and answers the question whichever way it falls.
        ---
        ---The crown is `ns.bestStanding`'s, which is the one the tooltip over this same row
        ---draws: it counts what has been earned this session rather than only what the store
        ---filed, so a character that overtook the account's best an hour ago is told so.
        ---@param gain ReputationGain
        local function accountStandingLine(gain)
            if not gain.faction then
                return
            end
            local best = ns.bestStanding({
                faction = gain.faction,
                gain = gain,
                rollup = deps.accountStanding and deps.accountStanding(gain.id),
                character = deps.character and deps.character(),
                now = deps.now and deps.now(),
            })
            if not best then
                return
            end
            -- "you" carries no staleness in the ordinary case, because the reading folded in
            -- for the character being played is the client's own and a moment old. It still
            -- gets one where the standing came off this character's stored row instead — a
            -- faction the client would not place this time, read at some earlier logout.
            local who = (best.you and "you" or best.name) .. staleness(best.at)
            line("    best " .. (best.standing or "standing"), who, ACCOUNT_COLOR, nil, SUMMARY_VALUE_WIDTH)
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
                    -- The name carries the colour as well as the word beside it, the way a
                    -- transmog row's does: purple for the account's first and green for this
                    -- character's own. The word stays — it is the legend the colours are
                    -- learned from — but the colour is what a column of names is read by, and
                    -- it belongs on the half of the row the eye is running down.
                    --
                    -- Nil rather than REP_COLOR where nobody said which it was: green means
                    -- "this character got there first" everywhere on this panel, and an
                    -- achievement filed without the flag has not said that.
                    local nameColor
                    if current.accountFirst == true then
                        scope = "account first"
                        color = ACCOUNT_COLOR
                        nameColor = ACCOUNT_COLOR
                    elseif current.accountFirst == false then
                        scope = "character first"
                        color = CHARACTER_COLOR
                        nameColor = CHARACTER_COLOR
                    end
                    line("  " .. current.name, scope, color, function()
                        if deps.openAchievement then
                            deps.openAchievement(current.id)
                        end
                    end, nil, nameColor)
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

        ---A block of things collected: a count on the heading, one name per row under it.
        ---@param name string
        ---@param key string Which flag in `expanded` the block is opened by.
        ---@param events CollectionEvent[]
        ---@param open fun(event: CollectionEvent)? Where a click on one of these rows goes,
        ---when the build wired somewhere for it to go. Withheld for a collection with no page
        ---to open, and skipped for an event filed without the id the page is found by: a row
        ---that cannot answer a click must not be mouse-enabled, or it becomes a dead spot on
        ---the frame the player drags the panel around by.
        ---@param tint fun(event: CollectionEvent): number[]? What colour this one is, for a
        ---collection where one row can mean something a different row does not. Nil, and a nil
        ---answer from it, leave the row in the panel's ordinary "collected" green.
        local function collection(name, key, events, open, tint)
            if #events == 0 then
                return
            end
            heading(name, key, tostring(#events))
            if expanded[key] then
                for _, event in ipairs(events) do
                    local current = event
                    local action = open and current.id and function()
                        open(current)
                    end or nil
                    local color = tint and tint(current) or nil
                    line("  " .. current.name, "collected", color or REP_COLOR, action, nil, color)
                end
            end
        end
        collection("Mounts", "mounts", mounts, deps.openMount and function(event)
            deps.openMount(event.id)
        end)
        -- The guid as well as the species: a battle pet is the one collectible the game lets a
        -- player own several of, so the journal can be opened on the very one that was caught
        -- rather than on the species it belongs to. A drop filed without one — a learned pet
        -- rather than a caught one — falls back to the species, which is what the row names.
        collection("Pets", "pets", pets, deps.openPet and function(event)
            deps.openPet(event.id, event.guid)
        end, function(event)
            -- The same two colours the rest of the panel is read by. A species the collection
            -- has never held is the account's first and purple; the fourth of a critter already
            -- owned is green, which is the whole difference between a catch worth stopping for
            -- and one worth caging. `speciesFirst` is absent rather than false where nobody
            -- asked the client at the moment of the catch, and an unasked question is not a
            -- "no" — so that row keeps the ordinary colour and says neither.
            if event.speciesFirst == true then
                return ACCOUNT_COLOR
            end
            if event.speciesFirst == false then
                return CHARACTER_COLOR
            end
            return nil
        end)

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
                        rollup = deps.accountStanding and deps.accountStanding(gain.id),
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
                    -- The colour is the whole of what says which of the two this is. It used to
                    -- be said twice — the word "new" or "variant" beside a row already coloured
                    -- purple or green — and a row that says one thing in two ways is a row where
                    -- the eye has to read the slower of them. So the item's own name carries the
                    -- colour, the word is gone, and the value column beside it is free for the
                    -- one thing a row can say that the colour cannot: the set's fraction. The
                    -- heading over the block still counts them in words, which is where a player
                    -- who does not yet know the colours learns them.
                    local kindColor = current.newAppearance and ACCOUNT_COLOR or CHARACTER_COLOR
                    local reviewKey = tostring(current.sourceID or current.id) .. ":" .. tostring(index)
                    local prefix = reviewedTransmogs[reviewKey] and REVIEWED_ICON or ""
                    -- Asked per row per repaint rather than held, because the fraction moves
                    -- as the account collects and a row drawn an hour ago would still be
                    -- claiming the count it was drawn with. See ns.newTransmogSets.
                    local set = deps.transmogSet and deps.transmogSet(current.sourceID)
                    local valueText = ""
                    local valueWidth
                    if set then
                        local hex = set.collected >= set.total and SET_COMPLETE_HEX or SET_HEX
                        valueText = hex .. SET_ICON
                            .. set.collected .. "/" .. set.total .. COLOR_END
                        -- Its own column rather than the ordinary rows': narrower than the 92
                        -- pixels a value gets, because an icon and a fraction is all of it, and
                        -- what it gives back goes to the item name beside it.
                        valueWidth = SET_VALUE_WIDTH
                    end
                    line("  " .. prefix .. (itemName or ("Item " .. current.id)), valueText, kindColor,
                        function(button)
                            reviewedTransmogs[reviewKey] = true
                            -- Which of the two set actions this button would take, resolved
                            -- before the click is classified rather than inside the branch it
                            -- picks. `transmogClickAction` is told there is a set only when
                            -- there is also a way to act on one, so a shifted click can never
                            -- enter a set branch and find nothing to do there: it falls back
                            -- to the piece that dropped, which is the whole point of the
                            -- fallback rule. Both deps arrive together from Main, so this is
                            -- about the panel still being whole without them.
                            local setHandler
                            if set then
                                if button == "RightButton" then
                                    setHandler = deps.openTransmogSet
                                elseif #set.sources > 0 then
                                    -- A set the client named no sources for can still be
                                    -- opened in the journal, but there is nothing to put on a
                                    -- body — and a dressing room opened over an empty set is
                                    -- the naked character ns.newTransmogPreview exists to
                                    -- avoid. The fraction on the row is still worth drawing,
                                    -- so only this half of the shifted pair falls back.
                                    setHandler = deps.previewTransmogSet
                                end
                            end
                            local action = ns.transmogClickAction(button, deps.shiftDown and deps.shiftDown(),
                                setHandler ~= nil)
                            if action == "openSet" then
                                setHandler(set.setID)
                            elseif action == "previewSet" then
                                setHandler(current.id, set.sources)
                            elseif action == "openItem" and current.sourceID and deps.openTransmogCollection then
                                deps.openTransmogCollection(current.sourceID)
                            elseif deps.previewTransmog then
                                deps.previewTransmog(current.id)
                            end
                            render(latest)
                        end, valueWidth, kindColor)
                    hover(ns.transmogSetTooltip(set))
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
                takesMouse(region, false)
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

        -- The body is what grows, not the panel. Refreshing afterwards is what keeps a
        -- viewport that was scrolled to the bottom from sitting past the last line once a
        -- block is collapsed and the content under it becomes shorter than the box.
        body:SetHeight(math.max(-y + PADDING, 1))
        viewport.refresh()
    end

    ---Opens the list, or shuts it again. Built on the first open, drawn on every one.
    function togglePicker()
        if not picker then
            buildPicker()
        end
        pickerOpen = not pickerOpen
        if pickerOpen then
            drawPicker()
            picker:Show()
        else
            picker:Hide()
        end
        -- Only the icon on the title changes, but it changes from the render that draws
        -- everything else, and the panel has exactly one of those.
        if latest then
            render(latest)
        end
    end

    ---Shuts the list without redrawing anything, for when the panel itself goes away.
    ---A menu left open behind a hidden HUD is a menu that reappears over whatever the
    ---player opened it for next.
    local function closePicker()
        if picker and pickerOpen then
            pickerOpen = false
            picker:Hide()
        end
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
            closePicker()
            if frame then
                frame:Hide()
            end
        end,

        toggle = function()
            if not frame then
                build()
            end
            if frame:IsShown() then
                closePicker()
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
