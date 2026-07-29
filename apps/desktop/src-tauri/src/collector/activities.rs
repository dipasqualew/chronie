//! What a visit was for.
//!
//! A guess, and what somebody did about it. The guessing is [`crate::activity`]'s and is
//! re-run on every sync so that a better rule reaches the whole of history; this module is
//! the part that has to survive that: a correction somebody typed, a guess they deleted, a
//! kind they suppressed. Only rows still marked as guesses are thrown away and recomputed,
//! which is what makes an edit an edit rather than a value the next sync overwrites.

use super::database::open_database;
use crate::activity;
use crate::saved_variables::{Delve, EncounterEvent, Experience, Keystone, LevelUpEvent, Segment};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::Value;
use std::path::Path;

/// Rebuilds the guesses for one segment, leaving everything the user did untouched.
///
/// Only 'inferred' rows are thrown away and recomputed, so a better rule set reaches all of
/// history on the next sync. A kind the user suppressed — by deleting the guess or by
/// editing it into a correction of their own — is skipped, which is what makes an edit
/// survive a sync instead of being quietly overwritten by the guess it replaced.
pub(super) fn refresh_activities(
    transaction: &Transaction<'_>,
    segment_id: i64,
    segment: &Segment,
    now: i64,
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM activities WHERE segment_id = ?1 AND source = 'inferred'",
            [segment_id],
        )
        .map_err(|error| error.to_string())?;
    let mut suppressed = transaction
        .prepare("SELECT kind FROM activity_suppressions WHERE segment_id = ?1")
        .map_err(|error| error.to_string())?;
    let kinds = suppressed
        .query_map([segment_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(suppressed);

    for guess in activity::infer(segment) {
        if kinds.contains(&guess.kind) {
            continue;
        }
        transaction
            .execute(
                "INSERT INTO activities (
                     segment_id, kind, source, confidence, metadata_json, created_at, updated_at
                 ) VALUES (?1, ?2, 'inferred', ?3, ?4, ?5, ?5)",
                params![
                    segment_id,
                    guess.kind,
                    guess.confidence,
                    guess.metadata.to_string(),
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Everything the desktop app can do to a segment's activities.
///
/// The editing rules live here rather than in the Tauri command layer so they can be tested
/// against a real database without a running app. All three write a suppression where one is
/// needed, which is the single mechanism that stops the next sync undoing a user's work.
pub fn add_activity(
    database_path: &Path,
    segment_id: i64,
    kind: &str,
    metadata: &Value,
    now: i64,
) -> Result<(), String> {
    let mut connection = open_database(database_path)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    // Adding a kind by hand also suppresses the guess for it, so the next sync cannot end up
    // with the user's version and the inferred one sitting side by side.
    suppress(&transaction, segment_id, kind, now)?;
    transaction
        .execute(
            "DELETE FROM activities
             WHERE segment_id = ?1 AND kind = ?2 AND source = 'inferred'",
            params![segment_id, kind],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO activities (
                 segment_id, kind, source, confidence, metadata_json, created_at, updated_at
             ) VALUES (?1, ?2, 'manual', 1, ?3, ?4, ?4)",
            params![segment_id, kind, metadata.to_string(), now],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

/// Edits an activity. Editing a guess adopts it: the row becomes the user's, and the guess
/// that produced it is suppressed so the next sync does not add it back alongside.
pub fn update_activity(
    database_path: &Path,
    activity_id: i64,
    kind: &str,
    metadata: &Value,
    now: i64,
) -> Result<(), String> {
    let mut connection = open_database(database_path)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let existing: Option<(i64, String)> = transaction
        .query_row(
            "SELECT segment_id, kind FROM activities WHERE id = ?1",
            [activity_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((segment_id, previous_kind)) = existing else {
        return Err("That activity no longer exists.".into());
    };
    suppress(&transaction, segment_id, &previous_kind, now)?;
    if previous_kind != kind {
        suppress(&transaction, segment_id, kind, now)?;
        transaction
            .execute(
                "DELETE FROM activities
                 WHERE segment_id = ?1 AND kind = ?2 AND source = 'inferred'",
                params![segment_id, kind],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "UPDATE activities
             SET kind = ?2, source = 'manual', confidence = 1,
                 metadata_json = ?3, updated_at = ?4
             WHERE id = ?1",
            params![activity_id, kind, metadata.to_string(), now],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

/// Removes an activity for good. A guess is suppressed as well as deleted, or the next sync
/// would simply put it back and the deletion would look like it never happened.
pub fn delete_activity(database_path: &Path, activity_id: i64, now: i64) -> Result<(), String> {
    let mut connection = open_database(database_path)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let existing: Option<(i64, String)> = transaction
        .query_row(
            "SELECT segment_id, kind FROM activities WHERE id = ?1",
            [activity_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((segment_id, kind)) = existing else {
        return Ok(());
    };
    suppress(&transaction, segment_id, &kind, now)?;
    transaction
        .execute("DELETE FROM activities WHERE id = ?1", [activity_id])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

/// Throws away everything the user did to one segment's activities and re-runs the guesses.
/// The way back from an edit the user regrets, and the only way a suppressed kind ever
/// returns.
pub fn reset_activities(database_path: &Path, segment_id: i64, now: i64) -> Result<(), String> {
    let mut connection = open_database(database_path)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute(
            "DELETE FROM activity_suppressions WHERE segment_id = ?1",
            [segment_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM activities WHERE segment_id = ?1", [segment_id])
        .map_err(|error| error.to_string())?;
    let segment = segment_for_inference(&transaction, segment_id)?;
    refresh_activities(&transaction, segment_id, &segment, now)?;
    transaction.commit().map_err(|error| error.to_string())
}

fn suppress(
    transaction: &Transaction<'_>,
    segment_id: i64,
    kind: &str,
    now: i64,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO activity_suppressions (segment_id, kind, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(segment_id, kind) DO NOTHING",
            params![segment_id, kind, now],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Rebuilds just enough of a stored segment for the inference to read, so a reset can
/// re-guess without the SavedVariables file the segment originally came from — which may be
/// long gone, since the addon only keeps a rolling week.
fn segment_for_inference(
    transaction: &Transaction<'_>,
    segment_id: i64,
) -> Result<Segment, String> {
    let mut segment = transaction
        .query_row(
            "SELECT instance_name, instance_type, difficulty_name, difficulty_id,
                    duration_seconds, expansion_tier, latest_expansion_tier,
                    experience_gained, experience_percent,
                    experience_start_level, experience_end_level
             FROM segments WHERE id = ?1",
            [segment_id],
            |row| {
                let gained: i64 = row.get(7)?;
                Ok(Segment {
                    instance: row.get(0)?,
                    instance_type: row.get(1)?,
                    difficulty: row.get(2)?,
                    difficulty_id: row.get(3)?,
                    seconds: row.get(4)?,
                    expansion_tier: row.get(5)?,
                    latest_expansion_tier: row.get(6)?,
                    experience: (gained != 0).then(|| Experience {
                        gained,
                        percent: row.get::<_, f64>(8).unwrap_or(0.0),
                        start_level: row.get::<_, Option<i64>>(9).unwrap_or(None),
                        end_level: row.get::<_, Option<i64>>(10).unwrap_or(None),
                    }),
                    ..Segment::default()
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "That segment no longer exists.".to_string())?;

    let mut statement = transaction
        .prepare("SELECT success FROM encounters WHERE segment_id = ?1 ORDER BY position")
        .map_err(|error| error.to_string())?;
    segment.encounters = statement
        .query_map([segment_id], |row| {
            Ok(EncounterEvent {
                id: 0,
                success: row.get::<_, i64>(0)? != 0,
                name: None,
                at: None,
                difficulty_id: None,
                group_size: None,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let levels: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM level_ups WHERE segment_id = ?1",
            [segment_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    segment.level_ups = vec![LevelUpEvent { level: 0, at: None }; levels as usize];

    segment.keystone = transaction
        .query_row(
            "SELECT level, map_id, affixes_json, completed, duration_ms, on_time, upgrades
             FROM keystone_runs WHERE segment_id = ?1",
            [segment_id],
            |row| {
                let affixes: String = row.get(2)?;
                Ok(Keystone {
                    level: Some(row.get(0)?),
                    map_id: row.get(1)?,
                    affixes: serde_json::from_str(&affixes).unwrap_or_default(),
                    completed: row.get::<_, i64>(3)? != 0,
                    duration_ms: row.get(4)?,
                    on_time: row.get::<_, Option<i64>>(5)?.map(|value| value != 0),
                    upgrades: row.get(6)?,
                    ..Keystone::default()
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    segment.delve = transaction
        .query_row(
            "SELECT tier, scenario_id, started_at, completed_at, completed
             FROM delve_runs WHERE segment_id = ?1",
            [segment_id],
            |row| {
                Ok(Delve {
                    tier: row.get(0)?,
                    scenario_id: row.get(1)?,
                    started_at: row.get(2)?,
                    completed_at: row.get(3)?,
                    completed: row.get::<_, i64>(4)? != 0,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(segment)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::database::MIGRATIONS;
    use rusqlite::Connection;

    use crate::collector::testing::*;

    use std::fs;

    #[test]
    fn stores_a_keystone_run_and_guesses_the_activity_from_it() {
        let keystone = r#"
          { ["id"] = "key-1", ["character"] = "Aster-Vale", ["instance"] = "Halls of Atonement",
            ["instanceType"] = "party", ["difficultyId"] = 8, ["endedAt"] = 2000000000,
            ["experience"] = { ["gained"] = 200, ["percent"] = 0.02 },
            ["keystone"] = { ["level"] = 14, ["mapId"] = 378, ["affixes"] = { 9, 6 },
              ["completed"] = true, ["onTime"] = true, ["upgrades"] = 2,
              ["durationMs"] = 1740000 } }
        "#;
        let install = Install::of(&SavedVariables::new().segments(keystone));

        install.collect(2_000_000_000);

        let segment = &install.dashboard()["segments"][0];
        assert_eq!(segment["keystone"]["level"], 14);
        assert_eq!(segment["keystone"]["affixes"], serde_json::json!([9, 6]));
        assert_eq!(segment["keystone"]["onTime"], true);
        // Two hundred experience is incidental, not a levelling session.
        let activities = segment["activities"].as_array().unwrap();
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0]["kind"], "mythic_plus");
        assert_eq!(activities[0]["source"], "inferred");
        assert_eq!(activities[0]["metadata"]["keystoneLevel"], 14);
    }

    #[test]
    fn stores_a_delve_run_and_guesses_the_activity_from_it() {
        let delve = r#"
          { ["id"] = "delve-1", ["character"] = "Aster-Vale", ["instance"] = "Fungal Folly",
            ["instanceType"] = "scenario", ["difficultyId"] = 208, ["endedAt"] = 2000000000,
            ["delve"] = { ["tier"] = 8, ["scenarioId"] = 2680, ["startedAt"] = 1999999220,
              ["completedAt"] = 2000000000, ["completed"] = true } }
        "#;
        let install = Install::of(&SavedVariables::new().segments(delve));

        install.collect(2_000_000_000);

        let segment = &install.dashboard()["segments"][0];
        assert_eq!(segment["delve"]["tier"], 8);
        assert_eq!(segment["delve"]["scenarioId"], 2680);
        assert_eq!(segment["delve"]["completed"], true);
        let activities = segment["activities"].as_array().unwrap();
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0]["kind"], "delve");
        assert_eq!(activities[0]["source"], "inferred");
        assert_eq!(activities[0]["metadata"]["delve"], "Fungal Folly");
        assert_eq!(activities[0]["metadata"]["tier"], 8);
    }

    #[test]
    fn stores_encounters_with_their_wipes_and_guesses_a_legacy_raid() {
        let install = Install::of(&SavedVariables::new().segments(RAID_SEGMENT));

        install.collect(2_000_000_000);

        let segment = &install.dashboard()["segments"][0];
        assert_eq!(segment["encounters"].as_array().unwrap().len(), 2);
        assert_eq!(segment["encounters"][1]["success"], false);
        let activities = segment["activities"].as_array().unwrap();
        assert_eq!(activities[0]["kind"], "legacy_raid");
        assert_eq!(activities[0]["metadata"]["bossesKilled"], 1);
        assert_eq!(activities[0]["metadata"]["wipes"], 1);
    }

    /// The heart of the editing contract: a sync must never undo what the user decided.
    #[test]
    fn keeps_manual_activities_and_deletions_across_a_resync() {
        let install = Install::of(&SavedVariables::new().segments(RAID_SEGMENT));
        install.collect(2_000_000_000);
        let segment_id = install.dashboard()["segments"][0]["segmentId"]
            .as_i64()
            .unwrap();
        let inferred = activities_of(&install.database);
        let inferred_id = inferred[0]["id"].as_i64().unwrap();

        // The user throws the guess away and files two corrections of their own.
        delete_activity(&install.database, inferred_id, 2_000_000_100).unwrap();
        add_activity(
            &install.database,
            segment_id,
            "transmog_farm",
            &serde_json::json!({ "note": "chasing the Val'anyr shards" }),
            2_000_000_200,
        )
        .unwrap();
        add_activity(
            &install.database,
            segment_id,
            "progress_raid",
            &serde_json::json!({ "bossesKilled": 9 }),
            2_000_000_300,
        )
        .unwrap();

        install.rewrite(&SavedVariables::new().segments(RAID_SEGMENT));
        install.collect(2_000_000_400);

        let after = activities_of(&install.database);
        let kinds: Vec<&str> = after
            .iter()
            .map(|entry| entry["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["progress_raid", "transmog_farm"]);
        assert!(after.iter().all(|entry| entry["source"] == "manual"));
        assert!(
            !kinds.contains(&"legacy_raid"),
            "the deleted guess came back: {kinds:?}"
        );
        assert_eq!(after[0]["metadata"]["bossesKilled"], 9);
    }

    #[test]
    fn editing_a_guess_adopts_it_so_the_next_sync_leaves_it_alone() {
        let install = Install::of(&SavedVariables::new().segments(RAID_SEGMENT));
        install.collect(2_000_000_000);
        let inferred_id = activities_of(&install.database)[0]["id"].as_i64().unwrap();

        update_activity(
            &install.database,
            inferred_id,
            "progress_raid",
            &serde_json::json!({ "bossesKilled": 4, "wipes": 12 }),
            2_000_000_100,
        )
        .unwrap();
        install.rewrite(&SavedVariables::new().segments(RAID_SEGMENT));
        install.collect(2_000_000_200);

        let after = activities_of(&install.database);
        assert_eq!(after.len(), 1, "unexpected extra activities: {after:?}");
        assert_eq!(after[0]["kind"], "progress_raid");
        assert_eq!(after[0]["source"], "manual");
        assert_eq!(after[0]["metadata"]["wipes"], 12);
    }

    /// Better data — and, by the same mechanism, better rules — has to reach history the
    /// user never touched. That is the whole reason inferred rows are rebuilt on every sync
    /// rather than written once when the segment first arrives.
    #[test]
    fn rebuilds_untouched_guesses_on_every_sync() {
        let install = Install::of(&SavedVariables::new().segments(RAID_SEGMENT));
        install.collect(2_000_000_000);
        assert_eq!(
            activities_of(&install.database)[0]["metadata"]["bossesKilled"],
            1
        );

        // The same segment, filed again after the group killed a second boss.
        install.rewrite(&SavedVariables::new().segments(&RAID_SEGMENT.replace(
            r#"{ ["id"] = 746, ["name"] = "Ignis", ["success"] = false }"#,
            r#"{ ["id"] = 746, ["name"] = "Ignis", ["success"] = true }"#,
        )));
        install.collect(2_000_000_100);

        let after = activities_of(&install.database);
        assert_eq!(after.len(), 1);
        assert_eq!(after[0]["kind"], "legacy_raid");
        assert_eq!(after[0]["metadata"]["bossesKilled"], 2);
        assert_eq!(after[0]["metadata"]["wipes"], 0);
    }

    /// The way back from an edit the user regrets, and the only test that proves a segment
    /// can be re-guessed from stored state alone — the saved variables the segment came from
    /// are long gone by then, since the addon only keeps a rolling week.
    #[test]
    fn resetting_a_segment_restores_the_guesses_from_stored_state() {
        let install = Install::of(&SavedVariables::new().segments(RAID_SEGMENT));
        install.collect(2_000_000_000);
        let segment_id = install.dashboard()["segments"][0]["segmentId"]
            .as_i64()
            .unwrap();
        delete_activity(
            &install.database,
            activities_of(&install.database)[0]["id"].as_i64().unwrap(),
            2_000_000_100,
        )
        .unwrap();
        add_activity(
            &install.database,
            segment_id,
            "transmog_farm",
            &serde_json::json!({}),
            2_000_000_200,
        )
        .unwrap();
        assert_eq!(activities_of(&install.database).len(), 1);

        reset_activities(&install.database, segment_id, 2_000_000_300).unwrap();

        let after = activities_of(&install.database);
        assert_eq!(after.len(), 1);
        assert_eq!(after[0]["kind"], "legacy_raid");
        assert_eq!(after[0]["source"], "inferred");
        assert_eq!(after[0]["metadata"]["bossesKilled"], 1);
    }

    #[test]
    fn resetting_recovers_a_keystone_guess_without_the_saved_variables() {
        let keystone = r#"
          { ["id"] = "key-2", ["character"] = "Aster-Vale", ["instance"] = "Mists of Tirna Scithe",
            ["instanceType"] = "party", ["difficultyId"] = 8, ["endedAt"] = 2000000000,
            ["keystone"] = { ["level"] = 9, ["completed"] = true, ["onTime"] = false,
              ["upgrades"] = 0, ["durationMs"] = 2400000 } }
        "#;
        let install = Install::of(&SavedVariables::new().segments(keystone));
        install.collect(2_000_000_000);
        let segment_id = install.dashboard()["segments"][0]["segmentId"]
            .as_i64()
            .unwrap();
        delete_activity(
            &install.database,
            activities_of(&install.database)[0]["id"].as_i64().unwrap(),
            2_000_000_100,
        )
        .unwrap();

        reset_activities(&install.database, segment_id, 2_000_000_200).unwrap();

        let after = activities_of(&install.database);
        assert_eq!(after[0]["kind"], "mythic_plus");
        assert_eq!(after[0]["metadata"]["keystoneLevel"], 9);
        assert_eq!(after[0]["metadata"]["timed"], false);
        assert_eq!(after[0]["metadata"]["durationSeconds"], 2400);
    }

    /// A reset re-guesses from what SQLite holds, never from the file the addon wrote — which
    /// may be long gone, or may have been rotated out from under a segment kept forever. The
    /// tier and the story are the two things only the stored run can supply: without them the
    /// guess falls back to what the difficulty alone can say, and the delve quietly loses the
    /// only two facts a segment cannot recover for itself.
    #[test]
    fn resetting_recovers_a_delves_tier_without_the_saved_variables() {
        let delve = r#"
          { ["id"] = "delve-2", ["character"] = "Aster-Vale", ["instance"] = "Kriegval's Rest",
            ["instanceType"] = "scenario", ["difficultyId"] = 208, ["endedAt"] = 2000000000,
            ["delve"] = { ["tier"] = 11, ["scenarioId"] = 2681, ["startedAt"] = 1999999100,
              ["completedAt"] = 2000000000, ["completed"] = true } }
        "#;
        let install = Install::of(&SavedVariables::new().segments(delve));
        install.collect(2_000_000_000);
        let segment_id = install.dashboard()["segments"][0]["segmentId"]
            .as_i64()
            .unwrap();
        delete_activity(
            &install.database,
            activities_of(&install.database)[0]["id"].as_i64().unwrap(),
            2_000_000_100,
        )
        .unwrap();

        reset_activities(&install.database, segment_id, 2_000_000_200).unwrap();

        let after = activities_of(&install.database);
        assert_eq!(after[0]["kind"], "delve");
        assert_eq!(after[0]["metadata"]["delve"], "Kriegval's Rest");
        assert_eq!(after[0]["metadata"]["tier"], 11);
        assert_eq!(after[0]["metadata"]["storyId"], 2681);
        assert_eq!(after[0]["metadata"]["completed"], true);
        // The run's own clock survives the round trip through SQLite too: 900 seconds of
        // delve inside a segment that the player stayed in for longer.
        assert_eq!(after[0]["metadata"]["durationSeconds"], 900);
    }

    /// An existing database predates the activities schema entirely; the migration has to
    /// carry it forward rather than demanding a fresh install.
    #[test]
    fn migrates_a_database_written_before_activities_existed() {
        let install = Install::of(&SavedVariables::new().segments(RAID_SEGMENT));
        {
            fs::create_dir_all(install.database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&install.database).unwrap();
            let transaction = connection.transaction().unwrap();
            transaction.execute_batch(MIGRATIONS[0].sql).unwrap();
            transaction
                .pragma_update(None, "user_version", 1_i64)
                .unwrap();
            transaction.commit().unwrap();
        }

        install.collect(2_000_000_000);

        assert_eq!(activities_of(&install.database)[0]["kind"], "legacy_raid");
    }
}
