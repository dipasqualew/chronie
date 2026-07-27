local _, ns = ...

---One photograph per moment, however many events that moment fired.
---
---A thing worth remembering rarely announces itself once. Killing the last boss of an old
---raid earns the boss achievement, the wing achievement and the meta all in the same
---breath; emptying a bag at a vendor collects a dozen appearances; a keystone that ends on
---time completes the run and hands over a mount. Every one of those is a single moment to
---the player and a burst of separate events to the addon, and asking `ns.newCaptureTriggers`
---about each of them in turn would answer yes to each of them in turn.
---
---So the shutter is not pressed by the event. A decision that wants a photograph is offered
---here instead, the first one opens a window, and every decision offered while that window
---is open is folded into it. When the window closes, exactly one photograph is taken.
---
---**The window is a fixed length from the first offer, not a timer the next offer restarts.**
---A restarting window is what "debounce" usually means and it is the wrong shape here: a
---steady trickle — twenty appearances arriving a third of a second apart as the bags empty —
---would postpone the photograph for as long as the trickle lasted, and the moment worth
---photographing is at the start of it rather than the end. A fixed window is bounded by
---construction: the picture is never more than `windowSeconds` behind the thing it is of.
---
---**The delay is a feature, not a cost paid to collapse the burst.** The client fires
---ACHIEVEMENT_EARNED before it has drawn the alert about it, so a shutter pressed in the
---event's own frame photographs a screen with no achievement on it, and the death animation
---of whatever was just killed is still playing. Half a second later both have arrived.
---
---What this module does not do is decide. Whether a decision is allowed, whether the world
---is on screen and whether one was taken too recently all belong to `ns.newCaptureTriggers`
---and are settled before anything gets here.

---@class CaptureBurst
---@field offer fun(decision: CaptureDecision): boolean A decision that wants a photograph.
---True when the burst is now holding this one — it either opened the window or displaced
---what was in it — and false when it was folded into a decision already held.
---@field pending fun(): CaptureDecision? What the open window would photograph, or nil when
---no window is open.

---@class CaptureBurstDeps
---@field after fun(seconds: number, callback: fun()) Runs `callback` once, later. Usually
---`C_Timer.After`. The only thing in here that a test has to stand in for.
---@field capture fun(decision: CaptureDecision) Takes the photograph. Called once per
---window, with the one decision that won it.
---@field windowSeconds number? How long a window stays open for. Default 0.5.

---Long enough for the client to have drawn the alert the picture is meant to contain and
---for a raid clear's achievements to arrive together, short enough that the photograph is
---still of the moment that earned it rather than of walking away from it.
---
---Erring short costs very little. A straggler that misses the window does not become a
---second photograph — `ns.newCaptureTriggers` has a rate limit measured in minutes and it
---refuses everything for a good while after a capture — so the window's length decides
---which decision the picture is filed against, never how many pictures there are.
local DEFAULT_WINDOW = 0.5

---Whether `candidate` deserves the photograph more than the decision already holding it.
---
---Rank is an index into one kind's candidate list, most specific first, so it means
---something only against another decision of the same kind: "an account first beats a plain
---achievement" is a real statement about a raid clear where the third achievement is the
---one nobody on the account had, and "a mount beats a keystone" is not a statement at all.
---Across kinds the first to arrive keeps it, which is the same answer the addon gave before
---any of this existed.
---@param candidate CaptureDecision
---@param held CaptureDecision
---@return boolean
local function displaces(candidate, held)
    return candidate.kind == held.kind and (candidate.rank or 1) < (held.rank or 1)
end

---@param deps CaptureBurstDeps
---@return CaptureBurst
function ns.newCaptureBurst(deps)
    local window = deps.windowSeconds or DEFAULT_WINDOW

    ---The decision the open window would photograph, nil when no window is open. Its
    ---presence is what "a window is open" means: there is no second flag to keep in step
    ---with it, and the timer that closes the window clears it before anything else runs.
    ---@type CaptureDecision?
    local holding

    local function close()
        local decision = holding
        -- Cleared before the photograph rather than after. Taking one is not instant — an
        -- entry is written, a prompt is offered — and an event arriving during that must
        -- open a fresh window rather than being folded into one that has already fired.
        holding = nil
        if decision then
            deps.capture(decision)
        end
    end

    return {
        ---@param decision CaptureDecision
        ---@return boolean
        offer = function(decision)
            if not decision then
                return false
            end

            if holding then
                if not displaces(decision, holding) then
                    return false
                end
                -- No second timer: the window belongs to the moment, not to the decision
                -- that happens to be winning it, so displacing the holder does not buy the
                -- picture another half second.
                holding = decision
                return true
            end

            holding = decision
            deps.after(window, close)
            return true
        end,

        ---@return CaptureDecision?
        pending = function()
            return holding
        end,
    }
end
