//! Everything the window draws, read back out in one pass.
//!
//! A read model and nothing else: no table here is written, and every rule about what the
//! numbers mean has already been applied by the module that owns them. The shape is the one
//! the frontend expects — see [`crate::dto`] for the typed form of it — assembled segment by
//! segment, with each thing that happened pushed onto the visit it happened during.

use super::database::open_database;
use super::holdings::account_holdings;
use crate::activity;
use chrono::Utc;
use serde_json::Value;
use std::{collections::HashMap, path::Path};

fn push_event(
    segments: &mut [Value],
    indices: &HashMap<i64, usize>,
    segment_id: i64,
    key: &str,
    event: Value,
) {
    if let Some(index) = indices.get(&segment_id) {
        segments[*index][key]
            .as_array_mut()
            .expect("dashboard event list")
            .push(event);
    }
}

pub fn dashboard(database_path: &Path) -> Result<Value, String> {
    let connection = open_database(database_path)?;
    let mut statement = connection
        .prepare(
            "SELECT
                 s.id, s.source_id, c.source_key, c.class_file, s.character_level,
                 s.ended_day, s.instance_name, s.difficulty_name, s.instance_type,
                 s.difficulty_id, s.started_at, s.ended_at, s.duration_seconds,
                 s.loot_value, s.gold_diff, s.currency_total, s.reputation_total,
                 s.housing_xp, s.expansion_tier, s.latest_expansion_tier,
                 s.experience_gained, s.experience_percent,
                 s.experience_start_level, s.experience_end_level
             FROM segments s
             JOIN characters c ON c.id = s.character_id
             ORDER BY s.ended_at DESC, s.source_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let experience_gained: i64 = row.get(20)?;
            let experience_percent: f64 = row.get(21)?;
            let experience_start: Option<i64> = row.get(22)?;
            let experience_end: Option<i64> = row.get(23)?;
            Ok((
                row.get::<_, i64>(0)?,
                serde_json::json!({
                    // The database row id, which is what an activity is filed against. The
                    // `id` beside it is the addon's own identity for the segment; the editor
                    // needs the one that survives a rename of the other.
                    "segmentId": row.get::<_, i64>(0)?,
                    "id": row.get::<_, String>(1)?,
                    "character": row.get::<_, String>(2)?,
                    "classFile": row.get::<_, Option<String>>(3)?,
                    "level": row.get::<_, Option<i64>>(4)?,
                    "day": row.get::<_, String>(5)?,
                    "instance": row.get::<_, String>(6)?,
                    "difficulty": row.get::<_, String>(7)?,
                    "instanceType": row.get::<_, String>(8)?,
                    "difficultyId": row.get::<_, Option<i64>>(9)?,
                    "startedAt": row.get::<_, i64>(10)?,
                    "endedAt": row.get::<_, i64>(11)?,
                    "seconds": row.get::<_, i64>(12)?,
                    "lootValue": row.get::<_, i64>(13)?,
                    "goldDiff": row.get::<_, i64>(14)?,
                    "currencyTotal": row.get::<_, i64>(15)?,
                    "reputationTotal": row.get::<_, i64>(16)?,
                    "housingXP": row.get::<_, i64>(17)?,
                    "expansionTier": row.get::<_, Option<i64>>(18)?,
                    "latestExpansionTier": row.get::<_, Option<i64>>(19)?,
                    // Absent, not zeroed, when the character never earned any: the same
                    // rule the ingest side follows, so a reader can trust the absence.
                    "experience": (experience_gained != 0).then(|| serde_json::json!({
                        "gained": experience_gained,
                        "percent": experience_percent,
                        "startLevel": experience_start,
                        "endLevel": experience_end,
                    })),
                    "activities": [],
                    "captures": [],
                    "encounters": [],
                    "equipsetChanges": [],
                    "transmogs": [],
                    "currencies": [],
                    "reputation": [],
                    "achievements": [],
                    "levelUps": [],
                    "mounts": [],
                    "pets": [],
                    "quests": [],
                    "toys": [],
                    "housingItems": [],
                    "housingLevelUps": []
                }),
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut segments = Vec::new();
    let mut indices = HashMap::new();
    for row in rows {
        let (id, segment) = row.map_err(|error| error.to_string())?;
        indices.insert(id, segments.len());
        segments.push(segment);
    }
    drop(statement);

    let mut statement = connection
        .prepare(
            "SELECT segment_id, item_id, source_id, appearance_id, collected_at,
                    acquisition_kind
             FROM transmogs ORDER BY segment_id, position",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let kind: String = row.get(5)?;
            Ok((
                row.get::<_, i64>(0)?,
                serde_json::json!({
                    "id": row.get::<_, i64>(1)?,
                    "sourceID": row.get::<_, Option<i64>>(2)?,
                    "appearanceID": row.get::<_, Option<i64>>(3)?,
                    "at": row.get::<_, Option<i64>>(4)?,
                    "newAppearance": match kind.as_str() {
                        "appearance" => Some(true),
                        "source" => Some(false),
                        _ => None,
                    }
                }),
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (segment_id, event) = row.map_err(|error| error.to_string())?;
        push_event(&mut segments, &indices, segment_id, "transmogs", event);
    }
    drop(statement);

    macro_rules! load_rows {
        ($sql:expr, $key:expr, $mapper:expr) => {{
            let mut child_statement = connection
                .prepare($sql)
                .map_err(|error| error.to_string())?;
            let child_rows = child_statement
                .query_map([], $mapper)
                .map_err(|error| error.to_string())?;
            for child_row in child_rows {
                let (segment_id, event) = child_row.map_err(|error| error.to_string())?;
                push_event(&mut segments, &indices, segment_id, $key, event);
            }
        }};
    }

    load_rows!(
        "SELECT segment_id, currency_id, name, amount, total
         FROM currency_gains ORDER BY segment_id, name",
        "currencies",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "name": row.get::<_, String>(2)?,
                "amount": row.get::<_, i64>(3)?,
                "total": row.get::<_, Option<i64>>(4)?
            })
        ))
    );
    load_rows!(
        "SELECT segment_id, faction, amount, standing, standing_current, standing_max
         FROM reputation_gains ORDER BY segment_id, faction",
        "reputation",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "faction": row.get::<_, String>(1)?,
                "amount": row.get::<_, i64>(2)?,
                "standing": row.get::<_, Option<String>>(3)?,
                "current": row.get::<_, Option<i64>>(4)?,
                "max": row.get::<_, Option<i64>>(5)?
            })
        ))
    );
    load_rows!(
        "SELECT segment_id, achievement_id, name, earned_at, account_first
         FROM achievements ORDER BY segment_id, position",
        "achievements",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "name": row.get::<_, Option<String>>(2)?,
                "at": row.get::<_, Option<i64>>(3)?,
                "accountFirst": row.get::<_, Option<i64>>(4)?.map(|value| value != 0)
            })
        ))
    );
    load_rows!(
        "SELECT segment_id, level, reached_at
         FROM level_ups ORDER BY segment_id, position",
        "levelUps",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "level": row.get::<_, i64>(1)?,
                "at": row.get::<_, Option<i64>>(2)?
            })
        ))
    );
    load_rows!(
        "SELECT segment_id, mount_id, name, collected_at
         FROM mounts ORDER BY segment_id, position",
        "mounts",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "name": row.get::<_, Option<String>>(2)?,
                "at": row.get::<_, Option<i64>>(3)?
            })
        ))
    );
    load_rows!(
        "SELECT segment_id, species_id, name, collected_at, pet_guid, species_first
         FROM pets ORDER BY segment_id, position",
        "pets",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "name": row.get::<_, Option<String>>(2)?,
                "at": row.get::<_, Option<i64>>(3)?,
                "guid": row.get::<_, Option<String>>(4)?,
                "speciesFirst": row.get::<_, Option<i64>>(5)?.map(|value| value != 0)
            })
        ))
    );
    load_rows!(
        "SELECT segment_id, quest_id, name, completed_at, character_first, account_first
         FROM quests ORDER BY segment_id, position",
        "quests",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "name": row.get::<_, Option<String>>(2)?,
                "at": row.get::<_, Option<i64>>(3)?,
                "characterFirst": row.get::<_, Option<i64>>(4)?.map(|value| value != 0),
                "accountFirst": row.get::<_, Option<i64>>(5)?.map(|value| value != 0)
            })
        ))
    );
    load_rows!(
        "SELECT segment_id, item_id, name, collected_at
         FROM toys ORDER BY segment_id, position",
        "toys",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "name": row.get::<_, Option<String>>(2)?,
                "at": row.get::<_, Option<i64>>(3)?
            })
        ))
    );
    load_rows!(
        "SELECT segment_id, decor_id, name, collected_at, warband_first
         FROM housing_items ORDER BY segment_id, position",
        "housingItems",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "name": row.get::<_, Option<String>>(2)?,
                "at": row.get::<_, Option<i64>>(3)?,
                "warbandFirst": row.get::<_, Option<i64>>(4)?.map(|value| value != 0)
            })
        ))
    );
    load_rows!(
        "SELECT segment_id, level, reached_at
         FROM housing_level_ups ORDER BY segment_id, position",
        "housingLevelUps",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "level": row.get::<_, i64>(1)?,
                "at": row.get::<_, Option<i64>>(2)?
            })
        ))
    );

    // The photographs of a segment, in the order they were taken. `image_state` travels with
    // every row because it is the difference between a picture that is coming, an entry that
    // never asked for one and a marker whose file was never found — and the window draws each
    // of those three as a different thing rather than as a blank tile.
    load_rows!(
        "SELECT segment_id, id, source_id, captured_at, stamp, image_state, note,
                trigger_name, achievement_source_id, byte_size, source_name,
                ui_map_id, map_x, map_y
         FROM captures
         WHERE segment_id IS NOT NULL
         ORDER BY segment_id, captured_at, id",
        "captures",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "sourceId": row.get::<_, String>(2)?,
                "at": row.get::<_, i64>(3)?,
                "stamp": row.get::<_, Option<String>>(4)?,
                "imageState": row.get::<_, String>(5)?,
                "note": row.get::<_, Option<String>>(6)?,
                // Absent for a capture somebody pressed the key for, which is the whole
                // difference between the two and is worth saying on screen.
                "trigger": row.get::<_, Option<String>>(7)?,
                "achievementId": row.get::<_, Option<i64>>(8)?,
                "byteSize": row.get::<_, Option<i64>>(9)?,
                "sourceName": row.get::<_, Option<String>>(10)?,
                "uiMapId": row.get::<_, Option<i64>>(11)?,
                "mapX": row.get::<_, Option<f64>>(12)?,
                "mapY": row.get::<_, Option<f64>>(13)?
            })
        ))
    );

    load_rows!(
        "SELECT segment_id, encounter_id, name, ended_at, difficulty_id, group_size, success
         FROM encounters ORDER BY segment_id, position",
        "encounters",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "name": row.get::<_, Option<String>>(2)?,
                "at": row.get::<_, Option<i64>>(3)?,
                "difficultyId": row.get::<_, Option<i64>>(4)?,
                "groupSize": row.get::<_, Option<i64>>(5)?,
                "success": row.get::<_, i64>(6)? != 0
            })
        ))
    );
    load_rows!(
        "SELECT id, segment_id, kind, source, confidence, metadata_json
         FROM activities ORDER BY segment_id, source DESC, kind",
        "activities",
        |row| {
            let metadata: String = row.get(5)?;
            Ok((
                row.get::<_, i64>(1)?,
                serde_json::json!({
                    "id": row.get::<_, i64>(0)?,
                    "kind": row.get::<_, String>(2)?,
                    "source": row.get::<_, String>(3)?,
                    "confidence": row.get::<_, f64>(4)?,
                    "metadata": serde_json::from_str::<Value>(&metadata)
                        .unwrap_or_else(|_| serde_json::json!({})),
                }),
            ))
        }
    );

    // Equipment set changes are the one event list whose rows carry a list of their own, so
    // they are assembled here rather than through `load_rows!`.
    //
    // What each slot replaced comes from the row behind it in the ledger — the previous row
    // for the same character, set and slot — which is what `LAG` is doing. That is the whole
    // reason the table stores only the state after a change: the before is already written
    // down, once, as somebody else's after.
    let mut statement = connection
        .prepare(
            "WITH history AS (
                 SELECT id, change_id, slot, item_id, item_level, item_name,
                        LAG(item_id)    OVER slot_history AS previous_item_id,
                        LAG(item_level) OVER slot_history AS previous_item_level,
                        LAG(item_name)  OVER slot_history AS previous_item_name
                 FROM equipset_slots
                 WINDOW slot_history AS (
                     PARTITION BY character_id, set_id, slot
                     ORDER BY changed_at, id
                 )
             )
             SELECT changes.segment_id, changes.id, changes.set_id, changes.name,
                    changes.kind, changes.changed_at,
                    history.slot, history.item_id, history.item_level, history.item_name,
                    history.previous_item_id, history.previous_item_level,
                    history.previous_item_name
             FROM equipset_changes AS changes
             LEFT JOIN history ON history.change_id = changes.id
             ORDER BY changes.segment_id, changes.position, history.slot",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                serde_json::json!({
                    "setId": row.get::<_, i64>(2)?,
                    "name": row.get::<_, String>(3)?,
                    "kind": row.get::<_, String>(4)?,
                    "at": row.get::<_, Option<i64>>(5)?,
                }),
                row.get::<_, Option<i64>>(6)?.map(|slot| {
                    serde_json::json!({
                        "slot": slot,
                        "itemId": row.get::<_, Option<i64>>(7).unwrap_or(None),
                        "itemLevel": row.get::<_, Option<i64>>(8).unwrap_or(None),
                        "itemName": row.get::<_, Option<String>>(9).unwrap_or(None),
                        "previousItemId": row.get::<_, Option<i64>>(10).unwrap_or(None),
                        "previousItemLevel": row.get::<_, Option<i64>>(11).unwrap_or(None),
                        "previousItemName": row.get::<_, Option<String>>(12).unwrap_or(None),
                    })
                }),
            ))
        })
        .map_err(|error| error.to_string())?;
    // The join hands back one row per slot, so a change with three slots arrives three
    // times. Changes come out grouped and in order, so the last one built is the one a
    // slot belongs to and no lookup table is needed.
    let mut open: Option<(i64, i64, Value)> = None;
    for row in rows {
        let (segment_id, change_id, change, slot) = row.map_err(|error| error.to_string())?;
        if open
            .as_ref()
            .is_none_or(|(_, open_id, _)| *open_id != change_id)
        {
            if let Some((previous_segment, _, built)) = open.take() {
                push_event(
                    &mut segments,
                    &indices,
                    previous_segment,
                    "equipsetChanges",
                    built,
                );
            }
            let mut change = change;
            change["items"] = Value::Array(Vec::new());
            open = Some((segment_id, change_id, change));
        }
        if let (Some((_, _, built)), Some(slot)) = (open.as_mut(), slot) {
            if let Some(items) = built["items"].as_array_mut() {
                items.push(slot);
            }
        }
    }
    if let Some((segment_id, _, built)) = open {
        push_event(
            &mut segments,
            &indices,
            segment_id,
            "equipsetChanges",
            built,
        );
    }
    drop(statement);

    // A keystone run is one per segment rather than a list, so it is attached directly
    // instead of pushed onto an event array.
    let mut statement = connection
        .prepare(
            "SELECT segment_id, level, map_id, affixes_json, started_at, completed_at,
                    completed, duration_ms, on_time, upgrades
             FROM keystone_runs",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let affixes: String = row.get(3)?;
            Ok((
                row.get::<_, i64>(0)?,
                serde_json::json!({
                    "level": row.get::<_, i64>(1)?,
                    "mapId": row.get::<_, Option<i64>>(2)?,
                    "affixes": serde_json::from_str::<Value>(&affixes)
                        .unwrap_or_else(|_| Value::Array(Vec::new())),
                    "startedAt": row.get::<_, Option<i64>>(4)?,
                    "completedAt": row.get::<_, Option<i64>>(5)?,
                    "completed": row.get::<_, i64>(6)? != 0,
                    "durationMs": row.get::<_, Option<i64>>(7)?,
                    "onTime": row.get::<_, Option<i64>>(8)?.map(|value| value != 0),
                    "upgrades": row.get::<_, Option<i64>>(9)?,
                }),
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (segment_id, keystone) = row.map_err(|error| error.to_string())?;
        if let Some(index) = indices.get(&segment_id) {
            segments[*index]["keystone"] = keystone;
        }
    }
    drop(statement);

    // A delve run is one per segment too, and goes on the same way.
    let mut statement = connection
        .prepare(
            "SELECT segment_id, tier, scenario_id, started_at, completed_at, completed
             FROM delve_runs",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                serde_json::json!({
                    "tier": row.get::<_, Option<i64>>(1)?,
                    "scenarioId": row.get::<_, Option<i64>>(2)?,
                    "startedAt": row.get::<_, Option<i64>>(3)?,
                    "completedAt": row.get::<_, Option<i64>>(4)?,
                    "completed": row.get::<_, i64>(5)? != 0,
                }),
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (segment_id, delve) = row.map_err(|error| error.to_string())?;
        if let Some(index) = indices.get(&segment_id) {
            segments[*index]["delve"] = delve;
        }
    }
    drop(statement);

    let holdings = account_holdings(&connection)?;

    Ok(serde_json::json!({
        "generatedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "knownActivityKinds": activity::KNOWN_KINDS,
        "segments": segments,
        "holdings": holdings,
    }))
}

/// The end of the newest segment in the history, in epoch seconds.
///
/// One column of one row, kept apart from [`dashboard`] because the caller is not drawing a
/// window: it is [`crate::gap`], asking how far the record reaches so it can be held against
/// how far the client's own combat log reaches. `None` is an empty history, which that rule
/// treats as nothing to compare rather than as a hole.
pub fn newest_segment_end(database_path: &Path) -> Result<Option<i64>, String> {
    let connection = open_database(database_path)?;
    connection
        .query_row("SELECT MAX(ended_at) FROM segments", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}
