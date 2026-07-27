local _, ns = ...

---Where a character was standing, as far as the client is willing to say.
---@class MapPosition
---@field uiMapID integer The map the character is on.
---@field x number? Normalised position across that map, 0..1. Absent far more often than not.
---@field y number?

---Reads the player's position off the client's map API.
---
---Two calls, and either can come back empty. `GetBestMapForUnit` has no map to name during
---a loading screen. `GetPlayerMapPosition` returns nothing at all inside most instanced
---content — that is the ordinary case, not the edge one: a dungeon knows perfectly well
---which map it is and simply refuses to say where on it you are standing.
---
---A refused point is left absent rather than recorded as `0, 0`, which would read to
---everything downstream as the top-left corner of the map. This is the same rule
---`SegmentSchema` applies to every optional key: a value the source never gave stays
---missing instead of arriving as a plausible-looking lie.
---@param cMap table? The client's `C_Map`.
---@return MapPosition?
function ns.readMapPosition(cMap)
    if type(cMap) ~= "table" or type(cMap.GetBestMapForUnit) ~= "function" then
        return nil
    end

    local uiMapID = cMap.GetBestMapForUnit("player")
    if not uiMapID then
        return nil
    end

    local position
    if type(cMap.GetPlayerMapPosition) == "function" then
        position = cMap.GetPlayerMapPosition(uiMapID, "player")
    end

    -- The client answers with a Vector2DMixin rather than a pair of numbers, so the point
    -- has to be asked for rather than read off the table.
    local x, y
    if type(position) == "table" and type(position.GetXY) == "function" then
        x, y = position:GetXY()
    end

    if type(x) == "number" and type(y) == "number" then
        return { uiMapID = uiMapID, x = x, y = y }
    end

    return { uiMapID = uiMapID }
end
