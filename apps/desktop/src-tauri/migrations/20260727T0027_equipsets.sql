-- What happened to a character's equipment sets, and what each of their slots has held.
--
-- The client never says which set changed or how, only that something did, so the addon
-- keeps the last look and subtracts. What arrives here is already the difference: a set
-- that appeared, one that went away, or one whose items were edited.

CREATE TABLE equipset_changes (
    id            INTEGER PRIMARY KEY,
    segment_id    INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    character_id  INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    -- The client's own id for the set. Unique per character and no further, which is why
    -- every read of this ledger is keyed by the character as well.
    set_id        INTEGER NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL CHECK (kind IN ('created', 'deleted', 'updated')),
    changed_at    INTEGER,
    UNIQUE (segment_id, position)
) STRICT;

CREATE INDEX equipset_changes_by_segment ON equipset_changes(segment_id);

-- The ledger proper: one row per slot per change, saying what the slot holds afterwards.
--
-- There is deliberately no "before" column. The row before this one for the same character,
-- set and slot is the before, so the latest row per (character_id, set_id, slot) is that
-- slot's current contents and the one behind it is what it replaced. Storing both sides
-- would only create two places for them to disagree.
--
-- A NULL item_id is a slot the change emptied — one cleared by an edit, or every slot of a
-- set that was deleted — and the row is still worth writing, because "the head slot was
-- cleared" is as much a fact about the set as any item ever put in it.
CREATE TABLE equipset_slots (
    id            INTEGER PRIMARY KEY,
    change_id     INTEGER NOT NULL REFERENCES equipset_changes(id) ON DELETE CASCADE,
    character_id  INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    set_id        INTEGER NOT NULL,
    -- Inventory slot id: 1 head, 2 neck, 3 shoulder, and so on to 19 tabard.
    slot          INTEGER NOT NULL,
    item_id       INTEGER,
    -- What the item was actually worth — upgrades, sockets and crafted quality included —
    -- read off the equipped item at the moment of the change, because saving a set saves
    -- what the character is wearing. NULL for a change only noticed at a later login, when
    -- the item that went into the slot was no longer on the character to be asked.
    item_level    INTEGER,
    item_name     TEXT,
    changed_at    INTEGER,
    UNIQUE (change_id, slot)
) STRICT;

-- The ledger is read one way — "what has this slot held, newest first" — and this is that
-- question as an index. `id` closes out the ties: two changes can land in the same second.
CREATE INDEX equipset_slots_history
    ON equipset_slots(character_id, set_id, slot, changed_at DESC, id DESC);
