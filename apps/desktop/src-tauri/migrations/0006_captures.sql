-- The things a player thought were worth remembering, and the images Chronie now holds for
-- them.
--
-- Deliberately not a child table of `segments`. Every other outcome table is rebuilt from
-- SavedVariables on each sync — `clear_outcomes` deletes the lot for a segment and inserts
-- them again — which is safe only because those rows are copies of something the file still
-- says. A capture is not: by the time its row exists Chronie has already taken custody of a
-- file, and deleting the row would leave that file on disk with nothing pointing at it. So
-- captures are keyed by the addon's own id, upserted, and never bulk-deleted by segment.
--
-- The segment is a link, not an owner. `ON DELETE SET NULL` says exactly that: a segment
-- that goes away leaves the photograph behind, unattached.
--
-- The row is the record; the path is one way of resolving it. `content_hash` and
-- `byte_size` describe the image itself rather than where it happens to live, so a later
-- backend — a shared folder, a pack, something remote — can verify that what it is holding
-- is what this row means, and a file that has been moved, truncated or replaced is
-- detectable instead of appearing in the app as a silent blank.
CREATE TABLE captures (
    id                INTEGER PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- The addon's own id for the entry, unique across accounts and not merely within one,
    -- which is why the constraint is global rather than per account. It is what makes
    -- ingesting the same capture twice impossible.
    source_id         TEXT NOT NULL UNIQUE,
    -- The shape version the addon stamped the entry with, so a reader can tell an old row
    -- from a new one without guessing from which columns happen to be NULL.
    schema            INTEGER,
    character_id      INTEGER REFERENCES characters(id) ON DELETE CASCADE,
    -- The account that made it, which is account-level rather than per character: entries
    -- are meant to be shareable, and the author of one outlives the character who was
    -- logged in at the time.
    author            TEXT,
    -- The segment as the addon named it — `character|startedAt|instance` — kept verbatim
    -- next to the resolved link. The two are not redundant: the capture can arrive before
    -- the segment it belongs to has been filed, and the text is what lets a later sync
    -- resolve the link that could not be made at the time.
    segment_source_id TEXT,
    segment_id        INTEGER REFERENCES segments(id) ON DELETE SET NULL,
    -- Both clocks the addon recorded. The epoch is what ordering and retention are done on;
    -- the local stamp, "MMDDYY_HHMMSS", is the half that pairs the marker with the file the
    -- client named `WoWScrnShot_<stamp>`.
    captured_at       INTEGER NOT NULL,
    stamp             TEXT,
    ui_map_id         INTEGER,
    -- Normalised across the map, 0..1, and NULL together: most instanced content gives the
    -- map and refuses the point, and a fabricated 0,0 reads as the top left corner.
    map_x             REAL,
    map_y             REAL,
    -- What Chronie has of the image. 'none' is an entry that never asked for one — a note
    -- rather than a screenshot. 'missing' is a marker whose file could not be found, which
    -- is recorded rather than dropped so that it can be shown, explained, and retried.
    image_state       TEXT NOT NULL CHECK (image_state IN ('none', 'stored', 'missing')),
    -- Where the image sits inside Chronie's own store, relative to its root, so that moving
    -- the store or restoring it onto another machine does not invalidate every row.
    file_path         TEXT,
    -- What the game called the file before Chronie took it, kept because it is the only
    -- thread back to the folder the image came out of.
    source_name       TEXT,
    byte_size         INTEGER,
    content_hash      TEXT,
    ingested_at       INTEGER,
    first_seen_at     INTEGER NOT NULL,
    last_seen_at      INTEGER NOT NULL
) STRICT;

-- What a segment was photographed with, which is how the app draws them beside it.
CREATE INDEX captures_by_segment ON captures(segment_id);

-- The whole store newest first, for a gallery that is not filtered by anything.
CREATE INDEX captures_by_time ON captures(captured_at DESC, id DESC);

-- The markers still hoping for a file. Partial, because it is read on every sync and the
-- rows it has to find are the rare ones.
CREATE INDEX captures_unresolved ON captures(stamp) WHERE image_state = 'missing';
