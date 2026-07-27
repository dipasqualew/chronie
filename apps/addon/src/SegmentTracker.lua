local _, ns = ...

---`InstanceInfo` — what the client reports about the place the player is standing in — is
---defined in Location.lua, beside the read that produces it.

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
---@field expansions ExpansionIndex? Resolves the location to the expansion that shipped it.
---@field experienceState fun(): table? `{ level, xp, xpMax }` right now, for the tally's baseline.
---@field holdings HoldingsStore? Where this character's holdings and standings are written
---down for the rest of the account to read.

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
            local summary = tally.summary()
            -- Filed before the segment is, and from the same summary: what the character
            -- was left holding is a fact about the character rather than about the segment,
            -- and the account's rollup is the only reader of it. Segment close is also the
            -- last moment it can be written — logout flushes through here too, and
            -- SavedVariables are only handed to disk once that has happened.
            if deps.holdings then
                deps.holdings.record(current.character, summary)
            end
            kept = segmentLog.record({
                character = current.character,
                classFile = current.classFile,
                level = current.level,
                instance = current.instance,
                difficulty = current.difficulty,
                instanceType = current.instanceType,
                difficultyId = current.difficultyId,
                expansionTier = current.expansionTier,
                latestExpansionTier = current.latestExpansionTier,
                startedAt = current.startedAt,
                endedAt = now(),
                summary = summary,
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
                local experience = deps.experienceState and deps.experienceState() or nil
                tally.begin(deps.getMoney(), currencyItemCounts, experience)
                -- Which expansion shipped this location is settled once, here, from the
                -- client that is standing in it. Deciding it later, in the desktop app, would
                -- mean maintaining a list of every instance ever released; the client already
                -- knows, and a segment that records the answer stays right forever.
                local instance = info.name or "Unknown"
                local expansion = deps.expansions and deps.expansions.forInstance(instance) or nil
                current = {
                    identity = identity,
                    character = character,
                    classFile = deps.classFile(),
                    level = deps.level(),
                    instance = instance,
                    difficulty = info.difficulty or "",
                    instanceType = info.kind or "",
                    difficultyId = info.difficultyId,
                    expansionTier = expansion and expansion.tier,
                    latestExpansionTier = deps.expansions and deps.expansions.latestTier() or nil,
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
