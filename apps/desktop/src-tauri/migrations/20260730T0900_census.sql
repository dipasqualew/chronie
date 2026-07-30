-- What the account holds, as opposed to what it was watched collecting.
--
-- Everything else the addon sends is a record of something happening: a segment, a gain, a kill.
-- That is the right shape for a history and the wrong shape for a collection, because a history
-- of gains can only ever describe an account Chronie has watched from the beginning. An
-- achievement earned in 2011, a mount bought on a laptop, an evening a crash took with it — none
-- of them is a gain anybody saw, and no amount of watching will produce one.
--
-- So the addon also walks the client's own lists and writes down what it finds, and these are the
-- tables that receive it. `apps/addon/src/Census.lua` is the walk; `docs/account-census.md` is the
-- argument for why it runs when it does rather than on a timer.
--
-- **`census_domains` is the mechanism and the per-domain tables are adapters.** The claim a walk
-- makes — was it whole, of which build, by whom, how much did it find — is the same claim for
-- every kind of thing and is kept once, here. What a mount *is* differs from what an achievement
-- is, so those get a table each. A new domain is a table and a reader, and nothing in this file
-- changes.

-- One walk's claim about one kind of thing.
--
-- **`complete` is the only column that licenses a reader to treat an absence as a removal**, and
-- it is the whole of the reconciliation rule. A walk that finished asked about every id the client
-- named, so what it did not write down is not held; a walk that was cut short by a logout is a
-- set of positive observations and nothing more. The addon demotes the flag the moment a pass
-- starts and restores it only when one finishes, so a file caught mid-pass says so itself.
CREATE TABLE census_domains (
    id           INTEGER PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- "mounts", "achievements". The addon's own word for the domain, and a key readers join on,
    -- so it is stable in a way the table names below are free not to be.
    domain       TEXT NOT NULL,
    -- Null for a domain every character answers the same for — mounts, achievements, appearances
    -- — which is kept once because keeping it per character would be the same answer stored once
    -- per alt. A character-scoped domain, when one arrives, names its character here, the way
    -- `character_currencies` does next door.
    character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
    complete     INTEGER NOT NULL,
    -- Bumped by the addon every time a pass finishes. A reader holding this revision is holding
    -- these entries, which is what lets a sync skip a domain nothing has walked since.
    revision     INTEGER NOT NULL,
    -- How many entries the walk ended up with, and what the client's own counter said at the same
    -- moment. Kept side by side on purpose: they are what the addon compares to decide whether a
    -- census is still true, and a reader that wants to know whether to trust one asks the same
    -- question the same way. `counted` is null for a domain whose client offers no counter.
    held         INTEGER NOT NULL,
    counted      INTEGER,
    -- Which game this was a census of. A patch adds mounts and retires achievements, so a census
    -- taken against an older build is a census of a different game and the addon walks it again.
    build        TEXT,
    -- Which character did the walking, for an account-wide domain. Not who owns the result —
    -- the account does — but who to blame for it, which matters when two characters disagree.
    walked_by    TEXT,
    started_at   INTEGER,
    completed_at INTEGER,
    observed_at  INTEGER NOT NULL
) STRICT;

-- One row per (account, domain, scope). Expressed over `IFNULL` rather than as a primary key
-- because the account-wide case genuinely has no character, and a NULL in a WITHOUT ROWID primary
-- key is not a key at all.
CREATE UNIQUE INDEX census_domains_key
    ON census_domains (account_id, domain, IFNULL(character_id, 0));

-- Every mount the account can summon.
--
-- Stored as the client's own mount ids and nothing else that the game's files already answer.
-- The name rides along because the addon has it localised and free, and because a machine with no
-- game installed still has to be able to draw this list — the same bargain `character_looks`
-- makes. Everything richer than a name is read out of the install when it is asked for.
CREATE TABLE account_mounts (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- `C_MountJournal`'s own mount id, which is what `GetMountInfoByID` takes.
    mount_id   INTEGER NOT NULL,
    name       TEXT,
    spell_id   INTEGER,
    -- `sourceType` — drop, vendor, achievement and so on, in the client's numbering.
    source     INTEGER,
    -- The player's own arrangement rather than facts about the mount, and worth keeping for
    -- exactly that reason: "hidden on this character" is how somebody says a mount is not really
    -- theirs to ride, and a list that ignored it would disagree with the journal they can see.
    favourite  INTEGER NOT NULL DEFAULT 0,
    hidden     INTEGER NOT NULL DEFAULT 0,
    -- `PvPFaction` for a mount only one side can ride; null for the great majority.
    faction    INTEGER,
    seen_at    INTEGER,
    PRIMARY KEY (account_id, mount_id)
) STRICT, WITHOUT ROWID;

-- Every achievement the account has earned, and which character earned it.
--
-- This is the row the census exists for. `GetAchievementInfo` reports completion for the
-- **account** and `wasEarnedByMe` for whoever is asking, and hands over `earnedBy` — the name of
-- the alt that actually did it — beside them. So one character reports the whole account's
-- history and attributes each line of it, without waiting for any other character to log in.
CREATE TABLE account_achievements (
    account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    achievement_id INTEGER NOT NULL,
    name           TEXT,
    points         INTEGER,
    -- The day it was earned, as the client states it: three numbers and no clock. Kept as three
    -- rather than resolved to an instant, because a local calendar date has no instant in it
    -- without a decision about time zones, and inventing one would put a date on screen that
    -- disagrees with the one the game's own achievement pane shows.
    earned_year    INTEGER,
    earned_month   INTEGER,
    earned_day     INTEGER,
    -- Whether the character that walked it is the one that earned it, and — when it is not —
    -- who did. Null `earned_by` with `earned_by_walker` set is the ordinary case.
    earned_by_walker INTEGER NOT NULL DEFAULT 0,
    earned_by      TEXT,
    seen_at        INTEGER,
    PRIMARY KEY (account_id, achievement_id)
) STRICT, WITHOUT ROWID;
