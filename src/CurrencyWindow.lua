local _, ns = ...

---A small, draggable panel for managing which item-based currencies are tracked. Drop an
---item onto its slot to start tracking it; click a row's remove control to stop. The panel
---holds no membership logic of its own — it lays out the slot and the rows and forwards
---edits to CurrencyItems, then repaints from whatever that list now says.
---@class CurrencyWindow
---@field show fun()
---@field hide fun()
---@field toggle fun()
---@field isShown fun(): boolean
---@field refresh fun() Repaint from the tracked list; builds the frame on first use.

---@class CurrencyWindowDeps
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field uiParent table
---@field name string Unique global frame name.
---@field specialFrames string[]? Global UISpecialFrames list, so Escape closes the window.
---@field items CurrencyItems The tracked-currency store to read and edit.
---@field getCursorItem fun(): (integer?, string?) Item held on the cursor: id and name, or nil.
---@field clearCursor fun() Drop whatever the cursor is holding once it has been tracked.
---@field itemName fun(itemID: integer): string? Localised item name, for a fresh row label.
---@field loadPoint fun(): (string?, number?, number?) Saved point, x, y — or nil for the default spot.
---@field savePoint fun(point: string, x: number, y: number) Persist a dragged position.

local WIDTH = 280
local PADDING = 12
local LINE = 16
local TITLE_HEIGHT = 20
local SLOT_HEIGHT = 30
local SLOT_GAP = 8
local BOTTOM_PADDING = 10

local TITLE_COLOR = { 1, 0.82, 0 }
local SLOT_COLOR = { 0.7, 0.7, 0.7 }
local NAME_COLOR = { 1, 1, 1 }
local REMOVE_COLOR = { 0.9, 0.4, 0.4 }
local EMPTY_COLOR = { 0.5, 0.5, 0.5 }

---@param deps CurrencyWindowDeps
---@return CurrencyWindow
function ns.newCurrencyWindow(deps)
    local createFrame = deps.createFrame

    ---@type { name: table, remove: table }[]
    local rows = {}
    local frame, slotLabel
    -- Forward-declared so the slot and row closures below capture the real repaint.
    local refresh

    ---Adds whatever the cursor is holding, if it is an item, then releases it. Called both
    ---when an item is dragged onto the slot and when it is clicked on with one on the cursor.
    local function handleDrop()
        local itemID, name = deps.getCursorItem()
        if not itemID then
            return
        end
        deps.items.add(itemID, name or deps.itemName(itemID))
        deps.clearCursor()
        refresh()
    end

    local function build()
        frame = createFrame("Frame", deps.name, deps.uiParent, "BackdropTemplate")
        frame:SetWidth(WIDTH)
        frame:SetHeight(120)
        frame:SetFrameStrata("DIALOG")
        frame:SetToplevel(true)
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

        local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
        title:SetPoint("TOPLEFT", PADDING, -PADDING)
        title:SetText("Tracked Currencies")
        title:SetTextColor(TITLE_COLOR[1], TITLE_COLOR[2], TITLE_COLOR[3])

        local close = createFrame("Button", nil, frame, "UIPanelCloseButton")
        close:SetPoint("TOPRIGHT", 2, 2)
        close:SetScript("OnClick", function()
            frame:Hide()
        end)
        if deps.specialFrames then
            table.insert(deps.specialFrames, deps.name)
        end

        -- The drop slot receives a dragged item (OnReceiveDrag) and also accepts a plain
        -- click while an item rides the cursor (OnClick), so either gesture tracks it.
        local slot = createFrame("Button", nil, frame, "BackdropTemplate")
        slot:SetPoint("TOPLEFT", PADDING, -(PADDING + TITLE_HEIGHT))
        slot:SetPoint("TOPRIGHT", -PADDING, -(PADDING + TITLE_HEIGHT))
        slot:SetHeight(SLOT_HEIGHT)
        slot:EnableMouse(true)
        slot:RegisterForClicks("LeftButtonUp", "RightButtonUp")
        slot:SetBackdrop({
            bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
            edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
            tile = true,
            tileSize = 8,
            edgeSize = 10,
            insets = { left = 2, right = 2, top = 2, bottom = 2 },
        })
        slot:SetScript("OnReceiveDrag", handleDrop)
        slot:SetScript("OnClick", handleDrop)

        slotLabel = slot:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
        slotLabel:SetPoint("CENTER")
        slotLabel:SetText("Drop an item here to track it")
        slotLabel:SetTextColor(SLOT_COLOR[1], SLOT_COLOR[2], SLOT_COLOR[3])

        frame:Hide()
    end

    ---@param index integer
    ---@return table name, table remove
    local function rowAt(index)
        local row = rows[index]
        if not row then
            local name = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            local remove = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
            name:SetJustifyH("LEFT")
            remove:SetJustifyH("RIGHT")
            name:SetWordWrap(false)
            row = { name = name, remove = remove }
            rows[index] = row
        end
        return row.name, row.remove
    end

    local function render()
        local tracked = deps.items.list()
        local top = PADDING + TITLE_HEIGHT + SLOT_HEIGHT + SLOT_GAP
        local y = -top
        local used = 0

        if #tracked == 0 then
            used = 1
            local name, remove = rowAt(1)
            name:SetPoint("TOPLEFT", PADDING, y)
            name:SetWidth(WIDTH - PADDING * 2)
            name:SetText("Nothing tracked yet.")
            name:SetTextColor(EMPTY_COLOR[1], EMPTY_COLOR[2], EMPTY_COLOR[3])
            name:EnableMouse(false)
            name:Show()
            remove:Hide()
            remove:EnableMouse(false)
        else
            for _, entry in ipairs(tracked) do
                used = used + 1
                local name, remove = rowAt(used)
                name:SetPoint("TOPLEFT", PADDING, y)
                name:SetWidth(WIDTH - PADDING * 2 - 60)
                name:SetText(deps.itemName(entry.id) or entry.name)
                name:SetTextColor(NAME_COLOR[1], NAME_COLOR[2], NAME_COLOR[3])
                name:EnableMouse(false)
                name:Show()

                remove:SetPoint("TOPRIGHT", -PADDING, y)
                remove:SetWidth(56)
                remove:SetText("remove")
                remove:SetTextColor(REMOVE_COLOR[1], REMOVE_COLOR[2], REMOVE_COLOR[3])
                remove:EnableMouse(true)
                local id = entry.id
                remove:SetScript("OnMouseUp", function()
                    deps.items.remove(id)
                    refresh()
                end)
                remove:Show()
                y = y - LINE
            end
        end

        for index = used + 1, #rows do
            rows[index].name:Hide()
            rows[index].remove:Hide()
            rows[index].remove:EnableMouse(false)
        end

        frame:SetHeight(top + used * LINE + BOTTOM_PADDING)
    end

    refresh = function()
        if not frame then
            build()
        end
        render()
    end

    return {
        refresh = refresh,

        show = function()
            refresh()
            frame:Show()
            frame:Raise()
        end,

        hide = function()
            if frame then
                frame:Hide()
            end
        end,

        toggle = function()
            if frame and frame:IsShown() then
                frame:Hide()
            else
                refresh()
                frame:Show()
                frame:Raise()
            end
        end,

        isShown = function()
            return frame ~= nil and frame:IsShown() and true or false
        end,
    }
end
