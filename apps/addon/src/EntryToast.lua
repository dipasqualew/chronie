local _, ns = ...

---The small thing that appears after a capture and offers to take a note.
---
---As thin as a frame gets: it shows what the prompt beside it says is pending, hides when
---the prompt says the offer has gone, and hands back the three things a player can do to
---it — engage, submit, dismiss. Every rule about which entry a note lands on and how long
---the offer stands lives in `ns.newEntryPrompt`, where it can be tested against a fake
---clock. This file owns geometry and scripts.
---
---**It never takes keyboard focus on its own.** `SetAutoFocus(false)` on the box and a box
---that is not even shown until `engage` are the two halves of that, and `engage` is
---reached only from a click on the toast. Until then the toast cannot consume a keystroke,
---which is the whole point: this appears while the player is doing something else — a
---screenshot is most often taken mid-fight — and a focused edit box swallows every keybind
---they have, including the interrupt they were about to press.
---
---Escape gets two routes on purpose. A focused box answers it through `OnEscapePressed`,
---and the frame is in `UISpecialFrames`, which is what closes it when the box is not
---focused. Both end in the same `OnHide`, which is also what a `/reload` or anything else
---hiding the frame goes through.
---@class EntryToast
---@field show fun(entry: EntryRecord) Offer to annotate this entry.
---@field hide fun()
---@field engage fun() The deliberate act: turn the offer into a focused box. What a click
---on the toast calls, and the only thing that reaches it.
---@field isShown fun(): boolean

---@class EntryToastDeps
---@field createFrame fun(frameType: string, name: string?, parent: table?, template: string?): table
---@field uiParent table
---@field specialFrames string[] Global UISpecialFrames list, so Escape dismisses the toast.
---@field name string? Global frame name. Default "ChronieEntryToast".
---@field onEngage fun(): EntryRecord? Asks the prompt to stop the clock. nil means too late.
---@field onSubmit fun(text: string?) Hands over what was typed.
---@field onDismiss fun() The toast went away with nothing written.
---@field onRelease fun() The box lost focus without submitting.
---@field tick fun() Driven from OnUpdate; how the offer expires.

local WIDTH = 300
local HEIGHT = 74
local BOX_HEIGHT = 20
local PADDING = 14

---High enough to clear the action bars and the chat frame, low enough to be seen.
local ANCHOR_Y = -170

local TITLE_COLOR = { 1, 0.82, 0 }
local HINT_COLOR = { 0.7, 0.7, 0.7 }

---Clicking is the only way in, so the toast can say so plainly. Chronie binds no keys —
---the screenshot that put this toast on screen was taken with the client's own — and a
---hint naming a key the player would have had to find and bind for themselves helps
---nobody.
local OFFER_HINT = "Click to add a note."

---@param deps EntryToastDeps
---@return EntryToast
function ns.newEntryToast(deps)
    local createFrame = deps.createFrame
    local name = deps.name or "ChronieEntryToast"

    local frame, title, hint, box

    ---The box is shown only from engage, so hiding it here is what guarantees a toast
    ---never reappears already focused on the last thing that was typed into it.
    local function reset()
        box:SetText("")
        box:ClearFocus()
        box:Hide()
    end

    local function engage()
        if not frame or not frame:IsShown() then
            return
        end
        local entry = deps.onEngage()
        if not entry then
            return
        end
        hint:SetText("Enter to keep it, Escape to let it go.")
        box:Show()
        -- The one place in the addon that takes keyboard focus, reached only from a click
        -- or a key the player pressed meaning exactly this.
        box:SetFocus()
    end

    local function build()
        frame = createFrame("Frame", name, deps.uiParent, "BackdropTemplate")
        frame:SetSize(WIDTH, HEIGHT)
        frame:SetPoint("TOP", deps.uiParent, "TOP", 0, ANCHOR_Y)
        frame:SetFrameStrata("DIALOG")
        frame:SetBackdrop({
            bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background-Dark",
            edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
            tile = true,
            tileSize = 32,
            edgeSize = 32,
            insets = { left = 8, right = 8, top = 8, bottom = 8 },
        })
        frame:EnableMouse(true)
        frame:SetMovable(true)
        frame:RegisterForDrag("LeftButton")
        frame:SetScript("OnDragStart", frame.StartMoving)
        frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
        frame:SetScript("OnMouseUp", engage)
        -- Two comparisons against a clock, and only while the toast is up: this script is
        -- installed on a frame that spends almost all of its life hidden.
        frame:SetScript("OnUpdate", function()
            deps.tick()
        end)
        frame:Hide()

        title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
        title:SetPoint("TOP", 0, -PADDING)
        title:SetTextColor(TITLE_COLOR[1], TITLE_COLOR[2], TITLE_COLOR[3])

        hint = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
        hint:SetPoint("TOP", 0, -PADDING - 18)
        hint:SetWidth(WIDTH - PADDING * 2)
        hint:SetTextColor(HINT_COLOR[1], HINT_COLOR[2], HINT_COLOR[3])

        box = createFrame("EditBox", nil, frame, "InputBoxTemplate")
        box:SetSize(WIDTH - PADDING * 2 - 12, BOX_HEIGHT)
        box:SetPoint("BOTTOM", 0, PADDING)
        -- Load-bearing, not decoration. Autofocus is the failure mode this whole feature
        -- was specified around.
        box:SetAutoFocus(false)
        -- The cap the text is held to anyway, applied where the player can see it stop.
        box:SetMaxBytes(ns.ENTRY_TEXT_MAX_BYTES)
        box:SetScript("OnEnterPressed", function(self)
            local text = self:GetText()
            self:ClearFocus()
            deps.onSubmit(text)
        end)
        box:SetScript("OnEscapePressed", function(self)
            self:ClearFocus()
            deps.onDismiss()
        end)
        -- Clicking away leaves the toast on screen with nobody typing into it. Rather than
        -- throw away a half-written note or leave it up for the rest of the evening, the
        -- expiry clock starts again from here.
        box:SetScript("OnEditFocusLost", function()
            deps.onRelease()
        end)
        box:Hide()

        -- Every way the toast can go away arrives here, including the Escape that
        -- UISpecialFrames handles without telling the addon anything.
        --
        -- Installed last on purpose, and the last thing in the function for the same reason.
        -- CreateFrame hands back a frame that is already shown, so the `frame:Hide()` above
        -- is a real hide and runs whatever OnHide is installed by then. Installed any
        -- earlier, that hide reaches `reset` before there is a box to reset — the error in
        -- #214 — and reports a dismissal for an offer the player has not been shown yet,
        -- which for a memory nobody photographed throws the entry away.
        frame:SetScript("OnHide", function()
            reset()
            deps.onDismiss()
        end)

        table.insert(deps.specialFrames, name)
    end

    return {
        ---@param entry EntryRecord
        show = function(entry)
            if not frame then
                build()
            end
            reset()
            -- The picture is optional: the same toast offers a note on a capture and on a
            -- moment nobody photographed, and says which of the two it is looking at.
            title:SetText(entry.hasImage and "Screenshot taken." or "Moment marked.")
            hint:SetText(OFFER_HINT)
            frame:Show()
        end,

        hide = function()
            if frame then
                frame:Hide()
            end
        end,

        engage = engage,

        isShown = function()
            return frame ~= nil and frame:IsShown() and true or false
        end,
    }
end
