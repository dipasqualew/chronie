local _, ns = ...

---One thing the results panel can be pointed at: the session's running total, the segment
---being played right now, or one that already closed during this session.
---@class SegmentView
---@field kind string "session", "live" or "record".
---@field key string Identity of the view, stable while it is reachable.
---@field title string What the panel's header says while this view is on screen.
---@field summary SegmentSummary What to draw. A filed record is summary-shaped already,
---which is why one can be handed to the same panel a live tally is.
---@field index integer Where this view sits in the strip, counting from one.
---@field count integer How many views the strip holds.

---The strip of views the panel's arrows walk, and which one they are standing on.
---
---Ordered so the aggregate sits at one end and time runs away from it: the session total
---first, then the open segment, then every segment that closed this session, newest
---first. The panel opens on the open segment, because that is what somebody glancing at a
---HUD is asking about; the arrows are what reach anything else, and where they are left is
---where they stay — a player who parked the panel on the session total meant to.
---
---"This session" is the same evening the desktop app draws: the segment being played, and
---every earlier one that chains back to it across a gap of no more than five minutes,
---whichever character played it. That rule lives in `apps/desktop/src/sessions.ts` as
---SESSION_GAP_SECONDS, and it is repeated here rather than invented afresh, because a panel
---that called an evening one thing while the app it feeds called it another would be worse
---than either. It also means a reload does not fork the evening in half: the log survives
---one, so the chain walks straight back through it.
---@class SegmentViews
---@field selected fun(): SegmentView What the panel should be drawing.
---@field move fun(delta: integer): SegmentView Walk the strip; clamped at both ends.

---@class SegmentViewsDeps
---@field liveSummary fun(): SegmentSummary The running tally of the open segment.
---@field liveLocation fun(): string? Where that segment is being played, when one is open.
---@field liveStart fun(): integer? When the open segment began, which is where the walk
---back through the evening starts from.
---@field segments fun(): SegmentRecord[] Everything the log holds.
---@field character fun(): string "Name-Realm" of whoever is playing.
---@field now fun(): integer

---The silence that ends an evening. Five minutes is long enough to cover a loading screen,
---and it is SESSION_GAP_SECONDS out of `apps/desktop/src/sessions.ts` — the same number
---because it is the same rule, not because both happened to pick five.
local SESSION_GAP = 300

---Lists concatenated end to end when segments are added up, as opposed to the two —
---currencies and reputation — whose entries have to be folded together by what they name.
local CONCATENATED = {
    "transmogs", "achievements", "levelUps", "mounts", "pets", "quests", "toys",
    "housingItems", "housingLevelUps", "encounters", "equipsetChanges",
}

---Adds a run of segments up into one summary shaped exactly like the ones it was built
---from, so a session can be drawn by the panel that draws a segment.
---
---Takes them oldest first and concatenates every list in that order, so the events under a
---heading read forward in time rather than in the order the segments were filed.
---
---Two things a segment carries have nowhere to go here and are deliberately dropped. A
---keystone run is one per segment and a session holds as many as the player did, so there
---is no single one to report; the wallet is a balance rather than something that happened,
---and the last one seen is the only one still true.
---@param summaries SegmentSummary[] Oldest first.
---@return SegmentSummary
function ns.mergeSegmentSummaries(summaries)
    local specs = ns.segmentEventSpecs
    local merged = {
        active = false,
        lootValue = 0,
        goldLooted = 0,
        itemValue = 0,
        goldDiff = 0,
        housingXP = 0,
        currencyTotal = 0,
        reputationTotal = 0,
    }
    for _, key in ipairs(CONCATENATED) do
        merged[key] = {}
    end

    -- Keyed tables beside ordered ones: the fold needs to find an entry by what it names,
    -- and the result has to be sorted the way a single segment's is.
    local currencies, currencyList = {}, {}
    local reputation, reputationList = {}, {}
    local experience
    local wallet

    for _, summary in ipairs(summaries or {}) do
        if summary then
            merged.active = merged.active or (summary.active and true or false)
            merged.lootValue = merged.lootValue + (summary.lootValue or 0)
            merged.goldLooted = merged.goldLooted + (summary.goldLooted or 0)
            merged.itemValue = merged.itemValue + (summary.itemValue or 0)
            merged.goldDiff = merged.goldDiff + (summary.goldDiff or 0)
            merged.housingXP = merged.housingXP + (summary.housingXP or 0)
            if summary.wallet then
                wallet = summary.wallet
            end

            for _, key in ipairs(CONCATENATED) do
                local list = merged[key]
                for _, event in ipairs(ns.copyEventList(specs[key], summary[key])) do
                    list[#list + 1] = event
                end
            end

            for _, gain in ipairs(summary.currencies or {}) do
                -- An item-based currency is keyed by item ID and a real one by currency
                -- type, and those are separate namespaces that can land on the same number,
                -- so the name is part of the identity rather than the id alone.
                local key = tostring(gain.id) .. "\0" .. tostring(gain.name)
                local entry = currencies[key]
                if not entry then
                    entry = { id = gain.id, name = gain.name, amount = 0 }
                    currencies[key] = entry
                    currencyList[#currencyList + 1] = entry
                end
                entry.amount = entry.amount + (gain.amount or 0)
                -- The holding the last change landed on is the one still true.
                if gain.total ~= nil then
                    entry.total = gain.total
                end
            end

            for _, gain in ipairs(summary.reputation or {}) do
                local entry = reputation[gain.faction]
                if not entry then
                    entry = { faction = gain.faction, amount = 0 }
                    reputation[gain.faction] = entry
                    reputationList[#reputationList + 1] = entry
                end
                entry.amount = entry.amount + (gain.amount or 0)
                -- Where the character stands is not summed: a standing is a position, and
                -- the latest segment that reported one is where they ended up.
                if gain.standing or gain.max then
                    entry.standing = gain.standing
                    entry.current = gain.current
                    entry.max = gain.max
                    entry.rank = gain.rank
                    entry.system = gain.system
                end
            end

            local gain = summary.experience
            if gain then
                experience = experience or { gained = 0, percent = 0, startLevel = gain.startLevel }
                experience.gained = experience.gained + (gain.gained or 0)
                experience.percent = experience.percent + (gain.percent or 0)
                experience.endLevel = gain.endLevel or experience.endLevel
            end
        end
    end

    for _, entry in ipairs(currencyList) do
        merged.currencyTotal = merged.currencyTotal + entry.amount
    end
    table.sort(currencyList, function(left, right)
        if left.name ~= right.name then
            return tostring(left.name) < tostring(right.name)
        end
        return tostring(left.id) < tostring(right.id)
    end)

    for _, entry in ipairs(reputationList) do
        merged.reputationTotal = merged.reputationTotal + entry.amount
    end
    table.sort(reputationList, function(left, right)
        return left.faction < right.faction
    end)

    merged.currencies = currencyList
    merged.reputation = reputationList
    merged.experience = experience
    merged.wallet = wallet
    return merged
end

---How long ago a segment ended, as it reads on the end of a title.
---
---formatAge answers "now" for anything inside the last minute, which is a fine staleness
---warning and a poor label: a segment that just closed sits one arrow away from the one
---being played, and "Deadmines · now" beside "Deadmines" is not a difference a player can
---see at a glance.
---@param seconds number
---@return string
local function ago(seconds)
    local age = ns.formatAge(seconds)
    return age == "now" and "just now" or age
end

---@param deps SegmentViewsDeps
---@return SegmentViews
function ns.newSegmentViews(deps)
    -- Where the arrows were left. Held as kind plus id rather than as a position, because
    -- the strip grows underneath it: a segment closing pushes every older one along, and an
    -- index would silently start pointing at a different segment than the player chose.
    local selection = { kind = "live", key = "live" }

    ---Every segment already finished that belongs to this evening, newest first.
    ---
    ---Walked backwards from the open segment: a record joins while it ended within the gap
    ---of the earliest start the session has reached so far, and the first one that did not
    ---ends the walk, because everything beyond it is older still. Comparing against the
    ---earliest start rather than the previous record's is what the app's forward pass does
    ---with its frontier, and for the same reason — two characters' segments can overlap, and
    ---a short one nested inside a long one must not look like a break in the evening.
    ---@return SegmentRecord[]
    local function history()
        local records = {}
        for index, record in ipairs(deps.segments()) do
            records[index] = record
        end
        table.sort(records, function(left, right)
            if (left.startedAt or 0) ~= (right.startedAt or 0) then
                return (left.startedAt or 0) > (right.startedAt or 0)
            end
            return (left.endedAt or 0) > (right.endedAt or 0)
        end)

        local earliest = deps.liveStart() or deps.now()
        local list = {}
        for _, record in ipairs(records) do
            if earliest - (record.endedAt or 0) > SESSION_GAP then
                break
            end
            list[#list + 1] = record
            earliest = math.min(earliest, record.startedAt or earliest)
        end
        return list
    end

    ---The strip, without the summaries: those are worked out for the one view that is
    ---actually going to be drawn. Adding up a whole session on every loot line, to draw a
    ---panel showing one segment, is work nobody asked for.
    ---@return table[] views, SegmentRecord[] finished
    local function build()
        local finished = history()
        local segments = #finished + 1
        local views = {
            {
                kind = "session",
                key = "session",
                title = "Session · " .. segments .. (segments == 1 and " segment" or " segments"),
            },
            {
                kind = "live",
                key = "live",
                title = deps.liveLocation() or "Current Segment",
            },
        }
        local now = deps.now()
        local playing = deps.character()
        for _, record in ipairs(finished) do
            -- An evening survives hopping alts, so the strip holds the alt's segments too —
            -- and one of those has to say whose it was, or it reads as somewhere this
            -- character has been. Only the name, because the realm is the same evening's.
            local who = record.character ~= playing
                and (tostring(record.character or ""):match("^([^-]+)") or record.character)
                or nil
            views[#views + 1] = {
                kind = "record",
                key = "record:" .. tostring(record.id),
                title = (who and who .. " — " or "")
                    .. (record.instance or "Unknown") .. " · " .. ago(now - (record.endedAt or now)),
                record = record,
            }
        end
        for index, view in ipairs(views) do
            view.index = index
            view.count = #views
        end
        return views, finished
    end

    ---@param finished SegmentRecord[]
    ---@param view table
    ---@return SegmentView
    local function materialise(finished, view)
        if view.kind == "record" then
            view.summary = view.record
        elseif view.kind == "live" then
            view.summary = deps.liveSummary()
        else
            -- Oldest first, and the open segment last, so the session's lists read forward
            -- in time and end on what is happening right now.
            local ordered = {}
            for index = #finished, 1, -1 do
                ordered[#ordered + 1] = finished[index]
            end
            ordered[#ordered + 1] = deps.liveSummary()
            view.summary = ns.mergeSegmentSummaries(ordered)
        end
        view.record = nil
        return view
    end

    ---The strip and where the selection sits on it. A selection that has gone — a segment
    ---pruned out of the log, or a character switch that emptied the session — falls back to
    ---the open segment, which is the one view that always exists.
    ---@return table[] views, integer index, SegmentRecord[] finished
    local function locate()
        local views, finished = build()
        for index, view in ipairs(views) do
            if view.key == selection.key then
                return views, index, finished
            end
        end
        selection = { kind = "live", key = "live" }
        return views, 2, finished
    end

    return {
        selected = function()
            local views, index, finished = locate()
            return materialise(finished, views[index])
        end,

        ---@param delta integer
        ---@return SegmentView
        move = function(delta)
            local views, index, finished = locate()
            local target = math.max(math.min(index + (delta or 0), #views), 1)
            local view = views[target]
            selection = { kind = view.kind, key = view.key }
            return materialise(finished, view)
        end,
    }
end
