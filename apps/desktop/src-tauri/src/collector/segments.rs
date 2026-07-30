//! A visit, and everything that happened during it.
//!
//! One segment row per visit, and a child table for each kind of thing the addon recorded
//! while it was open: what dropped, what was earned, what was caught, what a set was changed
//! to. The children are rebuilt from the file on every sync — the file is the record and the
//! database is a reading of it — which is why anything a person did to a segment lives
//! somewhere this module does not touch. See [`super::activities`].

use super::activities::refresh_activities;
use crate::failure::Failure;
use crate::saved_variables::Segment;
use rusqlite::{params, OptionalExtension, Transaction};

pub(super) fn clear_outcomes(
    transaction: &Transaction<'_>,
    segment_id: i64,
) -> Result<(), Failure> {
    for table in [
        "transmogs",
        "achievements",
        "quests",
        "currency_gains",
        "reputation_gains",
        "level_ups",
        "mounts",
        "pets",
        "toys",
        "housing_items",
        "housing_level_ups",
        "encounters",
        "keystone_runs",
        "delve_runs",
        // equipset_slots hang off the change row and go with it.
        "equipset_changes",
    ] {
        transaction.execute(
            &format!("DELETE FROM {table} WHERE segment_id = ?1"),
            [segment_id],
        )?;
    }
    Ok(())
}

fn insert_outcomes(
    transaction: &Transaction<'_>,
    character_id: i64,
    segment_id: i64,
    segment: &Segment,
) -> Result<(), Failure> {
    clear_outcomes(transaction, segment_id)?;

    for (position, event) in segment.transmogs.iter().enumerate() {
        let acquisition_kind = match event.new_appearance {
            Some(true) => "appearance",
            Some(false) => "source",
            None => "unknown",
        };
        transaction.execute(
            "INSERT INTO transmogs (
                     segment_id, position, item_id, source_id, appearance_id,
                     collected_at, acquisition_kind
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                segment_id,
                position as i64,
                event.id,
                event.source_id,
                event.appearance_id,
                event.at,
                acquisition_kind
            ],
        )?;
    }

    for (position, event) in segment.achievements.iter().enumerate() {
        transaction.execute(
            "INSERT INTO achievements (
                     segment_id, position, achievement_id, name, earned_at, account_first
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                segment_id,
                position as i64,
                event.id,
                event.name.as_deref(),
                event.at,
                event.account_first.map(i64::from)
            ],
        )?;
    }

    for (position, event) in segment.quests.iter().enumerate() {
        transaction.execute(
            "INSERT INTO quests (
                     segment_id, position, quest_id, name, completed_at,
                     character_first, account_first
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                segment_id,
                position as i64,
                event.id,
                event.name.as_deref(),
                event.at,
                event.character_first.map(i64::from),
                event.account_first.map(i64::from)
            ],
        )?;
    }

    for event in &segment.currencies {
        transaction.execute(
            "INSERT INTO currency_gains (segment_id, currency_id, name, amount, total)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            params![segment_id, event.id, event.name, event.amount, event.total],
        )?;
    }

    for event in &segment.reputation {
        transaction.execute(
            "INSERT INTO reputation_gains (
                     segment_id, faction, amount, standing, standing_current, standing_max
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                segment_id,
                event.faction,
                event.amount,
                event.standing.as_deref(),
                event.current,
                event.max
            ],
        )?;
    }

    for (position, event) in segment.level_ups.iter().enumerate() {
        transaction.execute(
            "INSERT INTO level_ups (segment_id, position, level, reached_at)
                 VALUES (?1, ?2, ?3, ?4)",
            params![segment_id, position as i64, event.level, event.at],
        )?;
    }

    for (position, event) in segment.mounts.iter().enumerate() {
        transaction.execute(
            "INSERT INTO mounts (segment_id, position, mount_id, name, collected_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                segment_id,
                position as i64,
                event.id,
                event.name.as_deref(),
                event.at
            ],
        )?;
    }

    for (position, event) in segment.pets.iter().enumerate() {
        transaction.execute(
            "INSERT INTO pets (
                     segment_id, position, species_id, name, collected_at, pet_guid,
                     species_first
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                segment_id,
                position as i64,
                event.id,
                event.name.as_deref(),
                event.at,
                event.guid.as_deref(),
                event.species_first.map(i64::from)
            ],
        )?;
    }

    for (position, event) in segment.toys.iter().enumerate() {
        transaction.execute(
            "INSERT INTO toys (segment_id, position, item_id, name, collected_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                segment_id,
                position as i64,
                event.id,
                event.name.as_deref(),
                event.at
            ],
        )?;
    }

    for (position, event) in segment.housing_items.iter().enumerate() {
        transaction.execute(
            "INSERT INTO housing_items (
                     segment_id, position, decor_id, name, collected_at, warband_first
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                segment_id,
                position as i64,
                event.id,
                event.name.as_deref(),
                event.at,
                event.warband_first.map(i64::from)
            ],
        )?;
    }

    for (position, event) in segment.housing_level_ups.iter().enumerate() {
        transaction.execute(
            "INSERT INTO housing_level_ups (segment_id, position, level, reached_at)
                 VALUES (?1, ?2, ?3, ?4)",
            params![segment_id, position as i64, event.level, event.at],
        )?;
    }

    for (position, event) in segment.encounters.iter().enumerate() {
        transaction.execute(
            "INSERT INTO encounters (
                     segment_id, position, encounter_id, name, ended_at,
                     difficulty_id, group_size, success
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                segment_id,
                position as i64,
                event.id,
                event.name.as_deref(),
                event.at,
                event.difficulty_id,
                event.group_size,
                i64::from(event.success)
            ],
        )?;
    }

    if let Some(keystone) = &segment.keystone {
        // A run with no level is not one the app can say anything useful about, and the
        // column is NOT NULL for exactly that reason.
        if let Some(level) = keystone.level {
            transaction.execute(
                "INSERT INTO keystone_runs (
                         segment_id, level, map_id, affixes_json, started_at,
                         completed_at, completed, duration_ms, on_time, upgrades
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    segment_id,
                    level,
                    keystone.map_id,
                    serde_json::to_string(&keystone.affixes)?,
                    keystone.started_at,
                    keystone.completed_at,
                    i64::from(keystone.completed),
                    keystone.duration_ms,
                    keystone.on_time.map(i64::from),
                    keystone.upgrades
                ],
            )?;
        }
    }

    if let Some(delve) = &segment.delve {
        // Every column but the segment is nullable here, unlike a keystone run: a delve the
        // addon saw start is worth recording even when the client had not yet said which
        // tier or which story it was, because the segment names the delve either way.
        transaction.execute(
            "INSERT INTO delve_runs (
                     segment_id, tier, scenario_id, started_at, completed_at, completed
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                segment_id,
                delve.tier,
                delve.scenario_id,
                delve.started_at,
                delve.completed_at,
                i64::from(delve.completed)
            ],
        )?;
    }

    insert_equipset_changes(transaction, character_id, segment_id, segment)?;
    Ok(())
}

/// Files what happened to the character's equipment sets, and what each changed slot holds.
///
/// The slot rows are the ledger: each says what its slot holds *after* the change, and the
/// row before it for the same character, set and slot is what it replaced. Nothing here
/// writes a "before", because the row behind already is one.
///
/// A change naming no slots is still written when the set itself came or went — an empty set
/// is a set — which is why the slot loop is allowed to write nothing.
fn insert_equipset_changes(
    transaction: &Transaction<'_>,
    character_id: i64,
    segment_id: i64,
    segment: &Segment,
) -> Result<(), Failure> {
    for (position, event) in segment.equipset_changes.iter().enumerate() {
        let changed_at = event.at;
        transaction.execute(
            "INSERT INTO equipset_changes (
                     segment_id, position, character_id, set_id, name, kind, changed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                segment_id,
                position as i64,
                character_id,
                event.set_id,
                event.name,
                event.kind.as_str(),
                changed_at
            ],
        )?;
        let change_id = transaction.last_insert_rowid();

        for item in &event.items {
            transaction.execute(
                "INSERT INTO equipset_slots (
                         change_id, character_id, set_id, slot,
                         item_id, item_level, item_name, changed_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(change_id, slot) DO NOTHING",
                params![
                    change_id,
                    character_id,
                    event.set_id,
                    item.slot,
                    item.item_id,
                    item.item_level,
                    item.item_name.as_deref(),
                    changed_at
                ],
            )?;
        }
    }
    Ok(())
}

pub(super) fn upsert_segment(
    transaction: &Transaction<'_>,
    character_id: i64,
    segment: &Segment,
    now: i64,
) -> Result<bool, Failure> {
    let source_id = &segment.id;
    let existing: Option<i64> = transaction
        .query_row(
            "SELECT id FROM segments WHERE character_id = ?1 AND source_id = ?2",
            params![character_id, source_id],
            |row| row.get(0),
        )
        .optional()?;
    let experience = segment.experience.as_ref();
    transaction.execute(
        "INSERT INTO segments (
                 character_id, source_id, ended_day, instance_name, instance_type,
                 difficulty_name, difficulty_id, started_at, ended_at, duration_seconds,
                 character_level, loot_value, gold_diff, currency_total, reputation_total,
                 housing_xp, first_seen_at, last_seen_at,
                 expansion_tier, latest_expansion_tier, experience_gained,
                 experience_percent, experience_start_level, experience_end_level
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                 ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17,
                 ?18, ?19, ?20, ?21, ?22, ?23
             )
             ON CONFLICT(character_id, source_id) DO UPDATE SET
                 ended_day = excluded.ended_day,
                 instance_name = excluded.instance_name,
                 instance_type = excluded.instance_type,
                 difficulty_name = excluded.difficulty_name,
                 difficulty_id = excluded.difficulty_id,
                 started_at = excluded.started_at,
                 ended_at = excluded.ended_at,
                 duration_seconds = excluded.duration_seconds,
                 character_level = excluded.character_level,
                 loot_value = excluded.loot_value,
                 gold_diff = excluded.gold_diff,
                 currency_total = excluded.currency_total,
                 reputation_total = excluded.reputation_total,
                 housing_xp = excluded.housing_xp,
                 last_seen_at = excluded.last_seen_at,
                 expansion_tier = excluded.expansion_tier,
                 latest_expansion_tier = excluded.latest_expansion_tier,
                 experience_gained = excluded.experience_gained,
                 experience_percent = excluded.experience_percent,
                 experience_start_level = excluded.experience_start_level,
                 experience_end_level = excluded.experience_end_level",
        params![
            character_id,
            source_id,
            segment.day,
            segment.instance,
            segment.instance_type,
            segment.difficulty,
            segment.difficulty_id,
            segment.started_at,
            segment.ended_at,
            segment.seconds,
            segment.level,
            segment.loot_value,
            segment.gold_diff,
            segment.currency_total,
            segment.reputation_total,
            segment.housing_xp,
            now,
            segment.expansion_tier,
            segment.latest_expansion_tier,
            experience.map(|value| value.gained).unwrap_or(0),
            experience.map(|value| value.percent).unwrap_or(0.0),
            experience.and_then(|value| value.start_level),
            experience.and_then(|value| value.end_level),
        ],
    )?;
    let segment_id = existing.unwrap_or_else(|| transaction.last_insert_rowid());
    insert_outcomes(transaction, character_id, segment_id, segment)?;
    refresh_activities(transaction, segment_id, segment, now)?;
    Ok(existing.is_none())
}

#[cfg(test)]
mod tests {
    use crate::collector::database::{open_database, MIGRATIONS};
    use rusqlite::Connection;
    use serde_json::Value;

    use crate::collector::testing::*;

    use std::fs;

    #[test]
    fn stores_what_happened_to_an_equipment_set_and_what_each_slot_holds() {
        let install = Install::of(&SavedVariables::new().segments(EQUIPSET_SEGMENTS));

        install.collect(2_000_100_000);

        let payload = install.dashboard();
        // Newest first, so the edit leads and the creation follows.
        let edit = &payload["segments"][0]["equipsetChanges"][0];
        assert_eq!(edit["setId"], 3);
        assert_eq!(edit["name"], "Raid");
        assert_eq!(edit["kind"], "updated");
        assert_eq!(edit["at"], 2_000_090_500_i64);
        assert_eq!(edit["items"].as_array().unwrap().len(), 1);
        assert_eq!(edit["items"][0]["slot"], 1);
        assert_eq!(edit["items"][0]["itemId"], 101);
        assert_eq!(edit["items"][0]["itemLevel"], 639);
        assert_eq!(edit["items"][0]["itemName"], "Deepwater Crown");

        let created = &payload["segments"][1]["equipsetChanges"][0];
        assert_eq!(created["kind"], "created");
        assert_eq!(created["items"].as_array().unwrap().len(), 2);
    }

    /// A battle pet is the one collectible a player can own several of, and the addon is
    /// the only thing in a position to tell the two cases apart — the client's owned count
    /// is only true at the moment of the catch. So the flag travels verbatim, all three
    /// ways: caught for the first time, caught again, and caught by a build that never said.
    #[test]
    fn keeps_whether_a_caught_pet_was_the_first_of_its_species() {
        let pets = r#"
          { ["id"] = "pets-1", ["character"] = "Aster-Vale", ["instance"] = "Nagrand",
            ["instanceType"] = "none", ["endedAt"] = 2000000000, ["startedAt"] = 1999990000,
            ["pets"] = {
              { ["id"] = 456, ["name"] = "Darkmoon Rabbit", ["at"] = 1999990500,
                ["guid"] = "BattlePet-0-1", ["speciesFirst"] = true },
              { ["id"] = 456, ["name"] = "Darkmoon Rabbit", ["at"] = 1999990600,
                ["guid"] = "BattlePet-0-2", ["speciesFirst"] = false },
              { ["id"] = 789, ["name"] = "Mossling", ["at"] = 1999990700 }
            } }
        "#;
        let install = Install::of(&SavedVariables::new().segments(pets));

        install.collect(2_000_000_100);

        let caught = &install.dashboard()["segments"][0]["pets"];
        assert_eq!(caught[0]["speciesFirst"], true);
        assert_eq!(caught[1]["speciesFirst"], false);
        // Not false: a catch recorded before the addon asked is one nobody can say either
        // way about, and reading it as a duplicate would hide a pet that may well be new.
        assert_eq!(caught[2]["speciesFirst"], Value::Null);
    }

    /// The whole reason the ledger stores only the state after a change: the row behind is
    /// the before, so an edit knows what it replaced without anyone writing it down twice.
    #[test]
    fn reads_what_a_slot_replaced_out_of_the_row_behind_it() {
        let install = Install::of(&SavedVariables::new().segments(EQUIPSET_SEGMENTS));

        install.collect(2_000_100_000);

        let payload = install.dashboard();
        let edit = &payload["segments"][0]["equipsetChanges"][0]["items"][0];
        assert_eq!(edit["previousItemId"], 100);
        assert_eq!(edit["previousItemLevel"], 623);
        assert_eq!(edit["previousItemName"], "Tideglass Crown");

        // The creation is the first thing that ever happened to the slot, so there is no row
        // behind it and nothing to have replaced.
        let created = &payload["segments"][1]["equipsetChanges"][0]["items"][0];
        assert_eq!(created["previousItemId"], Value::Null);
        assert_eq!(created["previousItemLevel"], Value::Null);
    }

    /// A slot the change emptied is a fact worth keeping, not a row to skip: "the head slot
    /// was cleared" says as much about a set as any item ever put in it.
    #[test]
    fn keeps_a_slot_a_change_emptied() {
        let cleared = r#"
          { ["id"] = "set-1", ["character"] = "Aster-Vale", ["instance"] = "Valdrakken",
            ["instanceType"] = "none", ["endedAt"] = 2000000000,
            ["equipsetChanges"] = {
              { ["setId"] = 3, ["name"] = "Raid", ["kind"] = "deleted", ["at"] = 1999990500,
                ["items"] = { { ["slot"] = 1 } } }
            } }
        "#;
        let install = Install::of(&SavedVariables::new().segments(cleared));

        install.collect(2_000_000_000);

        let item = &install.dashboard()["segments"][0]["equipsetChanges"][0]["items"][0];
        assert_eq!(item["slot"], 1);
        assert_eq!(item["itemId"], Value::Null);
    }

    /// A set that was created and holds nothing is still a set that was created. The change
    /// row has to survive having no slots to hang off it.
    #[test]
    fn keeps_a_change_that_names_no_slot_at_all() {
        let empty = r#"
          { ["id"] = "set-1", ["character"] = "Aster-Vale", ["instance"] = "Valdrakken",
            ["instanceType"] = "none", ["endedAt"] = 2000000000,
            ["equipsetChanges"] = {
              { ["setId"] = 3, ["name"] = "Empty", ["kind"] = "created", ["at"] = 1999990500,
                ["items"] = {} }
            } }
        "#;
        let install = Install::of(&SavedVariables::new().segments(empty));

        install.collect(2_000_000_000);

        let change = &install.dashboard()["segments"][0]["equipsetChanges"][0];
        assert_eq!(change["kind"], "created");
        assert_eq!(change["items"], serde_json::json!([]));
    }

    /// Two characters can each own a set numbered 3, and they are not the same set. Keying
    /// the ledger's history by the character alone is what keeps one from reading as the
    /// other's before.
    #[test]
    fn keeps_two_characters_sets_apart_even_when_they_share_an_id() {
        let shared = r#"
          { ["id"] = "aster-1", ["character"] = "Aster-Vale", ["instance"] = "Valdrakken",
            ["instanceType"] = "none", ["endedAt"] = 2000000000,
            ["equipsetChanges"] = {
              { ["setId"] = 3, ["name"] = "Aster Raid", ["kind"] = "created", ["at"] = 1999990000,
                ["items"] = { { ["slot"] = 1, ["itemId"] = 100, ["itemLevel"] = 600 } } }
            } },
          { ["id"] = "brann-1", ["character"] = "Brann-Vale", ["instance"] = "Valdrakken",
            ["instanceType"] = "none", ["endedAt"] = 2000100000,
            ["equipsetChanges"] = {
              { ["setId"] = 3, ["name"] = "Brann Raid", ["kind"] = "created", ["at"] = 2000090000,
                ["items"] = { { ["slot"] = 1, ["itemId"] = 500, ["itemLevel"] = 500 } } }
            } }
        "#;
        let install = Install::of(&SavedVariables::new().segments(shared));

        install.collect(2_000_100_000);

        let payload = install.dashboard();
        // Brann's creation is newest. It must not have inherited Aster's item as its before.
        let brann = &payload["segments"][0]["equipsetChanges"][0]["items"][0];
        assert_eq!(brann["itemId"], 500);
        assert_eq!(brann["previousItemId"], Value::Null);
    }

    /// Re-reading the same file rewrites a segment's rows, and the ledger must not grow a
    /// second copy of a change that already happened.
    #[test]
    fn does_not_double_a_change_when_the_same_segment_is_synced_again() {
        let install = Install::of(&SavedVariables::new().segments(EQUIPSET_SEGMENTS));
        install.collect(2_000_100_000);

        install.rewrite(&SavedVariables::new().segments(EQUIPSET_SEGMENTS));
        install.collect(2_000_100_001);

        let connection = open_database(&install.database).unwrap();
        let changes: i64 = connection
            .query_row("SELECT COUNT(*) FROM equipset_changes", [], |row| {
                row.get(0)
            })
            .unwrap();
        let slots: i64 = connection
            .query_row("SELECT COUNT(*) FROM equipset_slots", [], |row| row.get(0))
            .unwrap();
        assert_eq!((changes, slots), (2, 3));

        let edit = &install.dashboard()["segments"][0]["equipsetChanges"][0];
        assert_eq!(edit["items"][0]["previousItemId"], 100);
    }

    /// A kind the CHECK would refuse must not take the whole sync down with it. Everything
    /// else in the file is still worth storing.
    #[test]
    fn skips_a_change_whose_kind_is_not_one_of_the_three() {
        let nonsense = r#"
          { ["id"] = "set-1", ["character"] = "Aster-Vale", ["instance"] = "Valdrakken",
            ["instanceType"] = "none", ["endedAt"] = 2000000000, ["lootValue"] = 40,
            ["equipsetChanges"] = {
              { ["setId"] = 3, ["name"] = "Raid", ["kind"] = "rearranged", ["at"] = 1999990500,
                ["items"] = { { ["slot"] = 1, ["itemId"] = 100 } } }
            } }
        "#;
        let install = Install::of(&SavedVariables::new().segments(nonsense));

        install.collect(2_000_000_000);

        let segment = &install.dashboard()["segments"][0];
        assert_eq!(segment["equipsetChanges"], serde_json::json!([]));
        assert_eq!(segment["lootValue"], 40);
    }

    /// A history recorded before equipment sets were tracked has no such rows, and every
    /// reader of the payload is written to expect the key regardless.
    #[test]
    fn gives_a_segment_that_saw_no_set_change_an_empty_list() {
        let install = Install::of(&SavedVariables::new().segments(RAID_SEGMENT));

        install.collect(2_000_000_000);

        assert_eq!(
            install.dashboard()["segments"][0]["equipsetChanges"],
            serde_json::json!([])
        );
    }

    /// One segment holding both kinds of gain twice over: once with what the client said the
    /// character was left with, and once without. The pair is the point — the columns exist
    /// to tell "the client did not say" apart from "none", and only a file carrying both can
    /// show that the two survive as different things.
    const HOLDING_SEGMENT: &str = r#"
      { ["id"] = "hold-1", ["character"] = "Aster-Vale", ["instance"] = "Glass Caverns",
        ["instanceType"] = "party", ["endedAt"] = 2000000000, ["startedAt"] = 1999990000,
        ["currencies"] = {
          { ["id"] = 3008, ["name"] = "Valorstones", ["amount"] = 15, ["total"] = 12450 },
          { ["id"] = 2914, ["name"] = "Weathered Relic", ["amount"] = 3 }
        },
        ["reputation"] = {
          { ["faction"] = "Cavern Cartographers", ["amount"] = 250,
            ["standing"] = "Honored", ["current"] = 4200, ["max"] = 12000 },
          { ["faction"] = "Lamplighters", ["amount"] = 75 }
        } }
    "#;

    /// A gain says what was earned; what the character was left holding is the number that
    /// says whether it was enough to buy anything, or how far it moved the faction. Both are
    /// written by the addon and both have to come back out the other side of the database.
    #[test]
    fn keeps_what_a_gain_left_the_character_holding() {
        let install = Install::of(&SavedVariables::new().segments(HOLDING_SEGMENT));

        install.collect(2_000_000_000);

        let segment = &install.dashboard()["segments"][0];
        // Currencies come back ordered by name, so Valorstones leads.
        let currency = &segment["currencies"][0];
        assert_eq!(currency["name"], "Valorstones");
        assert_eq!(currency["amount"], 15);
        assert_eq!(currency["total"], 12_450);

        let faction = &segment["reputation"][0];
        assert_eq!(faction["faction"], "Cavern Cartographers");
        assert_eq!(faction["amount"], 250);
        assert_eq!(faction["standing"], "Honored");
        assert_eq!(faction["current"], 4_200);
        assert_eq!(faction["max"], 12_000);
    }

    /// The distinction the nullable columns exist for. An item-based currency counted before
    /// its first change has no holding, and a faction the client will not place has no
    /// standing — and neither of those is a holding of zero or a standing at the bottom of a
    /// bar. The key is still there, so nothing downstream has to guess whether it was asked.
    #[test]
    fn says_nothing_at_all_rather_than_zero_when_a_gain_carries_no_holding() {
        let install = Install::of(&SavedVariables::new().segments(HOLDING_SEGMENT));

        install.collect(2_000_000_000);

        let segment = &install.dashboard()["segments"][0];
        let currency = &segment["currencies"][1];
        assert_eq!(currency["name"], "Weathered Relic");
        assert_eq!(currency["amount"], 3);
        assert_eq!(currency["total"], Value::Null);
        assert!(
            currency
                .as_object()
                .expect("a currency object")
                .contains_key("total"),
            "the key has to be there and null, not missing: {currency}"
        );

        let faction = &segment["reputation"][1];
        assert_eq!(faction["faction"], "Lamplighters");
        assert_eq!(faction["standing"], Value::Null);
        assert_eq!(faction["current"], Value::Null);
        assert_eq!(faction["max"], Value::Null);
        let keys = faction.as_object().expect("a reputation object");
        for key in ["standing", "current", "max"] {
            assert!(
                keys.contains_key(key),
                "{key} has to be there and null: {faction}"
            );
        }
    }

    /// A history collected before the holdings were kept has rows in both tables and no
    /// columns to put them in. The migration has to widen those tables under the rows that
    /// are already there rather than demanding a fresh install — and what it cannot know
    /// about an old row is exactly what a null says.
    #[test]
    fn migrates_a_database_written_before_holdings_were_kept() {
        let install = Install::of(&SavedVariables::new().segments(HOLDING_SEGMENT));
        {
            fs::create_dir_all(install.database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&install.database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..4] {
                transaction.execute_batch(migration.sql).unwrap();
            }
            transaction
                .execute_batch(
                    "INSERT INTO accounts (id, source_key, first_seen_at, last_seen_at)
                       VALUES (1, 'legacy', 1900000000, 1900000000);
                     INSERT INTO characters (id, account_id, source_key, name, realm,
                                             first_seen_at, last_seen_at)
                       VALUES (1, 1, 'Brin-Vale', 'Brin', 'Vale', 1900000000, 1900000000);
                     INSERT INTO segments (id, character_id, source_id, ended_day,
                                           instance_name, instance_type, difficulty_name,
                                           started_at, ended_at, duration_seconds,
                                           first_seen_at, last_seen_at)
                       VALUES (1, 1, 'old-1', '2030-04-14', 'Copperwood', 'none', '',
                               1899999000, 1900000000, 1000, 1900000000, 1900000000);
                     INSERT INTO currency_gains (segment_id, currency_id, name, amount)
                       VALUES (1, 3008, 'Valorstones', 40);
                     INSERT INTO reputation_gains (segment_id, faction, amount)
                       VALUES (1, 'Lamplighters', 500);",
                )
                .unwrap();
            transaction
                .pragma_update(None, "user_version", 4_i64)
                .unwrap();
            transaction.commit().unwrap();
        }

        install.collect(2_000_000_000);

        let payload = install.dashboard();
        // Newest first, so the segment just collected leads and the old one follows.
        assert_eq!(payload["segments"][0]["currencies"][0]["total"], 12_450);
        let old = &payload["segments"][1];
        assert_eq!(old["id"], "old-1");
        assert_eq!(old["currencies"][0]["name"], "Valorstones");
        assert_eq!(old["currencies"][0]["amount"], 40);
        assert_eq!(old["currencies"][0]["total"], Value::Null);
        assert_eq!(old["reputation"][0]["faction"], "Lamplighters");
        assert_eq!(old["reputation"][0]["amount"], 500);
        assert_eq!(old["reputation"][0]["standing"], Value::Null);
    }
}
