-- What somebody said about a capture, and the record of one they threw away.
--
-- Both halves of this exist because a capture row is rebuilt from SavedVariables on every
-- sync. Everything else on the row is a copy of something the file still says, so an upsert
-- that overwrites is correct for it. These two are not: they are what a person did to the
-- row *after* it was written, in the app, and a sync that read the file again would undo it.

-- The note, whoever wrote it. There is one column rather than one per author because there
-- is one note: the in-game prompt and the app's own field are two ways of typing the same
-- sentence, and a reader should not have to pick between two of them.
--
-- Cleaned by the same rules at both ends — see `ns.entryText` in the addon and
-- `captures::note_text` beside it — so "a stored note holds no control character and no
-- pipe" is an invariant every reader downstream gets for free rather than four chances to
-- be wrong. NULL is a capture nobody has written about, which is nearly all of them, and it
-- is deliberately not the empty string: "cleared" and "never written" are the same state
-- and only one of them should be representable.
ALTER TABLE captures ADD COLUMN note TEXT;

-- When the app last wrote that note, and NULL when only the game ever has.
--
-- This is what makes an edit survive a sync. The marker in SavedVariables keeps whatever
-- note was typed in the moment for as long as the entry exists, so a plain
-- `COALESCE(excluded.note, captures.note)` would put that sentence back over the top of
-- every later edit — and clearing a note in the app would last exactly until the next
-- logout. The addon can only annotate an entry it has just written, so an edit made in the
-- app is necessarily the later of the two; once one exists, it wins outright.
ALTER TABLE captures ADD COLUMN note_edited_at INTEGER;

-- The captures somebody has deleted, so that deleting one means it is gone.
--
-- `db.entries` never prunes — that is the whole reason entries are not kept inside the
-- segments they belong to — so the marker for a deleted capture is still in SavedVariables
-- and every later sync reads it again. Without this the row would come straight back, now
-- with no file behind it, and the app would show a placeholder for a photograph somebody
-- deliberately threw away. Which is worse than not deleting it at all.
--
-- A tombstone rather than a `deleted_at` column on `captures`, because delete here means
-- what it says: the row and the file both go, and what is left behind is a note that a
-- source id is not to be ingested again. Nothing joins to it and nothing reads it but
-- `upsert_capture`.
CREATE TABLE capture_deletions (
    -- The addon's own id for the entry, which is what `captures.source_id` is keyed by and
    -- the only identity here that survives the row being deleted.
    source_id  TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
) STRICT;
