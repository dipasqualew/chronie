-- The long tail of the account's grow-only collections: pets, toys, heirlooms and titles.
--
-- Four tables rather than one, for the reason `census_domains` is kept apart from all of them:
-- what a reading *claims* is the same shape for every kind of thing and what a thing *is* is not.
-- A pet has a count because the game lets somebody own several; an heirloom has an upgrade level
-- and a ceiling; a title has a side of the name it goes on. None of that folds into a column
-- everything shares, and a table per domain is what `docs/account-census.md` says adding one is.
--
-- Three of the four are the account's and the fourth is one character's. That is not a filing
-- decision, it is what the game means: a pet, a toy and an heirloom are bought once for the
-- warband, and a title is earned by whoever earned it.

-- Every battle pet the account owns, counted by species.
--
-- **The one collectible with a count**, because it is the one the game lets somebody own several
-- of. `C_PetJournal.GetOwnedPetIDs` hands over a GUID per pet and a collection is counted in
-- species — three Mechanical Squirrels are one line of the pet journal — so the id here is the
-- species and `count` is how many of it the account holds, taken from the client's own
-- `GetNumCollectedInfo` rather than tallied by the walk. A GUID could not have been the key in any
-- case: it is a string like `BattlePet-0-000008B1F3A1`, and every census id is a number.
CREATE TABLE account_pets (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- `BattlePetSpecies`' own id, which is what the journal counts by and what the desktop would
    -- enter the game's tables through if it ever draws the ones nobody has.
    species_id INTEGER NOT NULL,
    name       TEXT,
    -- How many of the species the account has, which is the number the pet journal draws under
    -- the portrait. One for almost everything; three is somebody who kept the duplicates.
    count      INTEGER NOT NULL DEFAULT 0,
    -- The best of them: the highest level owned, and that pet's nickname if it has one. A species
    -- is the unit, so a level has to be some pet's, and the highest is the only choice that does
    -- not depend on the order the client handed the GUIDs over in.
    level      INTEGER,
    custom_name TEXT,
    -- True when any one of the species' pets is a favourite, which is what the journal puts a
    -- star on. The player's own arrangement rather than a fact about the pet, kept for the reason
    -- `account_mounts.favourite` is.
    favourite  INTEGER NOT NULL DEFAULT 0,
    seen_at    INTEGER,
    PRIMARY KEY (account_id, species_id)
) STRICT, WITHOUT ROWID;

-- Every toy the account can pull out of the box.
--
-- **Never pruned**, like `account_appearances` and for a related reason. `C_ToyBox` has one
-- indexer, `GetToyFromIndex`, and Blizzard's own `blizzard_toybox.lua` on 12.0.5.67823 pairs it
-- with `GetNumFilteredToys` in both places it uses it — so the list the addon walks is very
-- probably the one the player's filters left standing, and `ns.toyCensus` marks the domain
-- `partial` rather than claim otherwise. Toys are grow-only, so what that costs is nothing: an id
-- missing from a reading is a toy the walk was not shown, never one the account lost.
CREATE TABLE account_toys (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- The toy's own item id, which is what `PlayerHasToy` takes and what `Toy` is keyed by.
    item_id    INTEGER NOT NULL,
    name       TEXT,
    favourite  INTEGER NOT NULL DEFAULT 0,
    seen_at    INTEGER,
    PRIMARY KEY (account_id, item_id)
) STRICT, WITHOUT ROWID;

-- Every heirloom the account has bought, and how far each has been taken.
--
-- Never pruned either, and for the same unsettled reason: nothing in Blizzard's own interface
-- calls `C_Heirloom.GetHeirloomItemIDs`, so nothing in the install says whether it answers past
-- the heirloom pane's class, spec and source filters — see `ns.heirloomCensus`, which says what
-- would settle it. Heirlooms are grow-only, so the refusal to prune costs nothing at all.
CREATE TABLE account_heirlooms (
    account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    item_id       INTEGER NOT NULL,
    name          TEXT,
    -- `INVTYPE_HEAD` and the rest, straight from the client. The one thing about an heirloom a
    -- machine with no install can group the list by.
    slot          TEXT,
    -- How far it has been taken and how far it goes, which is the heirloom's version of a
    -- currency's cap: "is this one finished with" is a question no amount of watching somebody buy
    -- an upgrade would answer for the ones bought years ago. Nullable rather than defaulted,
    -- because a ceiling this client build would not state is not a ceiling of nought.
    upgrade_level INTEGER,
    max_upgrade   INTEGER,
    -- The client's own source enum, as `account_mounts.source` is.
    source        INTEGER,
    seen_at       INTEGER,
    PRIMARY KEY (account_id, item_id)
) STRICT, WITHOUT ROWID;

-- Every title one character may put before or after their name.
--
-- The second `scope = "character"` domain after the wallet and the standing, and the plainest case
-- of it: two alts of one account share almost no titles, so a walk by one says nothing whatever
-- about the others and a complete walk prunes that character's rows and nobody else's.
CREATE TABLE census_titles (
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- Never null, for the reason `census_currencies.character_id` is not.
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    -- The client's own title mask id — `CharTitles`' id, which is what `IsTitleKnown` takes.
    title_id     INTEGER NOT NULL,
    -- Stored trimmed. The client hands these over already spaced for the player's name, and
    -- Blizzard's own `TitleUtil.GetNameFromTitleMaskID` trims them for display.
    name         TEXT,
    -- Which side of the name it goes on, which is the one thing the trimmed-away space said:
    -- " the Explorer" follows the name and "Sergeant " precedes it.
    suffix       INTEGER NOT NULL DEFAULT 0,
    seen_at      INTEGER,
    PRIMARY KEY (account_id, character_id, title_id)
) STRICT, WITHOUT ROWID;
