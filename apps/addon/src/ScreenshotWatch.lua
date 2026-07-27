local _, ns = ...

---Who took the screenshot that just landed.
---
---The client fires `SCREENSHOT_SUCCEEDED` for every screenshot it writes, whether the file
---was asked for by the player's own screenshot key or by an addon calling `Screenshot()`,
---and it says nothing at all about which — the event carries no payload. So telling one
---from the other is done here, by remembering each shutter press the addon made and
---matching the events against those presses in the order they were made.
---
---**Everything unclaimed is the player's**, and the doubt is resolved in that direction on
---purpose. A shot wrongly called the addon's is a photograph the player took and Chronie
---silently ignored, which is the failure this whole feature exists to prevent; a shot
---wrongly called the player's is one extra marker beside a picture that already has one,
---which a reader can see and dismiss.
---
---**A claim expires.** `Screenshot()` is asynchronous and nothing guarantees an event ever
---comes back for it — a build that fires neither event, a shot the client abandons — and a
---claim left standing forever would swallow the next screenshot the player takes for
---themselves, for the rest of the session. The window is the ceiling on how long the addon
---is willing to be wrong about that.
---@class ScreenshotWatch
---@field fired fun() The addon has just called Screenshot(): the next shot to land is its
---own. Called by whatever presses the shutter, never by the event handlers.
---@field claim fun(): boolean A screenshot just succeeded or failed. True when it was one
---the addon asked for, which is also what takes that press off the list; false when nobody
---was waiting for it, which means the player took it themselves.

---@class ScreenshotWatchDeps
---@field now fun(): integer
---@field windowSeconds integer? How long a shutter press waits for its event before it is
---given up on. Default 5.

---Generous next to how long the client takes to write a file, short enough that a press
---whose event never arrives is forgotten well before the player's next photograph.
local DEFAULT_WINDOW = 5

---@param deps ScreenshotWatchDeps
---@return ScreenshotWatch
function ns.newScreenshotWatch(deps)
    local now = deps.now
    local window = deps.windowSeconds or DEFAULT_WINDOW

    ---When each shutter press the addon made still waiting for its event happened, oldest
    ---first. A list rather than a flag because two presses can be outstanding at once, and
    ---collapsing them would hand the second one's event to the player.
    ---@type integer[]
    local outstanding = {}

    ---@param at integer
    local function expire(at)
        local kept = {}
        for _, firedAt in ipairs(outstanding) do
            -- Only a clock that has moved forward, and not far enough. A clock that jumped
            -- backwards mid-session must not throw away a press that is still perfectly
            -- fresh, which would then be credited to the player.
            if at < firedAt or at - firedAt < window then
                kept[#kept + 1] = firedAt
            end
        end
        outstanding = kept
    end

    return {
        fired = function()
            local at = now()
            expire(at)
            outstanding[#outstanding + 1] = at
        end,

        ---@return boolean
        claim = function()
            expire(now())
            if #outstanding == 0 then
                return false
            end
            -- Oldest first: the client writes screenshots one at a time and reports them in
            -- the order it took them, so the press that has been waiting longest is the one
            -- this event belongs to.
            table.remove(outstanding, 1)
            return true
        end,
    }
end
