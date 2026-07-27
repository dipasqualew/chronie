local _, ns = ...

---What the client reports about the place the player is standing in.
---@class InstanceInfo
---@field name string? Zone or instance name.
---@field kind string? IsInInstance's type: "party", "raid", "scenario", "none", ...
---@field difficultyId integer?
---@field difficulty string? Localised difficulty name.

---Reads where the player is from the client, narrowed to the zone rather than the continent.
---
---Two calls, because neither one is right everywhere. `GetInstanceInfo` is the only one that
---carries the difficulty, and inside an instance its name is the one the rest of the addon is
---built on: the Encounter Journal files expansions under it, and the tracker pairs it with the
---difficulty to tell Heroic Deadmines from Normal. Out in the open world, though, that same
---call names the *continent* — every zone on Northrend answers "Northrend" — which is far too
---coarse to file a segment under. `GetRealZoneText` names the zone the player is actually in.
---
---So the instance name wins indoors and the zone text wins outdoors, and the difficulty and
---the type come from the same read either way.
---
---The one thing the zone text is not allowed to do is empty the name. It answers "" while the
---world is still loading, and a segment filed under nothing at all would be worse than the
---continent it replaced; the continent stands until the client has a zone to name. That
---correction costs nothing to wait for, because ZONE_CHANGED_NEW_AREA fires on the far side of
---the loading screen and syncs the tracker again — an empty segment opened under the continent
---is dropped rather than logged when it closes.
---@param client table? `{ getInstanceInfo, getRealZoneText }` — the client's own two calls.
---@return InstanceInfo?
function ns.readLocation(client)
    if type(client) ~= "table" or type(client.getInstanceInfo) ~= "function" then
        return nil
    end

    local name, kind, difficultyId, difficulty = client.getInstanceInfo()
    local info = { name = name, kind = kind, difficultyId = difficultyId, difficulty = difficulty }

    -- Anything the client will not name a type for is the open world as far as narrowing is
    -- concerned: "none" is what it says out there, and nothing at all is what a build that
    -- has not settled yet says, which is the same place.
    if kind ~= nil and kind ~= "none" then
        return info
    end

    if type(client.getRealZoneText) ~= "function" then
        return info
    end

    local zone = client.getRealZoneText()
    if type(zone) == "string" and zone ~= "" then
        info.name = zone
    end

    return info
end
