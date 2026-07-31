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
use std::path::Path;

use crate::dto;
use crate::failure::Failure;
use crate::saved_variables::{RawCensus, RawCensusAchievement, RawCensusMount, RawCensusState};

use super::database::open_database;
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
}
