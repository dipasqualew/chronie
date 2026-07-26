local _, ns = ...

---@class MinimapButton
---@field show fun()
---@field hide fun()

---@class MinimapButtonDeps
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field minimap table
---@field tooltip table
---@field onClick fun()
---@field loadPoint fun(): (string?, number?, number?)?
---@field savePoint fun(point: string, x: number, y: number)?

---@param deps MinimapButtonDeps
---@return MinimapButton
function ns.newMinimapButton(deps)
    local button

    local function build()
        button = deps.createFrame("Button", "WdpWowMinimapButton", deps.minimap)
        button:SetSize(32, 32)
        local point, x, y
        if deps.loadPoint then
            point, x, y = deps.loadPoint()
        end
        button:SetPoint(point or "TOPLEFT", deps.minimap, point or "TOPLEFT", x or -4, y or -4)
        button:SetFrameStrata("MEDIUM")
        button:SetMovable(true)
        button:SetClampedToScreen(true)
        button:RegisterForDrag("LeftButton")
        button:SetScript("OnDragStart", button.StartMoving)
        button:SetScript("OnDragStop", function(self)
            self:StopMovingOrSizing()
            if deps.savePoint then
                local savedPoint, savedX, savedY
                local buttonX, buttonY = self:GetCenter()
                local minimapX, minimapY = deps.minimap:GetCenter()
                if buttonX and buttonY and minimapX and minimapY then
                    savedPoint, savedX, savedY = "CENTER", buttonX - minimapX, buttonY - minimapY
                    self:ClearAllPoints()
                    self:SetPoint(savedPoint, deps.minimap, savedPoint, savedX, savedY)
                else
                    savedPoint, _, _, savedX, savedY = self:GetPoint()
                end
                deps.savePoint(savedPoint, savedX, savedY)
            end
        end)
        button:SetNormalTexture("Interface\\Icons\\INV_Misc_Map_01")
        button:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight", "ADD")
        button:RegisterForClicks("LeftButtonUp")
        button:SetScript("OnClick", deps.onClick)
        button:SetScript("OnEnter", function(self)
            deps.tooltip:SetOwner(self, "ANCHOR_LEFT")
            deps.tooltip:AddLine("wdp sessions", 1, 0.82, 0)
            deps.tooltip:AddLine("Click to open session history", 1, 1, 1)
            deps.tooltip:AddLine("Drag to move", 0.7, 0.7, 0.7)
            deps.tooltip:Show()
        end)
        button:SetScript("OnLeave", function()
            deps.tooltip:Hide()
        end)
    end

    return {
        show = function()
            if not button then
                build()
            end
            button:Show()
        end,
        hide = function()
            if button then
                button:Hide()
            end
        end,
    }
end
