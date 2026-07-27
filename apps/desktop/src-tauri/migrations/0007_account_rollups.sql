-- What each character was last seen holding, as state rather than as change.
--
-- Everything else about a currency or a faction is recorded per segment, which is a record
-- of what happened rather than of where things now stand. An account rollup needs the
-- second: summing every gain ever recorded is wrong the moment one segment is missed, and
-- reputation cannot be summed at all — two characters at Honored are not one at Exalted.
--
-- So these are the addon's own snapshot, one row per character per thing, replaced wholesale
-- as each character reports again. `observed_at` is what stops the rollup lying about how
-- current it is: a character not logged into since a change reports what it held when it was
-- last played, and the age of the eldest row is the weakest claim in any total built on it.
CREATE TABLE character_currencies (
    character_id  INTEGER NOT NULL REFERENCES characters(id),
    currency_id   INTEGER NOT NULL,
    name          TEXT,
    total         INTEGER NOT NULL,
    observed_at   INTEGER,
    PRIMARY KEY (character_id, currency_id)
) STRICT, WITHOUT ROWID;

-- The standing keeps the same three columns a reputation gain does, and adds the two that
-- make two characters' standings comparable at all. A name cannot be ranked — "Renown 12"
-- and "Honored" do not sort — so the addon carries the rank it read off the client, and the
-- ladder it read it off, because a rank only means anything against the same one: the
-- reaction ladder runs 1 to 8 where a friendship's runs into the thousands.
CREATE TABLE character_standings (
    character_id      INTEGER NOT NULL REFERENCES characters(id),
    faction           TEXT NOT NULL,
    standing          TEXT,
    standing_current  INTEGER,
    standing_max      INTEGER,
    ladder_rank       INTEGER,
    ladder            TEXT,
    observed_at       INTEGER,
    PRIMARY KEY (character_id, faction)
) STRICT, WITHOUT ROWID;
