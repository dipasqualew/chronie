-- Outfits this app has asked the game to hold on to, and what came of each.
--
-- The other direction. Everything else Chronie stores was read out of a file the game wrote;
-- this is the one thing it says back, and the road it travels is not the same road. A
-- SavedVariables file is read by the client once at load and rewritten wholesale at logout, so
-- the app cannot leave a message there — it would never be read and would then be destroyed.
-- What the app writes instead is a source file of the addon's own, listed in `chronie.toc`,
-- which the client loads and never writes. `docs/transmog-sets.md` is where that was settled.
--
-- **A request outlives the thing it asked for**, which is why this is a table and not a file
-- written and forgotten. The app has no way to know the game ever loaded: the player may not
-- log in for a week, may log in on a machine this app is not running on, may have the addon
-- disabled. So the request is kept, written into the addon's folder on every install and every
-- send, and only stops being written once the addon has said what became of it. That
-- acknowledgement comes back the ordinary way, in SavedVariables, and lands in the three
-- columns at the bottom.
--
-- The name is what a send is keyed on rather than any id, and that is the whole of the
-- create-or-replace rule: sending "Winter" twice saves over the set called Winter rather than
-- leaving the player with two of them. It matches how this app already saves a set of its own —
-- see `0017_custom_sets.sql`'s `COLLATE NOCASE UNIQUE` — and how the game's own dialog offers to
-- overwrite. It is deliberately *not* UNIQUE here, because two sends of one name a month apart
-- are two things that happened and the second is not a correction of the first.

CREATE TABLE transmog_set_requests (
    -- AUTOINCREMENT, because this id crosses into the game's own folder and comes back again:
    -- the addon remembers which requests it has carried out by it, and SQLite handing a deleted
    -- row's id to the next request would have the addon skip a set it had never saved.
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    -- The picture to give it, as a FileDataID, where the app had one to give. The game picks
    -- its own from the first piece when it is not told.
    icon        INTEGER,
    created_at  INTEGER NOT NULL,
    -- When the addon carried it out, what it did, and which set resulted. All three NULL means
    -- the request has not been answered yet — which is exactly the set of rows that gets written
    -- into the addon's folder.
    applied_at  INTEGER,
    outcome     TEXT,
    set_id      INTEGER
) STRICT;

-- What goes in one. The same shape as the slots of a set read back out of the game, and
-- deliberately: a send is an outfit expressed in the game's own vocabulary, so that the addon
-- has nothing to translate and this app has one idea of what a slot is.
--
-- `slot` is the client's `TransmogSlot`, 0 head through 12 off hand — see
-- `0018_in_game_sets.sql`, which spells the whole list.
CREATE TABLE transmog_set_request_slots (
    request_id              INTEGER NOT NULL
                            REFERENCES transmog_set_requests(id) ON DELETE CASCADE,
    slot                    INTEGER NOT NULL,
    appearance_id           INTEGER NOT NULL,
    secondary_appearance_id INTEGER,
    illusion_id             INTEGER,
    PRIMARY KEY (request_id, slot)
) STRICT, WITHOUT ROWID;

-- The one question asked of this table on every install and every send: what is still waiting.
CREATE INDEX transmog_set_requests_waiting ON transmog_set_requests(applied_at);
