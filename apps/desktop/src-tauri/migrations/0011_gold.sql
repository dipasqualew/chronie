-- What each character is carrying, and the one pot they all share.
--
-- Gold arrives as movement everywhere else in this schema — a segment's `gold_diff` says what
-- a stay in a zone was worth — and movement cannot answer the question a roster actually asks,
-- which is what the account is sitting on. Summing every diff ever recorded is wrong the moment
-- one segment is missed, and it is wrong from the start for a character that had gold before
-- the addon was ever installed.
--
-- So this is the addon's own reading of the balance, replaced wholesale as each character
-- reports again, exactly like `character_currencies` beside it. `observed_at` is what stops a
-- total lying about how current it is.
CREATE TABLE character_gold (
    character_id  INTEGER PRIMARY KEY REFERENCES characters(id),
    total         INTEGER NOT NULL,
    observed_at   INTEGER
) STRICT, WITHOUT ROWID;

-- The warband bank's gold, which belongs to the account rather than to any character.
--
-- One row per account rather than per character, because there is one pot: every character
-- reads the same balance, and a copy filed under each of them would be added to the account's
-- worth once per character on the roster. The addon reads it away from the bank as readily as
-- at one, so this is current rather than last-seen-at-a-banker — but it is still stamped,
-- because the character that last wrote it may not have been played in weeks.
CREATE TABLE account_gold (
    account_id    INTEGER PRIMARY KEY REFERENCES accounts(id),
    warband       INTEGER NOT NULL,
    observed_at   INTEGER
) STRICT, WITHOUT ROWID;
