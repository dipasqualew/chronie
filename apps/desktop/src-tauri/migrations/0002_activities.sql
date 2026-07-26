-- Which expansion shipped the location, and the newest expansion the client that recorded
-- the segment knew about. Deciding "current content" from the pair is what separates a
-- progression raid from a legacy one without anyone maintaining a list of current raids.
ALTER TABLE segments ADD COLUMN expansion_tier INTEGER;
ALTER TABLE segments ADD COLUMN latest_expansion_tier INTEGER;

-- Experience is kept twice on purpose. Raw points are incomparable between levels, while
-- the fraction of a level is what "did I level meaningfully here?" is actually asking.
ALTER TABLE segments ADD COLUMN experience_gained INTEGER NOT NULL DEFAULT 0;
ALTER TABLE segments ADD COLUMN experience_percent REAL NOT NULL DEFAULT 0;
ALTER TABLE segments ADD COLUMN experience_start_level INTEGER;
ALTER TABLE segments ADD COLUMN experience_end_level INTEGER;

-- Boss fights that ended. Wipes are stored alongside kills because the ratio between them
-- is the clearest signal there is for telling progression from a farm clear.
CREATE TABLE encounters (
    id             INTEGER PRIMARY KEY,
    segment_id     INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL,
    encounter_id   INTEGER NOT NULL,
    name           TEXT,
    ended_at       INTEGER,
    difficulty_id  INTEGER,
    group_size     INTEGER,
    success        INTEGER NOT NULL CHECK (success IN (0, 1)),
    UNIQUE (segment_id, position)
) STRICT;

CREATE INDEX encounters_by_segment ON encounters(segment_id);

-- At most one keystone run per segment: a segment is one continuous stay in one instance at
-- one difficulty, so the segment itself is the run's identity.
CREATE TABLE keystone_runs (
    segment_id    INTEGER PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
    level         INTEGER NOT NULL,
    map_id        INTEGER,
    affixes_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affixes_json)),
    started_at    INTEGER,
    completed_at  INTEGER,
    completed     INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    duration_ms   INTEGER,
    on_time       INTEGER CHECK (on_time IN (0, 1)),
    upgrades      INTEGER
) STRICT, WITHOUT ROWID;

-- A guess at what the player was doing during a segment.
--
-- `source` is what makes a guess and a user's correction able to share one table. An
-- 'inferred' row is derived from the segment and is thrown away and rebuilt on every sync,
-- so improving the inference reaches all of history. A 'manual' row was written by the user
-- and is never touched again — adding one, or editing an inferred one, produces a manual
-- row that outlives every later sync.
CREATE TABLE activities (
    id             INTEGER PRIMARY KEY,
    segment_id     INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    source         TEXT NOT NULL CHECK (source IN ('inferred', 'manual')),
    confidence     REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
    metadata_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX activities_by_segment ON activities(segment_id);

-- An inferred activity the user threw away, or replaced with an edit of their own. Without
-- this the next sync would simply infer it right back and the deletion would not stick.
-- Clearing a segment's rows here is what "go back to the guesses" means.
CREATE TABLE activity_suppressions (
    segment_id  INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (segment_id, kind)
) STRICT, WITHOUT ROWID;
