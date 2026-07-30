local _, ns = ...

---What the account holds of one thing, as one row of a census.
---
---`seen` is when the walk last looked at this id, and it is what makes a finished pass able to
---drop what is no longer held: everything a completed pass did not touch is older than the
---pass that just ran. Every other field belongs to the domain that wrote it.
---@class CensusEntry
---@field seen integer Epoch seconds.

---One domain's standing: what is held, and how much of a claim that is.
---@class CensusState
---@field entries table<integer, CensusEntry> Keyed by the client's own id for the thing.
---@field held integer How many entries there are, kept beside them so an audit is a comparison
---rather than a walk.
---@field complete boolean Whether `entries` is the whole of what the account holds. **This is
---the only field that licenses a reader to treat an absence as a removal.**
---@field revision integer Bumped every time a pass finishes. A reader that has already seen
---this revision has already seen these entries.
---@field startedAt integer? When the pass that produced this began.
---@field completedAt integer? When it finished; nil while one is running or was abandoned.
---@field by string? Which character walked it, for an account-wide domain.
---@field build string? The client build it was walked on. A patch invalidates a census, and
---this is what says which one it was taken against.
---@field counted integer? What the client's own counter said at the moment the pass finished.
---Nil for a domain whose client offers no counter.

---A kind of thing a census can be taken of.
---
---A domain is three seams and a name, and every one of them is the client's own answer rather
---than anything worked out here. That is what makes adding the next domain an adapter rather
---than a change to this file.
---@class CensusDomain
---@field name string What the domain is called in the file. Stable: it is a key readers join on.
---@field scope "account"|"character" Which of the two a reading belongs to. An account domain is
---one every character reports the same answer for — mounts, appearances, achievements — and is
---kept once. A character domain is kept per `Name-Realm`, the way `HoldingsStore` keeps holdings.
---@field list fun(): any[]? Every position the walk should visit, in whatever the domain finds
---cheapest to enumerate. Nil — not an empty list — when this client build will not answer at
---all, which leaves the last census standing rather than replacing it with an empty one.
---
---A position is not always an id, and that is the point. The mount journal hands over its ids
---outright, so a mount's position *is* its id; the achievement tree has no id list at all and
---is walked by category and offset, so an achievement's position is an index into a plan the
---domain drew up. What the two have in common is that building the list is arithmetic and a
---handful of calls, never the walk itself — the walk is what the budget below exists to spread
---out, and a `list` that did it would freeze the client for exactly as long as this avoids.
---@field read fun(position: any): (integer?, table?) The id at that position, and what the
---account holds of it — or nothing for a position that holds nothing. **Only what is held is
---written down**: the catalogue of what exists lives in the game's own tables, which the desktop
---reads, so a census that also recorded every absence would be several times the size and say
---nothing more.
---@field count fun(): integer? The client's own count of what is held, in one call. Nil for a
---domain whose client offers none. See `audit`.

---@class Census
---@field audit fun(): string[] Which domains look wrong without walking them.
---@field start fun(names: string[]?): string[] Begin a pass over these domains, or over every
---domain that `audit` distrusts. Returns what it will walk.
---@field step fun(): boolean One slice of work. True while there is more to do.
---@field run fun(names: string[]?) Start a pass and drive it to the end, a slice per frame.
---@field state fun(name: string, character: string?): CensusState? What a domain last said.
---@field running fun(): boolean

---@class CensusDeps
---@field db table SavedVariables root; mutated in place so the client persists it.
---@field now fun(): integer
---@field after fun(seconds: number, callback: fun()) The client's own scheduler. What makes a
---census something the player can play through rather than a freeze.
---@field character fun(): string "Name-Realm" of whoever is logged in.
---@field build fun(): string? Which client build this is.
---@field domains CensusDomain[]
---@field budget integer? How many ids one slice asks about. Default `DEFAULT_BUDGET`.

---The account-level schema version, which is **not** `segmentSchemaVersion`.
---
---The two feeds evolve on their own timetables and share nothing but a file. `docs/saved-variables.md`
---already says the segment version belongs only to the segment feed; this is the other half of
---that sentence, and keeping them apart is what stops a new domain here forcing a version bump
---that makes every reader re-import every segment.
local VERSION = 1

---How many ids one slice asks the client about.
---
---A slice runs inside one frame and nothing else runs while it does, so this is a frame-budget
---rather than a batch size. Two hundred `GetMountInfoByID` calls are well under a millisecond;
---the number is small enough that a domain whose reads are far more expensive than that still
---cannot drop a frame, and large enough that thirteen thousand achievements finish in about a
---minute of ordinary play.
local DEFAULT_BUDGET = 200

---How long between slices. Zero means "next frame", which is what `C_Timer.After(0, ...)` does.
---
---Next frame rather than a longer wait, because the whole pass is bounded by the budget above
---and a census that took ten minutes would be one that a logout reliably interrupts.
local SLICE_DELAY = 0

---@param deps CensusDeps
---@return Census
function ns.newCensus(deps)
    local db = deps.db
    local now = deps.now
    local budget = deps.budget or DEFAULT_BUDGET

    ---@type table<string, CensusDomain>
    local domains = {}
    for _, domain in ipairs(deps.domains or {}) do
        if type(domain) == "table" and type(domain.name) == "string" and domain.name ~= "" then
            domains[domain.name] = domain
        end
    end

    ---The root of the census, made on first use and then mutated in place, because the client
    ---only writes out what is still reachable from the saved table at logout.
    local function root()
        db.census = db.census or {}
        local census = db.census
        census.version = VERSION
        census.account = census.account or {}
        census.characters = census.characters or {}
        return census
    end

    ---Where one domain's state is kept, which is what `scope` decides.
    ---
    ---An account domain is kept once because every character answers the same; a character
    ---domain is kept under `Name-Realm` for the reason `HoldingsStore` does the same — two alts
    ---with a wallet each must not look like one alt whose wallet keeps being replaced.
    ---@param domain CensusDomain
    ---@param character string?
    ---@return table
    local function slotFor(domain, character)
        local census = root()
        if domain.scope == "character" then
            local key = character or deps.character()
            census.characters[key] = census.characters[key] or {}
            return census.characters[key]
        end
        return census.account
    end

    ---@param domain CensusDomain
    ---@param character string?
    ---@return CensusState
    local function stateOf(domain, character)
        local slot = slotFor(domain, character)
        local state = slot[domain.name]
        if type(state) ~= "table" then
            state = { entries = {}, held = 0, complete = false, revision = 0 }
            slot[domain.name] = state
        end
        state.entries = type(state.entries) == "table" and state.entries or {}
        state.held = type(state.held) == "number" and state.held or 0
        state.revision = type(state.revision) == "number" and state.revision or 0
        return state
    end

    ---The pass in flight: which domain, the ids it is walking, and how far it got.
    ---
    ---Deliberately not persisted. A pass interrupted by a logout is resumed by being run again
    ---rather than by being continued, because the id list it was walking is the client's answer
    ---from a session that has ended and may not be the same answer next time. What *is* kept is
    ---everything the pass observed — those are true whether or not the pass ever finished — and
    ---the `complete` flag it demoted, which is what stops a reader mistaking half a pass for a
    ---whole one.
    local pass

    ---What the domain says it holds, against what we have written down.
    ---
    ---This is the whole reason a census does not need to be re-run on a timer. Every domain here
    ---is already fed by an event while the addon is loaded — `NEW_MOUNT_ADDED`,
    ---`ACHIEVEMENT_EARNED` and the rest — so between two passes the record stays current by
    ---itself. What the events cannot cover is what happened while nothing was listening: before
    ---Chronie was installed, on another machine's install, in a session a crash took with it, or
    ---across a patch that changed what exists. Every one of those shows up as a count that does
    ---not match, and the client hands the count over for a single call.
    ---
    ---A domain whose client offers no counter is never distrusted by this, because there is
    ---nothing to distrust it with — such a domain is walked only when something else asks.
    ---Three things make a census stale, and none of them is the passing of time.
    ---
    ---**It was never whole.** No pass has ever finished, so there is nothing to trust.
    ---
    ---**The game changed underneath it.** A patch adds mounts, retires achievements and moves
    ---appearances between categories, and a census taken on the build before it is a census of a
    ---different game. The build string is exact, so this costs nothing and never fires spuriously.
    ---
    ---**The client's own count disagrees.** Only for a domain whose client offers a counter whose
    ---meaning is settled — see `ns.censusDomains`, where each one is wired or deliberately left
    ---nil. This is the case that catches what the events cannot: a session a crash took with it,
    ---an evening played on another machine's install, or anything at all that happened before
    ---Chronie was here.
    ---
    ---A domain that is none of those three needs no pass, because between passes the record keeps
    ---itself: every domain in here is also fed by a client event — `NEW_MOUNT_ADDED`,
    ---`ACHIEVEMENT_EARNED` and the rest — for as long as the addon is loaded.
    ---@return string[] The domains whose stored census cannot be trusted as it stands.
    local function audit()
        local build = deps.build and deps.build() or nil
        local stale = {}
        for name, domain in pairs(domains) do
            local state = stateOf(domain)
            local counter = domain.count
            local counted = counter and counter() or nil
            local wrongCount = type(counted) == "number" and state.held ~= counted
            if not state.complete or (build and state.build ~= build) or wrongCount then
                stale[#stale + 1] = name
            end
        end
        table.sort(stale)
        return stale
    end

    ---Everything a finished pass did not touch, taken back out again.
    ---
    ---A pass asks about every id the client named, and writes down every one that is held. An
    ---entry left with a `seen` from before the pass began is therefore one of two things: an id
    ---the client no longer names, or one it no longer says is held. Both are gone, and this is
    ---the only place a census ever removes anything.
    ---@param state CensusState
    ---@param startedAt integer
    local function prune(state, startedAt)
        local held = 0
        for id, entry in pairs(state.entries) do
            if type(entry) ~= "table" or (entry.seen or 0) < startedAt then
                state.entries[id] = nil
            else
                held = held + 1
            end
        end
        state.held = held
    end

    ---@param names string[]?
    ---@return string[]
    local function start(names)
        local wanted = names or audit()
        local queue = {}
        for _, name in ipairs(wanted) do
            if domains[name] then
                queue[#queue + 1] = domains[name]
            end
        end
        if #queue == 0 then
            pass = nil
            return {}
        end

        pass = { queue = queue, at = 0, ids = nil, index = 0, startedAt = now() }
        local walking = {}
        for _, domain in ipairs(queue) do
            walking[#walking + 1] = domain.name
        end
        return walking
    end

    ---Takes up the next domain in the queue, or reports that there is none.
    ---@return boolean
    local function advance()
        pass.at = pass.at + 1
        local domain = pass.queue[pass.at]
        if not domain then
            pass = nil
            return false
        end

        local ids = domain.list()
        if type(ids) ~= "table" then
            -- A client build that will not answer for this domain at all. The last census
            -- stands: replacing it with an empty one would tell a reader the account had lost
            -- everything, when what actually happened is that nobody could be asked.
            return advance()
        end

        local state = stateOf(domain)
        -- Demoted the moment the walk begins, and not restored until it ends. Between those two
        -- the entries are half of one reading and half of another, which is a position the
        -- account was never in — so for as long as that is true the file says so out loud.
        state.complete = false
        state.startedAt = pass.startedAt
        state.completedAt = nil
        state.build = deps.build and deps.build() or nil
        if domain.scope == "account" then
            state.by = deps.character()
        end

        pass.domain = domain
        pass.state = state
        pass.ids = ids
        pass.index = 0
        return true
    end

    ---Finishes the domain in hand: prunes what it did not see, and makes the claim.
    local function finish()
        local state, domain = pass.state, pass.domain
        prune(state, pass.startedAt)
        state.complete = true
        state.completedAt = now()
        state.revision = state.revision + 1
        local counter = domain.count
        state.counted = counter and counter() or nil
    end

    ---@return boolean
    local function step()
        if not pass then
            return false
        end
        if not pass.ids and not advance() then
            return false
        end

        local seen = now()
        local last = math.min(pass.index + budget, #pass.ids)
        for index = pass.index + 1, last do
            local position = pass.ids[index]
            if position ~= nil then
                local id, held = pass.domain.read(position)
                -- Both or neither. A domain that names an id but says nothing about it has
                -- reported an absence, and an absence is written down by not writing anything.
                if type(id) == "number" and type(held) == "table" then
                    held.seen = seen
                    pass.state.entries[id] = held
                end
            end
        end
        pass.index = last

        if pass.index < #pass.ids then
            return true
        end

        finish()
        pass.ids = nil
        -- False here is the queue running out, which `advance` reports by clearing the pass —
        -- so there is never a "finished" state to distinguish from "nothing in hand".
        return advance()
    end

    ---@param names string[]?
    local function run(names)
        -- One pass at a time. A second chain of slices over the same domains would walk the
        -- same ids twice and, far worse, could finish the first chain's domain on the second
        -- chain's `startedAt` — pruning away everything the first chain had already written.
        if pass or #start(names) == 0 then
            return
        end
        local function slice()
            if step() then
                deps.after(SLICE_DELAY, slice)
            end
        end
        slice()
    end

    return {
        audit = audit,
        start = start,
        step = step,
        run = run,
        running = function()
            return pass ~= nil
        end,
        ---@param name string
        ---@param character string?
        ---@return CensusState?
        state = function(name, character)
            local domain = domains[name]
            if not domain then
                return nil
            end
            return stateOf(domain, character)
        end,
    }
end
