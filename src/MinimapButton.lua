local _, ns = ...

---@class MinimapButton
---@field show fun()
---@field hide fun()

---@class MinimapButtonDeps
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field minimap table
---@field tooltip table
---@field onClick fun()

---@param deps MinimapButtonDeps
---@return MinimapButton
function ns.newMinimapButton(deps)
    local button

    local function build()
        button = deps.createFrame("Button", "WdpWowMinimapButton", deps.minimap)
        button:SetSize(32, 32)
        button:SetPoint("TOPLEFT", deps.minimap, "TOPLEFT", -4, -4)
        button:SetFrameStrata("MEDIUM")
        button:SetNormalTexture("Interface\\Icons\\INV_Misc_Map_01")
        button:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight", "ADD")
        button:RegisterForClicks("LeftButtonUp")
        button:SetScript("OnClick", deps.onClick)
        button:SetScript("OnEnter", function(self)
            deps.tooltip:SetOwner(self, "ANCHOR_LEFT")
            deps.tooltip:AddLine("wdp sessions", 1, 0.82, 0)
            deps.tooltip:AddLine("Click to open session history", 1, 1, 1)
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
