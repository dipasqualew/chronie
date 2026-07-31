-- Reputations keyed on the faction rather than on what the client happened to call it.
--
-- `character_standings.faction` was a **localised name**, and so was the key the addon filed a
-- standing under. Two things followed from that, and the second is the one that cost the most.
--
-- A client language change forked the store: the same faction came back under its German name
-- and arrived here as a second row, so the account's best standing was decided between two
-- halves of one grind. And `reputations.rs` — which borrows a faction's picture from the icon of
-- the achievement for reaching Exalted with it — had to *enter* the game's tables through
-- `Faction`'s name column just to find out which faction a string meant, matching
-- case-insensitively on a trimmed name and following every one of the fourteen names that sit on
-- more than one `Faction` row. All of that goes away against an id.
--
-- **The rows do not migrate, because a name is not an id and nothing here can turn one into the
-- other.** The mapping lives in the game's own `Faction` table, which the collector does not
-- open — and the rows are re-derived wholesale from the addon's own snapshot at the very next
-- sync anyway, which is what `sync_holdings` has always done. So the table is replaced rather
-- than widened, and a history reads as having no standings for exactly as long as it takes the
-- player to log a character in.
DROP TABLE character_standings;

CREATE TABLE character_standings (
    character_id     INTEGER NOT NULL REFERENCES characters(id),
    -- `Faction`'s own id, which is what `C_Reputation.GetFactionDataByID` takes and what
    -- `reputations.rs` now looks a picture up by.
    faction_id       INTEGER NOT NULL,
    -- What the client last called it. Kept for something to draw and never keyed on — that is
    -- the whole point of the column above.
    name             TEXT,
    standing         TEXT,
    standing_current INTEGER,
    standing_max     INTEGER,
    ladder_rank      INTEGER,
    ladder           TEXT,
    -- The warband's one standing rather than this character's own — the reputation side of
    -- `character_currencies.account_wide`, and NOT NULL with a default for the same reason: a
    -- row written before the flag was collected is an unasked question, and a faction counts as
    -- shared as soon as any character has said so.
    account_wide     INTEGER NOT NULL DEFAULT 0,
    observed_at      INTEGER,
    PRIMARY KEY (character_id, faction_id)
) STRICT, WITHOUT ROWID;

-- The same id on a segment's own gains, so a reputation line can be drawn with a picture by the
-- route that no longer knows anything about names.
--
-- Nullable, and the old rows keep a null: a gain filed before the addon asked the client to place
-- the faction was only ever a string, and inventing an id for it is exactly the join this whole
-- migration exists to delete. Such a line draws without a picture, which is what it drew before
-- there were any.
ALTER TABLE reputation_gains ADD COLUMN faction_id INTEGER;

-- Where a character stands with every faction the game has, walked by id rather than read off the
-- pane.
--
-- The second character-scoped census domain, and the one that finally reaches the **legacy**
-- reputations. `character_standings` next door is written from `apps/addon/src/HoldingsSweep.lua`,
-- which walks the client's reputation *pane* — and the pane hides every legacy faction unless the
-- player has asked for them, which is most of the game's factions. The call that would show them,
-- `C_Reputation.SetLegacyReputationsShown`, rearranges something the player arranged.
-- `C_Reputation.GetFactionDataByID(id)` takes an arbitrary id and answers for it whatever the
-- pane is doing, which is what this table receives.
--
-- Two tables rather than one, for the reason `census_currencies` gives beside it: the sweep is
-- the live shallow reading taken at every zoning-in and again inside the logout handler, and a
-- census is spread a slice per frame and so can never finish there. Folding them together would
-- mean one table with two writers of different freshness and no way to say which wrote a row.
CREATE TABLE census_standings (
    account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- Never null, unlike `census_domains.character_id`. A standing is one character's, and two
    -- alts at different renown must not read as one alt whose standing keeps being replaced.
    character_id     INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    faction_id       INTEGER NOT NULL,
    name             TEXT,
    -- The four ladders reduced to one bar by `ns.readFactionStanding`, which is what makes two
    -- characters' standings comparable at all: `ladder_rank` is monotone within one faction's
    -- own ladder, and `ladder` says which ladder that is — a reaction rank runs 1 to 8 where a
    -- friendship's runs into the thousands, so the two must never be ranked against each other.
    standing         TEXT,
    standing_current INTEGER NOT NULL DEFAULT 0,
    standing_max     INTEGER NOT NULL DEFAULT 0,
    ladder_rank      INTEGER,
    ladder           TEXT,
    account_wide     INTEGER NOT NULL DEFAULT 0,
    seen_at          INTEGER,
    PRIMARY KEY (account_id, character_id, faction_id)
) STRICT, WITHOUT ROWID;
