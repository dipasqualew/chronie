//! What each character is saved to.
//!
//! Current state rather than history: the client only ever reports what is true right now, so
//! a lockout missing from a scan has lapsed and a character's rows are replaced wholesale.
//! The activities they bar are the exception — what those record is a reset cadence learned
//! across scans, and deleting one would throw that away every time nobody happened to be
//! locked to it.

use super::roster::upsert_character_key;
use crate::saved_variables::{self, RawLockout, RawLockoutActivity, RawRosterEntry};
use rusqlite::{params, Transaction};
use std::collections::{BTreeMap, HashMap};

use crate::failure::Failure;

/// One account's lockout tables, which only mean anything read together: `activities` says
/// what is true of each lockable thing, `characters` says who is locked to what, and
/// `roster` names the characters themselves — including ones with nothing saved at all,
/// which are precisely the ones worth knowing are still free.
#[derive(Debug, Default)]
pub(super) struct LockoutFeed {
    activities: BTreeMap<String, RawLockoutActivity>,
    characters: BTreeMap<String, BTreeMap<String, RawLockout>>,
    roster: BTreeMap<String, RawRosterEntry>,
}

impl LockoutFeed {
    pub(super) fn take(saved: &mut saved_variables::RawSavedVariables) -> Self {
        Self {
            activities: std::mem::take(&mut saved.activities),
            characters: std::mem::take(&mut saved.characters),
            roster: std::mem::take(&mut saved.roster),
        }
    }
}

/// The kind of thing an activity is, from the activity record when the addon wrote one and
/// from the lockout itself for saves that predate the activity table. Anything unrecognised
/// falls back to the one distinction every save has always carried, because the column is
/// constrained and a stray kind would fail the whole sync rather than one row.
fn lockout_kind(record: &RawLockoutActivity, fallback: Option<&RawLockout>) -> &'static str {
    match record
        .kind
        .as_deref()
        .or_else(|| fallback.and_then(|value| value.kind.as_deref()))
    {
        Some("raid") => "raid",
        Some("dungeon") => "dungeon",
        Some("world_boss") => "world_boss",
        _ => {
            let is_raid = record
                .is_raid
                .or_else(|| fallback.and_then(|value| value.is_raid))
                .unwrap_or(false);
            if is_raid {
                "raid"
            } else {
                "dungeon"
            }
        }
    }
}

/// How often the activity resets, as the addon recorded it. A save written before the addon
/// stated a cadence falls back to the kind, which is the same flat rule the addon applies:
/// raids weekly, dungeons daily, world bosses weekly.
fn lockout_period(record: &RawLockoutActivity, kind: &str) -> &'static str {
    match record.period.as_deref() {
        Some("daily") => "daily",
        Some("weekly") => "weekly",
        _ => match kind {
            "dungeon" => "daily",
            "raid" | "world_boss" => "weekly",
            _ => "unknown",
        },
    }
}

fn upsert_lockout_activity(
    transaction: &Transaction<'_>,
    account_id: i64,
    source_key: &str,
    record: &RawLockoutActivity,
    fallback: Option<&RawLockout>,
    now: i64,
) -> Result<i64, Failure> {
    let name = record
        .activity
        .as_deref()
        .or_else(|| fallback.and_then(|value| value.activity.as_deref()))
        .or_else(|| fallback.and_then(|value| value.instance.as_deref()))
        .unwrap_or(source_key);
    let kind = lockout_kind(record, fallback);
    transaction.execute(
        "INSERT INTO lockout_activities (
                 account_id, source_key, name, kind, reset_period,
                 first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(account_id, source_key) DO UPDATE SET
                 name = excluded.name,
                 kind = excluded.kind,
                 -- An 'unknown' never overwrites a cadence already worked out: a file that
                 -- could not say is not the same as one saying the answer changed.
                 reset_period = CASE
                     WHEN excluded.reset_period = 'unknown' THEN lockout_activities.reset_period
                     ELSE excluded.reset_period
                 END,
                 last_seen_at = excluded.last_seen_at",
        params![
            account_id,
            source_key,
            name,
            kind,
            lockout_period(record, kind),
            now
        ],
    )?;
    Ok(transaction.query_row(
        "SELECT id FROM lockout_activities WHERE account_id = ?1 AND source_key = ?2",
        params![account_id, source_key],
        |row| row.get(0),
    )?)
}

fn insert_lockout(
    transaction: &Transaction<'_>,
    activity_id: i64,
    character_id: i64,
    lockout: &RawLockout,
    expires_at: i64,
    now: i64,
) -> Result<(), Failure> {
    transaction.execute(
        "INSERT INTO lockouts (
                 activity_id, character_id, difficulty_id, difficulty, max_players,
                 expires_at, recorded_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            activity_id,
            character_id,
            lockout.difficulty_id.unwrap_or(0),
            lockout.difficulty.as_deref().unwrap_or(""),
            lockout.max_players.unwrap_or(0),
            expires_at,
            now
        ],
    )?;
    let lockout_id = transaction.last_insert_rowid();

    for (position, encounter) in lockout.encounters.iter().enumerate() {
        let Some(name) = encounter.name.as_deref() else {
            continue;
        };
        transaction.execute(
            "INSERT INTO lockout_encounters (lockout_id, position, name, killed)
                 VALUES (?1, ?2, ?3, ?4)",
            params![
                lockout_id,
                position as i64,
                name,
                i64::from(encounter.killed.unwrap_or(false))
            ],
        )?;
    }
    Ok(())
}

/// Writes one account's lockouts as current state rather than as history.
///
/// The client only ever reports what is true right now, so a lockout missing from a scan
/// has lapsed and a character's rows are replaced wholesale. Activities are the exception:
/// they are never deleted, because what they record — the reset cadence — is learned across
/// scans and would be thrown away every time nobody happened to be locked to one.
pub(super) fn sync_lockouts(
    transaction: &Transaction<'_>,
    account_id: i64,
    feed: &LockoutFeed,
    now: i64,
) -> Result<(), Failure> {
    for (character, info) in &feed.roster {
        upsert_character_key(
            transaction,
            account_id,
            character,
            info.class_file.as_deref(),
            info.level,
            now,
        )?;
    }

    let mut activity_ids: HashMap<String, i64> = HashMap::new();
    for (key, record) in &feed.activities {
        let id = upsert_lockout_activity(transaction, account_id, key, record, None, now)?;
        activity_ids.insert(key.clone(), id);
    }

    for (character, lockouts) in &feed.characters {
        let character_id =
            upsert_character_key(transaction, account_id, character, None, None, now)?;
        transaction.execute(
            "DELETE FROM lockouts WHERE character_id = ?1",
            [character_id],
        )?;

        for (slot, lockout) in lockouts {
            let Some(expires_at) = lockout.expiry else {
                continue;
            };
            // The map key is the slot a save is filed under — activity plus difficulty —
            // while the activity it belongs to is named on the lockout itself. A save
            // written before activities existed has no key, and rebuilding it the way the
            // addon does is what stops one raid becoming two activities here.
            let key = match lockout.key.as_deref() {
                Some(key) => key.to_string(),
                None => format!("instance\0{}", lockout.instance.as_deref().unwrap_or(slot)),
            };
            let activity_id = match activity_ids.get(&key) {
                Some(id) => *id,
                None => {
                    // Nothing is lost by the activity table not having mentioned it: what
                    // that table would have said is still on each lockout that referred to it.
                    let id = upsert_lockout_activity(
                        transaction,
                        account_id,
                        &key,
                        &RawLockoutActivity::default(),
                        Some(lockout),
                        now,
                    )?;
                    activity_ids.insert(key, id);
                    id
                }
            };
            insert_lockout(
                transaction,
                activity_id,
                character_id,
                lockout,
                expires_at,
                now,
            )?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::collector::database::open_database;
    use std::path::Path;

    use crate::collector::testing::*;

    /// Every lockout in the database, as (activity name, kind, cadence, character, expiry).
    fn lockouts_of(database: &Path) -> Vec<(String, String, String, String, i64)> {
        let connection = open_database(database).unwrap();
        let mut statement = connection
            .prepare(
                "SELECT a.name, a.kind, a.reset_period, c.source_key, l.expires_at
                 FROM lockouts l
                 JOIN lockout_activities a ON a.id = l.activity_id
                 JOIN characters c ON c.id = l.character_id
                 ORDER BY a.name, c.source_key, l.difficulty_id",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows
    }

    fn cadence_of(database: &Path, name: &str) -> String {
        open_database(database)
            .unwrap()
            .query_row(
                "SELECT reset_period FROM lockout_activities WHERE name = ?1",
                [name],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn count_of(database: &Path, table: &str) -> i64 {
        open_database(database)
            .unwrap()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    /// The addon's tables as it writes them: what is true of the activity, then each
    /// character's save of it, filed under activity key plus difficulty.
    const ULDUAR_AND_DOOMWALKER: &str = r#"
["activities"] = {
  ["instance\0Ulduar"] = { ["activity"] = "Ulduar", ["kind"] = "raid",
     ["isRaid"] = true, ["period"] = "weekly" },
  ["worldboss\00017711"] = { ["activity"] = "Doomwalker", ["kind"] = "world_boss",
     ["isRaid"] = false, ["period"] = "weekly" },
},
["roster"] = {
  ["Aster-Vale"] = { ["classFile"] = "MAGE", ["level"] = 80 },
  ["Brin-Vale"] = { ["classFile"] = "DRUID", ["level"] = 70 },
},
["characters"] = {
  ["Aster-Vale"] = {
    ["instance\0Ulduar\0004"] = { ["key"] = "instance\0Ulduar", ["activity"] = "Ulduar",
       ["kind"] = "raid", ["difficultyId"] = 4, ["difficulty"] = "25 Player",
       ["maxPlayers"] = 25, ["isRaid"] = true, ["expiry"] = 2000100000,
       ["resetSeconds"] = 604800,
       ["encounters"] = {
         { ["name"] = "Flame Leviathan", ["killed"] = true },
         { ["name"] = "Yogg-Saron", ["killed"] = false },
       } },
    ["worldboss\00017711\0000"] = { ["key"] = "worldboss\00017711", ["activity"] = "Doomwalker",
       ["kind"] = "world_boss", ["difficultyId"] = 0, ["difficulty"] = "",
       ["maxPlayers"] = 0, ["isRaid"] = false, ["expiry"] = 2000200000,
       ["resetSeconds"] = 500000, ["encounters"] = {} },
  },
}"#;

    #[test]
    fn records_a_lockout_against_the_activity_it_bars() {
        let install = Install::of(&SavedVariables::new().raw(ULDUAR_AND_DOOMWALKER));
        install.collect(2_000_000_000);

        assert_eq!(
            lockouts_of(&install.database),
            vec![
                (
                    "Doomwalker".to_string(),
                    "world_boss".to_string(),
                    "weekly".to_string(),
                    "Aster-Vale".to_string(),
                    2_000_200_000
                ),
                (
                    "Ulduar".to_string(),
                    "raid".to_string(),
                    "weekly".to_string(),
                    "Aster-Vale".to_string(),
                    2_000_100_000
                ),
            ]
        );
    }

    #[test]
    fn keeps_the_boss_list_a_lockout_was_read_with() {
        let install = Install::of(&SavedVariables::new().raw(ULDUAR_AND_DOOMWALKER));
        install.collect(2_000_000_000);

        let connection = open_database(&install.database).unwrap();
        let mut statement = connection
            .prepare("SELECT name, killed FROM lockout_encounters ORDER BY position")
            .unwrap();
        let bosses = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(
            bosses,
            vec![
                ("Flame Leviathan".to_string(), 1),
                ("Yogg-Saron".to_string(), 0)
            ]
        );
    }

    /// The reason the roster is carried at all: the character nothing is recorded against
    /// is exactly the one worth knowing is still free to go.
    #[test]
    fn records_a_roster_character_that_has_no_lockouts_and_never_produced_a_segment() {
        let install = Install::of(&SavedVariables::new().raw(ULDUAR_AND_DOOMWALKER));
        install.collect(2_000_000_000);

        let (class, level): (Option<String>, Option<i64>) = open_database(&install.database)
            .unwrap()
            .query_row(
                "SELECT class_file, last_level FROM characters WHERE source_key = 'Brin-Vale'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(class.as_deref(), Some("DRUID"));
        assert_eq!(level, Some(70));
        assert_eq!(count_of(&install.database, "segments"), 0);
    }

    #[test]
    fn keeps_two_difficulties_of_one_raid_as_two_lockouts_of_one_activity() {
        let install = Install::of(&SavedVariables::new().raw(
            r#"
["characters"] = {
  ["Aster-Vale"] = {
    ["instance\0Ulduar\0003"] = { ["key"] = "instance\0Ulduar", ["activity"] = "Ulduar",
       ["kind"] = "raid", ["difficultyId"] = 3, ["expiry"] = 2000100000 },
    ["instance\0Ulduar\0004"] = { ["key"] = "instance\0Ulduar", ["activity"] = "Ulduar",
       ["kind"] = "raid", ["difficultyId"] = 4, ["expiry"] = 2000200000 },
  },
}"#,
        ));
        install.collect(2_000_000_000);

        assert_eq!(count_of(&install.database, "lockouts"), 2);
        assert_eq!(count_of(&install.database, "lockout_activities"), 1);
    }

    /// The client only ever reports what is true now, so a lockout that has dropped off the
    /// scan has lapsed. Leaving it behind would report a free character as barred.
    #[test]
    fn forgets_a_lockout_the_addon_stopped_reporting() {
        let install = Install::of(&SavedVariables::new().raw(ULDUAR_AND_DOOMWALKER));
        install.collect(2_000_000_000);
        assert_eq!(count_of(&install.database, "lockouts"), 2);

        install.rewrite(&SavedVariables::new().raw(
            r#"["characters"] = { ["Aster-Vale"] = {
                 ["instance\0Ulduar\0004"] = { ["key"] = "instance\0Ulduar",
                    ["activity"] = "Ulduar", ["kind"] = "raid", ["difficultyId"] = 4,
                    ["expiry"] = 2000100000 } } }"#,
        ));
        install.collect(2_000_300_000);

        assert_eq!(
            lockouts_of(&install.database)
                .into_iter()
                .map(|row| row.0)
                .collect::<Vec<_>>(),
            vec!["Ulduar".to_string()]
        );
        assert_eq!(count_of(&install.database, "lockout_encounters"), 0);
    }

    /// An activity outlives every lockout on it, because what it records — the cadence — is
    /// learned across scans and would otherwise be thrown away every quiet week.
    #[test]
    fn keeps_an_activity_after_the_last_lockout_on_it_is_gone() {
        let install = Install::of(&SavedVariables::new().raw(ULDUAR_AND_DOOMWALKER));
        install.collect(2_000_000_000);

        install.rewrite(&SavedVariables::new().raw(
            r#"["activities"] = { ["instance\0Ulduar"] = { ["activity"] = "Ulduar",
                 ["kind"] = "raid", ["period"] = "weekly" } },
                 ["characters"] = { ["Aster-Vale"] = { } }"#,
        ));
        install.collect(2_000_300_000);

        assert_eq!(count_of(&install.database, "lockouts"), 0);
        assert_eq!(count_of(&install.database, "lockout_activities"), 2);
    }

    /// A cadence already worked out is not unlearned by a file that could not state one.
    #[test]
    fn keeps_a_known_cadence_when_a_later_file_cannot_state_one() {
        let install = Install::of(&SavedVariables::new().raw(ULDUAR_AND_DOOMWALKER));
        install.collect(2_000_000_000);

        install.rewrite(&SavedVariables::new().raw(
            r#"["activities"] = { ["instance\0Ulduar"] = { ["activity"] = "Ulduar",
                 ["kind"] = "raid" } }"#,
        ));
        install.collect(2_000_300_000);

        assert_eq!(cadence_of(&install.database, "Ulduar"), "weekly");
    }

    /// The cadence follows from the kind, so a save that never stated one still lands on the
    /// right answer rather than on 'unknown'.
    #[test]
    fn reads_a_cadence_off_the_kind_when_the_addon_did_not_state_one() {
        let install = Install::of(&SavedVariables::new().raw(
            r#"
["activities"] = {
  ["instance\0Ulduar"] = { ["activity"] = "Ulduar", ["kind"] = "raid" },
  ["instance\0Deadmines"] = { ["activity"] = "Deadmines", ["kind"] = "dungeon" },
  ["worldboss\00017711"] = { ["activity"] = "Doomwalker", ["kind"] = "world_boss" },
}"#,
        ));
        install.collect(2_000_000_000);

        assert_eq!(cadence_of(&install.database, "Ulduar"), "weekly");
        assert_eq!(cadence_of(&install.database, "Deadmines"), "daily");
        assert_eq!(cadence_of(&install.database, "Doomwalker"), "weekly");
    }

    /// A file from before activities were recorded separately names only the instance. It
    /// must land on the same activity a freshly written one does, or one raid becomes two.
    #[test]
    fn files_a_pre_activity_save_under_the_activity_a_current_one_would_use() {
        let install = Install::of(&SavedVariables::new().raw(
            r#"
["characters"] = {
  ["Aster-Vale"] = {
    ["Ulduar\0004"] = { ["instance"] = "Ulduar", ["difficultyId"] = 4,
       ["isRaid"] = true, ["expiry"] = 2000100000 },
  },
  ["Brin-Vale"] = {
    ["instance\0Ulduar\0004"] = { ["key"] = "instance\0Ulduar", ["activity"] = "Ulduar",
       ["kind"] = "raid", ["difficultyId"] = 4, ["expiry"] = 2000100000 },
  },
}"#,
        ));
        install.collect(2_000_000_000);

        assert_eq!(count_of(&install.database, "lockout_activities"), 1);
        assert_eq!(count_of(&install.database, "lockouts"), 2);
        assert_eq!(lockouts_of(&install.database)[0].1, "raid");
    }

    /// Lockouts ride the same file as segments, and neither may cost the other.
    #[test]
    fn collects_lockouts_and_segments_out_of_one_file() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(
                    r#"{ ["id"] = "kept", ["character"] = "Aster-Vale",
                          ["instance"] = "Ulduar", ["endedAt"] = 1999999000 }"#,
                )
                .raw(
                    r#"["characters"] = { ["Aster-Vale"] = {
                         ["instance\0Ulduar\0004"] = { ["key"] = "instance\0Ulduar",
                            ["activity"] = "Ulduar", ["kind"] = "raid", ["difficultyId"] = 4,
                            ["expiry"] = 2000100000 } } }"#,
                ),
        );

        let result = install.collect(2_000_000_000);

        assert_eq!(result.added, 1);
        assert_eq!(count_of(&install.database, "lockouts"), 1);
        // One character, reached from both directions.
        assert_eq!(count_of(&install.database, "characters"), 1);
    }
}
