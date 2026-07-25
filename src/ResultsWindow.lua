local _, ns = ...

---A small, draggable HUD panel that renders the current session's SessionSummary.
---Deliberately thin: it lays out font strings and remembers where it was dragged, and
---nothing else.
---@class ResultsWindow
---@field show fun()
---@field hide fun()
---@field toggle fun()
---@field isShown fun(): boolean
---@field update fun(summary: SessionSummary) Repaint; builds the frame on first use.

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
---@field title string|fun(summary: SessionSummary): string?
---@field closable boolean?
---@field specialFrames string[]?

local WIDTH = 190
local PADDING = 12
local LINE = 15

local TITLE_COLOR = { 1, 0.82, 0 }
local LABEL_COLOR = { 0.7, 0.7, 0.7 }
local VALUE_COLOR = { 1, 1, 1 }
local GOLD_COLOR = { 1, 0.82, 0 }
local REP_COLOR = { 0.4, 0.8, 0.4 }
local MUTED_COLOR = { 0.5, 0.5, 0.5 }
local ACCOUNT_COLOR = { 0.7, 0.45, 1 }
local CHARACTER_COLOR = { 0.35, 0.85, 0.45 }

local ACCOUNT_HEX = "|cffb373ff"
local CHARACTER_HEX = "|cff59d973"
local COLOR_END = "|r"

---@param deps ResultsWindowDeps
---@return ResultsWindow
function ns.newResultsWindow(deps)
    local createFrame = deps.createFrame

    ---@type { label: table, value: table }[]
    local rows = {}
    local frame, title
    local latest
    local expanded = { transmogs = false, achievements = false, quests = false }

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
        title:SetText(type(deps.title) == "string" and deps.title or "Current Session")
        title:SetTextColor(TITLE_COLOR[1], TITLE_COLOR[2], TITLE_COLOR[3])

        if deps.closable then
            local close = createFrame("Button", nil, frame, "UIPanelCloseButton")
            close:SetPoint("TOPRIGHT", 2, 2)
            close:SetScript("OnClick", function()
                frame:Hide()
            end)
            if deps.specialFrames then
                table.insert(deps.specialFrames, deps.name)
            end
        end

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

    ---@param summary SessionSummary
    local function render(summary)
        if type(deps.title) == "function" then
            title:SetText(deps.title(summary) or "Session Details")
        end
        local y = -PADDING - LINE - 4
        local used = 0

        ---@param text string
        ---@param valueText string
        ---@param color number[]
        ---@param action fun(button: string)? Called when the line is clicked.
        local function line(text, valueText, color, action)
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
            label:EnableMouse(action ~= nil)
            value:EnableMouse(action ~= nil)
            label:SetScript("OnMouseUp", action and function(_, button) action(button) end or nil)
            value:SetScript("OnMouseUp", action and function(_, button) action(button) end or nil)
            y = y - LINE
        end

        ---An itemised block: a header line, then one indented signed line per entry, or
        ---a muted "none" when the list is empty.
        ---@param heading string
        ---@param entries table[]
        ---@param label fun(entry: table): string, string value the left text and right value
        local function block(heading, entries, label)
            entries = entries or {}
            if #entries == 0 then
                line(heading, "none", MUTED_COLOR)
                return
            end
            line(heading, "", LABEL_COLOR)
            for _, entry in ipairs(entries) do
                local left, right = label(entry)
                line("  " .. left, right, REP_COLOR)
            end
        end

        line("Loot value", deps.formatMoney(summary.lootValue), GOLD_COLOR)
        line("Gold Δ", deps.formatMoney(summary.goldDiff), GOLD_COLOR)

        local transmogs = summary.transmogs or {}
        local appearances = 0
        for _, event in ipairs(transmogs) do
            if event.newAppearance then
                appearances = appearances + 1
            end
        end
        local variants = #transmogs - appearances
        local transmogValue = tostring(appearances) .. " new"
        if variants > 0 then
            transmogValue = transmogValue .. " · " .. variants .. " variant"
            if variants ~= 1 then
                transmogValue = transmogValue .. "s"
            end
        end
        line((expanded.transmogs and "- " or "+ ") .. "Transmog", transmogValue, VALUE_COLOR, function()
            expanded.transmogs = not expanded.transmogs
            render(latest)
        end)
        if expanded.transmogs then
            for _, event in ipairs(transmogs) do
                local current = event
                local itemName = deps.itemName and deps.itemName(current.id)
                local kind = current.newAppearance and "new appearance" or "known appearance variant"
                line("  " .. (itemName or ("Item " .. current.id)), kind, REP_COLOR, function(button)
                    if button == "RightButton" and current.sourceID and deps.openTransmogCollection then
                        deps.openTransmogCollection(current.sourceID)
                    elseif deps.previewTransmog then
                        deps.previewTransmog(current.id)
                    end
                end)
            end
        end

        block("Currency", summary.currencies, function(gain)
            return gain.name, (gain.amount >= 0 and "+" or "") .. gain.amount
        end)
        block("Reputation", summary.reputation, function(gain)
            return gain.faction, "+" .. gain.amount
        end)
        local achievements = summary.achievements or {}
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
        line((expanded.achievements and "- " or "+ ") .. "Achievements",
            #achievements == 0 and "none" or achievementValue,
            #achievements == 0 and MUTED_COLOR or VALUE_COLOR,
            function()
                expanded.achievements = not expanded.achievements
                render(latest)
            end)
        if expanded.achievements then
            for _, event in ipairs(summary.achievements or {}) do
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

        local quests = summary.quests or {}
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
        line((expanded.quests and "- " or "+ ") .. "Quests",
            #quests == 0 and "none" or questValue,
            #quests == 0 and MUTED_COLOR or VALUE_COLOR,
            function()
            expanded.quests = not expanded.quests
            render(latest)
        end)
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

        for index = used + 1, #rows do
            rows[index].label:Hide()
            rows[index].value:Hide()
        end

        frame:SetHeight(-y + PADDING)
    end

    return {
        ---@param summary SessionSummary
        update = function(summary)
            if not frame then
                build()
            end
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
