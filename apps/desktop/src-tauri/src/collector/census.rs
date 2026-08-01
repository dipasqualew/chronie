//! What the account holds, and how much of a claim each reading is.
//!
//! Every other domain in here writes down something that happened. This one writes down where
//! things *stand*, which is a different problem with a different failure mode: a history that
//! misses an event is short by one line, and a state that misses one is simply wrong.
//!
//! The whole module turns on a single rule, and it is worth stating before any of the code:
//!
//! > **An absence means a removal only inside a reading that says it is complete.**
//!
//! The addon walks the client's own lists and marks the walk complete when it asked about every id
//! the client named. Anything less than that — a logout mid-walk, a client build with no such API,
//! an addon older than this app — arrives with the flag down, and is folded in as a set of
//! positive observations that can add and update but never delete. That one rule is what makes an
//! interrupted sync safe, and it is why [`sync_census`] takes the flag from the file rather than
//! inferring completeness from how much arrived.
//!
//! The bookkeeping is generic and the storage is not. `census_domains` holds the claim, which is
//! the same shape for every kind of thing; `account_mounts`, `account_achievements`,
//! `census_currencies` and `census_standings` hold what a mount, an achievement, a wallet and a
//! reputation actually are, which is not. Adding a domain is a table and a reader.

use rusqlite::{params, Transaction};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

use crate::dto;
use crate::failure::Failure;
use crate::saved_variables::{
    RawCensus, RawCensusAchievement, RawCensusAppearance, RawCensusCurrency, RawCensusHeirloom,
    RawCensusMount, RawCensusPet, RawCensusStanding, RawCensusState, RawCensusTitle, RawCensusToy,
};

use super::database::open_database;
use super::roster::upsert_character_key;

/// The domains this build knows how to store, and the table each one lives in.
///
/// A domain the addon sends that is not in here is not an error: a newer addon beside an older app
/// is the ordinary way a pair of these drift, and the claim is still worth recording even when the
/// entries cannot be. So the claim is written for every domain and the entries only for these.
const MOUNTS: &str = "mounts";
const ACHIEVEMENTS: &str = "achievements";
const CURRENCIES: &str = "currencies";
const REPUTATIONS: &str = "reputations";
const APPEARANCES: &str = "appearances";
const PETS: &str = "pets";
const TOYS: &str = "toys";
const HEIRLOOMS: &str = "heirlooms";
const TITLES: &str = "titles";

pub(super) fn sync_census(
    transaction: &Transaction<'_>,
    account_id: i64,
    census: &RawCensus,
    now: i64,
) -> Result<(), Failure> {
    for (domain, state) in &census.account {
        sync_domain(transaction, account_id, None, domain, state, now)?;
    }
    for (character, domains) in &census.characters {
        let character_id =
            upsert_character_key(transaction, account_id, character, None, None, now)?;
        for (domain, state) in domains {
            sync_domain(
                transaction,
                account_id,
                Some(character_id),
                domain,
                state,
                now,
            )?;
        }
    }
    Ok(())
}

/// One domain's claim, and then its entries.
///
/// The claim goes in whatever the entries turn out to be, because it is the claim that says how to
/// read them — an app that stored entries it could not qualify would be storing something it has
/// no way to trust later.
fn sync_domain(
    transaction: &Transaction<'_>,
    account_id: i64,
    character_id: Option<i64>,
    domain: &str,
    state: &RawCensusState,
    now: i64,
) -> Result<(), Failure> {
    let complete = state.complete.unwrap_or(false);
    transaction.execute(
        "INSERT INTO census_domains (
                 account_id, domain, character_id, complete, revision, held, counted,
                 build, walked_by, started_at, completed_at, observed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(account_id, domain, IFNULL(character_id, 0)) DO UPDATE SET
                 complete = excluded.complete,
                 revision = excluded.revision,
                 held = excluded.held,
                 counted = excluded.counted,
                 build = excluded.build,
                 walked_by = excluded.walked_by,
                 started_at = excluded.started_at,
                 completed_at = excluded.completed_at,
                 observed_at = excluded.observed_at",
        params![
            account_id,
            domain,
            character_id,
            i64::from(complete),
            state.revision.unwrap_or(0),
            state.held.unwrap_or(0),
            state.counted,
            state.build.as_deref(),
            state.by.as_deref(),
            state.started_at,
            state.completed_at,
            now,
        ],
    )?;

    match (domain, character_id) {
        (MOUNTS, _) => sync_mounts(transaction, account_id, state, complete),
        (APPEARANCES, _) => sync_appearances(transaction, account_id, state),
        (ACHIEVEMENTS, _) => sync_achievements(transaction, account_id, state, complete),
        (PETS, _) => sync_pets(transaction, account_id, state, complete),
        // No `complete` and nowhere to put one, exactly as appearances have none: `ns.toyCensus`
        // and `ns.heirloomCensus` both mark their domain `partial` because the client's own list
        // is very probably the player's filtered one, so an id missing from a reading is a thing
        // the walk was not shown rather than a thing the account lost. Both collections are
        // grow-only, which is what makes never pruning them cost nothing.
        (TOYS, _) => sync_toys(transaction, account_id, state),
        (HEIRLOOMS, _) => sync_heirlooms(transaction, account_id, state),
        // A title is one character's, so a reading filed against the account has nowhere to go —
        // the same nowhere a wallet has, and the claim above is what says a reading arrived and
        // was not stored.
        (TITLES, Some(character_id)) => {
            sync_titles(transaction, account_id, character_id, state, complete)
        }
        // A wallet belongs to a character, so a currencies reading filed against the account has
        // nowhere to go: there is no column for "whoever's" and summing it into one of the alts
        // would be inventing an owner. The claim above still stands, which is what says a reading
        // arrived and was not stored.
        (CURRENCIES, Some(character_id)) => {
            sync_currencies(transaction, account_id, character_id, state, complete)
        }
        // A standing belongs to a character for the same reason a wallet does: two alts at
        // different renown are two standings, not one that keeps being replaced. Filed against
        // the account it has nowhere to go, and the claim above is what says so.
        (REPUTATIONS, Some(character_id)) => {
            sync_standings(transaction, account_id, character_id, state, complete)
        }
        // A domain a newer addon sends and this build has no table for. The claim above is kept so
        // that a later build can tell it has never imported these entries, and nothing else
        // happens — which is the same tolerance every unknown field in this file gets.
        _ => Ok(()),
    }
}

/// The ids an incoming reading actually carried, so a complete one can say what it did not.
///
/// A key that is not a number is not an id. The addon keys these by the client's own id and Lua
/// hands every table key over as a string, so this is the same parse `holdings` does for currency
/// ids — and the same refusal for anything else, which is what keeps a hand-edited file from
/// deleting rows.
fn ids_of(state: &RawCensusState) -> BTreeSet<i64> {
    state
        .entries
        .keys()
        .filter_map(|key| key.parse::<i64>().ok())
        .collect()
}

/// Everything a complete reading did not mention, taken back out.
///
/// **Only ever called for a complete reading.** The `ids` are turned into a comma-joined literal
/// rather than bound one at a time because an established account's achievement census is thirteen
/// thousand of them and SQLite's parameter limit is under a thousand; they are `i64` parsed out of
/// the file above, so there is nothing here a string could carry into the statement.
///
/// `character` narrows it to one character's rows, and a character-scoped domain must pass one:
/// a walk by an alt says what *that* alt holds and nothing whatever about the others, so a prune
/// that reached across the account would delete every other character's currencies every time one
/// of them logged out.
fn prune(
    transaction: &Transaction<'_>,
    table: &str,
    key: &str,
    account_id: i64,
    character: Option<i64>,
    ids: &BTreeSet<i64>,
) -> Result<(), Failure> {
    // A complete walk that found nothing is a real answer — a brand new account holds no mounts —
    // so the statement has to be able to empty the table. `NOT IN ()` is not valid SQL, which is
    // why the empty set is a clause that is not written rather than a value written into one.
    let mut clauses = String::from("account_id = ?1");
    let mut bound: Vec<&dyn rusqlite::ToSql> = vec![&account_id];
    if let Some(character) = character.as_ref() {
        clauses.push_str(" AND character_id = ?2");
        bound.push(character);
    }
    if !ids.is_empty() {
        let kept = ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        clauses.push_str(&format!(" AND {key} NOT IN ({kept})"));
    }
    transaction.execute(
        &format!("DELETE FROM {table} WHERE {clauses}"),
        bound.as_slice(),
    )?;
    Ok(())
}

fn typed<T: serde::de::DeserializeOwned + Default>(value: &Value) -> T {
    serde_json::from_value(value.clone()).unwrap_or_default()
}

fn sync_mounts(
    transaction: &Transaction<'_>,
    account_id: i64,
    state: &RawCensusState,
    complete: bool,
) -> Result<(), Failure> {
    for (key, value) in &state.entries {
        let Ok(mount_id) = key.parse::<i64>() else {
            continue;
        };
        let mount: RawCensusMount = typed(value);
        transaction.execute(
            "INSERT INTO account_mounts (
                     account_id, mount_id, name, spell_id, source, favourite, hidden,
                     faction, seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(account_id, mount_id) DO UPDATE SET
                     name = excluded.name,
                     spell_id = excluded.spell_id,
                     source = excluded.source,
                     favourite = excluded.favourite,
                     hidden = excluded.hidden,
                     faction = excluded.faction,
                     seen_at = excluded.seen_at",
            params![
                account_id,
                mount_id,
                mount.name.as_deref(),
                mount.spell,
                mount.source,
                i64::from(mount.favourite.unwrap_or(false)),
                i64::from(mount.hidden.unwrap_or(false)),
                mount.faction,
                mount.seen,
            ],
        )?;
    }
    if complete {
        prune(
            transaction,
            "account_mounts",
            "mount_id",
            account_id,
            None,
            &ids_of(state),
        )?;
    }
    Ok(())
}

/// Every look the account has collected, which is the only domain here that is never pruned.
///
/// **It takes no `complete` and has nowhere to put one.** The addon walks this through the
/// logged-in character's class filter — a mage is shown no plate — so a reading of it is one
/// character's share of the account's wardrobe and the account's wardrobe is the union of them,
/// built up as the roster is played. `ns.appearanceCensus` marks the domain `partial` and the
/// claim it writes has `complete` down forever, which is what stops [`sync_domain`] ever handing
/// this function a flag it would be wrong to act on. An id missing from a reading is a look the
/// walker was not shown, not a look the account lost, and there is no reading in which the
/// difference can be told from in here.
///
/// So the rows only ever accumulate — which is also why this is the one domain whose stored count
/// can exceed what any single walk reports, and why `census_domains.counted` beside it is worth
/// reading: that is the client's own unfiltered total, and the two together say how much of the
/// account's wardrobe the roster has managed to show us so far.
fn sync_appearances(
    transaction: &Transaction<'_>,
    account_id: i64,
    state: &RawCensusState,
) -> Result<(), Failure> {
    for (key, value) in &state.entries {
        let Ok(appearance_id) = key.parse::<i64>() else {
            continue;
        };
        let look: RawCensusAppearance = typed(value);
        transaction.execute(
            "INSERT INTO account_appearances (
                     account_id, appearance_id, category, favourite, seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(account_id, appearance_id) DO UPDATE SET
                     category = excluded.category,
                     favourite = excluded.favourite,
                     seen_at = excluded.seen_at",
            params![
                account_id,
                appearance_id,
                look.category,
                i64::from(look.favourite.unwrap_or(false)),
                look.seen,
            ],
        )?;
    }
    Ok(())
}

/// Every battle pet the account owns, counted by species.
///
/// The one domain whose row carries a *count*, because pets are the one collectible the game lets
/// an account own several of: three Mechanical Squirrels are three GUIDs in the client's answer and
/// one line of the pet journal, and the journal's line is what this stores. The count is the
/// client's own `GetNumCollectedInfo` rather than a tally of the walk, so a pass a logout cut short
/// still says how many of a species the account has rather than how many of them it reached.
///
/// Pruned like a mount is. A pet can be released or caged away, so an id a complete walk did not
/// mention is genuinely one the account no longer owns — which is what separates this from the two
/// grow-only collections below.
fn sync_pets(
    transaction: &Transaction<'_>,
    account_id: i64,
    state: &RawCensusState,
    complete: bool,
) -> Result<(), Failure> {
    for (key, value) in &state.entries {
        let Ok(species_id) = key.parse::<i64>() else {
            continue;
        };
        let pet: RawCensusPet = typed(value);
        transaction.execute(
            "INSERT INTO account_pets (
                     account_id, species_id, name, count, level, custom_name, favourite, seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(account_id, species_id) DO UPDATE SET
                     name = excluded.name,
                     count = excluded.count,
                     level = excluded.level,
                     custom_name = excluded.custom_name,
                     favourite = excluded.favourite,
                     seen_at = excluded.seen_at",
            params![
                account_id,
                species_id,
                pet.name.as_deref(),
                pet.count.unwrap_or(0),
                // Nullable, unlike the count: a pet the client would not state a level for is not
                // a pet at level nought, and nothing downstream may draw the two the same.
                pet.level,
                pet.custom.as_deref(),
                i64::from(pet.favourite.unwrap_or(false)),
                pet.seen,
            ],
        )?;
    }
    if complete {
        prune(
            transaction,
            "account_pets",
            "species_id",
            account_id,
            None,
            &ids_of(state),
        )?;
    }
    Ok(())
}

/// Every toy the account can pull out of the box, and one of the two domains here that is never
/// pruned.
///
/// **It takes no `complete` and has nowhere to put one**, for the reason [`sync_appearances`] does
/// not. `C_ToyBox` has a single indexer and Blizzard's own toy box pairs it with the *filtered*
/// count, so the list `ns.toyCensus` walks is very probably the one the player's filters left
/// standing; the domain says so by declaring itself `partial`, and the claim it writes has
/// `complete` down forever. An id missing from a reading is a toy the walk was not shown rather
/// than one the account lost — and since toys cannot be lost, there is nothing a prune could ever
/// have been right about.
fn sync_toys(
    transaction: &Transaction<'_>,
    account_id: i64,
    state: &RawCensusState,
) -> Result<(), Failure> {
    for (key, value) in &state.entries {
        let Ok(item_id) = key.parse::<i64>() else {
            continue;
        };
        let toy: RawCensusToy = typed(value);
        transaction.execute(
            "INSERT INTO account_toys (
                     account_id, item_id, name, favourite, seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(account_id, item_id) DO UPDATE SET
                     name = excluded.name,
                     favourite = excluded.favourite,
                     seen_at = excluded.seen_at",
            params![
                account_id,
                item_id,
                toy.name.as_deref(),
                i64::from(toy.favourite.unwrap_or(false)),
                toy.seen,
            ],
        )?;
    }
    Ok(())
}

/// Every heirloom the account has bought, and how far each has been taken.
///
/// Never pruned, like the toys above and for a related reason: nothing in Blizzard's own interface
/// calls `C_Heirloom.GetHeirloomItemIDs`, so nothing in the install settles whether it answers past
/// the heirloom pane's filters, and `ns.heirloomCensus` declines to claim what it cannot check.
/// Heirlooms are bought once and kept, so the refusal costs nothing.
///
/// `upgrade_level` beside `max_upgrade` is the pair that makes "is this one finished with"
/// answerable — the heirloom's version of a currency's cap, and the half of the answer no amount of
/// watching somebody buy an upgrade would produce for the ones bought years before Chronie existed.
fn sync_heirlooms(
    transaction: &Transaction<'_>,
    account_id: i64,
    state: &RawCensusState,
) -> Result<(), Failure> {
    for (key, value) in &state.entries {
        let Ok(item_id) = key.parse::<i64>() else {
            continue;
        };
        let heirloom: RawCensusHeirloom = typed(value);
        transaction.execute(
            "INSERT INTO account_heirlooms (
                     account_id, item_id, name, slot, upgrade_level, max_upgrade, source, seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(account_id, item_id) DO UPDATE SET
                     name = excluded.name,
                     slot = excluded.slot,
                     upgrade_level = excluded.upgrade_level,
                     max_upgrade = excluded.max_upgrade,
                     source = excluded.source,
                     seen_at = excluded.seen_at",
            params![
                account_id,
                item_id,
                heirloom.name.as_deref(),
                heirloom.slot.as_deref(),
                // Nullable rather than defaulted to nought, which is the distinction
                // `census_standings.ladder_rank` keeps: the addon writes no upgrade level for an
                // heirloom sitting at nought, and a ceiling this build would not state is not a
                // ceiling of nought. A reader that defaulted both would say an un-upgraded
                // heirloom and an unknowable one were the same thing.
                heirloom.upgrade,
                heirloom.max_upgrade,
                heirloom.source,
                heirloom.seen,
            ],
        )?;
    }
    Ok(())
}

/// Every title one character may put before or after their name.
///
/// The third `scope = "character"` domain, and the plainest of them: two alts share almost no
/// titles, so a walk by one says nothing whatever about the others and a prune reaches no further
/// than the character that walked it — the property [`sync_currencies`] exists to keep.
fn sync_titles(
    transaction: &Transaction<'_>,
    account_id: i64,
    character_id: i64,
    state: &RawCensusState,
    complete: bool,
) -> Result<(), Failure> {
    for (key, value) in &state.entries {
        let Ok(title_id) = key.parse::<i64>() else {
            continue;
        };
        let title: RawCensusTitle = typed(value);
        transaction.execute(
            "INSERT INTO census_titles (
                     account_id, character_id, title_id, name, suffix, seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(account_id, character_id, title_id) DO UPDATE SET
                     name = excluded.name,
                     suffix = excluded.suffix,
                     seen_at = excluded.seen_at",
            params![
                account_id,
                character_id,
                title_id,
                title.name.as_deref(),
                // Which side of the name it goes on, which is the one thing the space the addon
                // trimmed away was saying. Absent means it precedes the name, which is what the
                // majority of them do.
                i64::from(title.suffix.unwrap_or(false)),
                title.seen,
            ],
        )?;
    }
    if complete {
        prune(
            transaction,
            "census_titles",
            "title_id",
            account_id,
            Some(character_id),
            &ids_of(state),
        )?;
    }
    Ok(())
}

fn sync_achievements(
    transaction: &Transaction<'_>,
    account_id: i64,
    state: &RawCensusState,
    complete: bool,
) -> Result<(), Failure> {
    for (key, value) in &state.entries {
        let Ok(achievement_id) = key.parse::<i64>() else {
            continue;
        };
        let earned: RawCensusAchievement = typed(value);
        transaction.execute(
            "INSERT INTO account_achievements (
                     account_id, achievement_id, name, points, earned_year, earned_month,
                     earned_day, earned_by_walker, earned_by, seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(account_id, achievement_id) DO UPDATE SET
                     name = excluded.name,
                     points = excluded.points,
                     earned_year = excluded.earned_year,
                     earned_month = excluded.earned_month,
                     earned_day = excluded.earned_day,
                     earned_by_walker = excluded.earned_by_walker,
                     earned_by = excluded.earned_by,
                     seen_at = excluded.seen_at",
            params![
                account_id,
                achievement_id,
                earned.name.as_deref(),
                earned.points,
                earned.year,
                earned.month,
                earned.day,
                i64::from(earned.mine.unwrap_or(false)),
                earned.by.as_deref(),
                earned.seen,
            ],
        )?;
    }
    if complete {
        prune(
            transaction,
            "account_achievements",
            "achievement_id",
            account_id,
            None,
            &ids_of(state),
        )?;
    }
    Ok(())
}

/// Every currency one character holds, and how much more of each it may hold.
///
/// The first domain that belongs to a character rather than to the account, so this is the one
/// place the account/character split in [`sync_domain`] is spent: the rows are keyed by the
/// character that walked them and a prune reaches no further than that, because a walk by an alt
/// says what *that* alt holds and nothing at all about the others.
///
/// It does not touch `character_currencies` next door, which the pane sweep writes. The two are
/// different readings of the same thing — one live and shallow, taken at every zoning-in and again
/// at logout; one complete and occasional, reaching the currencies a collapsed group hides and
/// carrying the caps — and the migration says why they are kept apart.
fn sync_currencies(
    transaction: &Transaction<'_>,
    account_id: i64,
    character_id: i64,
    state: &RawCensusState,
    complete: bool,
) -> Result<(), Failure> {
    for (key, value) in &state.entries {
        let Ok(currency_id) = key.parse::<i64>() else {
            continue;
        };
        let held: RawCensusCurrency = typed(value);
        transaction.execute(
            "INSERT INTO census_currencies (
                     account_id, character_id, currency_id, name, total, total_earned,
                     max_quantity, earned_this_week, max_weekly, account_wide, transferable,
                     seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(account_id, character_id, currency_id) DO UPDATE SET
                     name = excluded.name,
                     total = excluded.total,
                     total_earned = excluded.total_earned,
                     max_quantity = excluded.max_quantity,
                     earned_this_week = excluded.earned_this_week,
                     max_weekly = excluded.max_weekly,
                     account_wide = excluded.account_wide,
                     transferable = excluded.transferable,
                     seen_at = excluded.seen_at",
            params![
                account_id,
                character_id,
                currency_id,
                held.name.as_deref(),
                // Nought for every count the addon left out, which is what it means by leaving
                // one out: the client says nought for "no cap" and for "nothing yet this week"
                // alike, and writing that down per currency per character would be a saved file
                // spent saying what the absence already says.
                held.total.unwrap_or(0),
                held.earned.unwrap_or(0),
                held.cap.unwrap_or(0),
                held.week.unwrap_or(0),
                held.week_cap.unwrap_or(0),
                i64::from(held.account_wide.unwrap_or(false)),
                i64::from(held.transferable.unwrap_or(false)),
                held.seen,
            ],
        )?;
    }
    if complete {
        prune(
            transaction,
            "census_currencies",
            "currency_id",
            account_id,
            Some(character_id),
            &ids_of(state),
        )?;
    }
    Ok(())
}

/// Where one character stands with every faction the game has.
///
/// The domain that reaches what nothing else could. `character_standings` next door is written
/// from a walk of the reputation *pane*, and the pane hides every legacy faction unless the player
/// has asked for them — which is most of the game's factions. This one is walked by id, so the
/// pane's settings have no bearing on it at all.
///
/// Character-scoped, and pruned no further than the character that walked it, for the reason
/// [`sync_currencies`] gives: a walk by an alt says where *that* alt stands and nothing whatever
/// about the others.
fn sync_standings(
    transaction: &Transaction<'_>,
    account_id: i64,
    character_id: i64,
    state: &RawCensusState,
    complete: bool,
) -> Result<(), Failure> {
    for (key, value) in &state.entries {
        let Ok(faction_id) = key.parse::<i64>() else {
            continue;
        };
        let stands: RawCensusStanding = typed(value);
        transaction.execute(
            "INSERT INTO census_standings (
                     account_id, character_id, faction_id, name, standing, standing_current,
                     standing_max, ladder_rank, ladder, account_wide, seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(account_id, character_id, faction_id) DO UPDATE SET
                     name = excluded.name,
                     standing = excluded.standing,
                     standing_current = excluded.standing_current,
                     standing_max = excluded.standing_max,
                     ladder_rank = excluded.ladder_rank,
                     ladder = excluded.ladder,
                     account_wide = excluded.account_wide,
                     seen_at = excluded.seen_at",
            params![
                account_id,
                character_id,
                faction_id,
                stands.name.as_deref(),
                stands.standing.as_deref(),
                stands.current.unwrap_or(0),
                stands.max.unwrap_or(0),
                // Nullable rather than defaulted, unlike the two above: nought is a real place on
                // a ladder — the bottom of it — and "the client would not place this faction" is
                // a different answer nothing downstream may confuse with it. The ladder is absent
                // for exactly the same rows, which is what makes a rank comparable at all.
                stands.rank,
                stands.system.as_deref(),
                i64::from(stands.account_wide.unwrap_or(false)),
                stands.seen,
            ],
        )?;
    }
    if complete {
        prune(
            transaction,
            "census_standings",
            "faction_id",
            account_id,
            Some(character_id),
            &ids_of(state),
        )?;
    }
    Ok(())
}

/* ---------- reading it back ---------- */

/// What the account holds, and how much of a claim each part of it is.
///
/// The whole census in one answer, because the three halves are only worth anything together:
/// a list of earned achievements says nothing about how much of the game that is, and the claim
/// beside it is what says whether the list is a whole reading or half of one. The window
/// subtracts this from the game's own tables — see [`crate::achievements::catalogue`] — and
/// there is no version of that subtraction which is honest without the claim.
///
/// Not folded into [`super::read_model::dashboard`], which is the segments and is re-read every
/// thirty seconds. A census changes at a logout and is read when somebody opens the screen for
/// it.
pub fn account_census(database_path: &Path) -> Result<dto::AccountCensusPayload, Failure> {
    let connection = open_database(database_path)?;

    let mut statement = connection.prepare(
        "SELECT d.domain, c.source_key, d.complete, d.revision, d.held, d.counted,
                d.build, d.walked_by, d.started_at, d.completed_at, d.observed_at
           FROM census_domains d
           LEFT JOIN characters c ON c.id = d.character_id
          ORDER BY d.domain, c.source_key",
    )?;
    let readings: Vec<dto::CensusReading> = statement
        .query_map([], |row| {
            Ok(dto::CensusReading {
                domain: row.get(0)?,
                character: row.get(1)?,
                complete: row.get::<_, i64>(2)? != 0,
                revision: row.get(3)?,
                held: row.get(4)?,
                counted: row.get(5)?,
                build: row.get(6)?,
                walked_by: row.get(7)?,
                started_at: row.get(8)?,
                completed_at: row.get(9)?,
                observed_at: row.get(10)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    drop(statement);

    // Who did the walking, so that "the walker earned this one" can be answered with a name.
    // The claim is where that name lives, and it is per domain rather than per row — one
    // character reports the whole account's history, which is the reason achievements pay for
    // the mechanism at all.
    let walker = readings
        .iter()
        .find(|reading| reading.domain == ACHIEVEMENTS)
        .and_then(|reading| reading.walked_by.clone());

    let mut statement = connection.prepare(
        "SELECT achievement_id, name, points, earned_year, earned_month, earned_day,
                earned_by_walker, earned_by
           FROM account_achievements ORDER BY achievement_id",
    )?;
    let achievements: Vec<dto::EarnedAchievement> = statement
        .query_map([], |row| {
            let by_walker = row.get::<_, i64>(6)? != 0;
            Ok(dto::EarnedAchievement {
                id: row.get(0)?,
                name: row.get(1)?,
                points: row.get(2)?,
                earned_on: earned_on(row.get(3)?, row.get(4)?, row.get(5)?),
                earned_by: row
                    .get::<_, Option<String>>(7)?
                    .or_else(|| by_walker.then(|| walker.clone()).flatten()),
            })
        })?
        .collect::<Result<_, _>>()?;
    drop(statement);

    let mut statement = connection.prepare(
        "SELECT mount_id, name, favourite, hidden FROM account_mounts ORDER BY mount_id",
    )?;
    let mounts: Vec<dto::HeldMount> = statement
        .query_map([], |row| {
            Ok(dto::HeldMount {
                id: row.get(0)?,
                name: row.get(1)?,
                favourite: row.get::<_, i64>(2)? != 0,
                hidden: row.get::<_, i64>(3)? != 0,
            })
        })?
        .collect::<Result<_, _>>()?;

    Ok(dto::AccountCensusPayload {
        readings,
        achievements,
        mounts,
    })
}

/// Which of the game's looks the account has, as ids and the claim over them.
///
/// Its own command rather than a corner of [`account_census`], and the reason is the shape of the
/// two screens. The Collection view draws mounts and achievements with their names and dates; the
/// transmog view draws fifty-five thousand looks out of the game's own tables and wants one
/// question answered about each — *has this one been collected* — which is a set membership and
/// nothing more. Thirty thousand ids is a couple of hundred kilobytes and answers in a
/// millisecond; the same ids folded into the Collection payload would be paid for by a screen that
/// has no use for them.
///
/// **The claim travels with them and is not decoration.** This reading is the union of what the
/// roster's characters have each been shown, and `complete` on it is down permanently — so what
/// the window may say is "at least this much", never "this and no more". A look absent from here
/// is one nobody has proved the account owns, which is not the same as one it does not own, and a
/// window that drew the second from the first would be lying to a reader about their own wardrobe.
/// `None` is a reading that has never happened at all, which is every install where the addon has
/// not yet run a pass.
pub fn collected_appearances(
    database_path: &Path,
) -> Result<dto::CollectedAppearancesPayload, Failure> {
    let connection = open_database(database_path)?;

    let mut statement = connection.prepare(
        "SELECT d.domain, c.source_key, d.complete, d.revision, d.held, d.counted,
                d.build, d.walked_by, d.started_at, d.completed_at, d.observed_at
           FROM census_domains d
           LEFT JOIN characters c ON c.id = d.character_id
          WHERE d.domain = ?1",
    )?;
    let reading = statement
        .query_map([APPEARANCES], |row| {
            Ok(dto::CensusReading {
                domain: row.get(0)?,
                character: row.get(1)?,
                complete: row.get::<_, i64>(2)? != 0,
                revision: row.get(3)?,
                held: row.get(4)?,
                counted: row.get(5)?,
                build: row.get(6)?,
                walked_by: row.get(7)?,
                started_at: row.get(8)?,
                completed_at: row.get(9)?,
                observed_at: row.get(10)?,
            })
        })?
        .next()
        .transpose()?;
    drop(statement);

    let mut statement = connection
        .prepare("SELECT appearance_id FROM account_appearances ORDER BY appearance_id")?;
    let appearances: Vec<i64> = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;

    Ok(dto::CollectedAppearancesPayload {
        reading,
        appearances,
    })
}

/// The day the client stated, as one `YYYY-MM-DD` string.
///
/// `GetAchievementInfo` hands over three numbers and no clock, and its year is the years since
/// 2000 — the 9 of "Herald of the Titans" is 2009. Resolving them here rather than in the window
/// is the ordinary read-model rule: what the numbers mean is known where they are stored.
///
/// It stays a calendar day and never becomes an instant. There is no time in the client's answer
/// and no time zone either, so any instant this invented would be a date that disagreed with the
/// game's own achievement pane on somebody's screen.
///
/// `None` for a row the client dated at nothing, which is what the oldest achievements come back
/// as. A month of 0 is not January and a day of 0 is not the first.
fn earned_on(year: Option<i64>, month: Option<i64>, day: Option<i64>) -> Option<String> {
    let (year, month, day) = (year?, month?, day?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(format!("{:04}-{month:02}-{day:02}", year + 2000))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::collector::testing::*;

    /// A finished walk of a small account's mounts, written the way the addon writes one: the
    /// claim first, then the entries under it. Two mounts, one of them the player's favourite
    /// and one of them a Horde-only mount they keep hidden, so every column the table has to
    /// carry is carried by one of them.
    const WALKED_MOUNTS: &str = r#"
        ["account"] = {
            ["mounts"] = {
                ["complete"] = true,
                ["revision"] = 3,
                ["held"] = 2,
                ["build"] = "12.0.5.67823",
                ["by"] = "Aster-Vale",
                ["startedAt"] = 1999990000,
                ["completedAt"] = 1999990060,
                ["entries"] = {
                    [6] = {
                        ["name"] = "Swift Zhevra", ["spell"] = 37719, ["source"] = 4,
                        ["favourite"] = true, ["seen"] = 1999990000,
                    },
                    [9] = {
                        ["name"] = "Kua'fon", ["spell"] = 253058, ["source"] = 2,
                        ["hidden"] = true, ["faction"] = 1, ["seen"] = 1999990000,
                    },
                },
            },
        },
    "#;

    /// The same walk of the achievements, which is the domain the whole census exists for: one
    /// the walking character earned and one an alt did, reported by the same pass.
    const WALKED_ACHIEVEMENTS: &str = r#"
        ["account"] = {
            ["achievements"] = {
                ["complete"] = true,
                ["revision"] = 1,
                ["held"] = 2,
                ["counted"] = 2,
                ["build"] = "12.0.5.67823",
                ["by"] = "Aster-Vale",
                ["entries"] = {
                    [4842] = {
                        ["name"] = "Herald of the Titans", ["points"] = 25,
                        ["month"] = 8, ["day"] = 4, ["year"] = 9,
                        ["mine"] = true, ["seen"] = 1999990000,
                    },
                    [2144] = {
                        ["name"] = "The Immortal", ["points"] = 25,
                        ["month"] = 3, ["day"] = 22, ["year"] = 9,
                        ["by"] = "Brin", ["seen"] = 1999990000,
                    },
                },
            },
        },
    "#;

    /// A finished walk of one character's wallet. Two currencies, chosen so that between them
    /// every column of `census_currencies` is carried by one and left out by the other: Conquest
    /// is capped both ways and shared by the warband, and the Timewarped Badge is one this
    /// character discovered and has since spent to nothing.
    const ASTER_WALKED_CURRENCIES: &str = r#"
        ["characters"] = {
            ["Aster-Vale"] = {
                ["currencies"] = {
                    ["complete"] = true,
                    ["revision"] = 1,
                    ["held"] = 2,
                    ["build"] = "12.0.5.67823",
                    ["by"] = "Aster-Vale",
                    ["startedAt"] = 1999990000,
                    ["completedAt"] = 1999990010,
                    ["entries"] = {
                        [1602] = {
                            ["name"] = "Conquest", ["total"] = 1650, ["earned"] = 5400,
                            ["cap"] = 5500, ["week"] = 750, ["weekCap"] = 1350,
                            ["accountWide"] = true, ["transferable"] = true,
                            ["seen"] = 1999990000,
                        },
                        -- Discovered, spent to nothing, and never capped or weekly. Everything
                        -- the addon leaves out of a row it does write is left out here.
                        [1166] = {
                            ["name"] = "Timewarped Badge", ["total"] = 0,
                            ["seen"] = 1999990000,
                        },
                    },
                },
            },
        },
    "#;

    /// A different character's finished walk of their own wallet, holding a currency the first
    /// one has never seen. The pair is what the `character` on [`prune`] exists for.
    const BRIN_WALKED_CURRENCIES: &str = r#"
        ["characters"] = {
            ["Brin-Vale"] = {
                ["currencies"] = {
                    ["complete"] = true, ["revision"] = 1, ["held"] = 1,
                    ["entries"] = {
                        [2245] = {
                            ["name"] = "Flightstones", ["total"] = 4200,
                            ["seen"] = 2000000000,
                        },
                    },
                },
            },
        },
    "#;

    /// A walk of the wardrobe by a character who can see cloth, which is what every reading of
    /// this domain is: part of an answer. `complete` is down and stays down — see
    /// `ns.appearanceCensus` — so the claim beside these two looks is the only reason a reader
    /// knows not to conclude that the account owns nothing else.
    const CLOTH_WALKED_APPEARANCES: &str = r#"
        ["account"] = {
            ["appearances"] = {
                ["complete"] = false,
                ["revision"] = 1,
                ["held"] = 2,
                ["counted"] = 9,
                ["build"] = "12.0.5.67823",
                ["by"] = "Aster-Vale",
                ["startedAt"] = 1999990000,
                ["completedAt"] = 1999990030,
                ["entries"] = {
                    [1101] = { ["category"] = 1, ["favourite"] = true, ["seen"] = 1999990000 },
                    [1102] = { ["category"] = 11, ["seen"] = 1999990000 },
                },
            },
        },
    "#;

    /// The same wardrobe walked by a plate-wearing alt, which shows one look the first walk
    /// could see and one it could not. The pair is the union this domain exists to build.
    const PLATE_WALKED_APPEARANCES: &str = r#"
        ["account"] = {
            ["appearances"] = {
                ["complete"] = false, ["revision"] = 1, ["held"] = 2, ["counted"] = 9,
                ["by"] = "Brin-Vale",
                ["entries"] = {
                    [1101] = { ["category"] = 1, ["seen"] = 2000000000 },
                    [2201] = { ["category"] = 4, ["seen"] = 2000000000 },
                },
            },
        },
    "#;

    /// One domain's claim as it was stored, which is the row that says how to read the entries
    /// beside it.
    #[derive(Debug, PartialEq)]
    struct Claim {
        complete: i64,
        revision: i64,
        held: i64,
        counted: Option<i64>,
        build: Option<String>,
        walked_by: Option<String>,
        character_id: Option<i64>,
    }

    fn claim_of(install: &Install, domain: &str) -> Claim {
        install
            .open()
            .query_row(
                "SELECT complete, revision, held, counted, build, walked_by, character_id
                   FROM census_domains WHERE domain = ?1",
                params![domain],
                |row| {
                    Ok(Claim {
                        complete: row.get(0)?,
                        revision: row.get(1)?,
                        held: row.get(2)?,
                        counted: row.get(3)?,
                        build: row.get(4)?,
                        walked_by: row.get(5)?,
                        character_id: row.get(6)?,
                    })
                },
            )
            .unwrap()
    }

    fn ids_of(install: &Install, sql: &str) -> Vec<i64> {
        let connection = install.open();
        let mut statement = connection.prepare(sql).unwrap();
        let ids = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        ids
    }

    fn mount_ids(install: &Install) -> Vec<i64> {
        ids_of(
            install,
            "SELECT mount_id FROM account_mounts ORDER BY mount_id",
        )
    }

    fn achievement_ids(install: &Install) -> Vec<i64> {
        ids_of(
            install,
            "SELECT achievement_id FROM account_achievements ORDER BY achievement_id",
        )
    }

    /// The currencies stored against one character, and nobody else's. Every claim this module
    /// makes about wallets is a claim about one character's rows, so there is no version of this
    /// helper that reads the table whole.
    fn currency_ids(install: &Install, character: &str) -> Vec<i64> {
        ids_of(
            install,
            &format!(
                "SELECT currency_id FROM census_currencies w
                   JOIN characters c ON c.id = w.character_id
                  WHERE c.source_key = '{character}' ORDER BY currency_id"
            ),
        )
    }

    /// One currency as it was stored, whole. Every count is `NOT NULL` in the table, so what the
    /// addon left out has to arrive here as a nought rather than as an absence.
    #[derive(Debug, PartialEq)]
    struct Wallet {
        name: Option<String>,
        total: i64,
        total_earned: i64,
        max_quantity: i64,
        earned_this_week: i64,
        max_weekly: i64,
        account_wide: i64,
        transferable: i64,
        seen_at: Option<i64>,
    }

    fn wallet_of(install: &Install, character: &str, currency_id: i64) -> Wallet {
        install
            .open()
            .query_row(
                "SELECT w.name, w.total, w.total_earned, w.max_quantity, w.earned_this_week,
                        w.max_weekly, w.account_wide, w.transferable, w.seen_at
                   FROM census_currencies w
                   JOIN characters c ON c.id = w.character_id
                  WHERE c.source_key = ?1 AND w.currency_id = ?2",
                params![character, currency_id],
                |row| {
                    Ok(Wallet {
                        name: row.get(0)?,
                        total: row.get(1)?,
                        total_earned: row.get(2)?,
                        max_quantity: row.get(3)?,
                        earned_this_week: row.get(4)?,
                        max_weekly: row.get(5)?,
                        account_wide: row.get(6)?,
                        transferable: row.get(7)?,
                        seen_at: row.get(8)?,
                    })
                },
            )
            .unwrap()
    }

    /// The whole of the round trip for the simplest domain: the addon's table becomes rows, and
    /// the claim that qualifies them becomes the row beside them.
    #[test]
    fn files_every_mount_a_finished_walk_found_and_the_claim_over_them() {
        let install = Install::of(&SavedVariables::new().census(WALKED_MOUNTS));

        install.collect(2_000_000_100);

        assert_eq!(mount_ids(&install), vec![6, 9]);
        let connection = install.open();
        let zhevra: (String, i64, i64, i64, i64, Option<i64>, i64) = connection
            .query_row(
                "SELECT name, spell_id, source, favourite, hidden, faction, seen_at
                   FROM account_mounts WHERE mount_id = 6",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .unwrap();
        // The player's own arrangement travels with the mount, because "hidden on this
        // character" is how somebody says a mount is not really theirs to ride — and a mount
        // either side can ride has no side, which is a null rather than a nought.
        assert_eq!(
            zhevra,
            ("Swift Zhevra".into(), 37719, 4, 1, 0, None, 1_999_990_000)
        );
        let kuafon: (i64, i64, Option<i64>) = connection
            .query_row(
                "SELECT favourite, hidden, faction FROM account_mounts WHERE mount_id = 9",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(kuafon, (0, 1, Some(1)));
        drop(connection);

        assert_eq!(
            claim_of(&install, "mounts"),
            Claim {
                complete: 1,
                revision: 3,
                held: 2,
                // Null for a domain whose client offers no counter, which mounts deliberately
                // do not — see `ns.mountCensus`.
                counted: None,
                build: Some("12.0.5.67823".into()),
                walked_by: Some("Aster-Vale".into()),
                // Kept once for the account rather than once per alt, because every character
                // would answer this the same.
                character_id: None,
            }
        );
    }

    /// The row the census exists for. One character reports the whole account's achievement
    /// history *and* attributes each line of it, without any other character logging in.
    #[test]
    fn files_who_earned_each_achievement_and_the_day_they_did() {
        let install = Install::of(&SavedVariables::new().census(WALKED_ACHIEVEMENTS));

        install.collect(2_000_000_100);

        assert_eq!(achievement_ids(&install), vec![2144, 4842]);
        let connection = install.open();
        let herald: (String, i64, i64, i64, i64, i64, Option<String>) = connection
            .query_row(
                "SELECT name, points, earned_year, earned_month, earned_day,
                        earned_by_walker, earned_by
                   FROM account_achievements WHERE achievement_id = 4842",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .unwrap();
        // The day as three numbers and no clock, because a local calendar date has no instant
        // in it without a decision about time zones — and an invented one would put a date on
        // screen that disagrees with the game's own achievement pane.
        assert_eq!(
            herald,
            ("Herald of the Titans".into(), 25, 9, 8, 4, 1, None)
        );
        let immortal: (i64, Option<String>) = connection
            .query_row(
                "SELECT earned_by_walker, earned_by
                   FROM account_achievements WHERE achievement_id = 2144",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        // Earned years ago by an alt nobody has logged into since, and named as such.
        assert_eq!(immortal, (0, Some("Brin".into())));
        drop(connection);

        assert_eq!(claim_of(&install, "achievements").counted, Some(2));
    }

    /// The rule the whole module turns on, in the direction that deletes. A walk that finished
    /// asked about every id the client named, so an id it did not write down is an id the
    /// account no longer holds.
    #[test]
    fn a_second_finished_walk_takes_out_what_it_did_not_mention() {
        let install = Install::of(&SavedVariables::new().census(WALKED_MOUNTS));
        install.collect(2_000_000_100);
        assert_eq!(mount_ids(&install), vec![6, 9]);

        install.rewrite(&SavedVariables::new().census(
            r#"["account"] = { ["mounts"] = {
                ["complete"] = true, ["revision"] = 4, ["held"] = 1,
                ["entries"] = { [6] = { ["name"] = "Swift Zhevra", ["seen"] = 2000000000 } },
            } },"#,
        ));
        install.collect(2_000_100_100);

        assert_eq!(mount_ids(&install), vec![6]);
        assert_eq!(claim_of(&install, "mounts").revision, 4);
    }

    /// And the same rule in the direction that does not. A logout in the middle of a
    /// thirteen-thousand-call walk is ordinary rather than exceptional, and what arrives from
    /// one is a set of positive observations: it can add and it can update, and it can never
    /// be the reason a row is deleted.
    #[test]
    fn a_walk_that_was_cut_short_can_only_add() {
        let install = Install::of(&SavedVariables::new().census(WALKED_MOUNTS));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().census(
            r#"["account"] = { ["mounts"] = {
                ["complete"] = false, ["revision"] = 3, ["held"] = 2,
                ["entries"] = {
                    [6] = { ["name"] = "Swift Zhevra", ["seen"] = 2000000000 },
                    [12] = { ["name"] = "Reawakened Phase-Hunter", ["seen"] = 2000000000 },
                },
            } },"#,
        ));
        install.collect(2_000_100_100);

        // The mount the interrupted walk never reached is still there, and the one it found on
        // the way is there beside it.
        assert_eq!(mount_ids(&install), vec![6, 9, 12]);
        // And the claim says out loud that this reading is not whole, so the next reader knows
        // as much as this one did.
        assert_eq!(claim_of(&install, "mounts").complete, 0);
    }

    /// A finished walk that found nothing is a real answer — a brand new account holds no
    /// mounts — so it has to be able to empty the table. `NOT IN ()` is not valid SQL, which is
    /// why the empty set is a statement of its own rather than a value inside one.
    #[test]
    fn a_finished_walk_that_found_nothing_empties_the_account() {
        let install = Install::of(&SavedVariables::new().census(WALKED_MOUNTS));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().census(
            r#"["account"] = { ["mounts"] = {
                ["complete"] = true, ["revision"] = 4, ["held"] = 0, ["entries"] = {},
            } },"#,
        ));
        install.collect(2_000_100_100);

        assert!(mount_ids(&install).is_empty());
        assert_eq!(claim_of(&install, "mounts").held, 0);
    }

    /// A newer addon beside an older app is the ordinary way a pair of these drift, so a domain
    /// this build has no table for is not an error. The claim is still worth keeping: it is what
    /// lets a later build tell it has never imported these entries.
    #[test]
    fn records_the_claim_of_a_domain_this_build_has_no_table_for() {
        let install = Install::of(&SavedVariables::new().census(
            r#"["account"] = { ["appearances"] = {
                ["complete"] = true, ["revision"] = 1, ["held"] = 1,
                ["entries"] = { [55198] = { ["name"] = "Tideglass Robe" } },
            } },"#,
        ));

        install.collect(2_000_000_100);

        assert_eq!(claim_of(&install, "appearances").held, 1);
        assert_eq!(count_of(&install.database, "account_mounts"), 0);
        assert_eq!(count_of(&install.database, "account_achievements"), 0);
    }

    /// The addon keys these by the client's own id and Lua hands every table key over as a
    /// string, so anything that will not parse as an id is not one — and a hand-edited file
    /// full of them must not become a reason to delete the rows that are.
    #[test]
    fn refuses_an_entry_whose_key_is_not_an_id() {
        let install = Install::of(&SavedVariables::new().census(
            r#"["account"] = { ["mounts"] = {
                ["complete"] = true, ["revision"] = 1, ["held"] = 2,
                ["entries"] = {
                    [6] = { ["name"] = "Swift Zhevra", ["seen"] = 2000000000 },
                    ["oops"] = { ["name"] = "not a mount at all" },
                },
            } },"#,
        ));

        install.collect(2_000_000_100);

        // Stored: exactly the one entry that named an id. Kept: that same entry, which a prune
        // reading the unparseable key as "nothing to keep" would have deleted.
        assert_eq!(mount_ids(&install), vec![6]);
    }

    /// No domain ships character-scoped yet, and the storage path has to work before one needs
    /// it — the claim lands against the character rather than against the account, which is the
    /// difference between two alts with a wallet each and one alt whose wallet keeps being
    /// replaced.
    #[test]
    fn files_a_character_scoped_domain_under_the_character_that_walked_it() {
        let install = Install::of(&SavedVariables::new().census(
            r#"["characters"] = { ["Aster-Vale"] = { ["mounts"] = {
                ["complete"] = true, ["revision"] = 1, ["held"] = 1,
                ["build"] = "12.0.5.67823",
                ["entries"] = { [6] = { ["name"] = "Swift Zhevra", ["seen"] = 2000000000 } },
            } } },"#,
        ));

        install.collect(2_000_000_100);

        let claim = claim_of(&install, "mounts");
        assert_eq!(claim.held, 1);
        let owner: String = install
            .open()
            .query_row(
                "SELECT name || '-' || realm FROM characters WHERE id = ?1",
                params![claim.character_id.expect("a character to have walked it")],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owner, "Aster-Vale");
        assert_eq!(mount_ids(&install), vec![6]);
    }

    /// The whole round trip for the first domain that belongs to a character. Every column the
    /// table has is carried by one of the two currencies, and the caps beside the totals are the
    /// half of this the pane sweep next door could never say.
    #[test]
    fn files_every_column_of_a_wallet_under_the_character_that_walked_it() {
        let install = Install::of(&SavedVariables::new().census(ASTER_WALKED_CURRENCIES));

        install.collect(2_000_000_100);

        assert_eq!(currency_ids(&install, "Aster-Vale"), vec![1166, 1602]);
        assert_eq!(
            wallet_of(&install, "Aster-Vale", 1602),
            Wallet {
                name: Some("Conquest".into()),
                total: 1650,
                total_earned: 5400,
                max_quantity: 5500,
                earned_this_week: 750,
                max_weekly: 1350,
                account_wide: 1,
                transferable: 1,
                seen_at: Some(1_999_990_000),
            }
        );
        // Nought for every count the addon left out, which is exactly what it means by leaving
        // one out — the client says nought for "no cap" and for "nothing yet this week" alike.
        // The balance is the one number written whatever it is, because a character that has
        // spent everything it had must be able to say so.
        assert_eq!(
            wallet_of(&install, "Aster-Vale", 1166),
            Wallet {
                name: Some("Timewarped Badge".into()),
                total: 0,
                total_earned: 0,
                max_quantity: 0,
                earned_this_week: 0,
                max_weekly: 0,
                account_wide: 0,
                transferable: 0,
                seen_at: Some(1_999_990_000),
            }
        );
        // And the claim lands against the character rather than against the account, which is
        // what says these rows are one alt's wallet and not the account's.
        let claim = claim_of(&install, "currencies");
        assert_eq!(claim.held, 2);
        assert!(claim.character_id.is_some());
    }

    /// The property the `character` on [`prune`] exists for, and the one that costs an account
    /// its data if it is wrong. A walk by one alt says what *that* alt holds and nothing whatever
    /// about the others, so a prune that reached across the account would empty every other
    /// character's wallet every time one of them logged out.
    #[test]
    fn a_finished_walk_by_one_character_leaves_another_characters_wallet_alone() {
        let install = Install::of(&SavedVariables::new().census(ASTER_WALKED_CURRENCIES));
        install.collect(2_000_000_100);
        assert_eq!(currency_ids(&install, "Aster-Vale"), vec![1166, 1602]);

        install.rewrite(&SavedVariables::new().census(BRIN_WALKED_CURRENCIES));
        install.collect(2_000_100_100);

        // Brin's walk was complete and mentioned neither of Aster's currencies. Both are still
        // Aster's, because Brin was never in a position to say otherwise.
        assert_eq!(currency_ids(&install, "Aster-Vale"), vec![1166, 1602]);
        assert_eq!(currency_ids(&install, "Brin-Vale"), vec![2245]);
        assert_eq!(wallet_of(&install, "Brin-Vale", 2245).total, 4200);
    }

    /// And the rule the module turns on, inside the one character it is allowed to apply to. A
    /// walk that finished asked about every id in the range, so a currency it did not write down
    /// is one this character no longer holds.
    #[test]
    fn a_second_finished_walk_takes_out_what_that_character_no_longer_holds() {
        let install = Install::of(&SavedVariables::new().census(ASTER_WALKED_CURRENCIES));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().census(
            r#"["characters"] = { ["Aster-Vale"] = { ["currencies"] = {
                ["complete"] = true, ["revision"] = 2, ["held"] = 1,
                ["entries"] = {
                    [1602] = { ["name"] = "Conquest", ["total"] = 20, ["seen"] = 2000000000 },
                },
            } } },"#,
        ));
        install.collect(2_000_100_100);

        assert_eq!(currency_ids(&install, "Aster-Vale"), vec![1602]);
        // The balance that came down is the new one rather than the higher one it replaced.
        assert_eq!(wallet_of(&install, "Aster-Vale", 1602).total, 20);
        assert_eq!(claim_of(&install, "currencies").revision, 2);
    }

    /// The same rule in the direction that does not delete. A logout in the middle of a
    /// five-thousand-id walk is ordinary, and what arrives from one is a set of positive
    /// observations: it can add and update, and it can never be the reason a row is taken out.
    #[test]
    fn a_wallet_walk_that_was_cut_short_can_only_add() {
        let install = Install::of(&SavedVariables::new().census(ASTER_WALKED_CURRENCIES));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().census(
            r#"["characters"] = { ["Aster-Vale"] = { ["currencies"] = {
                ["complete"] = false, ["revision"] = 2, ["held"] = 1,
                ["entries"] = {
                    [2245] = { ["name"] = "Flightstones", ["total"] = 90, ["seen"] = 2000000000 },
                },
            } } },"#,
        ));
        install.collect(2_000_100_100);

        // The two the interrupted walk never reached are still there, and the one it found on
        // the way is there beside them.
        assert_eq!(currency_ids(&install, "Aster-Vale"), vec![1166, 1602, 2245]);
        assert_eq!(claim_of(&install, "currencies").complete, 0);
    }

    /// A wallet belongs to a character, so a currencies reading filed against the account has
    /// nowhere to go — there is no column for "whoever's", and summing it into one of the alts
    /// would be inventing an owner. The claim is still recorded, which is what says a reading
    /// arrived and was not stored.
    #[test]
    fn records_the_claim_of_a_currencies_reading_no_character_owns() {
        let install = Install::of(&SavedVariables::new().census(
            r#"["account"] = { ["currencies"] = {
                ["complete"] = true, ["revision"] = 1, ["held"] = 1,
                ["entries"] = {
                    [1602] = { ["name"] = "Conquest", ["total"] = 1650, ["seen"] = 2000000000 },
                },
            } },"#,
        ));

        install.collect(2_000_000_100);

        let claim = claim_of(&install, "currencies");
        assert_eq!(claim.held, 1);
        assert_eq!(claim.character_id, None);
        assert_eq!(count_of(&install.database, "census_currencies"), 0);
    }

    /// A finished walk of one character's reputations, written as the addon writes one. 2574 is a
    /// renown faction, 1090 an old reaction one the pane hides as legacy, and 2570 a warband
    /// reputation — so between them they carry every column the table has, on all three ladders
    /// the reduction can land on.
    const ASTER_WALKED_REPUTATIONS: &str = r#"
        ["characters"] = {
            ["Aster-Vale"] = {
                ["reputations"] = {
                    ["complete"] = true,
                    ["revision"] = 1,
                    ["held"] = 3,
                    ["build"] = "12.0.5.67823",
                    ["startedAt"] = 1999990000,
                    ["completedAt"] = 1999990020,
                    ["entries"] = {
                        [2574] = {
                            ["name"] = "Dream Wardens", ["standing"] = "Renown 22",
                            ["current"] = 100, ["max"] = 2500, ["rank"] = 22,
                            ["system"] = "renown", ["seen"] = 1999990000,
                        },
                        -- The one the sweep next door can never see: a legacy faction, which the
                        -- reputation pane hides unless the player has asked for it.
                        [1090] = {
                            ["name"] = "Kirin Tor", ["standing"] = "Exalted",
                            ["current"] = 1, ["max"] = 1, ["rank"] = 8,
                            ["system"] = "reaction", ["seen"] = 1999990000,
                        },
                        [2570] = {
                            ["name"] = "Hallowfall Arathi", ["standing"] = "Renown 4",
                            ["current"] = 50, ["max"] = 2500, ["rank"] = 4,
                            ["system"] = "renown", ["accountWide"] = true,
                            ["seen"] = 1999990000,
                        },
                    },
                },
            },
        },
    "#;

    fn standing_ids(install: &Install, character: &str) -> Vec<i64> {
        ids_of(
            install,
            &format!(
                "SELECT faction_id FROM census_standings s
                   JOIN characters c ON c.id = s.character_id
                  WHERE c.source_key = '{character}' ORDER BY faction_id"
            ),
        )
    }

    /// One standing as it was stored, whole. The two counts are `NOT NULL` and the rank is not,
    /// which is the distinction the table exists to keep: nought is the bottom of a ladder and a
    /// null is no ladder at all.
    #[derive(Debug, PartialEq)]
    struct Standing {
        name: Option<String>,
        standing: Option<String>,
        current: i64,
        max: i64,
        rank: Option<i64>,
        ladder: Option<String>,
        account_wide: i64,
        seen_at: Option<i64>,
    }

    fn standing_of(install: &Install, character: &str, faction_id: i64) -> Standing {
        install
            .open()
            .query_row(
                "SELECT s.name, s.standing, s.standing_current, s.standing_max, s.ladder_rank,
                        s.ladder, s.account_wide, s.seen_at
                   FROM census_standings s
                   JOIN characters c ON c.id = s.character_id
                  WHERE c.source_key = ?1 AND s.faction_id = ?2",
                params![character, faction_id],
                |row| {
                    Ok(Standing {
                        name: row.get(0)?,
                        standing: row.get(1)?,
                        current: row.get(2)?,
                        max: row.get(3)?,
                        rank: row.get(4)?,
                        ladder: row.get(5)?,
                        account_wide: row.get(6)?,
                        seen_at: row.get(7)?,
                    })
                },
            )
            .unwrap()
    }

    /// The round trip for the domain that reaches what nothing else could. The pane the sweep
    /// walks hides every legacy faction by default, so the Kirin Tor row here is one no amount of
    /// watching a player earn reputation would ever have produced.
    #[test]
    fn files_a_legacy_reputation_the_pane_would_never_have_shown() {
        let install = Install::of(&SavedVariables::new().census(ASTER_WALKED_REPUTATIONS));

        install.collect(2_000_000_100);

        assert_eq!(standing_ids(&install, "Aster-Vale"), vec![1090, 2570, 2574]);
        assert_eq!(
            standing_of(&install, "Aster-Vale", 1090),
            Standing {
                name: Some("Kirin Tor".into()),
                standing: Some("Exalted".into()),
                current: 1,
                max: 1,
                rank: Some(8),
                ladder: Some("reaction".into()),
                account_wide: 0,
                seen_at: Some(1_999_990_000),
            }
        );
        // The warband's one standing rather than this character's own, which is the reputation
        // side of a shared currency pot.
        assert_eq!(standing_of(&install, "Aster-Vale", 2570).account_wide, 1);
        // And the claim is the character's, not the account's: two alts at different renown are
        // two standings rather than one that keeps being replaced.
        let claim = claim_of(&install, "reputations");
        assert_eq!(claim.held, 3);
        assert!(claim.character_id.is_some());
    }

    /// The same property [`prune`]'s `character` exists for, on the second domain to need it.
    /// Where an alt stands says nothing whatever about where anybody else stands.
    #[test]
    fn a_finished_reputation_walk_leaves_another_characters_standings_alone() {
        let install = Install::of(&SavedVariables::new().census(ASTER_WALKED_REPUTATIONS));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().census(
            r#"["characters"] = { ["Brin-Vale"] = { ["reputations"] = {
                ["complete"] = true, ["revision"] = 1, ["held"] = 1,
                ["entries"] = {
                    [2515] = {
                        ["name"] = "The Assembly of the Deeps", ["standing"] = "Renown 9",
                        ["rank"] = 9, ["system"] = "renown", ["seen"] = 2000000000,
                    },
                },
            } } },"#,
        ));
        install.collect(2_000_100_100);

        assert_eq!(standing_ids(&install, "Aster-Vale"), vec![1090, 2570, 2574]);
        assert_eq!(standing_ids(&install, "Brin-Vale"), vec![2515]);
    }

    /// A faction the client would not place at all — no name for the level and no rank — never
    /// reaches this table, because the addon refuses it. What does arrive with no rank is a
    /// standing that was named and not placed, and its rank stays null rather than becoming the
    /// bottom of a ladder it was never on.
    #[test]
    fn keeps_an_unplaced_standing_apart_from_one_at_the_bottom_of_its_ladder() {
        let install = Install::of(&SavedVariables::new().census(
            r#"["characters"] = { ["Aster-Vale"] = { ["reputations"] = {
                ["complete"] = true, ["revision"] = 1, ["held"] = 1,
                ["entries"] = {
                    [1119] = { ["name"] = "The Sons of Hodir", ["standing"] = "Neutral" },
                },
            } } },"#,
        ));

        install.collect(2_000_000_100);

        let stands = standing_of(&install, "Aster-Vale", 1119);
        assert_eq!(stands.rank, None);
        assert_eq!(stands.ladder, None);
        // The two counts default to nought, which is what the addon means by leaving them out.
        assert_eq!(stands.current, 0);
        assert_eq!(stands.max, 0);
    }

    /* ---------- the grow-only collections ---------- */

    /// The titles stored against one character, and nobody else's — the same helper shape the
    /// wallets and the standings have, and for the same reason: every claim this module makes
    /// about a character-scoped domain is a claim about one character's rows.
    fn title_ids(install: &Install, character: &str) -> Vec<i64> {
        ids_of(
            install,
            &format!(
                "SELECT title_id FROM census_titles t
                   JOIN characters c ON c.id = t.character_id
                  WHERE c.source_key = '{character}' ORDER BY title_id"
            ),
        )
    }

    /// A finished walk of a small account's pets. Two species, one of them owned three times over
    /// with a levelled favourite among them and one of them a single unnamed pet, so between them
    /// every column `account_pets` has is carried by one and left out by the other.
    const WALKED_PETS: &str = r#"
        ["account"] = {
            ["pets"] = {
                ["complete"] = true,
                ["revision"] = 1,
                ["held"] = 2,
                ["build"] = "12.0.5.67823",
                ["by"] = "Aster-Vale",
                ["startedAt"] = 1999990000,
                ["completedAt"] = 1999990005,
                ["entries"] = {
                    [39] = {
                        ["name"] = "Mechanical Squirrel", ["count"] = 3, ["level"] = 25,
                        ["custom"] = "Nuts", ["favourite"] = true, ["seen"] = 1999990000,
                    },
                    [40] = {
                        ["name"] = "Bombay Cat", ["count"] = 1, ["seen"] = 1999990000,
                    },
                },
            },
        },
    "#;

    /// A walk of the toy box, which is only ever part of an answer: the client's own indexer walks
    /// the list the player's filters left standing, so `ns.toyCensus` marks the domain `partial`
    /// and `complete` here is down and stays down.
    const WALKED_TOYS: &str = r#"
        ["account"] = {
            ["toys"] = {
                ["complete"] = false, ["revision"] = 1, ["held"] = 2,
                ["build"] = "12.0.5.67823", ["by"] = "Aster-Vale",
                ["entries"] = {
                    [54212] = {
                        ["name"] = "Foot Ball", ["favourite"] = true, ["seen"] = 1999990000,
                    },
                    [88801] = { ["name"] = "Wormhole Generator", ["seen"] = 1999990000 },
                },
            },
        },
    "#;

    /// A walk of the heirlooms. One taken to its ceiling and one bought and never upgraded, which
    /// is the pair that separates "no upgrades yet" from "this build would not say".
    const WALKED_HEIRLOOMS: &str = r#"
        ["account"] = {
            ["heirlooms"] = {
                ["complete"] = false, ["revision"] = 1, ["held"] = 2, ["counted"] = 2,
                ["build"] = "12.0.5.67823", ["by"] = "Aster-Vale",
                ["entries"] = {
                    [122668] = {
                        ["name"] = "Eternal Woven Ivy Necklace", ["slot"] = "INVTYPE_NECK",
                        ["upgrade"] = 5, ["maxUpgrade"] = 5, ["source"] = 1,
                        ["seen"] = 1999990000,
                    },
                    -- Bought and never upgraded, so the addon writes no level at all: nought is
                    -- what it means by leaving one out.
                    [122340] = {
                        ["name"] = "Burnished Breastplate", ["slot"] = "INVTYPE_CHEST",
                        ["maxUpgrade"] = 5, ["source"] = 1, ["seen"] = 1999990000,
                    },
                },
            },
        },
    "#;

    /// A finished walk of one character's titles: one that follows the name and one that precedes
    /// it, which is the whole of what the trimmed-away space was saying.
    const ASTER_WALKED_TITLES: &str = r#"
        ["characters"] = {
            ["Aster-Vale"] = {
                ["titles"] = {
                    ["complete"] = true, ["revision"] = 1, ["held"] = 2,
                    ["build"] = "12.0.5.67823",
                    ["entries"] = {
                        [42] = {
                            ["name"] = "the Explorer", ["suffix"] = true,
                            ["seen"] = 1999990000,
                        },
                        [8] = { ["name"] = "Sergeant", ["seen"] = 1999990000 },
                    },
                },
            },
        },
    "#;

    /// The round trip for the one domain whose row carries a count, because pets are the one
    /// collectible the game lets an account own several of. A species is the line of the journal
    /// and the id of the row; the count beside it is how many of that line the account holds.
    #[test]
    fn files_a_pet_under_its_species_with_how_many_of_it_the_account_owns() {
        let install = Install::of(&SavedVariables::new().census(WALKED_PETS));

        install.collect(2_000_000_100);

        assert_eq!(
            ids_of(
                &install,
                "SELECT species_id FROM account_pets ORDER BY species_id"
            ),
            vec![39, 40]
        );
        let squirrel: (String, i64, Option<i64>, Option<String>, i64) = install
            .open()
            .query_row(
                "SELECT name, count, level, custom_name, favourite
                   FROM account_pets WHERE species_id = 39",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        // Three of them, the best of them at 25 and called something, and starred in the journal.
        assert_eq!(
            squirrel,
            (
                "Mechanical Squirrel".into(),
                3,
                Some(25),
                Some("Nuts".into()),
                1
            )
        );
        let cat: (i64, Option<i64>, Option<String>, i64) = install
            .open()
            .query_row(
                "SELECT count, level, custom_name, favourite
                   FROM account_pets WHERE species_id = 40",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        // A level the client would not state is not a level of nought, and a pet nobody renamed
        // has no name of its own — neither of which is a zero.
        assert_eq!(cat, (1, None, None, 0));
    }

    /// Pets are the one grow-only-looking collection that can actually shrink: a pet can be caged
    /// away or released, so an id a finished walk did not mention is a species the account has
    /// genuinely stopped owning.
    #[test]
    fn a_finished_pet_walk_takes_out_a_species_the_account_let_go() {
        let install = Install::of(&SavedVariables::new().census(WALKED_PETS));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().census(
            r#"["account"] = { ["pets"] = {
                ["complete"] = true, ["revision"] = 2, ["held"] = 1,
                ["entries"] = {
                    [39] = {
                        ["name"] = "Mechanical Squirrel", ["count"] = 1, ["level"] = 25,
                        ["seen"] = 2000000000,
                    },
                },
            } },"#,
        ));
        install.collect(2_000_100_100);

        assert_eq!(
            ids_of(
                &install,
                "SELECT species_id FROM account_pets ORDER BY species_id"
            ),
            vec![39]
        );
        // And the duplicates that were let go are off the count of the one that stayed.
        let count: i64 = install
            .open()
            .query_row(
                "SELECT count FROM account_pets WHERE species_id = 39",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn files_every_toy_a_walk_of_the_box_found() {
        let install = Install::of(&SavedVariables::new().census(WALKED_TOYS));

        install.collect(2_000_000_100);

        let stored: Vec<(i64, Option<String>, i64)> = {
            let connection = install.open();
            let mut statement = connection
                .prepare("SELECT item_id, name, favourite FROM account_toys ORDER BY item_id")
                .unwrap();
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            rows
        };
        assert_eq!(
            stored,
            vec![
                (54212, Some("Foot Ball".into()), 1),
                (88801, Some("Wormhole Generator".into()), 0),
            ]
        );
        // And the claim says what the domain says about itself: the walk ran and the reading is
        // still not whole, because the list the client indexed was the player's filtered one.
        assert_eq!(claim_of(&install, "toys").complete, 0);
    }

    /// The rule the two grow-only domains live inside. A reading of either is a set of positive
    /// observations and nothing more, so **no** reading may take a row out — not even one that
    /// arrives claiming to be complete, which the addon never writes and a hand-edited file
    /// might.
    #[test]
    fn no_reading_of_a_grow_only_collection_ever_deletes_a_row() {
        let install = Install::of(&SavedVariables::new().census(WALKED_TOYS));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().census(
            r#"["account"] = { ["toys"] = {
                ["complete"] = true, ["revision"] = 2, ["held"] = 1,
                ["entries"] = {
                    [61031] = { ["name"] = "Blazing Wings", ["seen"] = 2000000000 },
                },
            } },"#,
        ));
        install.collect(2_000_100_100);

        // The two the second walk was not shown are still there, and the one it found is beside
        // them.
        assert_eq!(
            ids_of(
                &install,
                "SELECT item_id FROM account_toys ORDER BY item_id"
            ),
            vec![54212, 61031, 88801]
        );
    }

    /// The heirloom's version of a currency's cap: how far this one has been taken against how far
    /// it goes, which is what makes "is this one finished with" answerable for an heirloom bought
    /// years before Chronie was installed.
    #[test]
    fn files_how_far_an_heirloom_has_been_taken_and_how_far_it_goes() {
        let install = Install::of(&SavedVariables::new().census(WALKED_HEIRLOOMS));

        install.collect(2_000_000_100);

        let necklace: (String, String, Option<i64>, Option<i64>, Option<i64>) = install
            .open()
            .query_row(
                "SELECT name, slot, upgrade_level, max_upgrade, source
                   FROM account_heirlooms WHERE item_id = 122668",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            necklace,
            (
                "Eternal Woven Ivy Necklace".into(),
                "INVTYPE_NECK".into(),
                Some(5),
                Some(5),
                Some(1),
            )
        );
        // Bought and never upgraded. Null rather than nought, because "no upgrades yet" and "this
        // build would not say" are different answers and a screen may not draw them the same.
        let untouched: (Option<i64>, Option<i64>) = install
            .open()
            .query_row(
                "SELECT upgrade_level, max_upgrade FROM account_heirlooms WHERE item_id = 122340",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(untouched, (None, Some(5)));
        // The client's own count of what is known, beside how much of it this walk reached.
        let claim = claim_of(&install, "heirlooms");
        assert_eq!((claim.held, claim.counted, claim.complete), (2, Some(2), 0));
    }

    /// A title is one character's, which is the plainest case of the character scope in the whole
    /// census: two alts of one account share almost none of them.
    #[test]
    fn files_a_characters_titles_and_which_side_of_the_name_each_goes_on() {
        let install = Install::of(&SavedVariables::new().census(ASTER_WALKED_TITLES));

        install.collect(2_000_000_100);

        assert_eq!(title_ids(&install, "Aster-Vale"), vec![8, 42]);
        let stored: Vec<(i64, Option<String>, i64)> = {
            let connection = install.open();
            let mut statement = connection
                .prepare(
                    "SELECT t.title_id, t.name, t.suffix FROM census_titles t
                       JOIN characters c ON c.id = t.character_id
                      WHERE c.source_key = 'Aster-Vale' ORDER BY t.title_id",
                )
                .unwrap();
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            rows
        };
        // Trimmed, with the side the space was saying kept beside it: "Sergeant" goes before the
        // name and "the Explorer" after it.
        assert_eq!(
            stored,
            vec![
                (8, Some("Sergeant".into()), 0),
                (42, Some("the Explorer".into()), 1)
            ]
        );
        let claim = claim_of(&install, "titles");
        assert_eq!(claim.held, 2);
        assert!(claim.character_id.is_some());
    }

    /// The property [`prune`]'s `character` exists for, on the third domain to need it. What one
    /// alt has earned says nothing whatever about what another has.
    #[test]
    fn a_finished_title_walk_leaves_another_characters_titles_alone() {
        let install = Install::of(&SavedVariables::new().census(ASTER_WALKED_TITLES));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().census(
            r#"["characters"] = { ["Brin-Vale"] = { ["titles"] = {
                ["complete"] = true, ["revision"] = 1, ["held"] = 1,
                ["entries"] = {
                    [175] = { ["name"] = "the Insane", ["suffix"] = true, ["seen"] = 2000000000 },
                },
            } } },"#,
        ));
        install.collect(2_000_100_100);

        assert_eq!(title_ids(&install, "Aster-Vale"), vec![8, 42]);
        assert_eq!(title_ids(&install, "Brin-Vale"), vec![175]);
    }

    /// And the rule the module turns on, inside the one character it may be applied to: a title
    /// this character no longer has is one a finished walk of theirs did not mention.
    #[test]
    fn a_second_finished_title_walk_takes_out_what_that_character_no_longer_has() {
        let install = Install::of(&SavedVariables::new().census(ASTER_WALKED_TITLES));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().census(
            r#"["characters"] = { ["Aster-Vale"] = { ["titles"] = {
                ["complete"] = true, ["revision"] = 2, ["held"] = 1,
                ["entries"] = {
                    [42] = {
                        ["name"] = "the Explorer", ["suffix"] = true, ["seen"] = 2000000000,
                    },
                },
            } } },"#,
        ));
        install.collect(2_000_100_100);

        assert_eq!(title_ids(&install, "Aster-Vale"), vec![42]);
    }

    /// A title belongs to a character, so a titles reading filed against the account has nowhere
    /// to go — the same nowhere a wallet has. The claim is still recorded, which is what says a
    /// reading arrived and was not stored.
    #[test]
    fn records_the_claim_of_a_titles_reading_no_character_owns() {
        let install = Install::of(&SavedVariables::new().census(
            r#"["account"] = { ["titles"] = {
                ["complete"] = true, ["revision"] = 1, ["held"] = 1,
                ["entries"] = { [42] = { ["name"] = "the Explorer" } },
            } },"#,
        ));

        install.collect(2_000_000_100);

        let claim = claim_of(&install, "titles");
        assert_eq!(claim.held, 1);
        assert_eq!(claim.character_id, None);
        assert_eq!(count_of(&install.database, "census_titles"), 0);
    }

    /* ---------- reading it back ---------- */

    /// A walk of both domains at once, which is what a real logout writes: the account's whole
    /// achievement history reported by one character, and its mounts beside it.
    const WALKED_BOTH: &str = r#"
        ["account"] = {
            ["mounts"] = {
                ["complete"] = true, ["revision"] = 3, ["held"] = 2,
                ["build"] = "12.0.5.67823", ["by"] = "Aster-Vale",
                ["startedAt"] = 1999990000, ["completedAt"] = 1999990060,
                ["entries"] = {
                    [6] = { ["name"] = "Swift Zhevra", ["favourite"] = true },
                    [9] = { ["name"] = "Kua'fon", ["hidden"] = true },
                },
            },
            ["achievements"] = {
                ["complete"] = true, ["revision"] = 1, ["held"] = 3, ["counted"] = 3,
                ["build"] = "12.0.5.67823", ["by"] = "Aster-Vale",
                ["entries"] = {
                    [4842] = {
                        ["name"] = "Herald of the Titans", ["points"] = 25,
                        ["month"] = 8, ["day"] = 4, ["year"] = 9, ["mine"] = true,
                    },
                    [2144] = {
                        ["name"] = "The Immortal", ["points"] = 25,
                        ["month"] = 3, ["day"] = 22, ["year"] = 9, ["by"] = "Brin",
                    },
                    -- The client dated this one at nothing and named nobody for it, which is
                    -- what the oldest of them come back as.
                    [6] = { ["name"] = "Level 10", ["points"] = 10 },
                },
            },
        },
    "#;

    fn census_of(install: &Install) -> dto::AccountCensusPayload {
        account_census(&install.database).unwrap()
    }

    /// Every reading, with the claim over it whole. The claim is not reducible to a boolean:
    /// the build a census was taken on and who took it are what a reader needs to decide
    /// whether a reading that says it is complete is still describing this game.
    #[test]
    fn hands_over_the_claim_each_reading_makes_about_itself() {
        let install = Install::of(&SavedVariables::new().census(WALKED_BOTH));
        install.collect(2_000_000_100);

        let census = census_of(&install);
        let named: Vec<(&str, bool, i64, Option<i64>)> = census
            .readings
            .iter()
            .map(|reading| {
                (
                    reading.domain.as_str(),
                    reading.complete,
                    reading.held,
                    reading.counted,
                )
            })
            .collect();
        assert_eq!(
            named,
            vec![
                // Achievements carry the client's own counter and mounts deliberately do not.
                ("achievements", true, 3, Some(3)),
                ("mounts", true, 2, None),
            ]
        );
        let mounts = &census.readings[1];
        assert_eq!(mounts.build.as_deref(), Some("12.0.5.67823"));
        assert_eq!(mounts.walked_by.as_deref(), Some("Aster-Vale"));
        assert_eq!(mounts.completed_at, Some(1_999_990_060));
        assert_eq!(mounts.observed_at, 2_000_000_100);
        // Account-wide, so no character owns it — which is the difference between a reading
        // every alt would answer the same and a reading about one of them.
        assert_eq!(mounts.character, None);
    }

    /// The rule the whole screen depends on, carried out to the reader. A walk that was cut
    /// short says so here as loudly as it does in the database, because every number drawn
    /// over these entries is a subtraction and a subtraction from half a reading is wrong.
    #[test]
    fn says_out_loud_when_a_reading_is_not_whole() {
        let install = Install::of(&SavedVariables::new().census(
            r#"["account"] = { ["mounts"] = {
                ["complete"] = false, ["revision"] = 3, ["held"] = 1,
                ["entries"] = { [6] = { ["name"] = "Swift Zhevra" } },
            } },"#,
        ));
        install.collect(2_000_000_100);

        let census = census_of(&install);
        assert_eq!(census.readings.len(), 1);
        assert!(!census.readings[0].complete);
        assert_eq!(census.mounts.len(), 1);
    }

    /// The row the census exists for, read back with each line attributed. One character
    /// walked all three, and the client said of one that the walker earned it themselves —
    /// so the name on that line is the walker's, taken off the claim beside it.
    #[test]
    fn says_who_earned_each_achievement_and_the_day_they_did() {
        let install = Install::of(&SavedVariables::new().census(WALKED_BOTH));
        install.collect(2_000_000_100);

        let census = census_of(&install);
        let earned: Vec<(i64, Option<&str>, Option<&str>)> = census
            .achievements
            .iter()
            .map(|found| {
                (
                    found.id,
                    found.earned_on.as_deref(),
                    found.earned_by.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            earned,
            vec![
                // Dated at nothing by the client, and attributed to nobody — neither of
                // which is the same as a zero: not the first of January in the year 2000,
                // and not whoever happened to be doing the walking.
                (6, None, None),
                (2144, Some("2009-03-22"), Some("Brin")),
                // `mine`, so the character that did the walking is the one that earned it.
                (4842, Some("2009-08-04"), Some("Aster-Vale")),
            ]
        );
    }

    /// The client's year is the years since 2000, so an achievement earned in 2009 arrives as
    /// a 9. A reader that took it at face value would date a decade of somebody's play to the
    /// tenth year of the first century.
    #[test]
    fn reads_the_clients_year_as_the_years_since_2000() {
        assert_eq!(
            earned_on(Some(9), Some(8), Some(4)).as_deref(),
            Some("2009-08-04")
        );
        assert_eq!(
            earned_on(Some(25), Some(12), Some(31)).as_deref(),
            Some("2025-12-31")
        );
        // Nothing a reader could act on, and none of it a date: a month of nought is not
        // January, a day of nought is not the first, and an absent number is not a zero.
        assert_eq!(earned_on(Some(9), Some(0), Some(4)), None);
        assert_eq!(earned_on(Some(9), Some(8), Some(0)), None);
        assert_eq!(earned_on(Some(9), Some(13), Some(4)), None);
        assert_eq!(earned_on(None, Some(8), Some(4)), None);
    }

    /// What the player arranged travels with the mount, because "hidden" is how somebody says
    /// a mount is not really theirs to ride and a list that ignored it would disagree with the
    /// journal they can see.
    #[test]
    fn keeps_what_the_player_arranged_about_a_mount() {
        let install = Install::of(&SavedVariables::new().census(WALKED_BOTH));
        install.collect(2_000_000_100);

        let census = census_of(&install);
        let held: Vec<(i64, Option<&str>, bool, bool)> = census
            .mounts
            .iter()
            .map(|mount| {
                (
                    mount.id,
                    mount.name.as_deref(),
                    mount.favourite,
                    mount.hidden,
                )
            })
            .collect();
        assert_eq!(
            held,
            vec![
                (6, Some("Swift Zhevra"), true, false),
                (9, Some("Kua'fon"), false, true),
            ]
        );
    }

    /// A database nothing has ever walked answers with nothing rather than failing — which is
    /// every install on its first run, and is what the window has to be able to draw.
    #[test]
    fn answers_with_nothing_for_an_account_no_walk_has_ever_covered() {
        let install = Install::initialized();

        let census = census_of(&install);
        assert!(census.readings.is_empty());
        assert!(census.achievements.is_empty());
        assert!(census.mounts.is_empty());
    }

    /* ---------- the wardrobe ---------- */

    #[test]
    fn files_every_look_a_walk_of_the_wardrobe_found() {
        let install = Install::of(&SavedVariables::new().census(CLOTH_WALKED_APPEARANCES));

        install.collect(2_000_000_100);

        let stored: Vec<(i64, Option<i64>, i64, Option<i64>)> = {
            let connection = install.open();
            let mut statement = connection
                .prepare(
                    "SELECT appearance_id, category, favourite, seen_at
                       FROM account_appearances ORDER BY appearance_id",
                )
                .unwrap();
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            rows
        };
        assert_eq!(
            stored,
            vec![
                (1101, Some(1), 1, Some(1_999_990_000)),
                (1102, Some(11), 0, Some(1_999_990_000)),
            ]
        );
        // The claim goes in as it always does, and it says the thing this whole domain turns
        // on: the walk finished and the reading is still not whole.
        assert_eq!(
            claim_of(&install, "appearances"),
            Claim {
                complete: 0,
                revision: 1,
                held: 2,
                // What the client's own unfiltered counter made of it, against which `held` is
                // how much of the account's wardrobe the roster has managed to show us.
                counted: Some(9),
                build: Some("12.0.5.67823".into()),
                walked_by: Some("Aster-Vale".into()),
                character_id: None,
            }
        );
    }

    /// The rule this domain exists inside, and the one that would break it. A walk by a
    /// plate-wearing alt is not shown the account's cloth, so a reading that pruned would empty
    /// the wardrobe at every login by a character of a different armour type — and then fill it
    /// again at the next, forever.
    #[test]
    fn a_walk_the_next_character_could_not_repeat_adds_rather_than_replaces() {
        let install = Install::of(&SavedVariables::new().census(CLOTH_WALKED_APPEARANCES));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().census(PLATE_WALKED_APPEARANCES));
        install.collect(2_000_000_200);

        assert_eq!(
            ids_of(
                &install,
                "SELECT appearance_id FROM account_appearances ORDER BY appearance_id"
            ),
            vec![1101, 1102, 2201]
        );
    }

    /// And what the window is handed: the ids, and the claim that says what may be said over
    /// them. "At least this much" — never "this and no more".
    #[test]
    fn hands_the_window_the_looks_and_the_claim_that_qualifies_them() {
        let install = Install::of(&SavedVariables::new().census(CLOTH_WALKED_APPEARANCES));
        install.collect(2_000_000_100);

        let payload = collected_appearances(&install.database).unwrap();

        assert_eq!(payload.appearances, vec![1101, 1102]);
        let reading = payload.reading.expect("a walk that ran is a reading");
        assert!(!reading.complete);
        assert_eq!(reading.held, 2);
        assert_eq!(reading.counted, Some(9));
        assert_eq!(reading.walked_by.as_deref(), Some("Aster-Vale"));
    }

    /// A wardrobe nobody has walked draws as one nothing is known about, rather than as one
    /// nothing is in — which is the same distinction the claim exists to keep everywhere else.
    #[test]
    fn answers_with_no_reading_at_all_where_no_walk_has_happened() {
        let install = Install::initialized();

        let payload = collected_appearances(&install.database).unwrap();

        assert!(payload.reading.is_none());
        assert!(payload.appearances.is_empty());
    }
}
