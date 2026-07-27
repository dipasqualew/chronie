local _, ns = ...

---Everything one character is holding right now, in the shape `HoldingsStore.record`
---already takes off a finished segment.
---@class HeldSweep
---@field currencies table[] `{ id, name, total, accountWide }` per currency the pane lists.
---@field reputation table[] `{ faction, standing, current, max, rank, system }` per faction.

---Reads a currency the pane is showing, or nothing when the row is not one.
---
---A header — the collapsible group titles the Currency tab draws between the currencies —
---comes back through the same call as a currency does, with `isHeader` set and a
---`currencyID` of 0. Both are checked rather than either: the flag is what the client
---means by it, and the id is what the store is keyed on, so a row without one is unusable
---even if the client never called it a header.
---
---`isAccountWide` is what says the quantity beside it is the **warband's** pot rather than
---this character's share of it — the client hands every character on the account the same
---number through this same call, so nothing downstream can tell the two apart by looking at
---the number. It is the client's own distinction rather than one invented here: build
---12.0.5.67823 carries the field on the row and exposes
---`C_CurrencyInfo.IsAccountWideCurrency(currencyID)` beside it, and keeps
---`isAccountTransferable` / `IsAccountTransferableCurrency` as a separate pair for the
---crest-like currencies that stay per-character but can be moved between them at a cost.
---Those are genuinely each character's own and are summed like anything else.
---@param row table?
---@return table? `{ id, name, total, accountWide }`
local function currencyHolding(row)
    if type(row) ~= "table" or row.isHeader then
        return nil
    end
    local id = row.currencyID
    if type(id) ~= "number" or id <= 0 or type(row.quantity) ~= "number" then
        return nil
    end
    -- The balance as it stands, zero included. That is the whole difference between walking
    -- and watching: a character that has spent everything it had must be able to say so, or
    -- the account total goes on counting what it was last seen with.
    --
    -- The flag is reported as a real boolean rather than only when it is set, because a walk
    -- reads it off the same row it reads the quantity off and so is a complete answer: a
    -- currency that stops being shared stops being shared here at the next zoning-in. A
    -- client build old enough to have no field at all reads as false, which is the truth on
    -- a build with no warband currencies to be wrong about.
    return { id = id, name = row.name, total = row.quantity, accountWide = row.isAccountWide == true }
end

---Walks the character's currency pane and reports what each row says it is holding.
---@param currency table? The client's `C_CurrencyInfo`.
---@return table[]
local function readCurrencies(currency)
    local size = ns.callable(currency, "GetCurrencyListSize")
    local info = ns.callable(currency, "GetCurrencyListInfo")
    if not size or not info then
        return {}
    end

    local held = {}
    for index = 1, size() or 0 do
        local holding = currencyHolding(info(index))
        if holding then
            held[#held + 1] = holding
        end
    end
    return held
end

---Walks the character's reputation pane and reduces every faction on it to the same bar a
---gain is reduced to.
---
---Headers are told apart differently here than in the currency pane, and the difference
---matters: a reputation header carries a faction id of its own — the expansion title
---"Midnight" reads 2698 on build 12.0.5.67823 — so an id cannot say whether a row is a
---group or a standing. `isHeaderWithRep` is what does: a header that is also a faction in
---its own right, the way a guild's row is, is kept.
---@param clients table? As `ns.readFactionStanding` takes them.
---@return table[]
local function readStandings(clients)
    local reputation = (clients or {}).reputation
    local count = ns.callable(reputation, "GetNumFactions")
    local byIndex = ns.callable(reputation, "GetFactionDataByIndex")
    if not count or not byIndex then
        return {}
    end

    local standings = {}
    for index = 1, count() or 0 do
        local data = byIndex(index)
        if type(data) == "table" and type(data.name) == "string" and data.name ~= ""
            and (not data.isHeader or data.isHeaderWithRep) then
            -- Through the same reduction a gain goes through, so that the rank and the
            -- ladder that make two characters' standings comparable travel with it.
            --
            -- A row the client answers for with neither a name nor a rank is left out. It
            -- is a standing in nothing but shape: it can never be crowned the account's
            -- best, because there is no ladder to crown it on, and it would draw as a
            -- nameless full bar. The store refuses it on the same terms; refusing it here
            -- as well is what keeps this the list of factions the character has a standing
            -- with rather than the list of rows the pane drew.
            local state = ns.readFactionStanding(clients, data)
            if state and (state.standing or state.rank) then
                standings[#standings + 1] = {
                    faction = data.name,
                    standing = state.standing,
                    current = state.current,
                    max = state.max,
                    rank = state.rank,
                    system = state.system,
                }
            end
        end
    end
    return standings
end

---Everything the character is holding, read off the client's own panes rather than out of
---what the addon happened to watch it earn.
---
---`HoldingsStore` is fed from finished segments, and a segment only ever knows about a
---currency the client announced a change to or a faction it announced a gain with. That
---makes a fresh install's account totals a set of holes that fill in one currency per
---character over weeks of play: an alt sitting on 5,000 Flightstones contributes nothing
---to the account's Flightstones until the next time it earns one. Walking the two panes at
---login and at logout is what closes them, and it needs nothing downstream to change,
---because what comes back is the same shape a segment summary hands over.
---
---**What it still cannot see.** Both walks read the pane as the player has it set up, and
---neither touches those settings. A currency under a collapsed group, a reputation under a
---collapsed expansion header, and — the big one — every legacy reputation, which the pane
---hides by default, are all invisible to the walk. Build 12.0.5.67823 has the calls that
---would open them up (`C_CurrencyInfo.ExpandCurrencyList`,
---`C_Reputation.ExpandAllFactionHeaders`, `C_Reputation.SetLegacyReputationsShown`), but
---every one of them rearranges a pane the player arranged, and doing that from a logout
---handler where nothing can be put back is a worse trade than a hole. So the walk reads
---what is on show, and what is hidden stays as incomplete as it was before.
---@param clients table? `{ currency = C_CurrencyInfo, reputation = C_Reputation,
---majorFaction = C_MajorFactionData, gossip = C_GossipInfo,
---reactionLabel = fun(reaction: integer): string? }`
---@return HeldSweep
function ns.readHoldings(clients)
    clients = clients or {}
    return {
        currencies = readCurrencies(clients.currency),
        reputation = readStandings(clients),
    }
end
