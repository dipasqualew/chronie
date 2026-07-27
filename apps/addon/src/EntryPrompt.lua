local _, ns = ...

---Which entry a note would attach to, and for how much longer.
---
---A picture with a sentence attached is worth considerably more than a picture, and the
---moment to write that sentence is the moment it happened. This module is that offer: an
---entry has just been filed, a note may be attached to it, and shortly it may not be.
---
---It holds no frame and reads no key. The toast beside it draws whatever this says is
---pending and does nothing else, which is what lets the part with the rules — when the
---offer lapses, what a submitted note lands on, what happens when a second capture arrives
---while the first is still being typed into — be tested against a fake clock with no
---client at all.
---
---**Nothing here may take keyboard focus, and nothing here can.** That is the hard
---requirement of the feature rather than a preference: a focused edit box swallows every
---keybind the player has, so a prompt that focused itself would be a note-taking feature
---that eats an interrupt mid-pull. The offer is passive by construction — it becomes an
---edit box only when `engage` is called, and `engage` is called only by a deliberate act:
---a click on the toast.
---
---**The offer expires.** A capture is annotatable for a few seconds and then it is not;
---the toast goes and the entry is filed with no note. There is deliberately no queue of
---pending offers stacking up through a raid and no state that survives a `/reload` waiting
---to ambush somebody — anything not annotated in the moment is annotated in the desktop
---app instead, which is what makes it affordable to be this aggressive about getting out
---of the way.
---
---The one thing that stops the clock is somebody typing. Once engaged the offer stays
---open, because taking the box away mid-sentence is worse than a toast that outstays its
---welcome; letting go of the box starts the clock again.
---@class EntryPrompt
---@field offer fun(entry: EntryRecord?): boolean Opens the window on a freshly filed entry.
---False when there was nothing to offer, or when somebody is mid-sentence on an older one.
---@field pending fun(): EntryRecord? What a note submitted now would attach to.
---@field engage fun(): EntryRecord? The deliberate act. Stops the clock and answers what is
---being annotated, or nil when the offer had already gone.
---@field release fun() Somebody stopped typing without submitting: start the clock again.
---@field submit fun(text: string?): EntryRecord? Attaches the note and closes. Answers the
---entry it landed on, or nil when nothing was written — an empty note, or too late.
---@field dismiss fun() Closes with nothing attached.
---@field tick fun(): boolean Closes the offer if its window has passed. Answers whether one
---is still open. What the toast's OnUpdate calls, and the only thing that expires anything.

---@class EntryPromptDeps
---@field now fun(): integer
---@field attach fun(entry: EntryRecord, text: string) Writes the note onto the entry.
---@field onShow fun(entry: EntryRecord)? Called when an offer opens.
---@field onHide fun(entry: EntryRecord, annotated: boolean)? Called when one closes, however
---it closed, with what it was offering and whether a note actually landed on it. Both halves
---matter to a caller that has to decide the entry's fate: a memory that nobody wrote anything
---about is a row worth taking back out again, and this is the only moment that says so.
---@field windowSeconds integer? How long an offer stands. Default 20.

---Long enough to read the toast, notice it and decide; short enough that it is gone before
---the next pull rather than during it.
local DEFAULT_WINDOW = 20

---@param deps EntryPromptDeps
---@return EntryPrompt
function ns.newEntryPrompt(deps)
    local now = deps.now
    local window = deps.windowSeconds or DEFAULT_WINDOW

    ---@type EntryRecord?
    local pending
    ---@type integer?
    local expiresAt
    local engaged = false

    ---@return boolean
    local function lapsed()
        -- Absent while engaged: the clock is not merely paused, there is no deadline.
        return expiresAt ~= nil and now() >= expiresAt
    end

    ---@param annotated boolean? Whether a note landed on the entry on the way out.
    local function close(annotated)
        if not pending then
            return
        end
        local entry = pending
        -- State goes first, so that anything the hide reaches — a frame's OnHide handler
        -- calling dismiss right back, which is exactly what Escape does — finds nothing
        -- pending and stops there rather than going round again.
        pending, expiresAt, engaged = nil, nil, false
        if deps.onHide then
            deps.onHide(entry, annotated and true or false)
        end
    end

    ---What is on offer this instant, which is not the same as what is on screen: a lapsed
    ---offer is gone the moment the clock says so, whether or not anything has ticked yet.
    ---@return EntryRecord?
    local function current()
        if pending and lapsed() then
            return nil
        end
        return pending
    end

    return {
        ---@param entry EntryRecord?
        ---@return boolean
        offer = function(entry)
            if not entry then
                return false
            end
            -- A second capture while somebody is mid-sentence does not steal the box from
            -- under them: the note they are writing is about the picture they were offered,
            -- and moving the target would file it against the wrong one.
            if pending and engaged then
                return false
            end

            pending = entry
            expiresAt = now() + window
            engaged = false
            if deps.onShow then
                deps.onShow(entry)
            end
            return true
        end,

        pending = current,

        ---@return EntryRecord?
        engage = function()
            local entry = current()
            if not entry then
                -- Nothing to annotate. If something was on screen it had already lapsed,
                -- so this is also the moment to take it away.
                close()
                return nil
            end
            engaged = true
            expiresAt = nil
            return entry
        end,

        release = function()
            if pending and engaged then
                engaged = false
                expiresAt = now() + window
            end
        end,

        ---@param text string?
        ---@return EntryRecord?
        submit = function(text)
            local entry = current()
            if not entry then
                close()
                return nil
            end

            -- Sanitised here rather than at the box, because every way in — this one, and
            -- whatever writes a memory later — has to be sanitised the same way.
            local note = ns.entryText(text)
            if note then
                deps.attach(entry, note)
            end
            close(note ~= nil)
            return note and entry or nil
        end,

        -- Wrapped rather than handed over directly: this is reached from a frame's OnHide,
        -- which calls it with arguments of its own, and none of them mean "a note landed".
        dismiss = function()
            close(false)
        end,

        ---@return boolean
        tick = function()
            if pending and lapsed() then
                close()
                return false
            end
            return pending ~= nil
        end,
    }
end
