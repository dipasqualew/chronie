-- What a person says about the game's wardrobe, as against what the game says about it.
--
-- Everything else the transmog view draws is read out of the installed game and is the same
-- for everybody who has that build. These two tables are the opposite: they hold nothing the
-- game knows, they survive a sync because no sync ever writes them, and they are the only
-- reason the view has anything of the reader's own in it.
--
-- **A subject is a set or an appearance, and nothing else.** Those are the two things the
-- browser lists, and both are numbered by the game rather than by Chronie — a set by
-- `TransmogSet.id`, a look by `ItemAppearance.id`. An appearance rather than an item on
-- purpose: the app has held throughout that a row is a look and not the item that sells it,
-- and marking the item would put the star on one of the nine things that give a look and not
-- on the other eight. No foreign key can be written for either, because the thing referred to
-- lives in the game's files and not in this database — a mark against a set the player later
-- uninstalls the expansion for is simply a mark nothing draws.

-- The looks and sets somebody starred. The row's existence is the whole of the fact, which is
-- why there is no `favourite` column to be 0: un-starring deletes, and "starred" and "starred
-- and then un-starred" are the same state and only one of them should be representable.
CREATE TABLE transmog_favourites (
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('set', 'appearance')),
    subject_id   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (subject_kind, subject_id)
) STRICT, WITHOUT ROWID;

-- Everything else somebody wants to say, as a key and — where they said one — a value.
--
-- One table for both halves of what was asked for. A label is a key with nothing after it and
-- a property is a key with something after it, and they are the same act with the same editor
-- and the same filter behind it: `NULL` is the label and a string is the property. That also
-- makes the third state impossible to write, which is the point of storing it this way —
-- `''` would be a value that filters like a property and reads like a label.
--
-- `COLLATE NOCASE` on the key is what stops "Faction" and "faction" being two tags on one
-- look while still keeping whichever of them was typed. Applying a tag a subject already
-- carries replaces its value, which is what the primary key here says and what somebody
-- correcting a typo means by typing it again.
CREATE TABLE transmog_tags (
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('set', 'appearance')),
    subject_id   INTEGER NOT NULL,
    key          TEXT NOT NULL COLLATE NOCASE,
    value        TEXT,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (subject_kind, subject_id, key)
) STRICT, WITHOUT ROWID;

-- Every subject carrying one key, which is the question the filter above the browser asks:
-- the picker offers the keys in use and the browser then wants the subjects under one of them.
CREATE INDEX transmog_tags_by_key ON transmog_tags(key, subject_kind);
