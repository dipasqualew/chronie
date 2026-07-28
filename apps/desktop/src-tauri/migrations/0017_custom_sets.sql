-- The sets a person puts together themselves, as against the ones Blizzard shipped.
--
-- The transmog view has always been a wardrobe rather than a catalogue: a helm out of one set,
-- a robe out of another, a staff out of the game at large, all worn at once on the character
-- beside the browser. Everything about that arrangement was lost the moment the window closed.
-- These two tables are where it stops being lost — an outfit saved under a name is a set of the
-- reader's own, browsed beside the game's and marked with the same stars and tags.
--
-- **A saved piece is what the reader was looking at, written down.** The alternative was to
-- store the appearance id alone and walk the game's tables again on every read, and that is
-- wrong twice over: it makes a saved set unreadable on a machine that has not got the game
-- installed, and it costs the same second of DB2 decoding per set that opening a Blizzard set
-- costs. What a row needs to be drawn and to be put back on a character is eight numbers and a
-- name, so those are what is kept. The appearance id is still there, and is still the game's own
-- unit of collection, which is what lets a piece inside a saved set carry the same star it
-- carries everywhere else in the view.

CREATE TABLE transmog_custom_sets (
    -- AUTOINCREMENT rather than a plain rowid alias, because these ids are what the marks below
    -- are written against: SQLite hands the id of a deleted row to the next set, and a set
    -- created after one was deleted would inherit the dead set's star and its tags.
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

-- What one of them is made of: at most one piece per place on the body, which is the same rule
-- the character herself obeys — see `outfit.ts`, where two helms cannot both be worn.
--
-- `place` is the window's own word for a place ("armour-3", "hand-right") rather than anything
-- the game numbers, and deliberately: which hand a one-hander goes in is a question the display
-- type cannot answer, and `outfit.ts` is where that is settled once for the whole view. This
-- table stores the answer rather than re-deriving it.
CREATE TABLE transmog_custom_set_pieces (
    set_id            INTEGER NOT NULL
                      REFERENCES transmog_custom_sets(id) ON DELETE CASCADE,
    place             TEXT NOT NULL,
    -- The game's own id for the look, which is what a mark against this piece is keyed by.
    appearance_id     INTEGER NOT NULL,
    -- And the item it was named after, which is what the link out of the row points at.
    item_id           INTEGER NOT NULL,
    name              TEXT NOT NULL,
    display_type      INTEGER NOT NULL,
    inventory_type    INTEGER NOT NULL,
    -- What the backend is handed to draw her wearing this. The one column the model needs.
    display_info_id   INTEGER NOT NULL,
    icon_file_data_id INTEGER NOT NULL,
    has_model         INTEGER NOT NULL,
    PRIMARY KEY (set_id, place)
) STRICT, WITHOUT ROWID;

-- A third kind of subject for the marks, which is the whole of what "custom sets can have any
-- metadata that can be assigned to Blizzard sets" comes to.
--
-- Rebuilt rather than altered because the kind is a `CHECK` constraint and SQLite has no way to
-- widen one in place. The rows are carried across unchanged — a star written against a Blizzard
-- set before this migration is the same star after it — and the constraint is the only thing
-- that differs. `id` here still means the game's own id for a set or a look, and for a set of
-- the reader's own it means `transmog_custom_sets.id`; no foreign key, for the same reason the
-- other two kinds have none, which is that two of the three subjects live in the game's files.

CREATE TABLE transmog_favourites_widened (
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('set', 'appearance', 'custom')),
    subject_id   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (subject_kind, subject_id)
) STRICT, WITHOUT ROWID;

INSERT INTO transmog_favourites_widened (subject_kind, subject_id, created_at)
SELECT subject_kind, subject_id, created_at FROM transmog_favourites;

DROP TABLE transmog_favourites;
ALTER TABLE transmog_favourites_widened RENAME TO transmog_favourites;

CREATE TABLE transmog_tags_widened (
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('set', 'appearance', 'custom')),
    subject_id   INTEGER NOT NULL,
    key          TEXT NOT NULL COLLATE NOCASE,
    value        TEXT,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (subject_kind, subject_id, key)
) STRICT, WITHOUT ROWID;

INSERT INTO transmog_tags_widened (subject_kind, subject_id, key, value, created_at)
SELECT subject_kind, subject_id, key, value, created_at FROM transmog_tags;

DROP TABLE transmog_tags;
ALTER TABLE transmog_tags_widened RENAME TO transmog_tags;

-- The index goes with the table it was on, so it is written again here. Same question as
-- before: the picker offers the keys in use, and the browser then wants the subjects under one.
CREATE INDEX transmog_tags_by_key ON transmog_tags(key, subject_kind);
