local _, ns = ...

---@class LockoutWindow
---@field toggle fun()
---@field refresh fun()

---@class LockoutWindowDeps
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field uiParent table
---@field specialFrames string[] Global UISpecialFrames list, so Escape closes the window.
---@field getRows fun(): LockoutRow[]
---@field lockoutTable LockoutTable
---@field onRefreshRequested fun() Asks the client for fresh lockout data.
---@field tooltip table Global GameTooltip.
---@field onCharacterSelected fun(character: string) Drill down into one character.
---@field onActivitySelected fun(row: LockoutRow) Drill down into one activity.
---@field classDisplay ClassDisplay
---@field expansions ExpansionIndex

local COLUMNS = {
    { key = "character", title = "Character", width = 160, sortable = true },
    { key = "expansion", title = "Expansion", width = 70, sortable = false },
    { key = "activity", title = "Activity", width = 200, sortable = true },
    { key = "difficulty", title = "Difficulty", width = 130, sortable = false },
    { key = "period", title = "Resets", width = 70, sortable = false },
    { key = "expiry", title = "Expires", width = 180, sortable = false },
}

local ROW_HEIGHT = 16
local PADDING = 12
local HEADER_Y = -52
local WIDTH = 870
local HEIGHT = 440

local EXPIRED_COLOR = { 0.45, 0.45, 0.45 }
local ACTIVE_COLOR = { 1, 1, 1 }
local KILLED_COLOR = { 0.5, 0.5, 0.5 }
local ALIVE_COLOR = { 0.1, 1, 0.1 }

---Index of the "Character" column.
local CHARACTER_COLUMN = 1
---Index of the "Expansion" column.
local EXPANSION_COLUMN = 2
---Index of the "Activity" column, whose cell owns the boss-list tooltip.
local ACTIVITY_COLUMN = 3
---Index of the "Difficulty" column.
local DIFFICULTY_COLUMN = 4
---Index of the "Resets" column, holding the activity's own cadence.
local PERIOD_COLUMN = 5
---Index of the "Expires" column.
local EXPIRY_COLUMN = 6

---@param deps LockoutWindowDeps
---@return LockoutWindow
function ns.newLockoutWindow(deps)
    local createFrame = deps.createFrame
    local lockoutTable = deps.lockoutTable
    local classDisplay = deps.classDisplay
    local expansions = deps.expansions

    local sortKey, sortAscending = "character", true
    ---@type table[]
    local rowPool = {}
    local frame, scrollChild

    local function buildFrame()
        frame = createFrame("Frame", "ChronieLockoutWindow", deps.uiParent, "BackdropTemplate")
        frame:SetSize(WIDTH, HEIGHT)
        frame:SetPoint("CENTER")
        frame:SetFrameStrata("DIALOG")
        frame:SetBackdrop({
            bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background-Dark",
            edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
            tile = true,
            tileSize = 32,
            edgeSize = 32,
            insets = { left = 8, right = 8, top = 8, bottom = 8 },
        })
        frame:SetMovable(true)
        frame:EnableMouse(true)
        frame:RegisterForDrag("LeftButton")
        frame:SetScript("OnDragStart", frame.StartMoving)
        frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
        frame:Hide()

        local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
        title:SetPoint("TOP", 0, -14)
        title:SetText("Lockouts")

        local hint = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
        hint:SetPoint("TOP", 0, -32)
        hint:SetText("Click an activity to see who is still free, or a character for its own locks")

        local close = createFrame("Button", nil, frame, "UIPanelCloseButton")
        close:SetPoint("TOPRIGHT", -6, -6)

        -- Escape closes the window, as players expect from any panel.
        table.insert(deps.specialFrames, "ChronieLockoutWindow")

        return frame
    end

    ---Boss list for the hovered row. Reads widget.row rather than closing over the
    ---row, so re-sorting does not leave stale tooltips attached to recycled widgets.
    ---@param anchor table
    ---@param row LockoutRow?
    local function showTooltip(anchor, row)
        if not row then
            return
        end

        local tooltip = deps.tooltip
        tooltip:SetOwner(anchor, "ANCHOR_RIGHT")
        tooltip:AddLine(row.activity)

        local expansion = expansions.abbreviationFor(row.activity)
        if expansion ~= "" then
            tooltip:AddLine(expansion, expansions.colorOf(row.activity))
        end

        tooltip:AddLine(
            row.difficulty .. " — " .. classDisplay.decorate(row.classFile, row.character),
            0.7, 0.7, 0.7
        )
        tooltip:AddLine(lockoutTable.encounterSummary(row), 1, 0.82, 0)
        tooltip:AddLine(" ")

        for _, encounter in ipairs(row.encounters or {}) do
            local color = encounter.killed and KILLED_COLOR or ALIVE_COLOR
            local mark = encounter.killed and "Defeated" or "Alive"
            tooltip:AddDoubleLine(encounter.name, mark, color[1], color[2], color[3], color[1], color[2], color[3])
        end

        tooltip:Show()
    end

    local function hideTooltip()
        deps.tooltip:Hide()
    end

    local function refresh()
        if not frame then
            return
        end

        local rows = lockoutTable.sort(deps.getRows(), sortKey, sortAscending)

        for index, row in ipairs(rows) do
            local widget = rowPool[index]
            if not widget then
                widget = { texts = {} }
                local holder = createFrame("Frame", nil, scrollChild)
                holder:SetSize(WIDTH - PADDING * 2, ROW_HEIGHT)
                holder:SetPoint("TOPLEFT", 0, -(index - 1) * ROW_HEIGHT)

                local offset = 0
                local offsets = {}
                for columnIndex, column in ipairs(COLUMNS) do
                    local text = holder:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
                    text:SetPoint("LEFT", offset, 0)
                    text:SetWidth(column.width)
                    text:SetJustifyH("LEFT")
                    widget.texts[columnIndex] = text
                    offsets[columnIndex] = offset
                    offset = offset + column.width
                end

                ---Invisible hit area over a single cell, so both the tooltip and the
                ---drill-down land where the player is actually pointing.
                ---@param columnIndex integer
                ---@return table
                local function cellButton(columnIndex)
                    local button = createFrame("Button", nil, holder)
                    button:SetSize(COLUMNS[columnIndex].width, ROW_HEIGHT)
                    button:SetPoint("LEFT", offsets[columnIndex], 0)
                    button:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
                    return button
                end

                local activityCell = cellButton(ACTIVITY_COLUMN)
                activityCell:SetScript("OnEnter", function(self)
                    showTooltip(self, widget.row)
                end)
                activityCell:SetScript("OnLeave", hideTooltip)
                activityCell:SetScript("OnClick", function()
                    if widget.row then
                        deps.onActivitySelected(widget.row)
                    end
                end)

                local characterCell = cellButton(CHARACTER_COLUMN)
                characterCell:SetScript("OnClick", function()
                    if widget.row then
                        deps.onCharacterSelected(widget.row.character)
                    end
                end)

                widget.holder = holder
                rowPool[index] = widget
            end

            widget.row = row

            local expired = lockoutTable.isExpired(row)
            local color = expired and EXPIRED_COLOR or ACTIVE_COLOR

            widget.texts[CHARACTER_COLUMN]:SetText(classDisplay.label(row.classFile, row.character))
            widget.texts[EXPANSION_COLUMN]:SetText(expansions.abbreviationFor(row.activity))
            widget.texts[ACTIVITY_COLUMN]:SetText(row.activity)
            widget.texts[DIFFICULTY_COLUMN]:SetText(row.difficulty)
            widget.texts[PERIOD_COLUMN]:SetText(lockoutTable.periodLabel(row))
            widget.texts[EXPIRY_COLUMN]:SetText(lockoutTable.formatExpiry(row))

            for _, text in ipairs(widget.texts) do
                text:SetTextColor(color[1], color[2], color[3])
            end

            -- Class and expansion carry their own colours, but only while the row still
            -- matters: an expired row stays uniformly grey so it reads as background.
            if not expired then
                widget.texts[CHARACTER_COLUMN]:SetTextColor(classDisplay.colorOf(row.classFile))
                widget.texts[EXPANSION_COLUMN]:SetTextColor(expansions.colorOf(row.activity))
            end

            widget.holder:Show()
        end

        for index = #rows + 1, #rowPool do
            rowPool[index].holder:Hide()
        end

        scrollChild:SetHeight(math.max(#rows * ROW_HEIGHT, 1))
    end

    local function buildHeader()
        local offset = PADDING + 8
        for _, column in ipairs(COLUMNS) do
            if column.sortable then
                local button = createFrame("Button", nil, frame)
                button:SetSize(column.width, ROW_HEIGHT)
                button:SetPoint("TOPLEFT", offset, HEADER_Y)

                local label = button:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
                label:SetPoint("LEFT")
                button.label = label

                button:SetScript("OnClick", function()
                    if sortKey == column.key then
                        sortAscending = not sortAscending
                    else
                        sortKey, sortAscending = column.key, true
                    end
                    refresh()
                end)

                -- Redrawn on every refresh so the arrow tracks the active sort.
                column.button = button
            else
                local label = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
                label:SetPoint("TOPLEFT", offset, HEADER_Y)
                label:SetText(column.title)
            end
            offset = offset + column.width
        end
    end

    local function updateHeaderLabels()
        for _, column in ipairs(COLUMNS) do
            if column.button then
                local arrow = ""
                if sortKey == column.key then
                    arrow = sortAscending and " |cffffd100^|r" or " |cffffd100v|r"
                end
                column.button.label:SetText(column.title .. arrow)
            end
        end
    end

    local function buildScroll()
        local scroll = createFrame("ScrollFrame", "ChronieLockoutScroll", frame, "UIPanelScrollFrameTemplate")
        scroll:SetPoint("TOPLEFT", PADDING + 8, HEADER_Y - ROW_HEIGHT - 4)
        scroll:SetPoint("BOTTOMRIGHT", -(PADDING + 24), PADDING + 4)

        scrollChild = createFrame("Frame", nil, scroll)
        scrollChild:SetSize(WIDTH - PADDING * 2, 1)
        scroll:SetScrollChild(scrollChild)
    end

    local function ensureBuilt()
        if frame then
            return
        end
        buildFrame()
        buildHeader()
        buildScroll()
    end

    local function render()
        refresh()
        updateHeaderLabels()
    end

    return {
        toggle = function()
            ensureBuilt()
            if frame:IsShown() then
                frame:Hide()
                return
            end
            -- Ask the server for current data; the response repaints us via refresh().
            deps.onRefreshRequested()
            render()
            frame:Show()
        end,

        refresh = function()
            if frame and frame:IsShown() then
                render()
            end
        end,
    }
end
