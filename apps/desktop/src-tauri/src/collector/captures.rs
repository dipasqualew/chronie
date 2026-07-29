//! Screenshots and remembered moments.
//!
//! Three separable things that arrive at different times and are written down separately: the
//! marker the addon recorded, the image the client wrote beside it, and where the moment
//! happened. The marker is the row; the image is copied into Chronie's own store, proved, and
//! only then named by a committed row; the place may come from the client, or later from the
//! position track a combat log leaves behind.
//!
//! The order those three happen in is not this module's to decide — see [`super`] — but the
//! rule that no image is ever the only copy of itself is kept here.

use super::database::open_database;
use crate::captures::{self, Marker, Stored, Wanted};
use crate::icons;
use crate::placement;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

/// Where Chronie keeps the images it has taken custody of: its own folder beside its own
/// database, so that a backup of one is a backup of the other.
pub(super) fn store_root(database_path: &Path) -> PathBuf {
    database_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(captures::STORE_FOLDER)
}

/// One capture's image, copied into the store and verified, waiting for the row that names
/// it to be committed before the original is touched.
pub(super) struct Ingested {
    stored: Stored,
    source_name: String,
    pub(super) original: PathBuf,
}

/// Which markers are still hoping for a file.
///
/// A capture whose image is already in the store is deliberately not among them. `db.entries`
/// is never pruned and the whole of it is re-read whenever anything in the file changes, so
/// without this every sync after any change would go back to the folder and re-hash every
/// original still sitting in it. Nothing about the row is at stake — `upsert_capture` will
/// not let an image be un-stored — it is the work that is not worth doing twice.
///
/// A row an earlier sync could not find a file for is, on the other hand, worth another look:
/// the client writes an image asynchronously and may not have finished when the folder was
/// read, and a folder can be restored.
fn wanted_images(connection: &Connection, markers: &[&Marker]) -> Result<Vec<Wanted>, String> {
    let mut state = connection
        .prepare("SELECT image_state FROM captures WHERE source_id = ?1")
        .map_err(|error| error.to_string())?;
    let mut wanted = Vec::new();
    let mut seen = HashSet::new();
    for marker in markers {
        let Some(stamp) = marker.stamp.clone() else {
            continue;
        };
        if !marker.wants_image || !seen.insert(marker.source_id.clone()) {
            continue;
        }
        let stored = state
            .query_row([&marker.source_id], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|error| error.to_string())?
            .is_some_and(|found| found == "stored");
        if !stored {
            wanted.push(Wanted {
                source_id: marker.source_id.clone(),
                stamp,
            });
        }
    }
    drop(state);

    let mut unresolved = connection
        .prepare(
            "SELECT source_id, stamp FROM captures
             WHERE image_state = 'missing' AND stamp IS NOT NULL",
        )
        .map_err(|error| error.to_string())?;
    let rows = unresolved
        .query_map([], |row| {
            Ok(Wanted {
                source_id: row.get(0)?,
                stamp: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let row = row.map_err(|error| error.to_string())?;
        if seen.insert(row.source_id.clone()) {
            wanted.push(row);
        }
    }
    Ok(wanted)
}

/// Finds the images this sync's markers are asking for and copies them into the store.
///
/// Everything here happens before the transaction opens, and the deletion of the originals
/// happens after it commits. That order is the whole safety argument: killed between the copy
/// and the commit, the game's folder is untouched and the worst that survives is an unnamed
/// file in the store that the next sync writes over; killed after the commit, the row already
/// points at a verified copy. There is no moment at which the only copy of an image is one
/// nothing has recorded.
///
/// One image that cannot be copied does not fail the sync. Its row says `missing`, which is
/// the honest thing to show and is retried next time, and the rest of the segments are worth
/// more than the tidiness of refusing them all over one unreadable file.
pub(super) fn ingest_images(
    connection: &Connection,
    wow_path: &Path,
    store_root: &Path,
    markers: &[&Marker],
    quality: captures::Quality,
) -> Result<HashMap<String, Ingested>, String> {
    let wanted = wanted_images(connection, markers)?;
    if wanted.is_empty() {
        return Ok(HashMap::new());
    }
    let shots = captures::folder(&wow_path.join(captures::GAME_FOLDER));
    let mut ingested = HashMap::new();
    for (source_id, path) in captures::pair(&wanted, &shots) {
        let Ok(stored) = captures::store(&path, store_root, quality) else {
            continue;
        };
        ingested.insert(
            source_id,
            Ingested {
                stored,
                source_name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                original: path,
            },
        );
    }
    Ok(ingested)
}

/// Writes down one entry the addon recorded.
///
/// Keyed on the addon's own id and upserted, which is what makes ingesting the same capture
/// twice impossible however many times the same unchanged file is read. The file columns are
/// left to `record_images`: a row is the marker, and the image is something that may arrive
/// with it, later, or never.
///
/// `image_state` only ever moves towards `stored`. A row that already has an image keeps it
/// even though this sync went looking for nothing, because the marker that is being read
/// again is the same marker whose image was taken custody of the first time.
pub(super) fn upsert_capture(
    transaction: &Transaction<'_>,
    account_id: i64,
    character_id: Option<i64>,
    marker: &Marker,
    now: i64,
) -> Result<(), String> {
    let state = if marker.wants_image { "missing" } else { "none" };
    transaction
        .execute(
            "INSERT INTO captures (
                 account_id, source_id, schema, character_id, author, segment_source_id,
                 captured_at, stamp, ui_map_id, map_x, map_y, image_state,
                 trigger_name, achievement_source_id, note, first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?16, ?15, ?15)
             ON CONFLICT(source_id) DO UPDATE SET
                 account_id = excluded.account_id,
                 schema = excluded.schema,
                 character_id = COALESCE(excluded.character_id, captures.character_id),
                 author = COALESCE(excluded.author, captures.author),
                 segment_source_id = COALESCE(
                     excluded.segment_source_id, captures.segment_source_id
                 ),
                 captured_at = excluded.captured_at,
                 stamp = COALESCE(excluded.stamp, captures.stamp),
                 ui_map_id = COALESCE(excluded.ui_map_id, captures.ui_map_id),
                 map_x = COALESCE(excluded.map_x, captures.map_x),
                 map_y = COALESCE(excluded.map_y, captures.map_y),
                 image_state = CASE
                     WHEN captures.image_state = 'stored' THEN 'stored'
                     ELSE excluded.image_state
                 END,
                 trigger_name = COALESCE(excluded.trigger_name, captures.trigger_name),
                 achievement_source_id = COALESCE(
                     excluded.achievement_source_id, captures.achievement_source_id
                 ),
                 note = CASE
                     WHEN captures.note_edited_at IS NOT NULL THEN captures.note
                     ELSE COALESCE(excluded.note, captures.note)
                 END,
                 last_seen_at = excluded.last_seen_at",
            params![
                account_id,
                marker.source_id,
                marker.schema,
                character_id,
                marker.author,
                marker.segment,
                marker.captured_at,
                marker.stamp,
                marker.ui_map_id,
                marker.x,
                marker.y,
                state,
                marker.trigger,
                marker.achievement,
                now,
                marker.note,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// The source ids somebody has deleted, which are the markers this sync must walk past.
///
/// Read once per sync rather than asked per marker: an account's entries are read in full every
/// time its file changes, and the deletions are a handful of rows against thousands of markers.
pub(super) fn deleted_captures(connection: &Connection) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare("SELECT source_id FROM capture_deletions")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut deleted = HashSet::new();
    for row in rows {
        deleted.insert(row.map_err(|error| error.to_string())?);
    }
    Ok(deleted)
}

/// Records the images this sync took custody of, whichever sync wrote the rows they belong
/// to. Run after the markers, so that a capture read for the first time already has a row for
/// its image to land on.
pub(super) fn record_images(
    transaction: &Transaction<'_>,
    ingested: &HashMap<String, Ingested>,
    now: i64,
) -> Result<(), String> {
    for (source_id, image) in ingested {
        transaction
            .execute(
                "UPDATE captures SET
                     image_state = 'stored',
                     file_path = ?2,
                     source_name = ?3,
                     byte_size = ?4,
                     content_hash = ?5,
                     ingested_at = ?6,
                     last_seen_at = ?6
                 WHERE source_id = ?1",
                params![
                    source_id,
                    image.stored.file_path,
                    image.source_name,
                    image.stored.byte_size,
                    image.stored.content_hash,
                    now,
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Attaches captures to the segments they were taken in, as and when those segments arrive.
///
/// The link is text in the file — `character|startedAt|instance`, built the same way the
/// segment log builds it — and it cannot always be resolved when the capture is read: a
/// screenshot taken in a segment the client had not finished filing arrives beside a segment
/// list that does not mention it yet. So resolving is not part of writing the capture. It is
/// this, run after every sync's segments are in, over every capture still waiting for one.
pub(super) fn link_captures(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute(
            "UPDATE captures SET segment_id = (
                 SELECT segments.id FROM segments
                 WHERE segments.character_id = captures.character_id
                   AND segments.source_id = captures.segment_source_id
             )
             WHERE segment_id IS NULL
               AND segment_source_id IS NOT NULL
               AND character_id IS NOT NULL",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Attaches a capture to the achievement it was taken for.
///
/// The same shape as `link_captures` above and for the same first reason — an achievement
/// earned in a segment the client had not finished filing arrives before the row for it — but
/// with one difference that matters: this is re-resolved every time rather than only where
/// the link is still NULL.
///
/// `achievements` rows are children of a segment, and `clear_outcomes` deletes and reinserts
/// the children of every segment the file still describes on every single sync. Their rowids
/// therefore do not survive one. A link written once and left alone would be pointing at
/// whatever row happens to hold that number by the next sync, which is a wrong picture
/// against a real achievement — far worse than no picture at all. So the link is derived
/// afresh from the achievement id the addon wrote down, which is the only identity here that
/// does not move.
///
/// Run after `link_captures`, because the segment is half of what identifies the achievement.
pub(super) fn link_capture_achievements(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute(
            "UPDATE captures SET achievement_id = (
                 SELECT achievements.id FROM achievements
                 WHERE achievements.segment_id = captures.segment_id
                   AND achievements.achievement_id = captures.achievement_source_id
                 ORDER BY achievements.position
                 LIMIT 1
             )
             WHERE achievement_source_id IS NOT NULL",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Fills in where a capture was taken, from the track, for the captures the client left blank.
///
/// This is what the position track is *for*. A screenshot taken in the open world arrives with a
/// map and a point on it, because `C_Map.GetPlayerMapPosition` answers out there; one taken
/// inside an instance arrives with the map and nothing else, and the combat log is the only
/// record of where the player was standing. Screenshots and memories are the same row with the
/// picture left out, so one pass covers both.
///
/// Run after [`super::logs::ingest_logs`] rather than beside `link_captures`, because both halves have to be
/// in before either can find the other: the capture arrives at logout, the points that surround
/// it were read thirty seconds at a time during the session, and a pass placed before the read
/// would be working from a track that stops short of the moment it is trying to place.
///
/// Every unplaced capture is reconsidered on every sync, not only the new ones. A capture read
/// before the log that covers it — a backlog still being worked through, a marker that arrived
/// while its session's log was still queued — is placed by whichever later sync finally reads
/// the points, and nothing has to remember that it is waiting.
///
/// The decision itself is [`placement::place`] and is not here. The query below only narrows:
/// it is allowed to be generous, because the rule re-checks the map and the reach on everything
/// it is handed.
pub(super) fn place_captures(connection: &mut Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT c.id, c.captured_at, c.ui_map_id, p.at_ms, p.ui_map_id, p.map_x, p.map_y
             FROM captures c
             JOIN log_positions p
               ON p.at_ms BETWEEN c.captured_at * 1000 - ?1 AND c.captured_at * 1000 + ?1
             WHERE c.map_x IS NULL AND c.ui_map_id IS NOT NULL",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([placement::REACH_MS], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                placement::Moment {
                    at_ms: row.get::<_, i64>(1)? * 1000,
                    ui_map_id: row.get(2)?,
                },
                placement::Point {
                    at_ms: row.get(3)?,
                    ui_map_id: row.get(4)?,
                    map_x: row.get(5)?,
                    map_y: row.get(6)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut wanting: HashMap<i64, (placement::Moment, Vec<placement::Point>)> = HashMap::new();
    for row in rows {
        let (capture, moment, point) = row.map_err(|error| error.to_string())?;
        wanting
            .entry(capture)
            .or_insert_with(|| (moment, Vec::new()))
            .1
            .push(point);
    }
    drop(statement);

    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for (capture, (moment, points)) in wanting {
        let Some(placed) = placement::place(moment, &points) else {
            continue;
        };
        transaction
            .execute(
                "UPDATE captures SET map_x = ?2, map_y = ?3 WHERE id = ?1",
                params![capture, placed.map_x, placed.map_y],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

/// Writes what somebody said about a capture, or clears it.
///
/// Cleaned by `captures::note_text`, so a note typed in the app is held to exactly the rules a
/// note typed in game is. Nothing but whitespace and escapes clears the note rather than
/// storing an empty string: the column has one way of saying "nobody has written about this",
/// and a note somebody deleted is that.
///
/// `note_edited_at` is what makes the write survive the next sync — the marker in
/// SavedVariables still carries whatever was typed in the moment, and without this the sync
/// would put that sentence back over the top of every edit. See `0010_capture_notes.sql`.
pub fn set_capture_note(
    database_path: &Path,
    capture_id: i64,
    note: &str,
    now: i64,
) -> Result<(), String> {
    let connection = open_database(database_path)?;
    let changed = connection
        .execute(
            "UPDATE captures SET note = ?2, note_edited_at = ?3 WHERE id = ?1",
            params![capture_id, captures::note_text(note), now],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("That screenshot is no longer in Chronie's history.".into());
    }
    Ok(())
}

/// Deletes a capture: the row, the file, and the thumbnails made from it.
///
/// One function owning both halves, deliberately. There is a second place a file will have to
/// be deleted from as soon as anything but the local disk holds one, and a delete path
/// scattered across the window is what leaves the other half behind — so everything that
/// deleting means lives here, and the window only says when.
///
/// Three things happen in an order that is the whole argument:
///
/// 1. The row goes, and a tombstone takes its place under the same source id. Without the
///    tombstone the next sync reads the marker again — `db.entries` never prunes — and puts
///    the row back with no file behind it.
/// 2. Whether anything else still names the file is asked *after* the row is gone and before
///    the commit. The store is content-addressed: two captures of identical bytes are one
///    file, and deleting it for one of them would blank the other.
/// 3. The file goes last, once the row that named it is committed. Killed in between, what
///    survives is a file nothing points at — which wastes space and shows nobody a
///    photograph they deleted. The other order would leave a row pointing at nothing, which
///    the window draws as a picture that failed to load.
pub fn delete_capture(database_path: &Path, capture_id: i64, now: i64) -> Result<(), String> {
    let store = store_root(database_path);
    let mut connection = open_database(database_path)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let found: Option<(String, Option<String>, Option<String>)> = transaction
        .query_row(
            "SELECT source_id, file_path, content_hash FROM captures WHERE id = ?1",
            [capture_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    // Deleting something that is already gone is what was asked for, so it is not an error.
    let Some((source_id, file_path, content_hash)) = found else {
        return Ok(());
    };

    transaction
        .execute("DELETE FROM captures WHERE id = ?1", [capture_id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO capture_deletions (source_id, deleted_at) VALUES (?1, ?2)
             ON CONFLICT(source_id) DO UPDATE SET deleted_at = excluded.deleted_at",
            params![source_id, now],
        )
        .map_err(|error| error.to_string())?;
    let shared: i64 = match file_path.as_deref() {
        Some(path) => transaction
            .query_row(
                "SELECT COUNT(*) FROM captures WHERE file_path = ?1",
                [path],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?,
        None => 0,
    };
    transaction.commit().map_err(|error| error.to_string())?;

    if let Some(path) = file_path.filter(|_| shared == 0) {
        captures::discard(&store, &path, content_hash.as_deref()).map_err(|error| {
            // The row is already gone, so this cannot be reported as "nothing happened".
            format!("Chronie forgot the screenshot, but could not delete the file: {error}")
        })?;
    }
    Ok(())
}

/// One capture's image, as the window has to be handed it.
///
/// A `data:` URL rather than a file the webview loads, and rather than Tauri's asset protocol.
/// The window has no origin to load from — every byte it draws already comes across the
/// command bridge, which is how the icons and the models arrive — and the asset protocol would
/// mean opening the store to the frontend by scope and widening `img-src` in the CSP to reach
/// it. The scaling argument for the protocol is real and is answered a different way: the grid
/// asks for thumbnails, which are tens of kilobytes each, and the original crosses the bridge
/// once, for one picture, when somebody opens it.
///
/// `None` is an ordinary answer: an entry that never asked for a picture, and a marker whose
/// file was never found, are both rows with nothing to show. So is a file that has gone missing
/// underneath a row that says `stored` — which is exactly why the row carries a hash and a size.
pub fn capture_image(database_path: &Path, capture_id: i64) -> Result<Value, String> {
    let connection = open_database(database_path)?;
    let Some(image) = stored_image(&connection, capture_id)? else {
        return Ok(serde_json::json!({ "id": capture_id, "image": Value::Null }));
    };
    let path = store_root(database_path).join(&image.file_path);
    let Ok(bytes) = fs::read(&path) else {
        return Ok(serde_json::json!({ "id": capture_id, "image": Value::Null }));
    };
    Ok(serde_json::json!({
        "id": capture_id,
        "image": icons::data_url(captures::mime_of(&image.file_path), &bytes),
        "byteSize": bytes.len(),
    }))
}

/// The thumbnails for a list of captures, keyed by the id the row carries.
///
/// Asked for in a batch and answered from a cache on disk, the way the game's icons are: a grid
/// asks for everything in it at once, and a reader scrolling back through a year of history
/// meets the same evening's pictures every time they come past it.
///
/// A capture this cannot produce one for is left out rather than sent as null, because a row
/// with no image and a row whose image will not decode draw the same placeholder.
pub fn capture_thumbnails(database_path: &Path, ids: &[i64]) -> Result<Value, String> {
    let connection = open_database(database_path)?;
    let store = store_root(database_path);
    let mut thumbnails = Map::new();
    for id in ids {
        if thumbnails.contains_key(&id.to_string()) {
            continue;
        }
        let Some(image) = stored_image(&connection, *id)? else {
            continue;
        };
        let Some(hash) = image.content_hash else {
            continue;
        };
        if let Ok(small) = captures::thumbnail(&store, &image.file_path, &hash) {
            thumbnails.insert(
                id.to_string(),
                Value::String(icons::data_url("image/jpeg", &small)),
            );
        }
    }
    Ok(serde_json::json!({ "thumbnails": Value::Object(thumbnails) }))
}

/// Where one capture's image sits, as its row names it, and nothing at all for a row that
/// never had one.
struct StoredImage {
    file_path: String,
    content_hash: Option<String>,
}

fn stored_image(connection: &Connection, capture_id: i64) -> Result<Option<StoredImage>, String> {
    connection
        .query_row(
            "SELECT file_path, content_hash FROM captures
             WHERE id = ?1 AND image_state = 'stored' AND file_path IS NOT NULL",
            [capture_id],
            |row| {
                Ok(StoredImage {
                    file_path: row.get(0)?,
                    content_hash: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::database::MIGRATIONS;
    use crate::collector::read_model::dashboard;
    use crate::collector::testing::*;
    use crate::collector::{collect, Options};

    use std::fs;

    /// A segment a capture can name, written the way the addon builds the link:
    /// `character|startedAt|instance`.
    const CAPTURE_SEGMENT: &str = r#"
      { ["id"] = "Aster-Vale|1999990000|Ulduar", ["character"] = "Aster-Vale",
        ["instance"] = "Ulduar", ["instanceType"] = "raid",
        ["startedAt"] = 1999990000, ["endedAt"] = 2000000000, ["seconds"] = 10000 }
    "#;

    /// One capture of that segment, taken at a stamp the tests can name a file after.
    const CAPTURE_ENTRY: &str = r#"
      { ["id"] = "TEST|2000000000|1", ["schema"] = 1, ["at"] = 2000000000,
        ["stamp"] = "111423_120000", ["character"] = "Aster-Vale", ["author"] = "TEST",
        ["segment"] = "Aster-Vale|1999990000|Ulduar", ["uiMapID"] = 350,
        ["x"] = 0.25, ["y"] = 0.5, ["hasImage"] = true }
    "#;

    /// One capture row: its rowid, what Chronie has of the image, where it put it, and the
    /// segment it ended up attached to.
    fn capture_row(database: &Path, source_id: &str) -> (i64, String, Option<String>, Option<i64>) {
        open_database(database)
            .unwrap()
            .query_row(
                "SELECT id, image_state, file_path, segment_id FROM captures
                 WHERE source_id = ?1",
                [source_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap()
    }

    /// How many images the store is holding, sharded directories and all.
    fn stored_files(root: &Path) -> usize {
        let Ok(listing) = fs::read_dir(root) else {
            return 0;
        };
        listing
            .flatten()
            .map(|entry| {
                if entry.path().is_dir() {
                    stored_files(&entry.path())
                } else {
                    1
                }
            })
            .sum()
    }

    #[test]
    fn takes_custody_of_the_image_a_marker_names() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        let original = install.screenshot("111423_120000", b"a picture of Ulduar");

        install.collect(2_000_000_100);

        let connection = open_database(&install.database).unwrap();
        let (file_path, hash, size, name, map, x, y, segment): (
            String,
            String,
            i64,
            String,
            i64,
            f64,
            f64,
            i64,
        ) = connection
            .query_row(
                "SELECT c.file_path, c.content_hash, c.byte_size, c.source_name, c.ui_map_id,
                        c.map_x, c.map_y, s.id
                 FROM captures c JOIN segments s ON s.id = c.segment_id",
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
                        row.get(7)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(size, 19);
        assert_eq!(name, "WoWScrnShot_111423_120000.jpg");
        assert_eq!((map, x, y), (350, 0.25, 0.5));
        assert!(segment > 0, "attached to the segment it was taken in");

        let stored = store_root(&install.database).join(&file_path);
        assert_eq!(fs::read(&stored).unwrap(), b"a picture of Ulduar");
        assert!(
            file_path.starts_with(&format!("{}/", &hash[..2])),
            "named for its own contents: {file_path}"
        );
        assert!(!original.exists(), "the game's copy is moved, not left");
    }

    #[test]
    fn ingests_the_same_capture_only_once_however_often_it_is_read() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");
        install.collect(2_000_000_100);
        let first = capture_row(&install.database, "TEST|2000000000|1");

        // The same entries and the same segment, read again because something else in the
        // file changed. The image it names is long gone from the game's folder by now, which
        // is exactly the trap: nothing here may conclude the image is missing.
        install.rewrite(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.collect(2_000_000_200);

        assert_eq!(count_of(&install.database, "captures"), 1);
        // The same rowid, so the row was never deleted and rebuilt the way a segment's
        // children are — which is the whole reason captures are not one of them.
        assert_eq!(capture_row(&install.database, "TEST|2000000000|1"), first);
        assert_eq!(stored_files(&store_root(&install.database)), 1);
    }

    #[test]
    fn does_not_go_back_for_an_image_it_already_holds() {
        // With the originals kept, the file a stored capture names is still sitting in the
        // game's folder, and nothing but the record of having already taken it stops the next
        // sync reading and hashing it all over again.
        let keep = Options {
            keep_originals: true,
            ..Options::default()
        };
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");
        collect(&install.wow, &install.database, 2_000_000_100, keep).unwrap();

        install.rewrite(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        collect(&install.wow, &install.database, 2_000_000_200, keep).unwrap();

        let ingested_at: i64 = open_database(&install.database)
            .unwrap()
            .query_row("SELECT ingested_at FROM captures", [], |row| row.get(0))
            .unwrap();
        assert_eq!(ingested_at, 2_000_000_100, "taken custody of once");
    }

    #[test]
    fn records_a_marker_whose_file_cannot_be_found() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );

        install.collect(2_000_000_100);

        let (_, state, file_path, _) = capture_row(&install.database, "TEST|2000000000|1");
        assert_eq!(state, "missing");
        assert_eq!(file_path, None);
    }

    #[test]
    fn looks_again_for_an_image_that_was_not_there_the_first_time() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.collect(2_000_000_100);
        assert_eq!(
            capture_row(&install.database, "TEST|2000000000|1").1,
            "missing"
        );

        // Written afterwards, and SavedVariables untouched — so this sync reads no markers at
        // all and still has to go looking on behalf of the row that is waiting.
        install.screenshot("111423_120000", b"late");
        install.collect(2_000_000_200);

        let (_, state, file_path, _) = capture_row(&install.database, "TEST|2000000000|1");
        assert_eq!(state, "stored");
        assert_eq!(
            fs::read(store_root(&install.database).join(file_path.unwrap())).unwrap(),
            b"late"
        );
    }

    #[test]
    fn attaches_a_capture_to_a_segment_that_arrives_after_it() {
        let install = Install::of(&SavedVariables::new().segments("").entries(CAPTURE_ENTRY));
        install.screenshot("111423_120000", b"a picture of Ulduar");

        install.collect(2_000_000_100);
        let (_, state, _, segment) = capture_row(&install.database, "TEST|2000000000|1");
        assert_eq!(state, "stored", "the image does not wait for the segment");
        assert_eq!(segment, None);

        install.rewrite(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.collect(2_000_000_200);

        assert!(capture_row(&install.database, "TEST|2000000000|1")
            .3
            .is_some());
    }

    #[test]
    fn keeps_a_capture_after_the_segment_it_named_is_gone() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");
        install.collect(2_000_000_100);

        open_database(&install.database)
            .unwrap()
            .execute("DELETE FROM segments", [])
            .unwrap();

        // Unattached, not deleted. The link is a link; the photograph is nobody's child.
        let (_, state, file_path, segment) = capture_row(&install.database, "TEST|2000000000|1");
        assert_eq!(state, "stored");
        assert_eq!(segment, None);
        assert!(store_root(&install.database)
            .join(file_path.unwrap())
            .is_file());
    }

    /// The same segment, with the account-first achievement that earned the photograph in it.
    /// A second achievement beside it, so that a link landing on "the segment's achievements"
    /// rather than on one of them is a test failure rather than a coincidence.
    const CAPTURE_SEGMENT_WITH_ACHIEVEMENTS: &str = r#"
      { ["id"] = "Aster-Vale|1999990000|Ulduar", ["character"] = "Aster-Vale",
        ["instance"] = "Ulduar", ["instanceType"] = "raid",
        ["startedAt"] = 1999990000, ["endedAt"] = 2000000000, ["seconds"] = 10000,
        ["achievements"] = {
          { ["id"] = 4000, ["name"] = "Glory of the Raider", ["at"] = 1999995000,
            ["accountFirst"] = false },
          { ["id"] = 4001, ["name"] = "Observed", ["at"] = 2000000000,
            ["accountFirst"] = true } } }
    "#;

    /// The same segment with another beside it, which is what makes a rebuild actually
    /// renumber. SQLite hands a reinserted row `max(rowid) + 1`, so a segment rebuilt on its
    /// own gets its old numbers straight back and one rebuilt next to a neighbour does not —
    /// and a database with one segment in it is not the case worth being right about.
    const CAPTURE_SEGMENTS_SIDE_BY_SIDE: &str = r#"
      { ["id"] = "Aster-Vale|1999990000|Ulduar", ["character"] = "Aster-Vale",
        ["instance"] = "Ulduar", ["instanceType"] = "raid",
        ["startedAt"] = 1999990000, ["endedAt"] = 2000000000, ["seconds"] = 10000,
        ["achievements"] = {
          { ["id"] = 4000, ["name"] = "Glory of the Raider", ["at"] = 1999995000,
            ["accountFirst"] = false },
          { ["id"] = 4001, ["name"] = "Observed", ["at"] = 2000000000,
            ["accountFirst"] = true } } },
      { ["id"] = "Aster-Vale|1999980000|Naxxramas", ["character"] = "Aster-Vale",
        ["instance"] = "Naxxramas", ["instanceType"] = "raid",
        ["startedAt"] = 1999980000, ["endedAt"] = 1999989000, ["seconds"] = 9000,
        ["achievements"] = {
          { ["id"] = 4002, ["name"] = "The Undying", ["at"] = 1999989000,
            ["accountFirst"] = true } } }
    "#;

    /// A capture Chronie took by itself, filed against the second of those achievements.
    const CAPTURE_ENTRY_OF_ACHIEVEMENT: &str = r#"
      { ["id"] = "TEST|2000000000|1", ["schema"] = 1, ["at"] = 2000000000,
        ["stamp"] = "111423_120000", ["character"] = "Aster-Vale", ["author"] = "TEST",
        ["segment"] = "Aster-Vale|1999990000|Ulduar", ["uiMapID"] = 350,
        ["x"] = 0.25, ["y"] = 0.5, ["hasImage"] = true,
        ["trigger"] = "accountFirstAchievement", ["achievement"] = 4001 }
    "#;

    /// What a capture says it is of: the rule that fired it, the achievement id the addon
    /// wrote down, and the achievement row that id resolved to.
    fn capture_subject(
        database: &Path,
        source_id: &str,
    ) -> (Option<String>, Option<i64>, Option<i64>) {
        open_database(database)
            .unwrap()
            .query_row(
                "SELECT trigger_name, achievement_source_id, achievement_id FROM captures
                 WHERE source_id = ?1",
                [source_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    #[test]
    fn files_an_automatic_capture_against_the_achievement_it_was_taken_for() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT_WITH_ACHIEVEMENTS)
                .entries(CAPTURE_ENTRY_OF_ACHIEVEMENT),
        );
        install.screenshot("111423_120000", b"a picture of Observed");

        install.collect(2_000_000_100);

        let (trigger, source, achievement) =
            capture_subject(&install.database, "TEST|2000000000|1");
        assert_eq!(trigger.as_deref(), Some("accountFirstAchievement"));
        assert_eq!(source, Some(4001));

        // The one it names, not merely one of the segment's.
        let earned: i64 = open_database(&install.database)
            .unwrap()
            .query_row(
                "SELECT achievements.achievement_id FROM achievements
                 JOIN captures ON captures.achievement_id = achievements.id",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(earned, 4001);
        assert!(achievement.is_some());
    }

    /// A pressed capture carries no trigger, and that absence is what tells the two apart.
    #[test]
    fn leaves_a_pressed_capture_saying_it_is_of_nothing() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");

        install.collect(2_000_000_100);

        assert_eq!(
            capture_subject(&install.database, "TEST|2000000000|1"),
            (None, None, None)
        );
    }

    /// The reason the link is re-resolved rather than written once: `clear_outcomes` deletes
    /// and reinserts the achievements of every segment the file still describes, on every
    /// single sync. Their rowids do not survive one, so a link left alone would end up
    /// pointing at whatever row inherited its number — a real achievement, and the wrong one.
    #[test]
    fn follows_the_achievement_through_the_rebuild_every_sync_does_to_it() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENTS_SIDE_BY_SIDE)
                .entries(CAPTURE_ENTRY_OF_ACHIEVEMENT),
        );
        install.screenshot("111423_120000", b"a picture of Observed");
        install.collect(2_000_000_100);
        let first = capture_subject(&install.database, "TEST|2000000000|1")
            .2
            .unwrap();

        install.rewrite(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENTS_SIDE_BY_SIDE)
                .entries(CAPTURE_ENTRY_OF_ACHIEVEMENT),
        );
        install.collect(2_000_000_200);

        let rebuilt = capture_subject(&install.database, "TEST|2000000000|1")
            .2
            .unwrap();
        assert_ne!(
            rebuilt, first,
            "the rebuild was expected to move the row this test is about"
        );
        let earned: i64 = open_database(&install.database)
            .unwrap()
            .query_row(
                "SELECT achievement_id FROM achievements WHERE id = ?1",
                [rebuilt],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(earned, 4001, "the link followed the row rather than the id");
    }

    /// Same reason a capture can arrive before its segment: the achievement is filed by the
    /// segment list, and a marker written in a session whose segment is still open beats it.
    #[test]
    fn attaches_a_capture_to_an_achievement_that_arrives_after_it() {
        let install = Install::of(
            &SavedVariables::new()
                .segments("")
                .entries(CAPTURE_ENTRY_OF_ACHIEVEMENT),
        );
        install.screenshot("111423_120000", b"a picture of Observed");

        install.collect(2_000_000_100);
        let (trigger, source, achievement) =
            capture_subject(&install.database, "TEST|2000000000|1");
        assert_eq!(trigger.as_deref(), Some("accountFirstAchievement"));
        assert_eq!(source, Some(4001), "the id it is waiting to resolve");
        assert_eq!(achievement, None);

        install.rewrite(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT_WITH_ACHIEVEMENTS)
                .entries(CAPTURE_ENTRY_OF_ACHIEVEMENT),
        );
        install.collect(2_000_000_200);

        assert!(capture_subject(&install.database, "TEST|2000000000|1")
            .2
            .is_some());
    }

    /// A segment ages out of the rolling week and takes its achievements with it. The
    /// photograph is nobody's child: it is left unattached, and it still says what it was of.
    #[test]
    fn keeps_a_capture_after_the_achievement_it_named_is_gone() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT_WITH_ACHIEVEMENTS)
                .entries(CAPTURE_ENTRY_OF_ACHIEVEMENT),
        );
        install.screenshot("111423_120000", b"a picture of Observed");
        install.collect(2_000_000_100);

        let connection = open_database(&install.database).unwrap();
        connection.execute("DELETE FROM achievements", []).unwrap();

        let (trigger, source, achievement) =
            capture_subject(&install.database, "TEST|2000000000|1");
        assert_eq!(achievement, None, "the foreign key let go rather than held");
        assert_eq!(trigger.as_deref(), Some("accountFirstAchievement"));
        assert_eq!(source, Some(4001));
        assert_eq!(count_of(&install.database, "captures"), 1);
    }

    #[test]
    fn records_an_entry_that_asked_for_no_picture() {
        let note = r#"
          { ["id"] = "TEST|2000000000|2", ["at"] = 2000000000,
            ["stamp"] = "111423_120000", ["character"] = "Aster-Vale", ["author"] = "TEST" }
        "#;
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(note),
        );
        let bystander = install.screenshot("111423_120000", b"somebody else's shot");

        install.collect(2_000_000_100);

        let (_, state, file_path, _) = capture_row(&install.database, "TEST|2000000000|2");
        assert_eq!(state, "none");
        assert_eq!(file_path, None);
        assert!(bystander.exists(), "an entry with no image claims no file");
    }

    #[test]
    fn leaves_the_players_own_archive_where_it_is() {
        let install = Install::of(&SavedVariables::new().segments(CAPTURE_SEGMENT).entries(""));
        let archive = [
            install.screenshot("010119_080000", b"a screenshot from 2019"),
            install.screenshot("070420_211500", b"and one from 2020"),
            install.screenshot("111423_120000", b"and one from today"),
        ];

        install.collect(2_000_000_100);

        // Marker-driven, all the way down. Thousands of files nothing has a marker for are
        // not orphans to be swept up; ingesting them is a different feature entirely.
        assert_eq!(count_of(&install.database, "captures"), 0);
        assert_eq!(stored_files(&store_root(&install.database)), 0);
        assert!(archive.iter().all(|path| path.is_file()));
    }

    #[test]
    fn keeps_the_games_own_copy_when_the_setting_asks_it_to() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        let original = install.screenshot("111423_120000", b"a picture of Ulduar");

        install.collect_with(
            Options {
                keep_originals: true,
                ..Options::default()
            },
            2_000_000_100,
        );

        let (_, state, file_path, _) = capture_row(&install.database, "TEST|2000000000|1");
        assert_eq!(state, "stored");
        assert_eq!(fs::read(&original).unwrap(), b"a picture of Ulduar");
        assert_eq!(
            fs::read(store_root(&install.database).join(file_path.unwrap())).unwrap(),
            b"a picture of Ulduar"
        );
    }

    #[test]
    fn migrates_a_database_written_before_captures_were_kept() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");
        {
            fs::create_dir_all(install.database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&install.database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..5] {
                transaction.execute_batch(migration.sql).unwrap();
            }
            transaction
                .pragma_update(None, "user_version", 5_i64)
                .unwrap();
            transaction.commit().unwrap();
        }

        install.collect(2_000_000_100);

        assert_eq!(
            capture_row(&install.database, "TEST|2000000000|1").1,
            "stored"
        );
    }

    /// The subject columns arrive by ALTER TABLE onto a table that already has rows in it,
    /// which is the case a fresh database never exercises. The photographs somebody already
    /// has must survive it and the new ones must be filed against what they are of.
    #[test]
    fn migrates_a_database_written_before_a_capture_could_say_what_it_was_of() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");
        {
            fs::create_dir_all(install.database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&install.database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..8] {
                transaction.execute_batch(migration.sql).unwrap();
            }
            transaction
                .pragma_update(None, "user_version", 8_i64)
                .unwrap();
            transaction.commit().unwrap();
        }
        // A photograph taken and stored under the old schema, before the columns existed.
        install.collect(2_000_000_100);
        assert_eq!(
            capture_row(&install.database, "TEST|2000000000|1").1,
            "stored"
        );

        install.rewrite(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT_WITH_ACHIEVEMENTS)
                .entries(CAPTURE_ENTRY_OF_ACHIEVEMENT),
        );
        install.collect(2_000_000_200);

        let (trigger, source, achievement) =
            capture_subject(&install.database, "TEST|2000000000|1");
        assert_eq!(trigger.as_deref(), Some("accountFirstAchievement"));
        assert_eq!(source, Some(4001));
        assert!(achievement.is_some());
        assert_eq!(
            capture_row(&install.database, "TEST|2000000000|1").1,
            "stored"
        );
    }

    /* ---------- what somebody says about a capture, and throwing one away ---------- */

    /// The same capture with a sentence typed in game beside it.
    const CAPTURE_ENTRY_WITH_NOTE: &str = r#"
      { ["id"] = "TEST|2000000000|1", ["schema"] = 1, ["at"] = 2000000000,
        ["stamp"] = "111423_120000", ["character"] = "Aster-Vale", ["author"] = "TEST",
        ["segment"] = "Aster-Vale|1999990000|Ulduar", ["hasImage"] = true,
        ["note"] = "first Yogg kill" }
    "#;

    /// The note on a capture, and whether the app is the one that last wrote it.
    fn capture_note(database: &Path, source_id: &str) -> (Option<String>, Option<i64>) {
        open_database(database)
            .unwrap()
            .query_row(
                "SELECT note, note_edited_at FROM captures WHERE source_id = ?1",
                [source_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    /// The captures the dashboard hands the window for one segment.
    fn dashboard_captures(database: &Path) -> Vec<Value> {
        dashboard(database).unwrap()["segments"][0]["captures"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn keeps_the_note_somebody_typed_in_the_moment() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY_WITH_NOTE),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");

        install.collect(2_000_000_100);

        assert_eq!(
            capture_note(&install.database, "TEST|2000000000|1")
                .0
                .as_deref(),
            Some("first Yogg kill")
        );
        // And nothing claims the app wrote it, which is what leaves the game free to correct
        // it on a later sync.
        assert_eq!(capture_note(&install.database, "TEST|2000000000|1").1, None);
        assert_eq!(
            dashboard_captures(&install.database)[0]["note"],
            "first Yogg kill"
        );
    }

    // The marker keeps whatever was typed in game for as long as the entry exists, and it is
    // read again on every single sync. An edit that a logout undid would be worse than no
    // editing at all: somebody would type the sentence, see it, and lose it silently.
    #[test]
    fn keeps_an_edited_note_through_the_syncs_that_read_the_marker_again() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY_WITH_NOTE),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");
        install.collect(2_000_000_100);
        let capture_id = capture_row(&install.database, "TEST|2000000000|1").0;

        set_capture_note(
            &install.database,
            capture_id,
            "  Yogg-Saron, no lights  ",
            2_000_000_200,
        )
        .unwrap();
        install.rewrite(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY_WITH_NOTE),
        );
        install.collect(2_000_000_300);

        let (note, edited) = capture_note(&install.database, "TEST|2000000000|1");
        assert_eq!(note.as_deref(), Some("Yogg-Saron, no lights"));
        assert_eq!(edited, Some(2_000_000_200));
    }

    // Clearing is an edit like any other, and the state it leaves behind is the one a capture
    // nobody ever wrote about is in — which is why it has to be the same NULL and not an
    // empty string that every reader downstream would have to know about.
    #[test]
    fn keeps_a_note_cleared_rather_than_letting_the_next_sync_put_it_back() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY_WITH_NOTE),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");
        install.collect(2_000_000_100);
        let capture_id = capture_row(&install.database, "TEST|2000000000|1").0;

        set_capture_note(&install.database, capture_id, "   ", 2_000_000_200).unwrap();
        install.rewrite(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY_WITH_NOTE),
        );
        install.collect(2_000_000_300);

        assert_eq!(capture_note(&install.database, "TEST|2000000000|1").0, None);
    }

    // The same rules the addon holds a typed note to, applied to the app's own field, so that
    // "a stored note holds no pipe" is true of every note however it was written.
    #[test]
    fn cleans_a_note_typed_in_the_app_the_way_the_game_cleans_one() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");
        install.collect(2_000_000_100);
        let capture_id = capture_row(&install.database, "TEST|2000000000|1").0;

        set_capture_note(
            &install.database,
            capture_id,
            "got |cffa335ee|Hitem:19019|h[Thunderfury]|h|r\nat last",
            2_000_000_200,
        )
        .unwrap();

        // Down to the `r` left behind by `|r`, which `ns.entryText` also leaves: it strips the
        // pipe and keeps what follows, and the two implementations agreeing is worth more than
        // either of them being tidier than the other.
        assert_eq!(
            capture_note(&install.database, "TEST|2000000000|1")
                .0
                .as_deref(),
            Some("got [Thunderfury]r at last"),
        );
    }

    #[test]
    fn refuses_to_write_a_note_on_a_capture_that_is_gone() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.collect(2_000_000_100);

        let error =
            set_capture_note(&install.database, 9999, "nothing to say", 2_000_000_200).unwrap_err();
        assert!(error.contains("no longer in Chronie's history"), "{error}");
    }

    // Deleting is the row and the file together, and it stays deleted: `db.entries` never
    // prunes, so the marker for this capture is read again on every sync for as long as the
    // player keeps that file. A photograph that came back as a broken tile after being thrown
    // away would be worse than one that could not be thrown away at all.
    #[test]
    fn deletes_the_row_and_the_file_and_does_not_ingest_it_again() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.screenshot("111423_120000", b"a picture of Ulduar");
        install.collect(2_000_000_100);
        let (capture_id, _, file_path, _) = capture_row(&install.database, "TEST|2000000000|1");
        let store = store_root(&install.database);
        let image = store.join(file_path.unwrap());
        assert!(image.is_file());

        delete_capture(&install.database, capture_id, 2_000_000_200).unwrap();

        assert!(!image.exists(), "the file goes with the row");
        assert_eq!(count_of(&install.database, "captures"), 0);

        // The marker is still in the file, and the original is still where the player left it
        // — which is exactly the case a sync would otherwise ingest all over again.
        install.screenshot("111423_120000", b"a picture of Ulduar");
        install.rewrite(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.collect(2_000_000_300);

        assert_eq!(count_of(&install.database, "captures"), 0);
        assert!(!image.exists());
    }

    // The store is content-addressed, so two captures of identical bytes are one file. Deleting
    // one of them must not blank the other, which would be a picture nobody asked to lose.
    #[test]
    fn keeps_a_file_a_second_capture_still_names() {
        let twins = format!(
            "{CAPTURE_ENTRY}, {}",
            r#"
          { ["id"] = "TEST|2000000001|2", ["schema"] = 1, ["at"] = 2000000001,
            ["stamp"] = "111423_120001", ["character"] = "Aster-Vale", ["author"] = "TEST",
            ["segment"] = "Aster-Vale|1999990000|Ulduar", ["hasImage"] = true }
        "#
        );
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(&twins),
        );
        install.screenshot("111423_120000", b"the very same picture");
        install.screenshot("111423_120001", b"the very same picture");
        install.collect(2_000_000_100);
        let first = capture_row(&install.database, "TEST|2000000000|1");
        let second = capture_row(&install.database, "TEST|2000000001|2");
        assert_eq!(first.2, second.2, "one file, named by both rows");
        let image = store_root(&install.database).join(second.2.clone().unwrap());

        delete_capture(&install.database, first.0, 2_000_000_200).unwrap();

        assert_eq!(count_of(&install.database, "captures"), 1);
        assert!(
            image.is_file(),
            "the surviving capture still has its picture"
        );
    }

    #[test]
    fn deletes_a_capture_that_has_already_gone_without_complaining() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(CAPTURE_ENTRY),
        );
        install.collect(2_000_000_100);

        delete_capture(&install.database, 9999, 2_000_000_200).unwrap();
    }

    // What the window is drawn from. The state of the image travels with every row because
    // the three ways there is no picture — one is coming, none was asked for, the file was
    // never found — are three different things to say and not one blank tile.
    #[test]
    fn hands_the_window_the_captures_of_the_segment_they_were_taken_in() {
        let entries = format!(
            "{CAPTURE_ENTRY_WITH_NOTE}, {}",
            r#"
          { ["id"] = "TEST|2000000050|2", ["schema"] = 1, ["at"] = 2000000050,
            ["stamp"] = "111423_130000", ["character"] = "Aster-Vale", ["author"] = "TEST",
            ["segment"] = "Aster-Vale|1999990000|Ulduar", ["hasImage"] = true }
        "#
        );
        let install = Install::of(
            &SavedVariables::new()
                .segments(CAPTURE_SEGMENT)
                .entries(&entries),
        );
        // Only the first has a file waiting for it; the second is a marker whose picture was
        // never found, which is a row the window has to show and explain rather than drop.
        install.screenshot("111423_120000", b"a picture of Ulduar");

        install.collect(2_000_000_100);

        let captures = dashboard_captures(&install.database);
        assert_eq!(captures.len(), 2);
        assert_eq!(captures[0]["sourceId"], "TEST|2000000000|1");
        assert_eq!(captures[0]["imageState"], "stored");
        assert_eq!(captures[0]["note"], "first Yogg kill");
        assert_eq!(captures[0]["byteSize"], 19);
        assert_eq!(captures[1]["imageState"], "missing");
        assert_eq!(captures[1]["note"], Value::Null);
    }

    /// A memory taken inside the raid the fixture log records: the map the client will answer for,
    /// and no point on it, which is exactly what an entry made inside an instance looks like.
    ///
    /// No picture is asked for, because whether a screenshot landed on disk has nothing to do with
    /// where it was taken — a memory and a screenshot are the same row with the image left out,
    /// and one pass places both.
    fn instanced_entry(id: &str, at: i64) -> String {
        format!(
            r#"
      {{ ["id"] = "{id}", ["schema"] = 1, ["at"] = {at},
        ["character"] = "Alyndra-Ravencrest", ["author"] = "TEST",
        ["segment"] = "night-1", ["uiMapID"] = 2232, ["note"] = "worth remembering" }}
    "#
        )
    }

    /// The point on the map a capture ended up with, if it ended up with one.
    fn capture_point(database: &Path, source_id: &str) -> Option<(f64, f64)> {
        let placed: (Option<f64>, Option<f64>) = open_database(database)
            .unwrap()
            .query_row(
                "SELECT map_x, map_y FROM captures WHERE source_id = ?1",
                [source_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        placed.0.zip(placed.1)
    }

    /// The whole reason the track is kept. The client will not answer
    /// `C_Map.GetPlayerMapPosition` inside an instance, so the entry arrives with a map and
    /// nothing on it, and the combat log two seconds later is the only record of where the player
    /// was standing.
    #[test]
    fn places_a_capture_the_client_refused_to_place() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(&night_segment(
                    "night-1",
                    "Alyndra-Ravencrest",
                    raid_second(20, 10, 0),
                    raid_second(20, 30, 0),
                ))
                .entries(&instanced_entry("TEST|1|1", raid_second(20, 16, 0))),
        );
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(
            &install.wow,
            &install.database,
            raid_night_sync(),
            Options::default(),
        )
        .unwrap();

        // The pull at 20:16:02, two seconds after the entry, at world 4000,-2200 on a map running
        // 4400..3600 north to south and -2000..-3000 west to east.
        assert_eq!(
            capture_point(&install.database, "TEST|1|1"),
            Some((0.2, 0.5))
        );
    }

    /// The refusal, which matters as much as the placement. A memory made while standing about
    /// between pulls has its nearest point minutes away, and minutes is long enough to have walked
    /// into another room — so it keeps the nothing the client gave it.
    #[test]
    fn leaves_a_capture_with_no_point_near_it_unplaced() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(&night_segment(
                    "night-1",
                    "Alyndra-Ravencrest",
                    raid_second(20, 10, 0),
                    raid_second(20, 30, 0),
                ))
                .entries(&instanced_entry("TEST|1|1", raid_second(20, 18, 0))),
        );
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(
            &install.wow,
            &install.database,
            raid_night_sync(),
            Options::default(),
        )
        .unwrap();

        assert_eq!(capture_point(&install.database, "TEST|1|1"), None);
    }

    /// A capture that arrives before the log covering it has been read — a backlog still being
    /// worked through — is not placed by the sync that files it and must not be given up on. The
    /// pass reconsiders every unplaced capture, so whichever later sync reads the points places it.
    #[test]
    fn places_a_capture_that_was_filed_before_the_log_was_read() {
        let install = Install::of(
            &SavedVariables::new()
                .segments(&night_segment(
                    "night-1",
                    "Alyndra-Ravencrest",
                    raid_second(20, 10, 0),
                    raid_second(20, 30, 0),
                ))
                .entries(&instanced_entry("TEST|1|1", raid_second(20, 16, 0))),
        );
        collect(
            &install.wow,
            &install.database,
            raid_night_sync(),
            Options::default(),
        )
        .unwrap();
        assert_eq!(
            capture_point(&install.database, "TEST|1|1"),
            None,
            "no track to place it from yet"
        );

        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");
        collect(
            &install.wow,
            &install.database,
            raid_night_sync() + 100,
            Options::default(),
        )
        .unwrap();

        assert_eq!(
            capture_point(&install.database, "TEST|1|1"),
            Some((0.2, 0.5))
        );
    }

    /// A capture the client *did* place is left exactly as it arrived. The track is a fallback for
    /// what the game refused to say, never a correction to what it said.
    #[test]
    fn does_not_move_a_capture_the_client_already_placed() {
        let stated = format!(
            r#"
      {{ ["id"] = "TEST|1|1", ["schema"] = 1, ["at"] = {},
        ["character"] = "Alyndra-Ravencrest", ["author"] = "TEST",
        ["segment"] = "night-1", ["uiMapID"] = 2232, ["x"] = 0.9, ["y"] = 0.9 }}
    "#,
            raid_second(20, 16, 0)
        );
        let install = Install::of(
            &SavedVariables::new()
                .segments(&night_segment(
                    "night-1",
                    "Alyndra-Ravencrest",
                    raid_second(20, 10, 0),
                    raid_second(20, 30, 0),
                ))
                .entries(&stated),
        );
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(
            &install.wow,
            &install.database,
            raid_night_sync(),
            Options::default(),
        )
        .unwrap();

        assert_eq!(
            capture_point(&install.database, "TEST|1|1"),
            Some((0.9, 0.9))
        );
    }
}
