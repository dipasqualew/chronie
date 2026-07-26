CREATE TABLE accounts (
    id             INTEGER PRIMARY KEY,
    source_key     TEXT NOT NULL UNIQUE,
    display_name   TEXT,
    first_seen_at  INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL,
    source_modified_ns INTEGER,
    source_size    INTEGER,
    metadata_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

CREATE TABLE characters (
    id             INTEGER PRIMARY KEY,
    account_id     INTEGER NOT NULL REFERENCES accounts(id),
    source_key     TEXT NOT NULL,
    name           TEXT NOT NULL,
    realm          TEXT NOT NULL,
    class_file     TEXT,
    last_level     INTEGER,
    first_seen_at  INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL,
    metadata_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    UNIQUE (account_id, source_key)
) STRICT;

CREATE INDEX characters_by_account ON characters(account_id);

CREATE TABLE segments (
    id                INTEGER PRIMARY KEY,
    character_id      INTEGER NOT NULL REFERENCES characters(id),
    source_id         TEXT NOT NULL,
    ended_day         TEXT NOT NULL,
    instance_name     TEXT NOT NULL,
    instance_type     TEXT NOT NULL,
    difficulty_name   TEXT NOT NULL,
    difficulty_id     INTEGER,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER NOT NULL,
    duration_seconds  INTEGER NOT NULL,
    character_level   INTEGER,
    loot_value        INTEGER NOT NULL DEFAULT 0,
    gold_diff         INTEGER NOT NULL DEFAULT 0,
    currency_total    INTEGER NOT NULL DEFAULT 0,
    reputation_total  INTEGER NOT NULL DEFAULT 0,
    housing_xp        INTEGER NOT NULL DEFAULT 0,
    first_seen_at     INTEGER NOT NULL,
    last_seen_at      INTEGER NOT NULL,
    UNIQUE (character_id, source_id),
    CHECK (ended_at >= started_at),
    CHECK (duration_seconds >= 0)
) STRICT;

CREATE INDEX segments_newest ON segments(ended_at DESC);
CREATE INDEX segments_by_character ON segments(character_id, ended_at DESC);
CREATE INDEX segments_by_day ON segments(ended_day DESC);

CREATE TABLE transmogs (
    id                INTEGER PRIMARY KEY,
    segment_id        INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position          INTEGER NOT NULL,
    item_id           INTEGER NOT NULL,
    source_id         INTEGER,
    appearance_id     INTEGER,
    collected_at      INTEGER,
    acquisition_kind  TEXT NOT NULL CHECK (
        acquisition_kind IN ('appearance', 'source', 'unknown')
    ),
    UNIQUE (segment_id, position)
) STRICT;

CREATE INDEX transmogs_new_appearances
    ON transmogs(collected_at DESC)
    WHERE acquisition_kind = 'appearance';
CREATE INDEX transmogs_by_appearance
    ON transmogs(appearance_id, collected_at DESC);

CREATE TABLE achievements (
    id              INTEGER PRIMARY KEY,
    segment_id      INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    achievement_id  INTEGER NOT NULL,
    name            TEXT,
    earned_at       INTEGER,
    account_first   INTEGER CHECK (account_first IN (0, 1)),
    UNIQUE (segment_id, position)
) STRICT;

CREATE TABLE quests (
    id               INTEGER PRIMARY KEY,
    segment_id       INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position         INTEGER NOT NULL,
    quest_id         INTEGER NOT NULL,
    name             TEXT,
    completed_at     INTEGER,
    character_first  INTEGER CHECK (character_first IN (0, 1)),
    account_first    INTEGER CHECK (account_first IN (0, 1)),
    UNIQUE (segment_id, position)
) STRICT;

CREATE TABLE currency_gains (
    segment_id   INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    currency_id  INTEGER NOT NULL,
    name         TEXT NOT NULL,
    amount       INTEGER NOT NULL,
    PRIMARY KEY (segment_id, currency_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE reputation_gains (
    segment_id  INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    faction     TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    PRIMARY KEY (segment_id, faction)
) STRICT, WITHOUT ROWID;

CREATE TABLE level_ups (
    id          INTEGER PRIMARY KEY,
    segment_id  INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    level       INTEGER NOT NULL,
    reached_at  INTEGER,
    UNIQUE (segment_id, position)
) STRICT;

CREATE TABLE mounts (
    id            INTEGER PRIMARY KEY,
    segment_id    INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    mount_id      INTEGER NOT NULL,
    name          TEXT,
    collected_at  INTEGER,
    UNIQUE (segment_id, position)
) STRICT;

CREATE TABLE pets (
    id            INTEGER PRIMARY KEY,
    segment_id    INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    species_id    INTEGER NOT NULL,
    name          TEXT,
    collected_at  INTEGER,
    pet_guid      TEXT,
    UNIQUE (segment_id, position)
) STRICT;

CREATE TABLE toys (
    id            INTEGER PRIMARY KEY,
    segment_id    INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    item_id       INTEGER NOT NULL,
    name          TEXT,
    collected_at  INTEGER,
    UNIQUE (segment_id, position)
) STRICT;

CREATE TABLE housing_items (
    id             INTEGER PRIMARY KEY,
    segment_id     INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL,
    decor_id       INTEGER NOT NULL,
    name           TEXT,
    collected_at   INTEGER,
    warband_first  INTEGER CHECK (warband_first IN (0, 1)),
    UNIQUE (segment_id, position)
) STRICT;

CREATE TABLE housing_level_ups (
    id          INTEGER PRIMARY KEY,
    segment_id  INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    level       INTEGER NOT NULL,
    reached_at  INTEGER,
    UNIQUE (segment_id, position)
) STRICT;
