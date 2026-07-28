-- The transmog sets the player saved in the game itself, as against the ones saved in here.
--
-- `0017_custom_sets.sql` above is the reader's own wardrobe, assembled in this app and known
-- only to it. These two tables are the other half of the same idea, and the half that was
-- always missing: the sets the player already had, put together at a transmogrifier months
-- before Chronie was installed, which the app could not see and so kept asking them to build
-- again. Midnight is what makes reading them possible — see `docs/transmog-sets.md`, which is
-- the looking that settled it — and the addon is what carries them out.
--
-- **Stored as appearance ids and nothing else**, which is the opposite of the decision one
-- migration above, and the difference is worth stating because the two tables sit side by side
-- and disagree. A set saved in the app is stored as what the reader was looking at, because
-- what they were looking at is the only record of it: nothing else in the world holds that
-- outfit. A set saved in the game is held by Blizzard's own servers, and the addon can only
-- report the ids; the rest — the item, its name, its picture, the display it is drawn from —
-- is read out of the installed game exactly as it is for every Blizzard set the view already
-- browses. Writing those down here would be caching a second copy of the game's files in a
-- database, and it would go stale on the next patch.
--
-- The consequence is honest and worth knowing: an in-game set can be *listed* without the game
-- installed, because its name lives here, but it cannot be *opened* without it. A set of the
-- reader's own can be opened either way.

CREATE TABLE character_transmog_sets (
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    -- The client's own id for the set, which survives a rename and is what the app names a
    -- set by when it asks the addon to change one.
    set_id       INTEGER NOT NULL,
    name         TEXT NOT NULL,
    -- The FileDataID of the picture the game shows it under, where it names one. The game
    -- picks it from the first piece in the set, so a set with nothing in it has none.
    icon         INTEGER,
    -- When the addon last saw the wardrobe *differ*, rather than when it last looked. The
    -- addon only moves this when two looks disagree, so it means what it says.
    observed_at  INTEGER,
    PRIMARY KEY (character_id, set_id)
) STRICT, WITHOUT ROWID;

-- What one of them is made of. At most one appearance per slot, which is the game's own rule:
-- `GetCustomSetItemTransmogInfoList` answers one `ItemTransmogInfo` per `TransmogSlot` and
-- there are thirteen of them.
--
-- `slot` is the client's `TransmogSlot`: 0 head, 1 shoulder, 2 back, 3 chest, 4 body, 5 tabard,
-- 6 wrist, 7 hand, 8 waist, 9 legs, 10 feet, 11 main hand, 12 off hand. Kept as the game's own
-- number rather than translated into the window's word for a place, because it is the one thing
-- in the whole chain that says which *hand* a one-hander is held in — a question `outfit.ts`
-- otherwise has to settle by guessing from the inventory type.
--
-- The two nullable columns are the parts of an `ItemTransmogInfo` a slot usually has not got:
-- a second appearance, and the enchant illusion on a weapon. The client reports both as `0`
-- when there is none, and the addon drops that zero rather than carrying it, so NULL here means
-- what an absent row means everywhere else in this database — nobody claimed anything.
CREATE TABLE character_transmog_set_slots (
    character_id             INTEGER NOT NULL,
    set_id                   INTEGER NOT NULL,
    slot                     INTEGER NOT NULL,
    -- An `ItemModifiedAppearance` id: the game's own unit of collection, and the same number a
    -- piece of a set saved in this app carries. That is what lets one row of each be drawn by
    -- the same code and starred by the same mark.
    appearance_id            INTEGER NOT NULL,
    secondary_appearance_id  INTEGER,
    illusion_id              INTEGER,
    PRIMARY KEY (character_id, set_id, slot),
    FOREIGN KEY (character_id, set_id)
        REFERENCES character_transmog_sets(character_id, set_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
