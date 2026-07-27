-- What the client's own combat log said, and where reading it got to.
--
-- Deliberately not the log. A raid night is hundreds of megabytes of damage events and a
-- table with one row per event would be a slower, larger copy of a file that already exists.
-- What is kept is the handful of facts the log is the only source of: where the player was,
-- the bounds that make those coordinates mean anything, the exact boundaries of every fight,
-- and what everyone had on when one started. The file on disk stays the source of truth and
-- these rows are derived from it, which is why re-reading a log rewrites them rather than
-- doubling them.

-- One row per name in the game's `Logs/` folder, holding the cursor that makes reading it
-- incremental. Everything here is about the file rather than about what is in it.
--
-- Per name and not per file, which matters exactly once: when a log is rotated, the name comes
-- back attached to a different file and this row goes on being the cursor for whatever now
-- answers to it. The facts already derived under it stay, because they are facts about the
-- player's history and not about the file they were read out of — the night happened whether
-- or not the log that recorded it still exists.
CREATE TABLE combat_logs (
    id             INTEGER PRIMARY KEY,
    -- The file's own name. Not its path: an install that moves is the same install, and the
    -- folder these live in is found from the configured game folder either way.
    name           TEXT NOT NULL UNIQUE,
    -- How far into the file reading got, always on a line boundary, and how big it was when
    -- that was true.
    byte_offset    INTEGER NOT NULL DEFAULT 0,
    byte_size      INTEGER NOT NULL DEFAULT 0,
    -- A digest of the file's first bytes and how many of them went into it. This is what
    -- makes a rotated log detectable: a replacement can be larger than what it replaced, so
    -- the size says nothing, and resuming into it would parse the middle of a record as if it
    -- were the start of one. Storing the length hashed is what stops a log that was short on
    -- its first read and long on its second from looking like a replacement.
    head_hash      TEXT NOT NULL DEFAULT '',
    head_bytes     INTEGER NOT NULL DEFAULT 0,
    lines_read     INTEGER NOT NULL DEFAULT 0,
    -- How many times this file had to be read again from the start. Not bookkeeping: a log
    -- that keeps restarting is a log something else is rewriting, which is worth being able
    -- to see rather than worth silently absorbing.
    restarts       INTEGER NOT NULL DEFAULT 0,
    -- Whether lines in this file actually carried advanced parameters, which is a different
    -- claim from the CVar being set. NULL until enough of the file has been read to say.
    advanced       INTEGER CHECK (advanced IN (0, 1)),
    first_event_at INTEGER,
    last_event_at  INTEGER,
    first_seen_at  INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL
) STRICT;

-- Every `MAP_CHANGE`: which map the player moved onto and the world coordinates of its
-- corners. Without these the positions below are yards on an unnamed grid; with them they are
-- the same normalised point the rest of the pipeline already speaks, and no hand-maintained
-- table of map bounds has to exist or be kept up to date with the game.
CREATE TABLE log_maps (
    id          INTEGER PRIMARY KEY,
    log_id      INTEGER NOT NULL REFERENCES combat_logs(id) ON DELETE CASCADE,
    ui_map_id   INTEGER NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    -- North and south edges, then west and east. `x0` and `y0` are the larger of each pair.
    x0          REAL NOT NULL,
    x1          REAL NOT NULL,
    y0          REAL NOT NULL,
    y1          REAL NOT NULL,
    changed_at  INTEGER NOT NULL,
    UNIQUE (log_id, changed_at, ui_map_id)
) STRICT;

-- Read one way — "what map was the player on most recently in this log" — which is the
-- question the next incremental read asks before it can place anything it finds.
CREATE INDEX log_maps_latest ON log_maps(log_id, changed_at DESC, id DESC);

-- Where the player was, once every few seconds.
--
-- This is the whole reason the epic exists. Inside an instance the client refuses to answer
-- `C_Map.GetPlayerMapPosition`, so the addon has nothing to record and the advanced
-- parameters on a damage line are the only place a position can be got at all.
CREATE TABLE log_positions (
    id          INTEGER PRIMARY KEY,
    log_id      INTEGER NOT NULL REFERENCES combat_logs(id) ON DELETE CASCADE,
    -- Which visit this point was during. A link rather than an owner, and filled in later
    -- than the row: the point is read within thirty seconds of being logged, and the segment
    -- it belongs to is not written until the player logs out.
    segment_id  INTEGER REFERENCES segments(id) ON DELETE SET NULL,
    -- Epoch milliseconds. The log states milliseconds and keeping them costs nothing, while
    -- rounding to the second would make two points a moment apart indistinguishable.
    at_ms       INTEGER NOT NULL,
    actor_guid  TEXT NOT NULL,
    -- What the log called them, which for a cross-realm character includes the realm. It is
    -- what lets a point be attached to the right character rather than merely to the right
    -- half hour.
    actor_name  TEXT NOT NULL DEFAULT '',
    ui_map_id   INTEGER,
    -- World yards, exactly as the line stated them.
    world_x     REAL NOT NULL,
    world_y     REAL NOT NULL,
    -- The same point as a fraction across the map, and NULL together when no `MAP_CHANGE` for
    -- that map has been seen yet. Kept beside the world coordinates rather than instead of
    -- them: the conversion between the two is a rule about the game, and a rule found to be
    -- wrong should cost a pass over these rows rather than a re-read of a log that has since
    -- been deleted.
    map_x       REAL,
    map_y       REAL,
    facing      REAL,
    -- One point per actor per instant, so that re-reading a log after a rotation writes the
    -- track it already holds rather than a second copy of it.
    UNIQUE (log_id, at_ms, actor_guid)
) STRICT;

CREATE INDEX log_positions_by_segment ON log_positions(segment_id, at_ms);

-- The points still waiting for the segment they were recorded during. Partial, because this
-- is read on every sync and the rows it has to find are the recent ones.
CREATE INDEX log_positions_unplaced ON log_positions(at_ms) WHERE segment_id IS NULL;

-- Boss fights and keystone runs, with the boundaries the log states to the millisecond.
--
-- The addon already records both more coarsely, from events it sees in the client. These are
-- not a replacement for those: they are the precise version, recorded by the game itself,
-- against which the coarse one can be checked.
CREATE TABLE log_fights (
    id             INTEGER PRIMARY KEY,
    log_id         INTEGER NOT NULL REFERENCES combat_logs(id) ON DELETE CASCADE,
    segment_id     INTEGER REFERENCES segments(id) ON DELETE SET NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('encounter', 'keystone')),
    -- The game's own id: the encounter id for a boss, the challenge mode id for a run.
    encounter_id   INTEGER,
    name           TEXT NOT NULL DEFAULT '',
    difficulty_id  INTEGER,
    group_size     INTEGER,
    instance_id    INTEGER,
    keystone_level INTEGER,
    affixes_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affixes_json)),
    -- Both in epoch milliseconds, and both nullable, because a read can begin or end in the
    -- middle of a fight. A row with only an end is not a broken row; it is the second half of
    -- one whose first half was written down on the previous pass, and the pass that finds the
    -- end closes the row that was left open rather than starting another.
    started_at     INTEGER,
    ended_at       INTEGER,
    success        INTEGER CHECK (success IN (0, 1)),
    -- What the client said the fight lasted, which older clients do not say at all. Left NULL
    -- rather than derived from the two boundaries and presented as though it had been stated.
    duration_ms    INTEGER,
    recorded_at    INTEGER NOT NULL,
    UNIQUE (log_id, kind, encounter_id, started_at)
) STRICT;

CREATE INDEX log_fights_by_segment ON log_fights(segment_id, started_at);
CREATE INDEX log_fights_open ON log_fights(log_id, encounter_id) WHERE ended_at IS NULL;

-- Who was there and what they had on, as of the moment the pull started.
--
-- The gear is the point. Item level and bonus ids are what actually decide what an item was
-- worth, and a snapshot taken at the pull is the only record of them that survives the player
-- replacing the item an hour later.
CREATE TABLE log_combatants (
    id             INTEGER PRIMARY KEY,
    fight_id       INTEGER NOT NULL REFERENCES log_fights(id) ON DELETE CASCADE,
    guid           TEXT NOT NULL,
    faction        INTEGER,
    spec_id        INTEGER,
    -- Both verbatim from the log, uninterpreted. What a talent id means is the game's
    -- business and changes every expansion; the numbers themselves do not.
    talents_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(talents_json)),
    equipment_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(equipment_json)),
    UNIQUE (fight_id, guid)
) STRICT;
