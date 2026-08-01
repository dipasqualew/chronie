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

---@class CensusReportDeps
---@field domains CensusDomain[] The same list `ns.newCensus` was given, in the same order — which
---is walk order, cheapest first, and so the order these are worth reading in.
---@field state fun(name: string, character: string?): CensusState?
---@field running fun(): boolean
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

    return {
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
