local _, ns = ...

---A panel of read-only edit boxes. There is no clipboard API in the WoW client, so
---the only way to get text out of the game is to put it in a focused, selected edit
---box and let the player press Ctrl+C.
---@class ReportWindow
---@field show fun(lines: ReportLine[])
---@field hide fun()
---@field toggle fun(lines: ReportLine[])
---@field isShown fun(): boolean

---@class ReportWindowDeps
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field uiParent table
---@field specialFrames string[] Global UISpecialFrames list, so Escape closes the window.
---@field name string Unique global frame name.

local WIDTH = 560
local PADDING = 16
local BOX_HEIGHT = 22
local BLOCK_HEIGHT = 52
local TOP = -64

local HINT_COLOR = { 0.65, 0.65, 0.65 }

---@param deps ReportWindowDeps
---@return ReportWindow
function ns.newReportWindow(deps)
    local createFrame = deps.createFrame

    ---@type table[]
    local blocks = {}
    local frame

    local function build()
        frame = createFrame("Frame", deps.name, deps.uiParent, "BackdropTemplate")
        frame:SetSize(WIDTH, 200)
        frame:SetPoint("CENTER")
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

        local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
        title:SetPoint("TOP", 0, -14)
        title:SetText("Session Report")

        local hint = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
        hint:SetPoint("TOP", 0, -34)
        hint:SetText("Click a box, then Ctrl+C to copy. Run it outside the game.")
        hint:SetTextColor(HINT_COLOR[1], HINT_COLOR[2], HINT_COLOR[3])

        local close = createFrame("Button", nil, frame, "UIPanelCloseButton")
        close:SetPoint("TOPRIGHT", -6, -6)

        table.insert(deps.specialFrames, deps.name)
    end

    ---A label above an edit box holding one command. The box is only nominally
    ---editable: typing into it snaps straight back, so the text stays copyable.
    ---@param index integer
    ---@return table
    local function blockAt(index)
        local block = blocks[index]
        if block then
            return block
        end

        local label = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
        label:SetPoint("TOPLEFT", PADDING, TOP - (index - 1) * BLOCK_HEIGHT)
        label:SetWidth(WIDTH - PADDING * 2)
        label:SetJustifyH("LEFT")

        local box = createFrame("EditBox", nil, frame, "InputBoxTemplate")
        box:SetSize(WIDTH - PADDING * 2 - 12, BOX_HEIGHT)
        box:SetPoint("TOPLEFT", PADDING + 6, TOP - (index - 1) * BLOCK_HEIGHT - 18)
        box:SetAutoFocus(false)
        box:SetScript("OnEscapePressed", box.ClearFocus)
        box:SetScript("OnEnterPressed", box.ClearFocus)
        box:SetScript("OnEditFocusGained", box.HighlightText)
        box:SetScript("OnMouseUp", box.HighlightText)

        block = { label = label, box = box }
        -- `user` is true only for a real keystroke, so restoring the text here cannot
        -- fight with the SetText below.
        box:SetScript("OnTextChanged", function(self, user)
            if user then
                self:SetText(block.text or "")
                self:HighlightText()
            end
        end)

        blocks[index] = block
        return block
    end

    ---@param lines ReportLine[]
    local function render(lines)
        for index, line in ipairs(lines) do
            local block = blockAt(index)
            block.text = line.text
            block.label:SetText(line.label)
            block.label:Show()
            block.box:SetText(line.text)
            block.box:SetCursorPosition(0)
            block.box:Show()
        end

        for index = #lines + 1, #blocks do
            blocks[index].label:Hide()
            blocks[index].box:Hide()
        end

        frame:SetHeight(-TOP + #lines * BLOCK_HEIGHT + PADDING)
    end

    return {
        ---@param lines ReportLine[]
        show = function(lines)
            if not frame then
                build()
            end
            render(lines or {})
            frame:Show()
            frame:Raise()
        end,

        hide = function()
            if frame then
                frame:Hide()
            end
        end,

        ---@param lines ReportLine[]
        toggle = function(lines)
            if frame and frame:IsShown() then
                frame:Hide()
                return
            end
            if not frame then
                build()
            end
            render(lines or {})
            frame:Show()
            frame:Raise()
        end,

        isShown = function()
            return frame ~= nil and frame:IsShown() and true or false
        end,
    }
end
