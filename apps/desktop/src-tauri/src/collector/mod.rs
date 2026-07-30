//! The sync, and the order it happens in.
//!
//! This module owns nothing a domain owns. It reads each account's SavedVariables once,
//! hands what it found to the module that keeps that kind of thing, and is where the
//! ordering that only makes sense across domains is written down and can be read: an image
//! is copied and proved before any row claims it, the log is read after the segments it
//! attaches to are in, the track is compacted after everything that reads it has had its
//! turn, and the game's own copy of a screenshot goes last of all.
//!
//! Everything under it is a domain: [`database`] the connection and the migrations,
//! [`lua`] the SavedVariables text, [`roster`] the accounts and characters every other
//! table hangs off, and then one module per kind of thing kept — [`segments`],
//! [`activities`], [`lockouts`], [`captures`], [`logs`], [`holdings`], [`looks`],
//! [`ingame_sets`], [`mod@custom_sets`], [`marks`] — with [`read_model`] reading them back out
//! again. A domain owns its tables, its SQL and its tests; a change to one is a change to
//! one file.

mod activities;
mod captures;
mod custom_sets;
mod database;
mod holdings;
mod ingame_sets;
mod lockouts;
mod logs;
mod looks;
mod lua;
mod marks;
mod read_model;
mod roster;
mod segments;
#[cfg(test)]
mod testing;

pub use activities::{add_activity, delete_activity, reset_activities, update_activity};
pub use captures::{capture_image, capture_thumbnails, delete_capture, set_capture_note};
pub use custom_sets::{custom_sets, delete_custom_set, save_custom_set};
pub use database::{initialize, install_database, snapshot, summarize, Summary};
pub use ingame_sets::{in_game_sets, request_set_in_game, set_requests, waiting_set_requests};
pub use logs::retention_report;
pub use looks::character_looks;
pub use lua::{read_saved_variable, resolve_wow_path};
pub use marks::{delete_transmog_tag, set_transmog_favourite, set_transmog_tag, transmog_marks};
pub use read_model::{dashboard, newest_segment_end};

use crate::captures::Marker;
use crate::failure::Failure;
use crate::ingamesets;
use crate::look;
use crate::retention;
use crate::saved_variables::{self, RawHoldingSnapshot, RawWarband, Segment};
use captures::{deleted_captures, ingest_images, link_capture_achievements, link_captures};
use captures::{place_captures, record_images, store_root, upsert_capture};
use database::open_database;
use holdings::{sync_holdings, sync_warband};
use ingame_sets::{sync_in_game_sets, sync_set_request_outcomes};
use lockouts::{sync_lockouts, LockoutFeed};
use logs::{compact_positions, ingest_logs, sweep_logs};
use looks::sync_character_looks;
use lua::account_files;
use roster::{account_key, upsert_account, upsert_character, upsert_character_key};
use rusqlite::OptionalExtension;
use segments::upsert_segment;
use serde::Serialize;
use specta::Type;
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub added: usize,
    pub updated: usize,
    pub segment_count: usize,
}

/// What a sync is allowed to do to the folders it reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Leave the game's own copy of a screenshot where it was, once Chronie holds one of its
    /// own. Off by default, because the point of ingesting is that the game's folder stops
    /// growing — but taking files out of a folder somebody has been curating for years is
    /// not a thing to make unrecoverable by design, so it stays a choice.
    pub keep_originals: bool,
    /// After how many days a combat log Chronie has read to its end is deleted. `None` — the
    /// default — deletes nothing at all, and is what every install starts as: a folder somebody
    /// has been logging into since before Chronie existed is not one to start emptying without
    /// being asked to.
    pub retain_log_days: Option<u32>,
    /// How much of each screenshot the store keeps. See [`crate::captures::Quality`]; the
    /// default is a re-encode, because the store is forever and the game writes megabytes a shot.
    pub capture_quality: crate::captures::Quality,
}

/// One account's SavedVariables file, parsed and ready to be written to the database.
struct Incoming {
    source_key: String,
    source_modified_ns: Option<i64>,
    source_size: Option<i64>,
    segments: Vec<Segment>,
    lockouts: LockoutFeed,
    holdings: BTreeMap<String, RawHoldingSnapshot>,
    warband: RawWarband,
    in_game_sets: Vec<ingamesets::CharacterSets>,
    /// Who each character of this account is: their race, and what they were last seen made of.
    looks: Vec<look::Look>,
    /// What the addon did about the outfits this app asked it to save: request id, outcome,
    /// when, and the set that resulted. Account-wide, because a custom set is.
    set_request_outcomes: Vec<(i64, String, Option<i64>, Option<i64>)>,
    markers: Vec<Marker>,
}

pub fn collect(
    wow_path: &Path,
    database_path: &Path,
    now: i64,
    options: Options,
) -> Result<SyncResult, Failure> {
    let mut connection = open_database(database_path)?;
    let mut incoming = Vec::new();
    for path in account_files(wow_path) {
        let Some(source_key) = account_key(&path) else {
            continue;
        };
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        let source_modified_ns = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_nanos()).ok());
        let source_size = i64::try_from(metadata.len()).ok();
        let previous = connection
            .query_row(
                "SELECT source_modified_ns, source_size
                 FROM accounts WHERE source_key = ?1",
                [&source_key],
                |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
            )
            .optional()?;
        if previous == Some((source_modified_ns, source_size)) {
            continue;
        }
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        let mut saved =
            saved_variables::read(read_saved_variable(&text, "ChronieDB")?.unwrap_or_default());
        let segments = saved.take_segments();
        let lockouts = LockoutFeed::take(&mut saved);
        let holdings = std::mem::take(&mut saved.holdings);
        let warband = std::mem::take(&mut saved.warband);
        let in_game_sets = ingamesets::read(&saved.custom_sets);
        let set_request_outcomes = ingamesets::outcomes(&saved.custom_set_requests);
        let looks = look::read(&saved.character_look);
        let markers = crate::captures::markers_from_entries(&saved.entries);
        incoming.push(Incoming {
            source_key,
            source_modified_ns,
            source_size,
            segments,
            lockouts,
            holdings,
            // Beside the per-character snapshots rather than inside them: the addon keys
            // `holdings` by character, and a warband entry in there would arrive here as a
            // character named "warband".
            warband,
            // `customSets` is the addon's word, because the addon is talking to the game and
            // that is what the game calls them. In here they are in-game sets, so that the
            // reader's own saved sets can keep the name they have had since before the game
            // had any. See `ingamesets.rs`.
            in_game_sets,
            // The other half of the two-way sync, coming back. The addon writes what it did
            // under the request's own id, which is how the app knows to stop asking.
            set_request_outcomes,
            // Who the reader's own characters are, which is what lets the transmog view draw
            // one of them rather than a body assembled from selects. See `look.rs`.
            looks,
            markers,
        });
    }

    // A capture somebody deleted is not read again. Its marker is still in SavedVariables and
    // will be for as long as the entry exists, so this is what makes deleting mean deleting
    // rather than hiding it until the next logout.
    let deleted = deleted_captures(&connection)?;

    // Before the transaction, on purpose: an image is copied and proved before any row claims
    // it exists, and the game's own copy is deleted only once that row has been committed.
    let store_root = store_root(database_path);
    let markers: Vec<&Marker> = incoming
        .iter()
        .flat_map(|account| account.markers.iter())
        .filter(|marker| !deleted.contains(&marker.source_id))
        .collect();
    let ingested = ingest_images(
        &connection,
        wow_path,
        &store_root,
        &markers,
        options.capture_quality,
    )?;
    drop(markers);

    let transaction = connection.transaction()?;
    let mut added = 0;
    let mut updated = 0;
    for account in incoming {
        let account_id = upsert_account(
            &transaction,
            &account.source_key,
            account.source_modified_ns,
            account.source_size,
            now,
        )?;
        for segment in account.segments {
            let character_id = upsert_character(&transaction, account_id, &segment, now)?;
            if upsert_segment(&transaction, character_id, &segment, now)? {
                added += 1;
            } else {
                updated += 1;
            }
        }
        sync_lockouts(&transaction, account_id, &account.lockouts, now)?;
        sync_holdings(&transaction, account_id, &account.holdings, now)?;
        sync_warband(&transaction, account_id, &account.warband)?;
        sync_in_game_sets(&transaction, account_id, &account.in_game_sets, now)?;
        sync_character_looks(&transaction, account_id, &account.looks, now)?;
        sync_set_request_outcomes(&transaction, &account.set_request_outcomes, now)?;
        for marker in &account.markers {
            if deleted.contains(&marker.source_id) {
                continue;
            }
            let character_id = match marker.character.as_deref() {
                Some(character) => Some(upsert_character_key(
                    &transaction,
                    account_id,
                    character,
                    None,
                    None,
                    now,
                )?),
                None => None,
            };
            upsert_capture(&transaction, account_id, character_id, marker, now)?;
        }
    }
    record_images(&transaction, &ingested, now)?;
    link_captures(&transaction)?;
    link_capture_achievements(&transaction)?;
    transaction.commit()?;

    // After the segments are in, because attaching a position to the visit it was recorded
    // during needs that visit to exist — and a sync that read a log first would leave every
    // point from the session that just ended waiting another thirty seconds for no reason.
    ingest_logs(&mut connection, wow_path, now)?;

    // With both halves in: the captures this sync filed, and the track that now reaches past the
    // moment each of them was taken at.
    place_captures(&mut connection)?;

    // Immediately after the read that decides it, and only when somebody has asked for it. A
    // log is eligible because a cursor says it was read to its end, so the sweep is worth
    // nothing before that cursor is up to date and is dangerous if it ever runs instead.
    if let Some(days) = options.retain_log_days {
        sweep_logs(&mut connection, wow_path, days, now)?;
    }

    // Last, because it deletes what the pass above reads, and nothing in the same sync may lose a
    // point before the capture beside it has had its chance at it.
    compact_positions(
        &connection,
        options
            .retain_log_days
            .unwrap_or(retention::DEFAULT_RETAIN_DAYS),
        now,
    )?;

    // Last of all, and only for images a committed row now names. A file deleted here is one
    // Chronie has already read, copied, hashed, read back and written down.
    if !options.keep_originals {
        for image in ingested.values() {
            let _ = fs::remove_file(&image.original);
        }
    }

    let segment_count: usize =
        connection.query_row("SELECT COUNT(*) FROM segments", [], |row| row.get(0))?;
    Ok(SyncResult {
        added,
        updated,
        segment_count,
    })
}

#[cfg(test)]
mod tests {
    use crate::collector::testing::*;

    /// One whole sync, end to end: the file the addon wrote, the domains it touches on the way
    /// in, and the window's own view of what came out.
    #[test]
    fn collects_typed_segments_without_expiring_history() {
        let now = 2_000_000_000_i64;
        let install = Install::of(&SavedVariables::new().segments(&format!(
            r#"
  {{ ["id"] = "kept", ["character"] = "Aster-Vale", ["classFile"] = "MAGE",
     ["instance"] = "Glass Caverns",
     ["endedAt"] = {now}, ["lootValue"] = 1200,
     ["transmogs"] = {{
       {{ ["id"] = 19019, ["sourceID"] = 11, ["appearanceID"] = 22,
          ["newAppearance"] = true, ["at"] = {now} }},
       {{ ["id"] = 17182, ["newAppearance"] = false, ["at"] = {now} }}
     }},
     ["achievements"] = {{
       {{ ["id"] = 9, ["name"] = "Into the Light", ["at"] = {now},
          ["accountFirst"] = false }}
     }} }},
  {{ ["id"] = "old", ["character"] = "Brin-Vale", ["endedAt"] = {} }}
"#,
            now - 8 * DAY_SECONDS
        )));
        let result = install.collect(now);
        assert_eq!(result.added, 2);
        assert_eq!(result.updated, 0);
        assert_eq!(result.segment_count, 2);

        let payload = install.dashboard();
        let typed: crate::dto::DashboardPayload =
            crate::dto::convert(payload.clone()).expect("dashboard matches the command DTO");
        assert_eq!(typed.segments.len(), 2);
        assert_eq!(payload["segments"][0]["id"], "kept");
        // The class is filed against the character and read back through the join, which is
        // the only route it has to the window that colours the cast by it.
        assert_eq!(payload["segments"][0]["classFile"], "MAGE");
        assert_eq!(
            payload["segments"][0]["transmogs"][0]["newAppearance"],
            true
        );
        assert_eq!(
            payload["segments"][0]["transmogs"][1]["newAppearance"],
            false
        );
        assert_eq!(
            payload["segments"][0]["achievements"][0]["name"],
            "Into the Light"
        );
        let connection = install.open();
        let appearances: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM transmogs WHERE acquisition_kind = 'appearance'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let sources: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM transmogs WHERE acquisition_kind = 'source'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((appearances, sources), (1, 1));
        drop(connection);

        let unchanged = install.collect(now + 1);
        assert_eq!(unchanged.added, 0);
        assert_eq!(unchanged.updated, 0);
        assert_eq!(unchanged.segment_count, 2);

        // History outlives the file it was read from: the addon prunes what it has written,
        // and nothing here goes with it.
        install.rewrite(&SavedVariables::new().segments(""));
        let result = install.collect(now + DAY_SECONDS);
        assert_eq!(result.segment_count, 2);
        assert_eq!(install.dashboard()["segments"][1]["id"], "old");
    }
}
