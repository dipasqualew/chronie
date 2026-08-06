local _, ns = ...

---One thing the results panel can be pointed at: the session's running total, the segment
---being played right now, or one that already closed during this session.
---@class SegmentView
---@field kind string "session", "live" or "record".
---@field key string Identity of the view, stable while it is reachable.
---@field title string What the panel's header says while this view is on screen.
---@field label string What the picker calls it: whose segment it was and where, or "Session".
---@field detail string The metadata beside that label — when a segment happened, or how many
---segments the evening holds. Two runs of the same dungeon on the same character are the same
---label twice, and this is what tells them apart.
---@field summary SegmentSummary What to draw. A filed record is summary-shaped already,
---which is why one can be handed to the same panel a live tally is.
---@field current boolean Whether this is the view the panel is standing on, so the picker
---can tick the one already being looked at.

---Everything the panel can be pointed at, and which one it is standing on.
---
---Ordered the way the menu reads: the session total on top, set apart from the rest,
---and then the evening itself running forwards — the oldest segment first and the one
---being played last, because that is the order the evening happened in and the segment
---at the bottom of the list is the one the player is in right now. The panel opens on
---that last one, because it is what somebody glancing at a HUD is asking about; the
---picker is what reaches anything else.
---
---Where they are left is where they stay, with one exception: a segment opening pulls the
---panel forward onto it, the way a damage meter jumps to the pull that just started. A
---player parked on a segment that finished twenty minutes ago is looking at history, and
---history is not what a HUD is for once something new is happening. The session total is
---the exception to the exception — parking there is a deliberate "show me the evening", and
---the evening is still the evening after a loading screen.
---
---"This session" is the evening the desktop app draws, narrowed to whoever is playing: the
---segment being played, and every earlier one *of this character's* that chains back to it
---across gaps of no more than five minutes. The chaining rule lives in
---`apps/desktop/src/sessions.ts` as SESSION_GAP_SECONDS, and it is repeated here rather than
---invented afresh, because a panel that measured an evening one way while the app it feeds
---measured it another would be worse than either. It also means a reload does not fork the
---evening in half: the log survives one, so the chain walks straight back through it.
---
---The narrowing is where the two part company, and deliberately. The app is read afterwards,
---at a desk, where "what happened tonight" is a fair question across every character that was
---logged in. The panel is read mid-pull by somebody standing in a dungeon, and there the only
---evening that means anything is the one they can still add to — a row for the alt's raid
---offers a run they cannot get back to without logging out.
---@class SegmentViews
---@field selected fun(): SegmentView What the panel should be drawing.
---@field list fun(): SegmentView[] The whole list, in order, for a picker to draw. Named
---and dated but not added up: the menu wants to say what is on offer, not compute it.
---@field select fun(key: string): SegmentView Stand on the view with that key. An unknown
---key leaves the panel where it is, which is what a stale menu row asking for a segment
---that has since been pruned should do.

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
---warning and a poor label: a segment that just closed sits one row above the one being
---played, and "Deadmines · now" beside "Deadmines" is not a difference a player can see at
---a glance.
---@param seconds number
---@return string
local function ago(seconds)
    local age = ns.formatAge(seconds)
    return age == "now" and "just now" or age
end

---Whoever played a segment, as their name reads in front of the place.
---
---Only the first name: every segment on the list belongs to the same evening, so the realm
---is the same one over and over and is the half of "Name-Realm" that tells nothing apart.
---@param character string?
---@return string?
local function named(character)
    local short = tostring(character or ""):match("^([^-]+)")
    return short ~= "" and short or nil
end

---@param deps SegmentViewsDeps
---@return SegmentViews
function ns.newSegmentViews(deps)
    -- What was picked off the menu. Held as kind plus id rather than as a position, because
    -- the list grows underneath it: a segment closing pushes every later one along, and an
    -- index would silently start pointing at a different segment than the player chose.
    local selection = { kind = "live", key = "live" }

    ---Every segment this character already finished this evening, newest first.
    ---
    ---Walked backwards from the open segment: a record joins while it ended within the gap
    ---of the earliest start the session has reached so far, and the first one that did not
    ---ends the walk, because everything beyond it is older still. Comparing against the
    ---earliest start rather than the previous record's is what the app's forward pass does
    ---with its frontier, and for the same reason — two characters' segments can overlap, and
    ---a short one nested inside a long one must not look like a break in the evening.
    ---
    ---The walk crosses every character's segments and collects only this one's. Those are two
    ---separate questions and they get separate answers: how far back tonight reaches is a
    ---wall clock fact, so an hour on the alt in the middle of the evening is an hour this
    ---character was quiet for a reason and the run from before it is still tonight's; what
    ---the panel is *for* is the character being played, so that hour is not on the list.
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

        local playing = deps.character()
        local earliest = deps.liveStart() or deps.now()
        local list = {}
        for _, record in ipairs(records) do
            if earliest - (record.endedAt or 0) > SESSION_GAP then
                break
            end
            if record.character == playing then
                list[#list + 1] = record
            end
            earliest = math.min(earliest, record.startedAt or earliest)
        end
        return list
    end

    ---The list, without the summaries: those are worked out for the one view that is
    ---actually going to be drawn. Adding up a whole session on every loot line, to draw a
    ---panel showing one segment, is work nobody asked for.
    ---
    ---The session first, then the evening in the order it happened: `history()` hands its
    ---records over newest first, so they are walked backwards onto the end of the list, and
    ---the segment being played goes on last of all because it is the most recent of them.
    ---@return table[] views, SegmentRecord[] finished
    local function build()
        local finished = history()
        local segments = #finished + 1
        local now = deps.now()
        local counted = segments .. (segments == 1 and " segment" or " segments")
        local views = {
            {
                kind = "session",
                key = "session",
                title = "Session · " .. counted,
                label = "Session",
                detail = counted,
            },
        }
        for index = #finished, 1, -1 do
            local record = finished[index]
            -- Every row is this character's now, and the row for the segment being played has
            -- carried the name since before there was a list at all. Naming the finished ones
            -- too is what keeps them reading as one character's evening: a name in front of
            -- some rows and not others reads as a list of two different kinds of thing.
            local who = named(record.character)
            local ended = record.endedAt or now
            local label = (who and who .. " — " or "") .. (record.instance or "Unknown")
            views[#views + 1] = {
                kind = "record",
                key = "record:" .. tostring(record.id),
                title = label .. " · " .. ago(now - ended),
                label = label,
                detail = ago(now - ended),
                record = record,
            }
        end
        local playing = named(deps.character())
        local where = deps.liveLocation() or "Current Segment"
        views[#views + 1] = {
            kind = "live",
            key = "live",
            title = (playing and playing .. " — " or "") .. where,
            label = (playing and playing .. " — " or "") .. where,
            detail = "playing",
        }
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

    ---Pulls the panel onto the segment that just opened.
    ---
    ---Compared against the last start actually seen rather than the last one looked for, so
    ---the gap between one segment closing and the next opening — a loading screen, where
    ---there is no open segment at all — is not mistaken for a change of its own. The first
    ---look only remembers: there is nothing to have moved on from yet.
    local lastStart
    local function follow()
        local start = deps.liveStart()
        if start and lastStart and start ~= lastStart and selection.kind ~= "session" then
            selection = { kind = "live", key = "live" }
        end
        lastStart = start or lastStart
    end

    ---The list and where the selection sits in it. A selection that has gone — a segment
    ---pruned out of the log, or a character switch that emptied the session — falls back to
    ---the open segment, which is the one view that always exists and is always last.
    ---@return table[] views, integer index, SegmentRecord[] finished
    local function locate()
        follow()
        local views, finished = build()
        for index, view in ipairs(views) do
            if view.key == selection.key then
                return views, index, finished
            end
        end
        selection = { kind = "live", key = "live" }
        return views, #views, finished
    end

    return {
        selected = function()
            local views, index, finished = locate()
            return materialise(finished, views[index])
        end,

        ---Everything on offer, for a picker to draw. Deliberately not materialised: a menu
        ---of five segments would otherwise add the whole evening up five times over to
        ---print five names.
        ---@return SegmentView[]
        list = function()
            local views, index = locate()
            for position, view in ipairs(views) do
                view.record = nil
                view.current = position == index
            end
            return views
        end,

        ---@param key string
        ---@return SegmentView
        select = function(key)
            local views, index, finished = locate()
            for position, view in ipairs(views) do
                if view.key == key then
                    index = position
                end
            end
            local view = views[index]
            selection = { kind = view.kind, key = view.key }
            return materialise(finished, view)
        end,
    }
end
