-- Every currency a character holds, walked by id rather than read off the pane.
--
-- The first character-scoped census domain, and the one that removes a trade rather than making
-- one. `character_currencies` next door is written from `apps/addon/src/HoldingsSweep.lua`, which
-- walks the client's currency *pane* — so a currency under a collapsed group is invisible to it,
-- because the call that would open the group up rearranges something the player arranged.
-- `C_CurrencyInfo.GetCurrencyInfo(id)` takes an arbitrary id and answers completely, with no pane
-- involved, which is what this table receives.
--
-- **Two tables rather than one, and the reason is the logout handler.** The census reading is
-- strictly the better one — it reaches every currency and carries the caps — but it is spread a
-- slice per frame and so cannot finish inside the moment a character stops answering, which is
-- exactly the moment `HoldingsSweep` is read for. So the sweep stays the live shallow reading
-- taken at every zoning-in and again on the way out, and this is the complete occasional one,
-- qualified by the claim in `census_domains` the way every census reading is. Folding them
-- together would mean one table with two writers of different freshness and no way to say which
-- of them a row came from.
CREATE TABLE census_currencies (
    account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- Never null, unlike `census_domains.character_id`. A wallet is one character's, and two alts
    -- with a wallet each must not read as one alt whose wallet keeps being replaced.
    character_id     INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    -- `CurrencyTypes`' own id, which is what `GetCurrencyInfo` takes and what `currencies.rs`
    -- looks the icon up by.
    currency_id      INTEGER NOT NULL,
    name             TEXT,
    -- The balance as it stands, nought included: a character that has spent everything it had
    -- must be able to say so, or a total goes on counting what it was last seen with.
    total            INTEGER NOT NULL DEFAULT 0,
    -- What the pane row could never say, and what the domain exists for. `max_quantity` beside
    -- `total_earned` is "am I capped"; `max_weekly` beside `earned_this_week` is "have I done my
    -- weekly". Nought is the client's own word for "no cap" and for "nothing yet" alike, so the
    -- addon leaves these out when they are nought and the default here says the same thing.
    total_earned     INTEGER NOT NULL DEFAULT 0,
    max_quantity     INTEGER NOT NULL DEFAULT 0,
    earned_this_week INTEGER NOT NULL DEFAULT 0,
    max_weekly       INTEGER NOT NULL DEFAULT 0,
    -- The warband's one pot seen from this character, and the separate case of a currency that
    -- stays each character's own but can be moved between them at a cost. Both are the client's
    -- own distinction rather than one worked out here.
    account_wide     INTEGER NOT NULL DEFAULT 0,
    transferable     INTEGER NOT NULL DEFAULT 0,
    seen_at          INTEGER,
    PRIMARY KEY (account_id, character_id, currency_id)
) STRICT, WITHOUT ROWID;
