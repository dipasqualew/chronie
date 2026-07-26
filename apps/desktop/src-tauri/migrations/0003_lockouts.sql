-- A lockable activity, and who is currently locked to it.
--
-- Lockouts are the one thing the pipeline carries that is not derived from a segment. A
-- segment says a character stood in Naxxramas on Tuesday; the lockout says that character
-- cannot go back until Wednesday. The second outlives the first and belongs to nobody's
-- visit, so it is filed against the activity rather than against any segment.
--
-- Everything here is current state rather than history: the addon replaces a character's
-- lockouts wholesale on every scan, because the client only reports what is true now.

CREATE TABLE lockout_activities (
    id             INTEGER PRIMARY KEY,
    account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- The addon's activity key: non-localised wherever the client allowed it, so a client
    -- locale change does not split one activity into two.
    source_key     TEXT NOT NULL,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('raid', 'dungeon', 'world_boss')),
    -- How often the activity resets, and the evidence behind it. The client only ever
    -- reports how long is LEFT, so the addon widens the observed span towards the true
    -- period across scans and writes its reading of it out; the raw seconds come along so
    -- a claimed cadence can always be checked against what was actually seen.
    reset_period   TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (reset_period IN ('daily', 'weekly', 'unknown')),
    reset_seconds  INTEGER NOT NULL DEFAULT 0,
    first_seen_at  INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL,
    UNIQUE (account_id, source_key)
) STRICT;

CREATE INDEX lockout_activities_by_account ON lockout_activities(account_id);

CREATE TABLE lockouts (
    id            INTEGER PRIMARY KEY,
    activity_id   INTEGER NOT NULL REFERENCES lockout_activities(id) ON DELETE CASCADE,
    character_id  INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    difficulty_id INTEGER NOT NULL DEFAULT 0,
    difficulty    TEXT NOT NULL DEFAULT '',
    max_players   INTEGER NOT NULL DEFAULT 0,
    expires_at    INTEGER NOT NULL,
    recorded_at   INTEGER NOT NULL,
    -- Difficulty is part of the identity because two difficulties of one raid can be held
    -- at once, and they reset independently. Whether being saved at one difficulty should
    -- count against another is a question about how to read these rows, not about how many
    -- there are, so it is left to whoever reads them.
    UNIQUE (activity_id, character_id, difficulty_id)
) STRICT;

CREATE INDEX lockouts_by_character ON lockouts(character_id);
CREATE INDEX lockouts_expiring ON lockouts(expires_at);

-- Which bosses were down when the lockout was last read. Only the logged-in character can
-- be asked, so this is empty for a character that has not logged in since the boss list
-- started being captured, and empty by nature for a world boss.
CREATE TABLE lockout_encounters (
    lockout_id  INTEGER NOT NULL REFERENCES lockouts(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    killed      INTEGER NOT NULL CHECK (killed IN (0, 1)),
    PRIMARY KEY (lockout_id, position)
) STRICT, WITHOUT ROWID;
