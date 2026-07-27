local _, ns = ...

---Where a character currently sits with one faction, reduced to the three things a
---progress bar needs: what the level is called, how far into it the character is, and how
---long the level is. Everything the client's four different reputation systems disagree
---about is resolved here.
---@class FactionStanding
---@field standing string? The level's name — "Honored", "Renown 12", "Best Friend".
---@field current integer Progress into the current level, never past its end.
---@field max integer Reputation the level takes to finish; 0 when the client offered none.
---@field rank integer? How far up this faction's own ladder the level sits; see below.
---@field system string? Which ladder that is: "renown", "paragon", "friendship", "reaction".

---Clamps a bar into shape. The client can report a standing below the level's own floor
---for a heartbeat after a level-up, and a value past its ceiling while a paragon reward
---waits to be collected; either would draw a bar running off its own ends.
---
---`rank` is what makes two characters' standings with the same faction comparable, which
---is the only thing a name cannot do: "Renown 12" and "Honored" do not sort, and nothing
---in the client says which of them is further along. It is only ever meaningful against
---the same faction on the same ladder, which is why `system` travels with it — a rank
---read off the reaction ladder runs 1 to 8 while a friendship's runs into the thousands,
---and comparing the two would call the smaller number the worse standing.
---@param label string?
---@param current number?
---@param max number?
---@param rank number? Monotone within one faction's ladder; higher is further along.
---@param system string? Which ladder `rank` was read from.
---@return FactionStanding?
local function bar(label, current, max, rank, system)
    max = math.max(math.floor(max or 0), 0)
    current = math.min(math.max(math.floor(current or 0), 0), max)
    if label == nil and max == 0 then
        return nil
    end
    return {
        standing = label,
        current = current,
        max = max,
        rank = rank and math.floor(rank) or nil,
        system = rank and system or nil,
    }
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
            renown.renownReputationEarned, renown.renownLevelThreshold,
            renown.renownLevel, "renown")
    end

    local paragon = sources.paragon
    if paragon and (paragon.threshold or 0) > 0 then
        -- Paragon value accumulates for the life of the character and never resets, so
        -- what is left over past the last reward is the part the bar shows. The rank is
        -- the reaction the character had to reach to be paragon at all — every paragon
        -- character sits at the top of the ladder, so rank alone says nothing about which
        -- of two is further, and the rewards already collected are not on offer here.
        local reaction = sources.faction and sources.faction.reaction
        return bar("Paragon", (paragon.value or 0) % paragon.threshold, paragon.threshold,
            reaction or 8, "paragon")
    end

    local friendship = sources.friendship
    if friendship and (friendship.friendshipFactionID or 0) > 0 then
        local floor = friendship.reactionThreshold or 0
        local ceiling = friendship.nextThreshold
        -- The raw standing rather than a rank index: the client numbers friendship ranks
        -- nowhere a caller can read, and the reputation behind them only ever goes up.
        local rank = friendship.standing
        if not ceiling or ceiling <= floor then
            return bar(friendship.reaction, 1, 1, rank, "friendship")
        end
        return bar(friendship.reaction, (friendship.standing or 0) - floor, ceiling - floor,
            rank, "friendship")
    end

    local faction = sources.faction
    if not faction then
        return nil
    end
    local floor = faction.currentReactionThreshold or 0
    local ceiling = faction.nextReactionThreshold
    if not ceiling or ceiling <= floor then
        return bar(sources.reactionLabel, 1, 1, faction.reaction, "reaction")
    end
    return bar(sources.reactionLabel, (faction.currentStanding or 0) - floor, ceiling - floor,
        faction.reaction, "reaction")
end

---The function `source[name]`, or nil when this client build does not have it.
---
---Every reputation call below goes through here rather than being called directly. The
---client's API is not a fixed surface: a build can drop a function, move it to another
---namespace, or never have had it, and calling one that is not there throws a Lua error
---out of an event handler — which is exactly what happened at every reputation gain on
---the build in issue #44, where `C_Reputation.GetFactionDataByName` was not defined.
---A standing the client will not tell us is worth losing; a Lua error is not.
---@param source table?
---@param name string
---@return function?
local function callable(source, name)
    if type(source) ~= "table" or type(source[name]) ~= "function" then
        return nil
    end
    return source[name]
end

---Finds one faction's data table by the name the chat message called it.
---
---By name where the client offers it. Where it does not, the reputation list is walked
---instead — the same tables, reached the long way round. That walk only sees the rows the
---pane is currently showing, so a faction under a collapsed header is invisible to it;
---the caller then keeps whatever standing it had rather than showing none.
---@param reputation table? The client's `C_Reputation`.
---@param faction string
---@return table? faction data, in `GetFactionDataByName`'s shape
local function findFaction(reputation, faction)
    local byName = callable(reputation, "GetFactionDataByName")
    if byName then
        return byName(faction)
    end

    local count = callable(reputation, "GetNumFactions")
    local byIndex = callable(reputation, "GetFactionDataByIndex")
    if not count or not byIndex then
        return nil
    end
    for index = 1, count() or 0 do
        local data = byIndex(index)
        if data and data.name == faction then
            return data
        end
    end
    return nil
end

---Asks the client everything it knows about one faction and reduces it to a single bar.
---
---This is `ns.factionStanding`'s outward-facing half: gathering the four systems' answers
---from four different namespaces, so that the choosing between them stays pure. Written
---the same way as `ns.readMapPosition` — the client tables arrive as arguments, so the
---whole thing is drivable from a spec without a game running.
---@param clients table? `{ reputation = C_Reputation, majorFaction = C_MajorFactionData,
---gossip = C_GossipInfo, reactionLabel = fun(reaction: integer): string? }`
---@param faction string? The faction's localised name, as the chat message named it.
---@return FactionStanding?
function ns.readFactionState(clients, faction)
    if type(faction) ~= "string" or faction == "" then
        return nil
    end
    clients = clients or {}

    local reputation = clients.reputation
    local data = findFaction(reputation, faction)
    if not data then
        return nil
    end

    local renown, friendship, paragon
    local factionID = data.factionID
    if factionID then
        local isMajor = callable(reputation, "IsMajorFaction")
        local majorData = callable(clients.majorFaction, "GetMajorFactionData")
        if isMajor and majorData and isMajor(factionID) then
            renown = majorData(factionID)
        end

        local friendshipFor = callable(clients.gossip, "GetFriendshipReputation")
        if friendshipFor then
            friendship = friendshipFor(factionID)
        end

        local isParagon = callable(reputation, "IsFactionParagon")
        local paragonInfo = callable(reputation, "GetFactionParagonInfo")
        if isParagon and paragonInfo and isParagon(factionID) then
            local value, threshold = paragonInfo(factionID)
            paragon = { value = value, threshold = threshold }
        end
    end

    local reactionLabel
    if data.reaction and type(clients.reactionLabel) == "function" then
        reactionLabel = clients.reactionLabel(data.reaction)
    end

    return ns.factionStanding({
        faction = data,
        renown = renown,
        friendship = friendship,
        paragon = paragon,
        reactionLabel = reactionLabel,
    })
end
