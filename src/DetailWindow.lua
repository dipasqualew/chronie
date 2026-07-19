local _, ns = ...

---A reusable drill-down panel. It knows nothing about lockouts: it renders whatever
---DetailSpec it is handed, so the instance and character views share one implementation.
---@class DetailWindow
---@field show fun(spec: DetailSpec)
---@field hide fun()
---@field isShown fun(): boolean

---@class DetailWindowDeps
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field uiParent table
---@field specialFrames string[] Global UISpecialFrames list, so Escape closes the window.
---@field name string Unique global frame name; two windows must not share one.

local ROW_HEIGHT = 16
local HEADING_HEIGHT = 24
local PADDING = 12
local BODY_TOP = -40
local WIDTH = 840
local HEIGHT = 470

local HEADING_COLOR = { 1, 0.82, 0 }
local COLUMN_COLOR = { 0.65, 0.65, 0.65 }
local EMPTY_COLOR = { 0.55, 0.55, 0.55 }

---@param deps DetailWindowDeps
---@return DetailWindow
function ns.newDetailWindow(deps)
    local createFrame = deps.createFrame

    ---@type table[]
    local linePool = {}
    local frame, scrollChild, title

    local function buildFrame()
        frame = createFrame("Frame", deps.name, deps.uiParent, "BackdropTemplate")
        frame:SetSize(WIDTH, HEIGHT)
        -- Offset from centre so it does not land exactly on top of the list it came from.
        frame:SetPoint("CENTER", 60, -40)
        frame:SetFrameStrata("DIALOG")
        frame:SetToplevel(true)
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

        title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
        title:SetPoint("TOP", 0, -14)

        local close = createFrame("Button", nil, frame, "UIPanelCloseButton")
        close:SetPoint("TOPRIGHT", -6, -6)

        table.insert(deps.specialFrames, deps.name)

        local scroll = createFrame("ScrollFrame", deps.name .. "Scroll", frame, "UIPanelScrollFrameTemplate")
        scroll:SetPoint("TOPLEFT", PADDING + 8, BODY_TOP)
        scroll:SetPoint("BOTTOMRIGHT", -(PADDING + 24), PADDING + 4)

        scrollChild = createFrame("Frame", nil, scroll)
        scrollChild:SetSize(WIDTH - PADDING * 2, 1)
        scroll:SetScrollChild(scrollChild)
    end

    ---Lines are recycled across renders, so every field a previous spec may have set
    ---is reset here rather than assumed empty.
    ---@param index integer
    ---@return table
    local function lineAt(index)
        local line = linePool[index]
        if line then
            return line
        end

        local holder = createFrame("Frame", nil, scrollChild)
        holder:SetSize(WIDTH - PADDING * 2, ROW_HEIGHT)

        local heading = holder:CreateFontString(nil, "OVERLAY", "GameFontNormal")
        heading:SetPoint("LEFT", 0, 0)

        line = { holder = holder, heading = heading, cells = {} }
        linePool[index] = line
        return line
    end

    ---@param line table
    ---@param columnIndex integer
    ---@return table
    local function cellAt(line, columnIndex)
        local cell = line.cells[columnIndex]
        if not cell then
            cell = line.holder:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            cell:SetJustifyH("LEFT")
            line.cells[columnIndex] = cell
        end
        return cell
    end

    ---@param line table
    ---@param cells string[]
    ---@param columns { title: string, width: integer }[]
    ---@param color number[]
    local function paintCells(line, cells, columns, color)
        local offset = 0
        for columnIndex, column in ipairs(columns) do
            local cell = cellAt(line, columnIndex)
            cell:SetPoint("LEFT", offset, 0)
            cell:SetWidth(column.width)
            cell:SetText(cells[columnIndex] or "")
            cell:SetTextColor(color[1], color[2], color[3])
            cell:Show()
            offset = offset + column.width
        end

        for columnIndex = #columns + 1, #line.cells do
            line.cells[columnIndex]:Hide()
        end
    end

    ---@param spec DetailSpec
    local function render(spec)
        title:SetText(spec.title)

        local used = 0
        local y = 0

        ---@param height integer
        ---@return table
        local function nextLine(height)
            used = used + 1
            local line = lineAt(used)
            line.holder:SetHeight(height)
            line.holder:SetPoint("TOPLEFT", 0, -y)
            line.holder:Show()
            y = y + height
            return line
        end

        for _, section in ipairs(spec.sections) do
            if section.heading then
                local line = nextLine(HEADING_HEIGHT)
                line.heading:SetText(section.heading)
                line.heading:SetTextColor(HEADING_COLOR[1], HEADING_COLOR[2], HEADING_COLOR[3])
                line.heading:Show()
                paintCells(line, {}, {}, HEADING_COLOR)
            end

            local columnLine = nextLine(ROW_HEIGHT)
            columnLine.heading:Hide()
            local columnTitles = {}
            for columnIndex, column in ipairs(section.columns) do
                columnTitles[columnIndex] = column.title
            end
            paintCells(columnLine, columnTitles, section.columns, COLUMN_COLOR)

            if #section.rows == 0 then
                local line = nextLine(ROW_HEIGHT)
                line.heading:Hide()
                local wholeRow = { { title = "", width = WIDTH } }
                paintCells(line, { section.empty or "Nothing to show." }, wholeRow, EMPTY_COLOR)
            else
                for _, row in ipairs(section.rows) do
                    local line = nextLine(ROW_HEIGHT)
                    line.heading:Hide()
                    paintCells(line, row.cells, section.columns, row.color)
                end
            end

            -- Blank spacer between sections.
            local spacer = nextLine(ROW_HEIGHT)
            spacer.heading:Hide()
            paintCells(spacer, {}, {}, EMPTY_COLOR)
        end

        for index = used + 1, #linePool do
            linePool[index].holder:Hide()
        end

        scrollChild:SetHeight(math.max(y, 1))
    end

    return {
        ---@param spec DetailSpec
        show = function(spec)
            if not frame then
                buildFrame()
            end
            render(spec)
            frame:Show()
            frame:Raise()
        end,

        hide = function()
            if frame then
                frame:Hide()
            end
        end,

        isShown = function()
            return frame ~= nil and frame:IsShown() and true or false
        end,
    }
end
