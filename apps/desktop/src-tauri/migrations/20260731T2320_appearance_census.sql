-- Every look the account has collected, so that the wardrobe can tell one apart from one it has
-- never seen.
--
-- `wardrobe.rs` reads all 55,198 appearances of a shipping install out of `ItemAppearance` and
-- `transmog.rs` reads the sets that name them, and until this table neither knew whether the
-- reader owned any of it: a look ten years in the wardrobe was drawn exactly like one nobody had
-- ever laid eyes on. This is the other half of that subtraction, and it is the largest single
-- thing the census can light up.
--
-- **The reading is never whole, and that is by design rather than by accident.** The client
-- answers `C_TransmogCollection.GetCategoryAppearances` through the logged-in character's class
-- filter, so a mage is not shown plate however faithfully the walk runs — see
-- `ns.appearanceCensus`, which marks the domain `partial` for exactly that reason. So the account's
-- wardrobe here is the *union* of what its characters have each been able to see, built up as they
-- are played, and `census_domains.complete` for this domain stays 0 forever. Which means these
-- rows are only ever added to: nothing in `collector::census` may delete one, because an id
-- missing from a reading is a look the walker was never shown rather than a look the account lost.
--
-- The alternative was driving `C_TransmogCollection.SetClassFilter` over all thirteen classes from
-- one character, which is complete in a single login and leaves the player's own wardrobe filtered
-- to somebody else's class if the session ends mid-walk. Issue #250 settled on the union.
CREATE TABLE account_appearances (
    account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- The client's own `visualID`, which is the id of the `ItemAppearance` row the desktop reads
    -- everything else about the look from. That the two are the same number is what makes this
    -- table worth having: `wardrobe.rs` keys its rows on it and joins for nothing.
    appearance_id INTEGER NOT NULL,
    -- `Enum.TransmogCollectionType` — 1 to 11 the armour slots, 12 to 29 what is held in a hand.
    -- The one thing this domain can say about a look without the game's own tables, which is what
    -- lets a machine with no install still count a reader's heads. Not the same numbering as
    -- `ItemAppearance`'s display type, so nothing may join the two on it.
    category      INTEGER,
    -- The player's own arrangement rather than a fact about the look, kept for the reason
    -- `account_mounts.favourite` is: a list that ignored it would disagree with the wardrobe they
    -- are looking at in the game.
    favourite     INTEGER NOT NULL DEFAULT 0,
    seen_at       INTEGER,
    PRIMARY KEY (account_id, appearance_id)
) STRICT, WITHOUT ROWID;
