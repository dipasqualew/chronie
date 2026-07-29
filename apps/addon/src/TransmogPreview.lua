local _, ns = ...

---Showing one collected appearance on the player's own body, and nothing else on it.
---
---`DressUpItemLink` alone answers the wrong question. It opens the dressing room on the
---character as they are dressed right now and lays the item over the top, which is what a
---player linking an item to a friend wants and is exactly wrong for the thing this list is
---for: a robe already worn hides the legs and the feet the run just collected, so the click
---that was meant to show the new piece shows the old one. Undressing first is what makes the
---picture answer "what does this look like", rather than "what would this look like under
---everything I happen to be wearing".
---
---So the item is tried on twice. The client's own entry point is the only way to get the
---dressing room open and its player actor built — it picks which of the several dress-up
---frames the player is in front of, sets the background for their race, and reports whether
---the item was something it could show at all — and none of that is reachable any other way.
---Once it has run there is an actor to strip, and the second fitting is the cheap half.
---@class TransmogPreview
---@field show fun(itemID: integer?) Open the dressing room wearing this item and nothing else.

---@class TransmogPreviewDeps
---@field dressUp fun(link: string): boolean The client's `DressUpItemLink`: opens the dressing
---room over what the character is already wearing, and answers false for anything it will not
---put on a body at all.
---@field playerActor fun(): table? The player's actor inside whichever dressing room that just
---opened, or nil when the client did not build one. Answered after `dressUp`, never before —
---the actor does not exist until the frame it lives in has been shown.

---@param deps TransmogPreviewDeps
---@return TransmogPreview
function ns.newTransmogPreview(deps)
    return {
        ---@param itemID integer?
        show = function(itemID)
            if not itemID then
                return
            end
            local link = "item:" .. itemID
            -- False is the client saying this is not a dressable item, and it has already told
            -- the player so. Nothing has been shown, so there is no actor to go looking for.
            if not deps.dressUp(link) then
                return
            end
            local actor = deps.playerActor()
            if not actor then
                return
            end
            -- Strip, then fit. The other order takes the item straight back off again, and
            -- the player is left looking at a naked character.
            actor:Undress()
            actor:TryOn(link)
        end,
    }
end
