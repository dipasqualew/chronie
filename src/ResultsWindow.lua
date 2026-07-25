local _, ns = ...

---A small, draggable HUD panel that renders a ResultsSummary. Deliberately thin:
---it lays out font strings and remembers where it was dragged, and nothing else.
---@class ResultsWindow
---@field show fun()
---@field hide fun()
---@field toggle fun()
---@field isShown fun(): boolean
---@field update fun(summary: ResultsSummary) Repaint; builds the frame on first use.

---@class ResultsWindowDeps
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field uiParent table
---@field name string Unique global frame name.
---@field formatMoney fun(copper: integer): string
---@field loadPoint fun(): (string?, number?, number?) Saved point, x, y — or nil for the default spot.
---@field savePoint fun(point: string, x: number, y: number) Persist a dragged position.

local WIDTH = 190
local PADDING = 12
local LINE = 15

local TITLE_COLOR = { 1, 0.82, 0 }
local LABEL_COLOR = { 0.7, 0.7, 0.7 }
local VALUE_COLOR = { 1, 1, 1 }
local GOLD_COLOR = { 1, 0.82, 0 }
local REP_COLOR = { 0.4, 0.8, 0.4 }
local MUTED_COLOR = { 0.5, 0.5, 0.5 }

---@param deps ResultsWindowDeps
---@return ResultsWindow
function ns.newResultsWindow(deps)
    local createFrame = deps.createFrame

    ---@type { label: table, value: table }[]
    local rows = {}
    local frame, title

    local function build()
        frame = createFrame("Frame", deps.name, deps.uiParent, "BackdropTemplate")
        frame:SetWidth(WIDTH)
        frame:SetHeight(90)
        frame:SetFrameStrata("MEDIUM")
        frame:SetBackdrop({
            bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background-Dark",
            edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
            tile = true,
            tileSize = 16,
            edgeSize = 16,
            insets = { left = 4, right = 4, top = 4, bottom = 4 },
        })
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

        title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
        title:SetPoint("TOPLEFT", PADDING, -PADDING)
        title:SetText("Instance Results")
        title:SetTextColor(TITLE_COLOR[1], TITLE_COLOR[2], TITLE_COLOR[3])

        frame:Hide()
    end

    ---A label/value pair sharing one line; both span the content width so the value
    ---sits flush right while the label reads from the left.
    ---@param index integer
    ---@return table label, table value
    local function rowAt(index)
        local row = rows[index]
        if not row then
            local label = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            local value = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            label:SetWidth(WIDTH - PADDING * 2)
            value:SetWidth(WIDTH - PADDING * 2)
            label:SetJustifyH("LEFT")
            value:SetJustifyH("RIGHT")
            row = { label = label, value = value }
            rows[index] = row
        end
        return row.label, row.value
    end

    ---@param summary ResultsSummary
    local function render(summary)
        local y = -PADDING - LINE - 4
        local used = 0

        ---@param text string
        ---@param valueText string
        ---@param color number[]
        local function line(text, valueText, color)
            used = used + 1
            local label, value = rowAt(used)
            label:SetPoint("TOPLEFT", PADDING, y)
            label:SetText(text)
            label:SetTextColor(LABEL_COLOR[1], LABEL_COLOR[2], LABEL_COLOR[3])
            label:Show()
            value:SetPoint("TOPLEFT", PADDING, y)
            value:SetText(valueText)
            value:SetTextColor(color[1], color[2], color[3])
            value:Show()
            y = y - LINE
        end

        line("Gold", deps.formatMoney(summary.gold), GOLD_COLOR)
        line("New transmog", tostring(summary.newAppearances), VALUE_COLOR)
        line("New versions", tostring(summary.newVersions), VALUE_COLOR)

        if #summary.reputation == 0 then
            line("Reputation", "none", MUTED_COLOR)
        else
            line("Reputation", "", LABEL_COLOR)
            for _, rep in ipairs(summary.reputation) do
                line("  " .. rep.faction, "+" .. rep.amount, REP_COLOR)
            end
        end

        for index = used + 1, #rows do
            rows[index].label:Hide()
            rows[index].value:Hide()
        end

        frame:SetHeight(-y + PADDING)
    end

    return {
        ---@param summary ResultsSummary
        update = function(summary)
            if not frame then
                build()
            end
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
