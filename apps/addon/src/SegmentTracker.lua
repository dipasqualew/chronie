local _, ns = ...

---What the client reports about the zone the player is standing in.
---@class InstanceInfo
---@field name string? Zone or instance name.
---@field kind string? IsInInstance's type: "party", "raid", "scenario", "none", ...
---@field difficultyId integer?
---@field difficulty string? Localised difficulty name.

---Owns the lifecycle of a segment: when it starts, when it ends, and what identity it
---is filed under. A segment is one character's continuous stay in one location — any
---zone, instance or open world. The running tally itself lives in SegmentTally; this
---only decides the boundaries, drops segments that saw nothing, and hands the rest to
---the log.
---@class SegmentTracker
---@field sync fun(): boolean Reconcile with the current zone. True while a segment is open.
---@field flush fun(): SegmentRecord? File the open segment early, e.g. on logout.
---@field current fun(): table? The open segment's descriptor, or nil.

---@class SegmentTrackerDeps
---@field tally SegmentTally
---@field segmentLog SegmentLog
---@field now fun(): integer
---@field instanceInfo fun(): InstanceInfo? The zone the player is in right now.
---@field getMoney fun(): integer
---@field currencyItemCounts fun(): table<integer, integer>? Owned count of each tracked currency item.
---@field character fun(): string "Name-Realm" of the character running it.
---@field classFile fun(): string?
---@field level fun(): integer?

---@param character string
---@param info InstanceInfo
---@return string
local function identityOf(character, info)
    -- Difficulty is part of the identity: walking out of Heroic and back in on Mythic
    -- is two segments, even though the instance name never changed. Character is too, so
    -- a relog into the same spot never folds two players' segments into one.
    return table.concat({
        tostring(character or ""),
        tostring(info.name or ""),
        tostring(info.difficultyId or ""),
    }, "\0")
end

---@param deps SegmentTrackerDeps
---@return SegmentTracker
function ns.newSegmentTracker(deps)
    local tally = deps.tally
    local segmentLog = deps.segmentLog
    local now = deps.now

    ---@type table?
    local current

    ---Closes the open segment. It reaches the log only if something actually happened
    ---in it — an empty stroll through a zone leaves no record. Either way the tally is
    ---wiped so the next segment cannot inherit this one's totals.
    ---@return SegmentRecord?
    local function finish()
        if not current then
            return nil
        end

        local kept
        if tally.hasEvents() then
            kept = segmentLog.record({
                character = current.character,
                classFile = current.classFile,
                level = current.level,
                instance = current.instance,
                difficulty = current.difficulty,
                instanceType = current.instanceType,
                difficultyId = current.difficultyId,
                startedAt = current.startedAt,
                endedAt = now(),
                summary = tally.summary(),
            })
        end

        current = nil
        tally.leave()
        return kept
    end

    return {
        current = function()
            return current
        end,

        ---Called whenever the player finishes zoning. Ends the open segment if the
        ---player has moved on, then opens one for wherever they are now. Every zone —
        ---the open world included — gets a segment; the empty ones simply never reach
        ---the log when they close.
        ---@return boolean active
        sync = function()
            local info = deps.instanceInfo() or {}
            local character = deps.character()
            local identity = identityOf(character, info)

            if current and identity ~= current.identity then
                finish()
            end

            if not current then
                local currencyItemCounts = deps.currencyItemCounts and deps.currencyItemCounts() or nil
                tally.begin(deps.getMoney(), currencyItemCounts)
                current = {
                    identity = identity,
                    character = character,
                    classFile = deps.classFile(),
                    level = deps.level(),
                    instance = info.name or "Unknown",
                    difficulty = info.difficulty or "",
                    instanceType = info.kind or "",
                    difficultyId = info.difficultyId,
                    startedAt = now(),
                }
            end

            return true
        end,

        ---SavedVariables are only written when the client shuts the segment down, so a
        ---segment still open at logout has to be filed here or it never reaches disk.
        ---An empty one is dropped the same as on any other close.
        flush = finish,
    }
end
