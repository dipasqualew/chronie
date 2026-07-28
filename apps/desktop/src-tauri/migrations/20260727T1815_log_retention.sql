-- What Chronie deleted out of the game's `Logs/` folder, and what it was when it went.
--
-- The only irreversible thing Chronie does. Every other write can be recomputed from the game's
-- own files; a deleted combat log is gone, and "Chronie deleted my logs" with nothing to point
-- at is a question nobody can answer. So the file leaves a headstone: what it was called, how
-- big it was, when the client last wrote it, how much of it had been read, and the window that
-- decided it. Appended to and never updated — a row here is a thing that happened.
--
-- Deliberately not a foreign key to `combat_logs`. That row is the cursor for a *name*, it
-- outlives the file, and the facts hanging off it — the positions, the fights — are facts about
-- the player's history rather than about the bytes they were read out of. Deleting the file
-- must not take them with it, which is exactly what a cascade from that table would do.
CREATE TABLE log_deletions (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    -- The file's size and modification time as they were at the moment it was removed, so the
    -- record still says what was lost after the only copy of it has stopped existing.
    bytes       INTEGER NOT NULL,
    modified_at INTEGER,
    -- How many lines had been read out of it by then. The claim the deletion rested on, kept
    -- beside the deletion: a row here with zero lines would be a bug worth being able to find.
    lines_read  INTEGER NOT NULL DEFAULT 0,
    -- The retention window in force when this ran, because the setting is a number somebody can
    -- change and a record that does not say which one applied explains nothing.
    retain_days INTEGER NOT NULL,
    deleted_at  INTEGER NOT NULL
) STRICT;

-- Read one way: the last handful, newest first, which is what the panel shows.
CREATE INDEX log_deletions_recent ON log_deletions(deleted_at DESC, id DESC);
