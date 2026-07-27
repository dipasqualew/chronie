local _, ns = ...

---Where a character currently sits with one faction, reduced to the three things a
---progress bar needs: what the level is called, how far into it the character is, and how
---long the level is. Everything the client's four different reputation systems disagree
---about is resolved here.
---@class FactionStanding
---@field standing string? The level's name — "Honored", "Renown 12", "Best Friend".
---@field current integer Progress into the current level, never past its end.
---@field max integer Reputation the level takes to finish; 0 when the client offered none.

---Clamps a bar into shape. The client can report a standing below the level's own floor
---for a heartbeat after a level-up, and a value past its ceiling while a paragon reward
---waits to be collected; either would draw a bar running off its own ends.
---@param label string?
---@param current number?
---@param max number?
---@return FactionStanding?
local function bar(label, current, max)
    max = math.max(math.floor(max or 0), 0)
    current = math.min(math.max(math.floor(current or 0), 0), max)
    if label == nil and max == 0 then
        return nil
    end
    return { standing = label, current = current, max = max }
end

---Reduces whatever the client knows about one faction to a single bar.
---
---Four systems answer this question and none of them share a shape. A major faction
---(Dragonflight onwards) counts renown levels and reports its own progress; a paragon
---faction has run out of levels and instead fills the same bar over and over for a
---reward; a friendship counts ranks with names of its own; and everything else is the
---classic reaction ladder, whose bar is the slice of the total between the current
---level's floor and the next one's. They are tried in that order because a faction can
---answer to more than one — a paragon faction still reports Exalted on the ladder, and
---reporting Exalted's permanently full bar over the paragon progress would hide the only
---part of it that still moves.
---
---A level with no next one — Exalted, the last friendship rank — has no bar to fill, so
---it is drawn full rather than empty: the character is at the end of the track, not at
---the start of it.
---@param sources table? `{ faction, renown, friendship, paragon, reactionLabel }`, each the
---client table of the same name; nil for whichever systems do not answer for this faction.
---@return FactionStanding?
function ns.factionStanding(sources)
    sources = sources or {}

    local renown = sources.renown
    if renown and renown.renownLevel then
        -- Spelled out rather than taken from a client global: the label the game uses is
        -- built into its renown frames rather than exposed as a string, so this is the one
        -- standing whose name is not localised.
        return bar("Renown " .. renown.renownLevel,
            renown.renownReputationEarned, renown.renownLevelThreshold)
    end

    local paragon = sources.paragon
    if paragon and (paragon.threshold or 0) > 0 then
        -- Paragon value accumulates for the life of the character and never resets, so
        -- what is left over past the last reward is the part the bar shows.
        return bar("Paragon", (paragon.value or 0) % paragon.threshold, paragon.threshold)
    end

    local friendship = sources.friendship
    if friendship and (friendship.friendshipFactionID or 0) > 0 then
        local floor = friendship.reactionThreshold or 0
        local ceiling = friendship.nextThreshold
        if not ceiling or ceiling <= floor then
            return bar(friendship.reaction, 1, 1)
        end
        return bar(friendship.reaction, (friendship.standing or 0) - floor, ceiling - floor)
    end

    local faction = sources.faction
    if not faction then
        return nil
    end
    local floor = faction.currentReactionThreshold or 0
    local ceiling = faction.nextReactionThreshold
    if not ceiling or ceiling <= floor then
        return bar(sources.reactionLabel, 1, 1)
    end
    return bar(sources.reactionLabel, (faction.currentStanding or 0) - floor, ceiling - floor)
end
