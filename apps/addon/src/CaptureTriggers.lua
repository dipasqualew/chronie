local _, ns = ...

---Whether a thing that just happened is worth a photograph, and what the photograph is of.
---
---The decision and nothing else. This module presses no shutter, writes no entry and holds
---no frame: it is handed something the tally has already been told about and answers with a
---trigger name and a subject, or with nothing. Everything it needs to say no — the
---allowlist, the clock, whether the world is on screen — arrives as a dependency, which is
---what lets the rules be tested without a client.
---
---Three separate reasons to say no, and they are not the same reason:
---
---* **The trigger is not allowed.** The allowlist is the player's, not Chronie's. Every
---  rule below offers its candidate names most specific first, so somebody who wants a
---  picture of every achievement and somebody who wants one only of an account first are
---  both expressible, and neither is the default.
---* **One was taken too recently.** Clearing an old raid fires thirty achievements in a
---  minute, and thirty pictures of the same corridor is a mess rather than a memory. The
---  limiter counts automatic captures only: a player holding the keybinding down is doing
---  something deliberate, and being told no by a rule they did not press is not helpful.
---* **The world is not on screen.** Events fire during loading screens and cinematics, and
---  the picture that comes back is a black rectangle. The obstruction is tracked by name
---  because two of them can overlap — a cinematic that ends in a loading screen — and the
---  world is back only once every one of them has lifted.

---What happened, as the handler that folded it into the tally already knows it.
---@class CaptureEvent
---@field kind string Which of the rules below to ask: "achievement", "levelUp", "mount",
---"pet", "toy" or "keystone".
---@field id integer? The achievement, mount, pet species or toy the event was about.
---@field accountFirst boolean? For an achievement: nobody on this account had it before.
---@field onTime boolean? For a keystone: the run beat the timer.

---What a capture would be, when one is worth taking.
---@class CaptureDecision
---@field trigger string The allowed rule that fired, which is filed with the entry so a
---reader can tell an automatic capture from a pressed one and say why it happened.
---@field achievement integer? The achievement this hangs off, when that is what fired it.
---An explicit field per subject kind rather than a kind/id pair: there will only ever be a
---handful, and downstream the link is a real foreign key that a polymorphic column could
---not be.

---@class CaptureTriggers
---@field consider fun(event: CaptureEvent): CaptureDecision? What to capture, or nil.
---@field taken fun() Records that a capture actually happened, starting the limiter. Called
---by the caller rather than by consider, because the entry log has refusals of its own and
---a minute of silence should not be spent on a picture that was never taken.
---@field obscured fun(reason: string, active: boolean) Whether something is between the
---player and the world right now.
---@field visible fun(): boolean Whether the world is on screen, for anyone who wants to say.

---@class CaptureTriggersDeps
---@field triggers string[]? The rule names the player allows. Absent or empty means
---automatic capture is off entirely, which is a legitimate thing to want.
---@field now fun(): integer
---@field cooldownSeconds integer? Seconds between two automatic captures. Default 60.

---Long enough that a raid clear's worth of achievements is one photograph rather than
---thirty, short enough that two genuinely separate moments in an evening both get one.
local DEFAULT_COOLDOWN = 60

---Which trigger names each kind of event can satisfy, most specific first.
---
---A list rather than a single name so that the specific and the general are both
---expressible: an account-first achievement is offered as the account-first rule and then as
---the plain one, so allowing either is enough to photograph it, and allowing only the
---account-first rule leaves the other twenty-nine achievements of a raid clear alone.
---
---Nothing here needs an event Chronie was not already listening to. That is deliberate: a
---second set of listeners for events the tally already handles is how the two drift apart.
local RULES = {
    achievement = function(event)
        if event.accountFirst then
            return { "accountFirstAchievement", "achievement" }
        end
        return { "achievement" }
    end,
    levelUp = function()
        return { "levelUp" }
    end,
    mount = function()
        return { "mount" }
    end,
    pet = function()
        return { "pet" }
    end,
    toy = function()
        return { "toy" }
    end,
    keystone = function(event)
        if event.onTime then
            return { "keystoneOnTime", "keystone" }
        end
        return { "keystone" }
    end,
}

---What the decision hangs off, per kind. Only the achievement has one today, because it is
---the only subject the desktop side has a row with a stable identity for; the rest are filed
---against the segment and the trigger name, which is honest about what is known.
---@param event CaptureEvent
---@param decision CaptureDecision
local function attach(event, decision)
    if event.kind == "achievement" then
        decision.achievement = event.id
    end
end

---@param deps CaptureTriggersDeps
---@return CaptureTriggers
function ns.newCaptureTriggers(deps)
    local now = deps.now
    local cooldown = deps.cooldownSeconds or DEFAULT_COOLDOWN

    ---The allowlist as a set. Built once, from a list, because a list is what crosses the
    ---settings channel from the desktop app and a set is what answering the question wants.
    local allowed = {}
    for _, name in ipairs(deps.triggers or {}) do
        allowed[name] = true
    end

    ---@type table<string, boolean>
    local obstructions = {}

    ---@type integer?
    local lastCapture

    ---@return boolean
    local function worldVisible()
        return next(obstructions) == nil
    end

    return {
        ---@param event CaptureEvent
        ---@return CaptureDecision?
        consider = function(event)
            if not event or not worldVisible() then
                return nil
            end

            local rule = RULES[event.kind]
            if not rule then
                return nil
            end

            local trigger
            for _, candidate in ipairs(rule(event)) do
                if allowed[candidate] then
                    trigger = candidate
                    break
                end
            end
            if not trigger then
                return nil
            end

            -- Only a clock that has moved forward, and not far enough. A clock that jumped
            -- backwards mid-session must not silence automatic capture for however long it
            -- went back by.
            local at = now()
            if lastCapture and at >= lastCapture and at - lastCapture < cooldown then
                return nil
            end

            local decision = { trigger = trigger }
            attach(event, decision)
            return decision
        end,

        taken = function()
            lastCapture = now()
        end,

        ---@param reason string
        ---@param active boolean
        obscured = function(reason, active)
            obstructions[reason] = active and true or nil
        end,

        visible = worldVisible,
    }
end
