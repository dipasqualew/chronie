local _, ns = ...

---What the census knows about itself, as lines somebody can read in chat.
---
---The census runs in silence otherwise. It is provoked at a loading screen, spread a slice per
---frame and written out at logout, and until this there was no way at all to see whether a domain
---was whole, when it was last walked, or what the client's own counter made of it — the only
---route in was `/dump ChronieDB.census` and a lot of scrolling.
---
---**`held` and `counted` go on the same line, and that is the point of the line.** They are the
---two numbers `Census.lua`'s audit compares to decide whether a reading is still true, and seeing
---them beside each other is what turns "the achievement counter may or may not include guild
---achievements" from a question needing a debugger into one a person answers by looking — see
---`docs/account-census.md`, which asks for exactly that comparison against a running client.
---@class CensusReport
---@field lines fun(): string[]
---@field section fun(): DetailSection The same reading as a block of the segments window, with a
---row per domain and a bar under the one being walked. See `section`.

---@class CensusReportDeps
---@field domains CensusDomain[] The same list `ns.newCensus` was given, in the same order — which
---is walk order and so the order these are worth reading in.
---@field state fun(name: string, character: string?): CensusState?
---@field running fun(): boolean
---@field progress fun(): CensusProgress? How far the walk in flight has got, or nil when none is.
---@field now fun(): integer
---@field character fun(): string "Name-Realm" of whoever is logged in.

---How a reading describes itself, which is the first thing on every line.
---
---Four states rather than a flag, because `complete` alone cannot tell the three ways of not
---being complete apart, and they mean different things to a reader: one is waiting for a walk,
---one is waiting for the rest of a walk, and one will never be whole however long it is left.
---@param domain CensusDomain
---@param state CensusState
---@return string
local function standing(domain, state)
    -- Never touched at all. A pass that began sets `startedAt` and leaves it set, so a state
    -- carrying neither that nor a revision is one nothing has ever walked — as opposed to one a
    -- logout cut short, which looks identical in `complete` and is not the same news.
    if state.revision == 0 and not state.startedAt then
        return "never walked"
    end
    if state.complete then
        return "whole"
    end
    -- A domain the client will only answer part of, whoever asks. It reads as "part of an answer"
    -- forever rather than as a failure, because it is not one: the account's wardrobe is the union
    -- of what its characters can each see, built up as they are played.
    if domain.partial then
        return "part of an answer"
    end
    return "cut short"
end

---@param state CensusState
---@param now integer
---@return string
local function age(state, now)
    local at = state.completedAt or state.startedAt
    if not at then
        return "never"
    end
    return ns.formatAge(now - at)
end

---The columns of the block the segments window draws.
---
---Six of them against the segment table's nine, and they add up to the same width so that the two
---blocks read as one window rather than as two tables that happen to be stacked.
local COLUMNS = {
    { title = "Collection", width = 148 },
    { title = "Reading", width = 150 },
    { title = "Walking", width = 132 },
    { title = "Held", width = 92 },
    { title = "Counted", width = 84 },
    { title = "Last walked", width = 110 },
}

local ROW_COLOR = { 1, 1, 1 }
-- The domain being walked right now, in the gold every other table here uses for the line the
-- eye should land on.
local WALKING_COLOR = { 1, 0.82, 0 }

---How far into the domain being walked, as something with a shape rather than two numbers.
---
---A player watching this wants "is it moving and how much is left", which a bar answers at a
---glance and "1,240 / 4,000" does not. The percentage rides beside it because the bar alone
---cannot say whether a walk is nearly done or has barely begun once it is past halfway.
---@param progress CensusProgress
---@return string
local function bar(progress)
    local total = progress.total or 0
    local share = total > 0 and math.min(math.max(progress.done / total, 0), 1) or 0
    local filled = math.floor(share * 10 + 0.5)
    return string.rep("|", filled) .. string.rep("·", 10 - filled)
        .. string.format(" %d%%", math.floor(share * 100))
end

---@param deps CensusReportDeps
---@return CensusReport
function ns.newCensusReport(deps)
    local domains = deps.domains or {}

    ---One domain's line: what it claims, what it holds, and what to hold that against.
    ---@param domain CensusDomain
    ---@return string
    local function line(domain)
        local character = domain.scope == "character" and deps.character() or nil
        local state = deps.state(domain.name, character)
        local name = character and (domain.name .. " (" .. character .. ")") or domain.name
        if not state then
            -- A domain the census was never given. Only reachable if the two lists disagree,
            -- which they cannot here — but a nil indexed a moment later would take the whole
            -- command down, and this command exists to be run when something is already wrong.
            return name .. " — nothing recorded"
        end

        local parts = { standing(domain, state) }
        parts[#parts + 1] = state.held .. " held"
        -- Only where the client offers a counter. Its absence is a fact about the domain rather
        -- than about this reading — see `ns.mountCensus`, which does without on purpose — so a
        -- line saying "no counter" would repeat the same non-news at every login.
        if type(state.counted) == "number" then
            parts[#parts + 1] = state.counted .. " counted"
        end
        if state.build then
            parts[#parts + 1] = "build " .. state.build
        end
        if state.by then
            parts[#parts + 1] = "by " .. state.by
        end
        parts[#parts + 1] = age(state, deps.now())
        return name .. " — " .. table.concat(parts, ", ")
    end

    ---What one domain says, as a row of the segments window.
    ---@param domain CensusDomain
    ---@param progress CensusProgress?
    ---@return DetailRow
    local function rowOf(domain, progress)
        local character = domain.scope == "character" and deps.character() or nil
        local state = deps.state(domain.name, character)
        local walking = progress and progress.domain == domain.name or false
        if not state then
            return { cells = { domain.name, "nothing recorded", "", "", "", "" }, color = ROW_COLOR }
        end
        return {
            cells = {
                domain.name,
                standing(domain, state),
                -- Only on the one row it is true of. A column of empty cells under a bar is what
                -- says which domain the client is actually busy with.
                walking and bar(progress) or "",
                tostring(state.held),
                -- Blank rather than a nought where the client offers no counter: its absence is a
                -- fact about the domain — see `ns.mountCensus`, which does without on purpose —
                -- and a nought there would read as "the client says you have none".
                type(state.counted) == "number" and tostring(state.counted) or "",
                age(state, deps.now()),
            },
            color = walking and WALKING_COLOR or ROW_COLOR,
        }
    end

    return {
        ---The whole reading as a block of the segments window.
        ---
        ---**The census used to run in complete silence, and that is half of why it was switched
        ---off.** It is provoked at a loading screen, spread over slices and written out at logout;
        ---there was no way at all to see that a walk was happening, let alone how far it had got,
        ---so a client that felt worse for a minute after every zone had nothing at all to point
        ---at. `/chronie census` broke the first half of that silence and is still the place the
        ---two numbers an audit compares are read side by side. This is the other half: the walk
        ---while it is running, somewhere a player is already looking.
        ---@return DetailSection
        section = function()
            local progress = deps.progress and deps.progress() or nil
            local rows = {}
            for _, domain in ipairs(domains) do
                rows[#rows + 1] = rowOf(domain, progress)
            end

            local heading = "Collections"
            if progress then
                -- Which domain of how many, because the bar on the row below only ever describes
                -- the one in hand — and a player watching a pass wants to know there are five
                -- more behind it.
                heading = string.format("Collections — walking %s, %d of %d",
                    progress.domain, progress.at, progress.of)
            end
            return {
                heading = heading,
                columns = COLUMNS,
                rows = rows,
                empty = "This client build answers for none of them.",
            }
        end,

        ---@return string[]
        lines = function()
            local whole = 0
            local body = {}
            for _, domain in ipairs(domains) do
                local character = domain.scope == "character" and deps.character() or nil
                local state = deps.state(domain.name, character)
                if state and state.complete then
                    whole = whole + 1
                end
                body[#body + 1] = line(domain)
            end

            local running = deps.running()
            local head = string.format("census — %d of %d domains whole", whole, #domains)
            -- Said first, because it changes what every line under it means: a domain being
            -- walked right now has had its completeness demoted for the duration, and a reader
            -- who did not know that would read a walk in progress as a walk that failed.
            head = head .. (running and ", and one is walking now." or ".")

            local out = { head }
            for _, one in ipairs(body) do
                out[#out + 1] = one
            end
            -- The way out, offered only when there is one. `census.run` refuses to begin a second
            -- pass while one is in flight, so pointing at it mid-walk would be pointing at
            -- something that silently does nothing.
            if not running then
                out[#out + 1] = "/chronie census refresh walks every one of them again."
            end
            return out
        end,
    }
end
