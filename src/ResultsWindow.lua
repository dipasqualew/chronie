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
---@field frameStrata string?
---@field toplevel boolean?

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
local VARIANT_COLOR = { 0.7, 0.45, 1 }

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
    }
    local reviewedTransmogs = {}
    local reviewedSessionKey
    local lastTransmogCount = 0

    local function build()
        frame = createFrame("Frame", deps.name, deps.uiParent, "BackdropTemplate")
        frame:SetWidth(WIDTH)
        frame:SetHeight(90)
        frame:SetFrameStrata(deps.frameStrata or "MEDIUM")
        if deps.toplevel then
            frame:SetToplevel(true)
        end
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

        ---Keeps the disclosure marker after the heading so changing + to - never
        ---shifts the heading itself.
        ---@param heading string
        ---@param isExpanded boolean
        ---@return string
        local function disclosure(heading, isExpanded)
            return heading .. (isExpanded and " -" or " +")
        end

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
        if #achievements + #currencies + #levelUps + #mounts + #pets + #quests
            + #reputation + #toys + #transmogs > 0 then
            line("────────────────────────", "", MUTED_COLOR)
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
            line(disclosure("Achievements", expanded.achievements), achievementValue, VALUE_COLOR, function()
                expanded.achievements = not expanded.achievements
                render(latest)
            end)
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
            line(disclosure("Currency", expanded.currencies),
                ((summary.currencyTotal or 0) >= 0 and "+" or "") .. (summary.currencyTotal or 0),
                VALUE_COLOR,
                function()
                    expanded.currencies = not expanded.currencies
                    render(latest)
                end)
            if expanded.currencies then
                for _, gain in ipairs(currencies) do
                    line("  " .. gain.name, (gain.amount >= 0 and "+" or "") .. gain.amount, REP_COLOR)
                end
            end
        end

        if #levelUps > 0 then
            line(disclosure("Level ups", expanded.levelUps), tostring(#levelUps), VALUE_COLOR, function()
                expanded.levelUps = not expanded.levelUps
                render(latest)
            end)
            if expanded.levelUps then
                for _, event in ipairs(levelUps) do
                    line("  Level " .. event.level, "reached", REP_COLOR)
                end
            end
        end

        local function collection(heading, key, events)
            if #events == 0 then
                return
            end
            line(disclosure(heading, expanded[key]), tostring(#events), VALUE_COLOR, function()
                expanded[key] = not expanded[key]
                render(latest)
            end)
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
            line(disclosure("Quests", expanded.quests), questValue, VALUE_COLOR, function()
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
        end

        if #reputation > 0 then
            line(disclosure("Reputation", expanded.reputation), "+" .. (summary.reputationTotal or 0),
                VALUE_COLOR, function()
                    expanded.reputation = not expanded.reputation
                    render(latest)
                end)
            if expanded.reputation then
                for _, gain in ipairs(reputation) do
                    line("  " .. gain.faction, "+" .. gain.amount, REP_COLOR)
                end
            end
        end

        collection("Toys", "toys", toys)

        if #transmogs > 0 then
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
            line(disclosure("Transmog", expanded.transmogs), transmogValue, VALUE_COLOR, function()
                expanded.transmogs = not expanded.transmogs
                render(latest)
            end)
            if expanded.transmogs then
                for index, event in ipairs(transmogs) do
                    local current = event
                    local itemName = deps.itemName and deps.itemName(current.id)
                    local kind = current.newAppearance and "new" or "variant"
                    local kindColor = current.newAppearance and REP_COLOR or VARIANT_COLOR
                    local reviewKey = tostring(current.sourceID or current.id) .. ":" .. tostring(index)
                    local prefix = reviewedTransmogs[reviewKey] and "✓ " or ""
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
            local sessionKey = summary.id or summary.startedAt
            local transmogCount = #(summary.transmogs or {})
            if (sessionKey and reviewedSessionKey and sessionKey ~= reviewedSessionKey)
                or transmogCount < lastTransmogCount then
                reviewedTransmogs = {}
            end
            reviewedSessionKey = sessionKey or reviewedSessionKey
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
