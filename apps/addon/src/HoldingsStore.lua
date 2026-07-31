local _, ns = ...

---What one character was last seen holding of one currency.
---@class CurrencyHolding
---@field character string "Name-Realm".
---@field name string What the client called the currency when it last said.
---@field total integer The holding itself.
---@field accountWide boolean? True when this is the warband's one pot rather than this
---character's own holding, so every character reads the same number. Absent rather than
---false, because a key per currency per character saying "no" costs a saved file to say
---nothing.
---@field at integer When it was read, in epoch seconds.

---What one character was last seen standing at with one faction.
---@class StandingHolding : FactionStanding
---@field character string "Name-Realm".
---@field at integer When it was read, in epoch seconds.

---Where the account as a whole stands with one faction.
---@class StandingRollup
---@field id integer The faction's own id, which is what the snapshot is keyed on.
---@field faction string What the client last called it, for something to draw.
---@field accountWide boolean True when the standing is the warband's rather than each
---character's own, so the several rows are one standing reported several times.
---@field best StandingHolding The furthest along any character has been seen.
---@field characters StandingHolding[] Sorted by character.

---Every character's holding of one currency, and what they come to across the account.
---@class CurrencyRollup
---@field id integer
---@field name string
---@field total integer Summed across every character that has ever reported holding any —
---or, when `accountWide`, the freshest single reading of the one pot they all share.
---@field accountWide boolean True when the account holds one shared pot of this rather than
---a holding per character.
---@field characters CurrencyHolding[] Sorted by character, so the list never reshuffles.
---@field oldest integer The least recently read of the holdings the total is built from.

---What one character was last seen carrying in its own wallet.
---@class GoldHolding
---@field character string "Name-Realm".
---@field total integer Copper.
---@field at integer When it was read, in epoch seconds.

---What the account is worth: every wallet, and the one pot they all share.
---@class GoldRollup
---@field characters GoldHolding[] Sorted by character.
---@field wallets integer Summed across every character that has reported one.
---@field warband integer? The warband bank's own gold; nil when it has never been read.
---@field warbandAt integer? When that was read.
---@field total integer `wallets` plus `warband`.
---@field oldest integer The least recently read of the numbers the total is built from.

---@class HoldingsStore
---@field record fun(character: string, summary: table)
---@field recordWarband fun(amount: integer?)
---@field currency fun(currencyID: integer): CurrencyRollup?
---@field standing fun(factionID: integer): StandingRollup?
---@field gold fun(): GoldRollup?

---@class HoldingsStoreDeps
---@field db table SavedVariables table; mutated in place so the client persists it.
---@field now fun(): integer

---What every character on the account was last seen holding, so a number can be read as an
---account's rather than one character's.
---
---SavedVariables are the account's but the client only ever hands us the character in front
---of it, so this is the same trick `LockoutStore` plays with lockouts: each character writes
---down what it saw under its own `Name-Realm` key, and reading them all back is what makes
---"how much of this do I have, everywhere" answerable at all.
---
---Two things follow from that and are worth being plain about, because the UI has to be
---honest about both:
---
---* Every entry is **last known**, not live. A character that has not been logged into since
---  it spent the currency reports what it held when it was last played, and the entry's `at`
---  is what says how far in the past that was.
---* It only holds what the character was **there for**. A segment reports a currency as part
---  of a change to it and a faction as part of a gain, so on segments alone a currency this
---  character has never gained while the addon was loaded would not be in here — a hole in
---  the account total rather than a zero. `ns.readHoldings` is what closes that: it walks
---  the client's own currency and reputation panes at every zoning-in and again at logout
---  and hands the lot to `record`, which is why the same call takes both. What it still
---  cannot reach is what those panes are not showing — a collapsed group, and every legacy
---  reputation, which the pane hides by default. `ns.currencyCensus` and
---  `ns.reputationCensus` are what reach those, by id and with no pane involved; they are
---  kept in `db.census` rather than folded in here, because a census is a complete
---  occasional reading and this is a shallow live one.
---
---Gold sits outside both of those. `GetMoney` answers outright rather than only as part of a
---change, so a wallet is read whole at every segment close — but only at a close that files,
---so a character that logs in, wanders and logs out has still never reported one. The warband
---bank is kept beside the wallets rather than inside them: every character reads the same
---pot, so filing it per character would add it to the account's worth once per alt.
---
---A warband-wide currency is that pot under another name, and it is the one thing in here
---that cannot be kept outside the snapshots the way the bank's gold is — which currencies
---are shared is a fact about the currency and only the client knows it, so the flag rides in
---on the reading and `currency` is where it is spent.
function ns.newHoldingsStore(deps)
    local db = deps.db
    local now = deps.now

    db.holdings = db.holdings or {}

    ---@param character string
    ---@return table
    local function entryFor(character)
        local entry = db.holdings[character] or {}
        entry.currencies = entry.currencies or {}
        entry.factions = entry.factions or {}
        db.holdings[character] = entry
        return entry
    end

    ---Which ladder a faction's standings are to be judged on: the one most of the account's
    ---characters were read off.
    ---
    ---Rank only means anything against the same ladder. A client build that could not reach
    ---the friendship API falls back to the reaction ladder, whose ranks run 1 to 8 against a
    ---friendship's several thousand, and comparing the two would hand the crown to whichever
    ---ladder counts higher rather than to whichever character is further along. So the odd
    ---reading out is set aside rather than ranked, and a tie is broken by name so that which
    ---ladder wins never depends on the order a Lua table happened to be walked in.
    ---@param rows StandingHolding[]
    ---@return string?
    local function ladderOf(rows)
        local counts = {}
        for _, row in ipairs(rows) do
            if row.rank and row.system then
                counts[row.system] = (counts[row.system] or 0) + 1
            end
        end

        local winner, best = nil, 0
        for system, count in pairs(counts) do
            if count > best or (count == best and winner and system < winner) then
                winner, best = system, count
            end
        end
        return winner
    end

    ---Which of two observations on the same ladder is further along. Rank ties break on
    ---progress into the level.
    ---@param challenger StandingHolding
    ---@param incumbent StandingHolding?
    ---@return boolean
    local function isFurther(challenger, incumbent)
        if not incumbent then
            return true
        end
        if challenger.rank ~= incumbent.rank then
            return challenger.rank > incumbent.rank
        end
        if (challenger.current or 0) ~= (incumbent.current or 0) then
            return (challenger.current or 0) > (incumbent.current or 0)
        end
        return challenger.character < incumbent.character
    end

    return {
        ---Folds what a finished segment saw into this character's snapshot.
        ---
        ---Only what the client actually said is written. A gain the client answered with no
        ---holding leaves the previous holding standing rather than overwriting it with a
        ---nil — the last number we had is a better answer than none — and the same goes for
        ---a faction the client would not place.
        ---@param character string "Name-Realm".
        ---@param summary table A SegmentSummary.
        record = function(character, summary)
            if type(character) ~= "string" or character == "" or type(summary) ~= "table" then
                return
            end

            local entry = entryFor(character)
            local at = now()
            local touched = false

            for _, gain in ipairs(summary.currencies or {}) do
                if gain.id and gain.total then
                    local previous = entry.currencies[gain.id] or {}
                    -- Only a walk of the currency pane reads whether the pot is shared; a
                    -- gain arrives off an event that never carries the flag, and a reading
                    -- that says nothing must leave the last answer standing or a currency
                    -- would unshare itself between two zonings-in. A walk does say — false
                    -- included — so it is also what takes the flag back off again.
                    local accountWide = gain.accountWide
                    if accountWide == nil then
                        accountWide = previous.accountWide
                    end
                    entry.currencies[gain.id] = {
                        name = gain.name or previous.name,
                        total = gain.total,
                        accountWide = accountWide or nil,
                        at = at,
                    }
                    touched = true
                end
            end

            for _, gain in ipairs(summary.reputation or {}) do
                -- Keyed on the faction's own id, never on what it is called. A name is
                -- localised: keyed on one, a player who switches the client to German comes
                -- back as a second character standing with a second faction, and the account's
                -- best is decided between two halves of the same grind. A gain the client
                -- would not put an id on has nowhere to go — and it has no standing either,
                -- because the id and the standing come off the same lookup.
                if gain.id and (gain.standing or gain.rank) then
                    local previous = entry.factions[gain.id] or {}
                    -- The same rule the currency flag keeps: a reading that says nothing must
                    -- leave the last answer standing, or a warband reputation would unshare
                    -- itself between two zonings-in. A walk does say — false included.
                    local accountWide = gain.accountWide
                    if accountWide == nil then
                        accountWide = previous.accountWide
                    end
                    entry.factions[gain.id] = {
                        name = gain.faction or previous.name,
                        accountWide = accountWide or nil,
                        standing = gain.standing,
                        current = gain.current,
                        max = gain.max,
                        rank = gain.rank,
                        system = gain.system,
                        at = at,
                    }
                    touched = true
                end
            end

            -- Zero is a real balance rather than a missing reading: a character that has
            -- genuinely spent everything must be able to say so, or the account total keeps
            -- counting gold that is no longer there. Below zero is not a balance at all — no
            -- wallet holds one — and is refused on the same terms the warband pot refuses it.
            if type(summary.wallet) == "number" and summary.wallet >= 0 then
                entry.gold = { total = summary.wallet, at = at }
                touched = true
            end

            if touched then
                entry.updatedAt = at
            end
        end,

        ---What the warband bank is holding, which belongs to the account rather than to any
        ---one character.
        ---
        ---Kept once, outside the per-character snapshots, because every character reads the
        ---same pot: filed under each of them it would be added to the account's worth once
        ---per character on the roster.
        ---
        ---`C_Bank.FetchDepositedMoney` answers away from a banker as readily as at one, so
        ---this is current rather than last-seen-at-the-bank — but it is still stamped, because
        ---the character that last wrote it may not have been played in weeks.
        ---@param amount integer? Copper; a nil or a non-number leaves the last reading standing.
        recordWarband = function(amount)
            if type(amount) ~= "number" or amount < 0 then
                return
            end
            db.warband = { gold = amount, at = now() }
        end,

        ---What the whole account holds of one currency, and who holds it.
        ---
        ---Nil rather than an empty rollup when no character has ever reported a holding: a
        ---total of zero is a claim, and the honest answer is that nobody has looked.
        ---
        ---A warband-wide currency is the same trap the warband bank's gold sits beside, come
        ---at from the other direction. The client answers every character that asks with the
        ---account's shared balance, so the per-character rows are one number reported several
        ---times rather than several holdings to add up, and summing them multiplies the pot
        ---by the size of the roster. The pot could not simply be kept outside the snapshots
        ---the way the bank's gold is, because which currencies are shared is a fact about the
        ---currency that only the client knows — so it travels with the reading instead, and
        ---is spent here.
        ---
        ---One reading is taken rather than the sum, and it is the freshest: the older rows
        ---are the same pot out of date. That also makes the freshest reading the whole claim,
        ---which is why it is what dates the total rather than the eldest — everywhere else
        ---the eldest is the weakest link in a sum, and here there is no sum to weaken.
        ---
        ---A currency counts as shared once **any** character has said so. Being shared is a
        ---fact about the currency rather than about the character that looked, so a snapshot
        ---written before the addon ever collected the flag is an unasked question rather than
        ---a "no", and one character that has been asked settles it for the whole roster.
        ---@param currencyID integer
        ---@return CurrencyRollup?
        currency = function(currencyID)
            if not currencyID then
                return nil
            end

            local holders = {}
            local total, name, oldest = 0, nil, nil
            local accountWide = false
            local freshest

            for character, entry in pairs(db.holdings) do
                local held = (entry.currencies or {})[currencyID]
                if held and held.total then
                    total = total + held.total
                    name = name or held.name
                    accountWide = accountWide or held.accountWide == true
                    if not oldest or (held.at or 0) < oldest then
                        oldest = held.at or 0
                    end
                    local holder = {
                        character = character,
                        name = held.name,
                        total = held.total,
                        at = held.at or 0,
                    }
                    -- Ties break on name so that which reading wins never depends on the
                    -- order a Lua table happened to be walked in.
                    if not freshest or holder.at > freshest.at
                        or (holder.at == freshest.at and holder.character < freshest.character) then
                        freshest = holder
                    end
                    holders[#holders + 1] = holder
                end
            end

            if #holders == 0 then
                return nil
            end

            table.sort(holders, function(left, right)
                return left.character < right.character
            end)

            return {
                id = currencyID,
                name = name or "",
                total = accountWide and freshest.total or total,
                accountWide = accountWide,
                characters = holders,
                oldest = accountWide and freshest.at or (oldest or 0),
            }
        end,

        ---Where the account stands with one faction: every character that has been seen with
        ---it, and the furthest along any of them has been. Nil when none of them has.
        ---
        ---Asked by id rather than by name, because that is what the snapshots are keyed on —
        ---see `record`. The name comes back on the rollup for something to draw with.
        ---@param factionID integer
        ---@return StandingRollup?
        standing = function(factionID)
            if type(factionID) ~= "number" then
                return nil
            end

            local seen = {}
            local name, accountWide = nil, false

            for character, entry in pairs(db.holdings) do
                local held = (entry.factions or {})[factionID]
                if held then
                    name = name or held.name
                    -- One character that has been asked settles it for the roster, the same
                    -- way a shared currency's flag does: being the warband's is a fact about
                    -- the faction rather than about whoever looked, so a snapshot written
                    -- before the flag was ever collected is an unasked question, not a "no".
                    accountWide = accountWide or held.accountWide == true
                    seen[#seen + 1] = {
                        character = character,
                        standing = held.standing,
                        current = held.current,
                        max = held.max,
                        rank = held.rank,
                        system = held.system,
                        at = held.at or 0,
                    }
                end
            end

            table.sort(seen, function(left, right)
                return left.character < right.character
            end)

            -- A standing with no rank at all — a faction the client would name but not place —
            -- is kept in the list and never crowned, because there is nothing to crown it on.
            local ladder = ladderOf(seen)
            local best
            for _, row in ipairs(seen) do
                if row.rank and row.system == ladder and isFurther(row, best) then
                    best = row
                end
            end

            if not best then
                return nil
            end

            return {
                id = factionID,
                faction = name or "",
                accountWide = accountWide,
                best = best,
                characters = seen,
            }
        end,

        ---What the account is worth in gold: every wallet that has reported, and the warband
        ---bank once.
        ---
        ---Nil when nothing has ever been read, for the same reason an unheld currency rolls up
        ---to nil: a total of zero is a claim about the account, and the honest answer is that
        ---nobody has looked yet.
        ---@return GoldRollup?
        gold = function()
            local holders = {}
            local wallets, oldest = 0, nil

            for character, entry in pairs(db.holdings) do
                local held = entry.gold
                if held and held.total then
                    wallets = wallets + held.total
                    if not oldest or (held.at or 0) < oldest then
                        oldest = held.at or 0
                    end
                    holders[#holders + 1] = {
                        character = character,
                        total = held.total,
                        at = held.at or 0,
                    }
                end
            end

            local warband = db.warband and db.warband.gold
            if #holders == 0 and not warband then
                return nil
            end

            table.sort(holders, function(left, right)
                return left.character < right.character
            end)

            -- The warband reading ages the total the same way a wallet does, so it is weighed
            -- for the eldest alongside them rather than being treated as permanently current.
            local warbandAt = db.warband and db.warband.at
            if warband and (not oldest or (warbandAt or 0) < oldest) then
                oldest = warbandAt or 0
            end

            return {
                characters = holders,
                wallets = wallets,
                warband = warband,
                warbandAt = warbandAt,
                total = wallets + (warband or 0),
                oldest = oldest or 0,
            }
        end,
    }
end

---How long ago something was read, short enough to sit on the end of a line.
---
---Rounded down to one unit on purpose: this is a staleness warning rather than a clock, and
---"3d" answers the only question being asked of it — is this recent enough to trust?
---@param seconds number? Age in seconds; negative or nil reads as "now".
---@return string
function ns.formatAge(seconds)
    seconds = math.max(math.floor(seconds or 0), 0)
    if seconds < 60 then
        return "now"
    end
    if seconds < 3600 then
        return string.format("%dm ago", math.floor(seconds / 60))
    end
    if seconds < 86400 then
        return string.format("%dh ago", math.floor(seconds / 3600))
    end
    return string.format("%dd ago", math.floor(seconds / 86400))
end
