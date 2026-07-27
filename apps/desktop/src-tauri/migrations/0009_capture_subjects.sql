-- What a capture is of, when Chronie took it by itself rather than being asked.
--
-- A capture has always hung off the segment it happened in. That is where it was, not what
-- it was: an account-first achievement is the reason the photograph exists, and the segment
-- around it is incidental. So the row gains a second, narrower link.
--
-- Explicitly one nullable column per subject kind rather than a polymorphic
-- `subject_type`/`subject_id` pair. There will only ever be a handful of kinds, the tables
-- are STRICT, and a real foreign key gets referential integrity and cascade behaviour that
-- a polymorphic column cannot: a subject that goes away leaves the photograph behind rather
-- than leaving it pointing at a row number some other table has since reused.

-- Which rule fired it — see ns.newCaptureTriggers in the addon. NULL is a capture a person
-- pressed the key for, and that is the whole difference between the two.
--
-- Not called `trigger`, which is a keyword SQLite would want quoted at every use.
ALTER TABLE captures ADD COLUMN trigger_name TEXT;

-- The achievement as the game numbers it, kept verbatim beside the resolved link for the
-- same reason `segment_source_id` is: a capture can arrive before the segment that lists the
-- achievement has been filed, and this is what lets a later sync resolve a link that could
-- not be made at the time.
--
-- It is also what lets the link be *re*-resolved. The rows in `achievements` are children of
-- a segment, and every sync deletes and reinserts the children of every segment the file
-- still describes — so their rowids do not survive a sync, and a link stored once would be
-- pointing somewhere wrong by the next one. See `link_capture_achievements`.
ALTER TABLE captures ADD COLUMN achievement_source_id INTEGER;

-- ON DELETE SET NULL, matching the segment link above it: a segment aging out of the rolling
-- week takes its achievements with it, and the photograph of one outlives both.
ALTER TABLE captures ADD COLUMN achievement_id INTEGER
    REFERENCES achievements(id) ON DELETE SET NULL;

-- What an achievement was photographed with, which is how the app draws the picture beside
-- the thing it is of.
CREATE INDEX captures_by_achievement ON captures(achievement_id);

-- The captures with a subject to resolve, which is the set `link_capture_achievements`
-- walks on every sync. Partial, because most captures are of nothing in particular.
CREATE INDEX captures_wanting_a_subject
    ON captures(achievement_source_id)
    WHERE achievement_source_id IS NOT NULL;
