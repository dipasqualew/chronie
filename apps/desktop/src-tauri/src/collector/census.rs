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
//! the same shape for every kind of thing; `account_mounts` and `account_achievements` hold what a
//! mount and an achievement actually are, which is not. Adding a domain is a table and a reader.

use rusqlite::{params, Transaction};
use serde_json::Value;
use std::collections::BTreeSet;

use crate::failure::Failure;
use crate::saved_variables::{RawCensus, RawCensusAchievement, RawCensusMount, RawCensusState};

use super::roster::upsert_character_key;

/// The domains this build knows how to store, and the table each one lives in.
///
/// A domain the addon sends that is not in here is not an error: a newer addon beside an older app
/// is the ordinary way a pair of these drift, and the claim is still worth recording even when the
/// entries cannot be. So the claim is written for every domain and the entries only for these.
const MOUNTS: &str = "mounts";
const ACHIEVEMENTS: &str = "achievements";

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
        let character_id = upsert_character_key(transaction, account_id, character, None, None, now)?;
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

    match domain {
        MOUNTS => sync_mounts(transaction, account_id, state, complete),
        ACHIEVEMENTS => sync_achievements(transaction, account_id, state, complete),
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
fn prune(
    transaction: &Transaction<'_>,
    table: &str,
    key: &str,
    account_id: i64,
    ids: &BTreeSet<i64>,
) -> Result<(), Failure> {
    if ids.is_empty() {
        // A complete walk that found nothing is a real answer — a brand new account holds no
        // mounts — and it has to be able to empty the table. `NOT IN ()` is not valid SQL, so the
        // empty case is the statement without the clause rather than a special value inside it.
        transaction.execute(
            &format!("DELETE FROM {table} WHERE account_id = ?1"),
            params![account_id],
        )?;
        return Ok(());
    }
    let kept = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    transaction.execute(
        &format!("DELETE FROM {table} WHERE account_id = ?1 AND {key} NOT IN ({kept})"),
        params![account_id],
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
            &ids_of(state),
        )?;
    }
    Ok(())
}
