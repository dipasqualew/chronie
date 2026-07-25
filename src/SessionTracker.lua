local _, ns = ...

---What the client reports about the zone the player is standing in.
---@class InstanceInfo
---@field name string? Zone or instance name.
---@field kind string? IsInInstance's type: "party", "raid", "scenario", "none", ...
---@field difficultyId integer?
---@field difficulty string? Localised difficulty name.

---Owns the lifecycle of an instance visit: when it starts, when it ends, and what
---identity it is filed under. The running tally itself lives in InstanceResults;
---this only decides the boundaries and hands finished visits to the log.
---@class SessionTracker
---@field sync fun(): boolean Reconcile with the current zone. True while a visit is open.
---@field flush fun(): SessionRecord? File the open visit early, e.g. on logout.
---@field current fun(): table? The open visit's descriptor, or nil.

---@class SessionTrackerDeps
---@field results InstanceResults
---@field sessionLog SessionLog
---@field now fun(): integer
---@field instanceInfo fun(): InstanceInfo? The zone the player is in right now.
---@field getMoney fun(): integer
---@field character fun(): string "Name-Realm" of the character running it.
---@field classFile fun(): string?

---@param info InstanceInfo
---@return string
local function identityOf(info)
    -- Difficulty is part of the identity: walking out of Heroic and back in on
    -- Mythic is two visits, even though the instance name never changed.
    return tostring(info.name or "") .. "\0" .. tostring(info.difficultyId or "")
end

---@param deps SessionTrackerDeps
---@return SessionTracker
function ns.newSessionTracker(deps)
    local results = deps.results
    local sessionLog = deps.sessionLog
    local now = deps.now

    ---@type table?
    local current

    ---@return SessionRecord?
    local function finish()
        if not current then
            return nil
        end

        local visit = {
            character = current.character,
            classFile = current.classFile,
            instance = current.instance,
            difficulty = current.difficulty,
            instanceType = current.instanceType,
            startedAt = current.startedAt,
            endedAt = now(),
            summary = results.summary(),
        }

        current = nil
        -- Closes the tally before it is reused, so the next enter() cannot fold this
        -- visit's gold into the following one.
        results.leave()

        return sessionLog.record(visit)
    end

    return {
        current = function()
            return current
        end,

        ---Called whenever the player finishes zoning. Ends the open visit if the
        ---player is no longer in it, then opens one if the new zone is trackable.
        ---@return boolean active
        sync = function()
            local info = deps.instanceInfo() or {}
            local identity = identityOf(info)

            if current and identity ~= current.identity then
                finish()
            end

            local active = results.enter(info.kind, deps.getMoney())

            if not active then
                -- Whatever the zone is called, it is not one we track: any visit still
                -- open ended on the way here. No-op when none was.
                finish()
            elseif not current then
                current = {
                    identity = identity,
                    character = deps.character(),
                    classFile = deps.classFile(),
                    instance = info.name or "Unknown",
                    difficulty = info.difficulty or "",
                    instanceType = info.kind or "",
                    startedAt = now(),
                }
            end

            return active
        end,

        ---SavedVariables are only written when the client shuts the session down, so
        ---a visit still open at logout has to be filed here or it never reaches disk.
        flush = finish,
    }
end
