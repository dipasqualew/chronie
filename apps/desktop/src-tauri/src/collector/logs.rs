//! The client's own combat log.
//!
//! What the app gets out of a log is a track of where the player stood and a list of the
//! fights they were in, read a bounded number of bytes at a time so that a season's backlog
//! is worked through over many syncs rather than in one that looks like it has hung. A cursor
//! per file says where the last read got to.
//!
//! Clearing up afterwards is here too, and is two separate promises: a log file is deleted
//! only when somebody has asked for that, and the position table — which nothing but capture
//! placement reads, and which grows for ever otherwise — is compacted whether they have or
//! not.

use super::database::open_database;
use crate::combatlog;
use crate::logfile::{self, Fight, Fought, MapBounds, Position, Reading, Resume, Sampled};
use crate::placement;
use crate::retention;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use std::{collections::HashMap, fs, path::Path};

/// How many new bytes of combat log one sync will get through.
///
/// A first pass over a season of logs is gigabytes, and doing it in one go is a sync that
/// looks like it has hung. This is the same work spread over a beat that comes round every
/// thirty seconds: nothing is skipped, nothing is read twice, and a backlog of a hundred
/// gigabytes clears in half an hour of the app simply being open.
const LOG_BYTES_PER_SYNC: u64 = 64 * 1024 * 1024;

/// Where the last read of this log got to, and the state it needs to carry on.
///
/// The cursor comes off the log's own row; the map and the sample clock are read back out of
/// the rows the last read wrote, rather than kept a second time on the cursor. One place for
/// each fact is one place for it to be wrong.
fn log_resume(connection: &Connection, name: &str) -> Result<(Option<i64>, Resume), String> {
    let Some((log_id, cursor)) = connection
        .query_row(
            "SELECT id, byte_offset, byte_size, head_hash, head_bytes
             FROM combat_logs WHERE name = ?1",
            [name],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    logfile::Cursor {
                        offset: row.get::<_, i64>(1)? as u64,
                        size: row.get::<_, i64>(2)? as u64,
                        head: row.get(3)?,
                        head_bytes: row.get::<_, i64>(4)? as u64,
                    },
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
    else {
        return Ok((None, Resume::default()));
    };
    let map = connection
        .query_row(
            "SELECT ui_map_id, name, x0, x1, y0, y1, changed_at FROM log_maps
             WHERE log_id = ?1 ORDER BY changed_at DESC, id DESC LIMIT 1",
            [log_id],
            |row| {
                Ok(MapBounds {
                    ui_map_id: row.get(0)?,
                    name: row.get(1)?,
                    x0: row.get(2)?,
                    x1: row.get(3)?,
                    y0: row.get(4)?,
                    y1: row.get(5)?,
                    at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let sampled = connection
        .query_row(
            "SELECT at_ms, ui_map_id FROM log_positions
             WHERE log_id = ?1 ORDER BY at_ms DESC, id DESC LIMIT 1",
            [log_id],
            |row| {
                Ok(Sampled {
                    at: row.get(0)?,
                    ui_map_id: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok((
        Some(log_id),
        Resume {
            cursor: Some(cursor),
            map,
            sampled,
        },
    ))
}

/// Writes down where reading a log got to, and what it is turning out to be.
///
/// `advanced` only ever moves towards true. A file can span two sessions and be written
/// without advanced parameters for one of them, and the answer that matters — "did this log
/// ever carry positions" — must not be undone by a later pass over its quiet half.
fn upsert_log(
    transaction: &Transaction<'_>,
    name: &str,
    reading: &Reading,
    now: i64,
) -> Result<i64, String> {
    let facts = &reading.facts;
    transaction
        .execute(
            "INSERT INTO combat_logs (
                 name, byte_offset, byte_size, head_hash, head_bytes, lines_read, restarts,
                 advanced, first_event_at, last_event_at, first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
             ON CONFLICT(name) DO UPDATE SET
                 byte_offset = excluded.byte_offset,
                 byte_size = excluded.byte_size,
                 head_hash = excluded.head_hash,
                 head_bytes = excluded.head_bytes,
                 -- Reset by a restart, because the lines counted before it were counted
                 -- against a file this row is no longer the cursor for. `?7` is whether this
                 -- read restarted, not how many times this file ever has, so the count it
                 -- feeds is added to rather than replaced — a log rotated twice has restarted
                 -- twice, and the second one resets the tally exactly as the first did.
                 lines_read = CASE
                     WHEN ?7 = 1 THEN excluded.lines_read
                     ELSE combat_logs.lines_read + excluded.lines_read
                 END,
                 restarts = combat_logs.restarts + ?7,
                 advanced = CASE
                     WHEN combat_logs.advanced = 1 THEN 1
                     ELSE COALESCE(excluded.advanced, combat_logs.advanced)
                 END,
                 first_event_at = COALESCE(combat_logs.first_event_at, excluded.first_event_at),
                 last_event_at = COALESCE(excluded.last_event_at, combat_logs.last_event_at),
                 last_seen_at = excluded.last_seen_at",
            params![
                name,
                reading.cursor.offset as i64,
                reading.cursor.size as i64,
                reading.cursor.head,
                reading.cursor.head_bytes as i64,
                facts.lines as i64,
                i64::from(reading.restarted.is_some()),
                // Nothing to say until a line has been read that could have carried them.
                (facts.lines > 0).then(|| i64::from(facts.advanced_seen)),
                facts.first_at,
                facts.last_at,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .query_row("SELECT id FROM combat_logs WHERE name = ?1", [name], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())
}

fn insert_map(
    transaction: &Transaction<'_>,
    log_id: i64,
    bounds: &MapBounds,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO log_maps (log_id, ui_map_id, name, x0, x1, y0, y1, changed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(log_id, changed_at, ui_map_id) DO NOTHING",
            params![
                log_id,
                bounds.ui_map_id,
                bounds.name,
                bounds.x0,
                bounds.x1,
                bounds.y0,
                bounds.y1,
                bounds.at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// One point of the track.
///
/// The normalised pair is filled in rather than overwritten, because a point read before the
/// `MAP_CHANGE` that would place it can be placed by a later pass — and a point already
/// placed must not lose that to a pass that happens to have no bounds in hand.
fn insert_position(
    transaction: &Transaction<'_>,
    log_id: i64,
    point: &Position,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO log_positions (
                 log_id, at_ms, actor_guid, actor_name, ui_map_id,
                 world_x, world_y, map_x, map_y, facing
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(log_id, at_ms, actor_guid) DO UPDATE SET
                 map_x = COALESCE(excluded.map_x, log_positions.map_x),
                 map_y = COALESCE(excluded.map_y, log_positions.map_y)",
            params![
                log_id,
                point.at,
                point.actor_guid,
                point.actor_name,
                point.ui_map_id,
                point.world_x,
                point.world_y,
                point.map_x,
                point.map_y,
                point.facing,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Writes down one fight, from whichever end of it was read.
///
/// A fight with only an end is the second half of one the previous pass left open, so it
/// closes that row rather than starting another. Only when there is no such row is an
/// end-with-no-beginning written down on its own — which is what a log that was rotated
/// mid-pull leaves behind, and is still worth having.
fn store_fight(
    transaction: &Transaction<'_>,
    log_id: i64,
    fight: &Fight,
    now: i64,
) -> Result<Option<i64>, String> {
    let kind = match fight.kind {
        Fought::Encounter => "encounter",
        Fought::Keystone => "keystone",
    };
    let affixes = Value::Array(fight.affixes.iter().map(|id| Value::from(*id)).collect());
    if fight.started_at.is_none() {
        let Some(ended_at) = fight.ended_at else {
            // Neither end. Nothing about it is a fact.
            return Ok(None);
        };
        let open: Option<i64> = transaction
            .query_row(
                "SELECT id FROM log_fights
                 WHERE log_id = ?1 AND kind = ?2 AND ended_at IS NULL
                   AND (encounter_id IS ?3 OR ?3 IS NULL)
                 ORDER BY started_at DESC, id DESC LIMIT 1",
                params![log_id, kind, fight.encounter_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(id) = open {
            transaction
                .execute(
                    "UPDATE log_fights SET
                         ended_at = ?2, success = ?3, duration_ms = ?4,
                         name = CASE WHEN ?5 = '' THEN name ELSE ?5 END
                     WHERE id = ?1",
                    params![id, ended_at, fight.success, fight.duration_ms, fight.name],
                )
                .map_err(|error| error.to_string())?;
            return Ok(Some(id));
        }
        // Nothing open to close, so this is a fight whose beginning was never read. Written
        // once and recognised by its ending, since that is the only identity it has.
        let existing: Option<i64> = transaction
            .query_row(
                "SELECT id FROM log_fights
                 WHERE log_id = ?1 AND kind = ?2 AND encounter_id IS ?3 AND ended_at = ?4",
                params![log_id, kind, fight.encounter_id, ended_at],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(id) = existing {
            return Ok(Some(id));
        }
    }
    transaction
        .execute(
            "INSERT INTO log_fights (
                 log_id, kind, encounter_id, name, difficulty_id, group_size, instance_id,
                 keystone_level, affixes_json, started_at, ended_at, success, duration_ms,
                 recorded_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(log_id, kind, encounter_id, started_at) DO UPDATE SET
                 name = CASE WHEN excluded.name = '' THEN log_fights.name ELSE excluded.name END,
                 difficulty_id = COALESCE(excluded.difficulty_id, log_fights.difficulty_id),
                 group_size = COALESCE(excluded.group_size, log_fights.group_size),
                 instance_id = COALESCE(excluded.instance_id, log_fights.instance_id),
                 keystone_level = COALESCE(excluded.keystone_level, log_fights.keystone_level),
                 affixes_json = CASE
                     WHEN excluded.affixes_json = '[]' THEN log_fights.affixes_json
                     ELSE excluded.affixes_json
                 END,
                 ended_at = COALESCE(excluded.ended_at, log_fights.ended_at),
                 success = COALESCE(excluded.success, log_fights.success),
                 duration_ms = COALESCE(excluded.duration_ms, log_fights.duration_ms)",
            params![
                log_id,
                kind,
                fight.encounter_id,
                fight.name,
                fight.difficulty_id,
                fight.group_size,
                fight.instance_id,
                fight.keystone_level,
                affixes.to_string(),
                fight.started_at,
                fight.ended_at,
                fight.success,
                fight.duration_ms,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .query_row(
            // Ordered, because the row just written is the only one this can mean and a fight
            // with no beginning is not covered by the unique key that would otherwise say so.
            "SELECT id FROM log_fights
             WHERE log_id = ?1 AND kind = ?2 AND encounter_id IS ?3 AND started_at IS ?4
             ORDER BY id DESC LIMIT 1",
            params![log_id, kind, fight.encounter_id, fight.started_at],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn insert_combatants(
    transaction: &Transaction<'_>,
    fight_row: i64,
    fight: &Fight,
) -> Result<(), String> {
    for combatant in &fight.combatants {
        transaction
            .execute(
                "INSERT INTO log_combatants (
                     fight_id, guid, faction, spec_id, talents_json, equipment_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(fight_id, guid) DO UPDATE SET
                     faction = COALESCE(excluded.faction, log_combatants.faction),
                     spec_id = COALESCE(excluded.spec_id, log_combatants.spec_id),
                     talents_json = excluded.talents_json,
                     equipment_json = excluded.equipment_json",
                params![
                    fight_row,
                    combatant.guid,
                    combatant.faction,
                    combatant.spec_id,
                    combatant.talents.to_string(),
                    combatant.equipment.to_string(),
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Attaches what the log said to the visits it was said during.
///
/// Run after every sync's segments are in, over everything still unattached, for the same
/// reason `link_captures` is: a position is read within thirty seconds of being logged and
/// the segment it belongs to is not written until the player logs out, so the link almost
/// never can be made at the moment the row is.
///
/// A point prefers the segment whose character the log named — every position carries the
/// name the client wrote — and falls back on the time alone, which is enough whenever only
/// one character was being played, and that is always.
fn place_log_facts(transaction: &Transaction<'_>) -> Result<(), String> {
    // Ranked in a CTE rather than ordered inside a correlated subquery, because SQLite will
    // not resolve a reference to the row being updated from a subquery's ORDER BY — and the
    // preference is exactly the sort of thing that belongs in an ORDER BY.
    transaction
        .execute(
            "WITH ranked AS (
                 SELECT
                     p.id AS point,
                     s.id AS segment,
                     ROW_NUMBER() OVER (
                         PARTITION BY p.id
                         ORDER BY (
                             c.source_key = p.actor_name OR c.name = p.actor_name
                         ) DESC, s.started_at DESC
                     ) AS rank
                 FROM log_positions p
                 JOIN segments s ON p.at_ms / 1000 BETWEEN s.started_at AND s.ended_at
                 JOIN characters c ON c.id = s.character_id
                 WHERE p.segment_id IS NULL
                   -- Nothing outside the span history covers can land in it, and this is what
                   -- keeps the pass from costing anything at all on an install that has read
                   -- a season of logs and has no segments yet: with no segments the pair is
                   -- NULL, the comparison is NULL, and no row is considered.
                   AND p.at_ms / 1000 BETWEEN (SELECT MIN(started_at) FROM segments)
                                          AND (SELECT MAX(ended_at) FROM segments)
             )
             UPDATE log_positions SET segment_id = (
                 SELECT segment FROM ranked
                 WHERE ranked.point = log_positions.id AND ranked.rank = 1
             )
             WHERE segment_id IS NULL",
            [],
        )
        .map_err(|error| error.to_string())?;
    // A fight has no character on it, so it goes to the visit it overlaps most. A boss pulled
    // at the very end of one segment and finished at the start of the next belongs to
    // whichever of them it spent longer inside, which is the only answer that does not need
    // somebody to pick a tie-break rule out of the air.
    transaction
        .execute(
            "WITH bounded AS (
                 SELECT
                     id,
                     COALESCE(started_at, ended_at) / 1000 AS from_second,
                     COALESCE(ended_at, started_at) / 1000 AS to_second
                 FROM log_fights
                 WHERE segment_id IS NULL AND COALESCE(started_at, ended_at) IS NOT NULL
             ),
             ranked AS (
                 SELECT
                     f.id AS fight,
                     s.id AS segment,
                     ROW_NUMBER() OVER (
                         PARTITION BY f.id
                         ORDER BY
                             MIN(s.ended_at, f.to_second) - MAX(s.started_at, f.from_second)
                                 DESC,
                             s.started_at DESC
                     ) AS rank
                 FROM bounded f
                 JOIN segments s
                     ON s.started_at <= f.to_second AND s.ended_at >= f.from_second
             )
             UPDATE log_fights SET segment_id = (
                 SELECT segment FROM ranked
                 WHERE ranked.fight = log_fights.id AND ranked.rank = 1
             )
             WHERE segment_id IS NULL",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Deletes the points nothing claimed, once they are old enough to be final.
///
/// The table is written every five seconds and read by exactly one thing, and almost every row it
/// holds is a place the player passed through on the way to somewhere nobody photographed. Those
/// rows are what makes it grow without bound, and this is what stops it.
///
/// A point may go when both of these are true:
///
/// - it is older than the retention window — the same window the log files are swept on, rather
///   than a second number to explain. A log old enough to be deleted can produce nothing new, so
///   what has been derived from it is final;
/// - no remembered moment is within [`placement::KEEP_MS`] of it. Every capture anchors a window,
///   whether or not it was placed: the capture the current rule *refused* is exactly the one a
///   later rule would want the neighbouring points for, and sweeping them would decide that
///   question permanently in favour of the rule that happens to be written today.
///
/// This runs whether or not the log sweeper is switched on, at the configured window when there
/// is one and at the default otherwise, and the asymmetry is deliberate. Deleting a player's
/// combat log is irreversible and is theirs to ask for; deleting rows Chronie derived from a file
/// that is still sitting on disk is not the same act, and an install that has chosen to keep
/// every log for ever has not thereby asked for a position table that never stops growing.
///
/// Nothing here can outrun a capture that has not arrived. A capture is written at logout, within
/// hours of the points around it; the window is days.
pub(super) fn compact_positions(connection: &Connection, retain_days: u32, now: i64) -> Result<usize, String> {
    let window = i64::from(retain_days.max(retention::MIN_RETAIN_DAYS)) * 86_400;
    let cutoff_ms = (now - window) * 1000;
    connection
        .execute(
            // The bounds on the anchor are in seconds, because that is what `captures` stores and
            // what its index is over, and they are widened by a second at each end so that the
            // truncating division cannot narrow the window it is protecting.
            "DELETE FROM log_positions
             WHERE at_ms < ?1
               AND NOT EXISTS (
                   SELECT 1 FROM captures
                   WHERE captures.captured_at
                         BETWEEN (log_positions.at_ms - ?2) / 1000 - 1
                             AND (log_positions.at_ms + ?2) / 1000 + 1
               )",
            params![cutoff_ms, placement::KEEP_MS],
        )
        .map_err(|error| error.to_string())
}

/// Reads what is new in every combat log this install has, and files what it finds.
///
/// Oldest first, on a shared byte budget, so that a backlog is worked through in the order it
/// was written and no single sync disappears into it.
///
/// A file that cannot be read is skipped rather than fatal, and the next sync tries again: a
/// log can be deleted between the folder being listed and the file being opened, and a night
/// of segments is worth more than refusing them all over one file that went away. A database
/// error is a different thing and is passed up.
pub(super) fn ingest_logs(connection: &mut Connection, wow_path: &Path, now: i64) -> Result<(), String> {
    let mut budget = LOG_BYTES_PER_SYNC;
    let mut anything = false;
    for found in combatlog::logs(wow_path) {
        if budget == 0 {
            break;
        }
        let (_, resume) = log_resume(connection, &found.file.name)?;
        let mut reader = logfile::Reader::new(combatlog::year_of(&found), logfile::Zone::Local);
        reader.budget = budget;
        let Ok(reading) = reader.read(&found.path, &resume) else {
            continue;
        };
        budget = budget.saturating_sub(reading.consumed);
        anything = true;

        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        let log_id = upsert_log(&transaction, &found.file.name, &reading, now)?;
        for bounds in &reading.facts.maps {
            insert_map(&transaction, log_id, bounds)?;
        }
        for point in &reading.facts.positions {
            insert_position(&transaction, log_id, point)?;
        }
        for fight in &reading.facts.fights {
            if let Some(row) = store_fight(&transaction, log_id, fight, now)? {
                insert_combatants(&transaction, row, fight)?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())?;
    }
    if anything {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        place_log_facts(&transaction)?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/* ---------- clearing up after the client ---------- */

/// How far reading got into every log Chronie has a row for, keyed on the name the folder uses.
///
/// This is the whole of what the retention rule is allowed to believe about what has been
/// ingested. It comes off the same row the incremental reader keeps its cursor on, so "read to
/// the end" here and "read to the end" there cannot drift apart into two different claims.
fn log_cursors(connection: &Connection) -> Result<HashMap<String, retention::Cursor>, String> {
    let mut statement = connection
        .prepare("SELECT name, byte_offset, byte_size, lines_read FROM combat_logs")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                retention::Cursor {
                    offset: row.get::<_, i64>(1)?.max(0) as u64,
                    size: row.get::<_, i64>(2)?.max(0) as u64,
                    lines: row.get(3)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut cursors = HashMap::new();
    for row in rows {
        let (name, cursor) = row.map_err(|error| error.to_string())?;
        cursors.insert(name, cursor);
    }
    Ok(cursors)
}

/// Deletes the logs the rule says may go, and writes down every one that went.
///
/// Called after [`ingest_logs`] and never before it, which is the ordering the whole feature
/// rests on: a log becomes deletable by being read, so the read that makes this pass's decisions
/// is the one that just happened rather than the one from thirty seconds ago.
///
/// The record is committed for each file as soon as its unlink returns, rather than once at the
/// end. A crash halfway through a sweep then leaves a folder missing three files and a ledger
/// naming three files, instead of a folder missing three and a ledger naming none.
///
/// A file that will not delete — held open by the client, read-only, gone already — is left
/// alone and tried again on the next sweep. Nothing else in the folder is punished for it.
pub(super) fn sweep_logs(
    connection: &mut Connection,
    wow_path: &Path,
    retain_days: u32,
    now: i64,
) -> Result<(), String> {
    let cursors = log_cursors(connection)?;
    let plan = retention::plan(&combatlog::logs(wow_path), &cursors, retain_days, now);
    for found in &plan.doomed {
        if fs::remove_file(&found.path).is_err() {
            continue;
        }
        let lines = cursors
            .get(&found.file.name)
            .map(|cursor| cursor.lines)
            .unwrap_or_default();
        connection
            .execute(
                "INSERT INTO log_deletions (
                     name, bytes, modified_at, lines_read, retain_days, deleted_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    found.file.name,
                    found.file.bytes as i64,
                    found.file.modified,
                    lines,
                    retain_days,
                    now,
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// What a sweep would do to this install right now, what it will not touch, and what it has
/// already done.
///
/// Computed whether or not the sweeper is switched on, because the question worth answering
/// before somebody turns it on is which files that would cost them — and the only honest answer
/// names them. `retain_days` is `None` when the setting is off, and the preview is then taken at
/// the default window.
pub fn retention_report(
    database_path: &Path,
    wow_path: Option<&Path>,
    retain_days: Option<u32>,
    now: i64,
) -> Result<retention::Report, String> {
    let days = retain_days.unwrap_or(retention::DEFAULT_RETAIN_DAYS);
    let connection = open_database(database_path)?;
    let logs = wow_path.map(combatlog::logs).unwrap_or_default();
    let plan = retention::plan(&logs, &log_cursors(&connection)?, days, now);
    let mut report = retention::Report::of(&plan, retain_days.is_some(), days);
    let mut statement = connection
        .prepare(
            "SELECT name, bytes, modified_at, lines_read, retain_days, deleted_at
             FROM log_deletions ORDER BY deleted_at DESC, id DESC LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([retention::SHOWN as i64], |row| {
            Ok(retention::Gone {
                name: row.get(0)?,
                bytes: row.get::<_, i64>(1)?.max(0) as u64,
                modified: row.get(2)?,
                lines_read: row.get(3)?,
                retain_days: row.get::<_, i64>(4)?.max(0) as u32,
                deleted_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        report.removed.push(row.map_err(|error| error.to_string())?);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::database::MIGRATIONS;
    use crate::collector::testing::*;
    use crate::collector::{collect, Options};

    use serde_json::json;
    use std::fs;

    fn rows_of<T: rusqlite::types::FromSql>(database: &Path, query: &str) -> Vec<T> {
        let connection = open_database(database).unwrap();
        let mut statement = connection.prepare(query).unwrap();
        let found: Vec<T> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        found
    }

    #[test]
    fn reads_a_raid_night_out_of_the_game_s_log_folder() {
        let install = Install::of(&SavedVariables::new().segments(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        )));
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(
            &install.wow,
            &install.database,
            raid_night_sync(),
            Options::default(),
        )
        .unwrap();

        assert_eq!(count_of(&install.database, "log_positions"), 6);
        assert_eq!(count_of(&install.database, "log_maps"), 1);
        assert_eq!(count_of(&install.database, "log_fights"), 2);
        // Three at the first pull and two at the second.
        assert_eq!(count_of(&install.database, "log_combatants"), 5);
        let connection = open_database(&install.database).unwrap();
        let (offset, size, advanced, lines): (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT byte_offset, byte_size, advanced, lines_read FROM combat_logs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(offset, size, "the whole file should have been read");
        assert_eq!(advanced, 1);
        assert_eq!(lines, 28);
    }

    /// What the whole thing is for: a position inside an instance, placed on the map and filed
    /// against the visit it happened during.
    #[test]
    fn attaches_the_track_and_the_fights_to_the_visit_they_happened_during() {
        let install = Install::of(&SavedVariables::new().segments(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        )));
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(
            &install.wow,
            &install.database,
            raid_night_sync(),
            Options::default(),
        )
        .unwrap();

        let connection = open_database(&install.database).unwrap();
        let segment: i64 = connection
            .query_row(
                "SELECT id FROM segments WHERE source_id = 'night-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            rows_of::<i64>(&install.database, "SELECT segment_id FROM log_positions"),
            vec![segment; 6]
        );
        assert_eq!(
            rows_of::<i64>(&install.database, "SELECT segment_id FROM log_fights"),
            vec![segment; 2]
        );
        let (x, y, map): (f64, f64, i64) = connection
            .query_row(
                "SELECT map_x, map_y, ui_map_id FROM log_positions ORDER BY at_ms LIMIT 1 OFFSET 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((x, y, map), (0.5, 0.25, 2232));
    }

    /// The fights themselves, with the boundaries the game stated rather than the ones the
    /// addon inferred, and the gear everybody had on at the pull.
    #[test]
    fn keeps_the_boundaries_and_the_gear_the_log_alone_knows() {
        let install = Install::of(&SavedVariables::new().segments(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        )));
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");

        install.collect(2_000_000_100);

        let connection = open_database(&install.database).unwrap();
        let mut statement = connection
            .prepare(
                "SELECT kind, encounter_id, name, started_at, ended_at, success, duration_ms
                 FROM log_fights ORDER BY started_at",
            )
            .unwrap();
        let fights: Vec<(String, i64, String, i64, i64, i64, i64)> = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            fights,
            [
                (
                    "encounter".to_string(),
                    2820,
                    "Gnarlroot".to_string(),
                    raid_second(20, 16, 0) * 1000,
                    raid_second(20, 16, 30) * 1000,
                    0,
                    1_800_000,
                ),
                (
                    "encounter".to_string(),
                    2820,
                    "Gnarlroot".to_string(),
                    raid_second(20, 20, 0) * 1000,
                    raid_second(20, 24, 0) * 1000,
                    1,
                    240_000,
                ),
            ]
        );
        let equipment: String = connection
            .query_row(
                "SELECT equipment_json FROM log_combatants
                 WHERE guid = 'Player-3676-0A1B2C3D' ORDER BY id LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let worn: Value = serde_json::from_str(&equipment).unwrap();
        assert_eq!(worn[0]["itemId"], 207198);
        assert_eq!(worn[0]["itemLevel"], 486);
        assert_eq!(worn[1]["bonusIds"], json!([8836, 8840]));
    }

    /// Every position carries the name the client wrote beside it, which is what lets a point
    /// go to the character who was standing there rather than merely to the right half hour.
    #[test]
    fn gives_a_point_to_the_character_the_log_named() {
        let bystander = night_segment(
            "bystander",
            "Ruvenne-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        );
        let played = night_segment(
            "played",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        );
        let install =
            Install::of(&SavedVariables::new().segments(&format!("{bystander}, {played}")));
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(
            &install.wow,
            &install.database,
            raid_night_sync(),
            Options::default(),
        )
        .unwrap();

        let placed = rows_of::<String>(
            &install.database,
            "SELECT DISTINCT s.source_id FROM log_positions p JOIN segments s ON s.id = p.segment_id",
        );
        assert_eq!(placed, ["played"]);
    }

    /// The log is read on every sync and the file has not changed. Reading it again must cost
    /// nothing and must not double anything.
    #[test]
    fn does_not_read_a_log_it_has_already_read() {
        let install = Install::of(&SavedVariables::new().segments(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        )));
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");
        collect(
            &install.wow,
            &install.database,
            raid_night_sync(),
            Options::default(),
        )
        .unwrap();

        collect(
            &install.wow,
            &install.database,
            raid_night_sync() + 100,
            Options::default(),
        )
        .unwrap();

        assert_eq!(count_of(&install.database, "log_positions"), 6);
        assert_eq!(count_of(&install.database, "log_fights"), 2);
        assert_eq!(count_of(&install.database, "log_combatants"), 5);
        let lines: i64 = open_database(&install.database)
            .unwrap()
            .query_row("SELECT lines_read FROM combat_logs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(lines, 28, "the file was read a second time");
    }

    /// The ordinary case while somebody is playing: the file grows between two syncs, and the
    /// line it was halfway through writing at the first one is whole by the second.
    #[test]
    fn reads_only_what_was_added_to_a_log_that_grew() {
        let install = Install::of(&SavedVariables::new().segments(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            1_714_600_000,
            1_714_610_000,
        )));
        install.plant_log("partial-tail.txt", "WoWCombatLog-050124_221000.txt");
        install.collect(1_714_610_100);
        assert_eq!(
            count_of(&install.database, "log_fights"),
            0,
            "a half-written line was read"
        );

        install.plant_log(
            "partial-tail-complete.txt",
            "WoWCombatLog-050124_221000.txt",
        );
        install.collect(1_714_610_200);

        assert_eq!(count_of(&install.database, "log_fights"), 1);
        assert_eq!(count_of(&install.database, "log_positions"), 1);
        let (lines, restarts): (i64, i64) = open_database(&install.database)
            .unwrap()
            .query_row("SELECT lines_read, restarts FROM combat_logs", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(lines, 5, "the first two lines were read twice");
        assert_eq!(restarts, 0);
    }

    /// Rotation: the name comes back attached to a different file. The cursor has to notice
    /// rather than resume into the middle of a record it has never seen — and the night the
    /// old log recorded is still a night that happened, so its rows stay.
    #[test]
    fn notices_a_rotated_log_and_keeps_what_the_old_one_said() {
        let install = Install::of(&SavedVariables::new().segments(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            1_718_200_000,
            1_718_300_000,
        )));
        install.plant_log("rotated-before.txt", "WoWCombatLog.txt");
        install.collect(1_718_300_100);
        assert_eq!(count_of(&install.database, "log_fights"), 1);

        install.plant_log("rotated-after.txt", "WoWCombatLog.txt");
        install.collect(1_718_300_200);

        let (restarts, lines): (i64, i64) = open_database(&install.database)
            .unwrap()
            .query_row("SELECT restarts, lines_read FROM combat_logs", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(restarts, 1);
        assert_eq!(
            lines, 7,
            "the restart should count the new file's lines only"
        );
        let names = rows_of::<String>(
            &install.database,
            "SELECT DISTINCT name FROM log_fights ORDER BY name",
        );
        assert_eq!(names, ["Fyrakk the Blazing", "Gnarlroot"]);
    }

    /// A log rotated more than once. The tally of restarts is a count and not a flag, and the
    /// line count it resets has to be reset by the second rotation exactly as by the first —
    /// otherwise the number quietly becomes the sum of two files that never coexisted.
    #[test]
    fn counts_every_rotation_rather_than_the_first_one() {
        let install = Install::of(&SavedVariables::new().segments(""));
        install.plant_log("rotated-before.txt", "WoWCombatLog.txt");
        install.collect(1_718_300_100);
        install.plant_log("rotated-after.txt", "WoWCombatLog.txt");
        install.collect(1_718_300_200);
        install.plant_log("raid-night.txt", "WoWCombatLog.txt");

        install.collect(1_718_300_300);

        let (restarts, lines): (i64, i64) = open_database(&install.database)
            .unwrap()
            .query_row("SELECT restarts, lines_read FROM combat_logs", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(restarts, 2);
        assert_eq!(
            lines, 28,
            "the tally carried lines from a file that is gone"
        );
    }

    /// A log with advanced logging off carries no positions and no map bounds, and every other
    /// thing in it is still worth having. What it must not do is fail.
    #[test]
    fn stores_a_log_written_without_advanced_logging_for_what_it_does_carry() {
        let install = Install::of(&SavedVariables::new().segments(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            1_700_600_000,
            1_700_610_000,
        )));
        install.plant_log("advanced-off.txt", "WoWCombatLog-112123_210300.txt");

        install.collect(1_700_610_100);

        assert_eq!(count_of(&install.database, "log_positions"), 0);
        assert_eq!(count_of(&install.database, "log_maps"), 0);
        assert_eq!(count_of(&install.database, "log_fights"), 1);
        let advanced: i64 = open_database(&install.database)
            .unwrap()
            .query_row("SELECT advanced FROM combat_logs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(advanced, 0);
    }

    /// A night is several files, because the client splits a log per session. All of them get
    /// read, each with its own cursor.
    #[test]
    fn reads_every_log_in_the_folder_and_keeps_a_cursor_for_each() {
        let install = Install::of(&SavedVariables::new().segments(RAID_SEGMENT));
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");
        install.plant_log("mythic-plus.txt", "WoWCombatLog-120223_190000.txt");
        install.plant_log("advanced-off.txt", "WoWCombatLog-112123_210300.txt");
        // Everything else in the folder is not a combat log and is not to be touched.
        fs::write(
            install.wow.join("Logs/Client.log"),
            b"not a combat log at all",
        )
        .unwrap();

        install.collect(2_000_000_100);

        assert_eq!(count_of(&install.database, "combat_logs"), 3);
        let kinds = rows_of::<String>(
            &install.database,
            "SELECT kind FROM log_fights ORDER BY kind, started_at",
        );
        assert_eq!(
            kinds,
            [
                "encounter",
                "encounter",
                "encounter",
                "encounter",
                "keystone"
            ]
        );
        assert!(
            open_database(&install.database)
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM combat_logs WHERE byte_offset < byte_size",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap()
                == 0
        );
    }

    /// A capture, a lockout, an equipment set and now a combat log all arrive through the same
    /// sync. A database written before this shape existed has to grow into it without being
    /// rebuilt, and without losing what it already held.
    #[test]
    fn migrates_a_database_written_before_combat_logs_were_read() {
        let install = Install::of(&SavedVariables::new().segments(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        )));
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");
        {
            fs::create_dir_all(install.database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&install.database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..7] {
                transaction.execute_batch(migration.sql).unwrap();
            }
            transaction
                .pragma_update(None, "user_version", 7_i64)
                .unwrap();
            transaction.commit().unwrap();
        }

        collect(
            &install.wow,
            &install.database,
            raid_night_sync(),
            Options::default(),
        )
        .unwrap();

        assert_eq!(count_of(&install.database, "log_positions"), 6);
        assert_eq!(count_of(&install.database, "segments"), 1);
    }

    /// A log read before the visit it belongs to has been filed is the ordinary case, not the
    /// exception: the client writes SavedVariables at logout and the log while playing. The
    /// points wait, and the sync that finally sees the segment attaches them.
    #[test]
    fn attaches_a_track_to_a_visit_that_is_filed_after_it() {
        let install = Install::of(&SavedVariables::new().segments(""));
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");
        collect(
            &install.wow,
            &install.database,
            raid_night_sync(),
            Options::default(),
        )
        .unwrap();
        assert_eq!(count_of(&install.database, "log_positions"), 6);
        assert_eq!(
            rows_of::<Option<i64>>(&install.database, "SELECT segment_id FROM log_positions"),
            vec![None; 6]
        );

        install.rewrite(&SavedVariables::new().segments(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        )));
        collect(
            &install.wow,
            &install.database,
            raid_night_sync() + 100,
            Options::default(),
        )
        .unwrap();

        assert!(
            rows_of::<Option<i64>>(&install.database, "SELECT segment_id FROM log_positions")
                .iter()
                .all(Option::is_some)
        );
    }

    /// A pull that straddles two visits goes to the one it spent longer inside, which is the
    /// only answer that does not need a tie-break rule picked out of the air.
    #[test]
    fn gives_a_fight_to_the_visit_it_spent_longest_inside() {
        let early = night_segment(
            "early",
            "Alyndra-Ravencrest",
            raid_second(20, 0, 0),
            raid_second(20, 16, 10),
        );
        let late = night_segment(
            "late",
            "Alyndra-Ravencrest",
            raid_second(20, 16, 11),
            raid_second(20, 30, 0),
        );
        let install = Install::of(&SavedVariables::new().segments(&format!("{early}, {late}")));
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");

        install.collect(2_000_000_100);

        // The first pull runs 20:16:00 to 20:16:30: ten seconds in `early`, nineteen in `late`.
        let placed = rows_of::<String>(
            &install.database,
            "SELECT s.source_id FROM log_fights f JOIN segments s ON s.id = f.segment_id
             ORDER BY f.started_at",
        );
        assert_eq!(placed, ["late", "late"]);
    }

    /// A database holding one log's worth of track and whatever captures a test wants to remember
    /// moments with, built row by row rather than read out of a fixture — the sweep is a rule
    /// about times, and a file would only be a slower way of stating them.
    ///
    /// `points` are epoch seconds; `captures` likewise. Everything else is the least a row needs
    /// to satisfy the schema.
    fn track_database(points: &[i64], captures: &[i64]) -> (Install, Connection) {
        let install = Install::empty();
        let connection = install.open();
        connection
            .execute(
                "INSERT INTO combat_logs (id, name, first_seen_at, last_seen_at)
                 VALUES (1, 'WoWCombatLog-111423_201500.txt', 0, 0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO accounts (id, source_key, first_seen_at, last_seen_at)
                 VALUES (1, 'TEST', 0, 0)",
                [],
            )
            .unwrap();
        for (index, at) in points.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO log_positions (
                         log_id, at_ms, actor_guid, actor_name, ui_map_id, world_x, world_y,
                         map_x, map_y
                     ) VALUES (1, ?1, 'Player-1', 'Alyndra', 2232, 0, 0, ?2, ?2)",
                    params![at * 1000, index as f64 / 100.0],
                )
                .unwrap();
        }
        for (index, at) in captures.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO captures (
                         account_id, source_id, captured_at, image_state, first_seen_at,
                         last_seen_at
                     ) VALUES (1, ?1, ?2, 'none', 0, 0)",
                    params![format!("TEST|{index}"), at],
                )
                .unwrap();
        }
        (install, connection)
    }

    /// Epoch seconds a whole retention window ago, which is where every point in these tests that
    /// is meant to be old sits.
    const LONG_AGO: i64 = SWEEP_NOW - 30 * DAY_SECONDS;

    fn remaining(connection: &Connection) -> Vec<i64> {
        let mut statement = connection
            .prepare("SELECT at_ms / 1000 FROM log_positions ORDER BY at_ms")
            .unwrap();
        let found = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        found
    }

    /// The table with no reader, finally getting one. A month-old track that nothing was taken
    /// during is every row the sweep exists for.
    #[test]
    fn deletes_old_points_no_capture_remembered() {
        let (_install, connection) = track_database(&[LONG_AGO, LONG_AGO + 5, LONG_AGO + 10], &[]);

        let removed = compact_positions(&connection, 7, SWEEP_NOW).unwrap();

        assert_eq!(removed, 3);
        assert_eq!(remaining(&connection), [] as [i64; 0]);
    }

    /// The other half of the rule, and the reason it is a window rather than the rows the
    /// placement happened to read: a capture keeps the whole minute or two around it, so a later
    /// placement rule — one that interpolates, or reaches further — still has something to be
    /// written against.
    #[test]
    fn keeps_the_track_around_a_remembered_moment() {
        let (_install, connection) = track_database(
            &[LONG_AGO, LONG_AGO + 60, LONG_AGO + 100, LONG_AGO + 400],
            &[LONG_AGO + 60],
        );

        compact_positions(&connection, 7, SWEEP_NOW).unwrap();

        // Everything within two minutes of the capture, and nothing else — the point five
        // minutes later goes even though it belongs to the same night.
        assert_eq!(
            remaining(&connection),
            [LONG_AGO, LONG_AGO + 60, LONG_AGO + 100]
        );
    }

    /// A capture that the placement rule refused anchors a window exactly as one it placed does.
    /// It is the capture most likely to be wanted by a future rule, and sweeping the points around
    /// it would settle that question permanently in favour of the rule written today.
    #[test]
    fn keeps_the_track_around_a_capture_it_could_not_place() {
        // Two moments ten minutes apart, so neither window can be mistaken for the other's, and a
        // point beside each.
        let (_install, connection) = track_database(
            &[LONG_AGO, LONG_AGO + 600, LONG_AGO + 1_200],
            &[LONG_AGO, LONG_AGO + 600],
        );
        connection
            .execute(
                "UPDATE captures SET map_x = 0.5, map_y = 0.5 WHERE captured_at = ?1",
                [LONG_AGO],
            )
            .unwrap();

        compact_positions(&connection, 7, SWEEP_NOW).unwrap();

        assert_eq!(
            remaining(&connection),
            [LONG_AGO, LONG_AGO + 600],
            "the unplaced capture held its window exactly as the placed one did"
        );
    }

    /// Nothing recent is touched, whether or not anything was taken during it. A point is
    /// compacted because it is final, and a point from this week is not final: the capture that
    /// would claim it may not have been written yet, the client writing that at logout.
    #[test]
    fn keeps_every_point_still_inside_the_window() {
        let recent = SWEEP_NOW - 3_600;
        let (_install, connection) = track_database(&[recent, recent + 5], &[]);

        let removed = compact_positions(&connection, 7, SWEEP_NOW).unwrap();

        assert_eq!(removed, 0);
        assert_eq!(remaining(&connection), [recent, recent + 5]);
    }

    /// The window is the one the logs are swept on, and a longer one keeps more — the setting
    /// being a single number is the whole reason there is nothing else to explain here.
    #[test]
    fn compacts_on_the_window_the_logs_are_swept_on() {
        let (_install, connection) = track_database(&[SWEEP_NOW - 10 * DAY_SECONDS], &[]);

        assert_eq!(compact_positions(&connection, 30, SWEEP_NOW).unwrap(), 0);
        assert_eq!(compact_positions(&connection, 7, SWEEP_NOW).unwrap(), 1);
    }

    /// A sync on an install that has never turned the log sweeper on still compacts. Keeping the
    /// player's own logs for ever is a decision about their files; it is not a request for a table
    /// Chronie derived from them that never stops growing.
    #[test]
    fn compacts_the_track_even_when_no_log_is_ever_deleted() {
        let install = swept_install();

        install.collect(SWEEP_NOW);

        assert!(
            install.has_log("WoWCombatLog-111423_201500.txt"),
            "no log was swept"
        );
        assert_eq!(count_of(&install.database, "log_positions"), 0);
    }

    /* ---------- clearing the logs up again ---------- */

    /// When the sweep runs, in the same epoch seconds every other test in here uses.
    const SWEEP_NOW: i64 = 2_000_000_100;

    /// A folder with an old log, a slightly less old one, and a current one, all read.
    fn swept_install() -> Install {
        let install = Install::of(&SavedVariables::new().segments(RAID_SEGMENT));
        install.plant_log("raid-night.txt", "WoWCombatLog-111423_201500.txt");
        install.plant_log("mythic-plus.txt", "WoWCombatLog-120223_190000.txt");
        install.plant_log("advanced-off.txt", "WoWCombatLog-112123_210300.txt");
        install.backdate(
            "WoWCombatLog-111423_201500.txt",
            SWEEP_NOW - 30 * DAY_SECONDS,
        );
        install.backdate(
            "WoWCombatLog-112123_210300.txt",
            SWEEP_NOW - 20 * DAY_SECONDS,
        );
        install.backdate("WoWCombatLog-120223_190000.txt", SWEEP_NOW - 3_600);
        install
    }

    /// The ordinary case, through the sync that does it: two logs read to their end weeks ago
    /// go, the one the client is writing stays, and the going is written down.
    #[test]
    fn deletes_the_old_logs_it_has_read_and_records_every_one() {
        let install = swept_install();

        install.collect_with(
            Options {
                retain_log_days: Some(7),
                ..Options::default()
            },
            SWEEP_NOW,
        );

        assert!(!install.has_log("WoWCombatLog-111423_201500.txt"));
        assert!(!install.has_log("WoWCombatLog-112123_210300.txt"));
        assert!(
            install.has_log("WoWCombatLog-120223_190000.txt"),
            "the active log"
        );
        let deleted = rows_of::<String>(
            &install.database,
            "SELECT name FROM log_deletions ORDER BY name",
        );
        assert_eq!(
            deleted,
            [
                "WoWCombatLog-111423_201500.txt",
                "WoWCombatLog-112123_210300.txt"
            ]
        );
        let (bytes, lines, days, at): (i64, i64, i64, i64) = open_database(&install.database)
            .unwrap()
            .query_row(
                "SELECT bytes, lines_read, retain_days, deleted_at FROM log_deletions
                 WHERE name = 'WoWCombatLog-111423_201500.txt'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert!(bytes > 0, "the record has to say what was lost");
        assert_eq!(lines, 28, "and that it had been read");
        assert_eq!(days, 7);
        assert_eq!(at, SWEEP_NOW);
    }

    /// The file is the source, and what was carried out of it is not. A deleted log leaves its
    /// fights and its cursor exactly where they were — the night happened whether or not the
    /// bytes that recorded it still exist.
    ///
    /// The track is the one thing that does not survive it, and deliberately: a log old enough to
    /// be swept is old enough that the points under it are final, and the ones no capture asked
    /// about are what `compact_positions` exists to remove. What it leaves is covered by its own
    /// tests below.
    #[test]
    fn keeps_everything_it_learned_from_a_log_it_deleted() {
        let install = swept_install();

        install.collect_with(
            Options {
                retain_log_days: Some(7),
                ..Options::default()
            },
            SWEEP_NOW,
        );

        // The cursor row survives the file, and so does everything hanging off it — which is
        // the whole reason the sweeper does not delete that row along with the bytes.
        assert_eq!(count_of(&install.database, "combat_logs"), 3);
        let (positions, fights): (i64, i64) = open_database(&install.database)
            .unwrap()
            .query_row(
                "SELECT
                     (SELECT COUNT(*) FROM log_positions WHERE log_id = logs.id),
                     (SELECT COUNT(*) FROM log_fights WHERE log_id = logs.id)
                 FROM combat_logs logs WHERE name = 'WoWCombatLog-111423_201500.txt'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            positions, 0,
            "a month-old track nothing remembered was compacted"
        );
        assert_eq!(fights, 2, "the fights read out of a log that is now gone");
    }

    /// Off is off. The same folder, the same ages, and nothing is touched.
    #[test]
    fn deletes_nothing_at_all_until_somebody_turns_it_on() {
        let install = swept_install();

        install.collect(SWEEP_NOW);

        assert!(install.has_log("WoWCombatLog-111423_201500.txt"));
        assert!(install.has_log("WoWCombatLog-112123_210300.txt"));
        assert_eq!(count_of(&install.database, "log_deletions"), 0);
    }

    /// The case the whole feature is built around. Three weeks of logs somebody wrote before
    /// Chronie could read one: old enough by any window, and read by nothing. A sweeper that
    /// went by age would take all of them, permanently, and nobody would find out until they
    /// went looking for a raid night that no longer exists.
    #[test]
    fn never_deletes_an_old_log_that_was_never_ingested() {
        let install = swept_install();
        let mut connection = open_database(&install.database).unwrap();

        sweep_logs(&mut connection, &install.wow, 7, SWEEP_NOW).unwrap();

        assert!(install.has_log("WoWCombatLog-111423_201500.txt"));
        assert!(install.has_log("WoWCombatLog-112123_210300.txt"));
        assert!(install.has_log("WoWCombatLog-120223_190000.txt"));
        assert_eq!(count_of(&install.database, "log_deletions"), 0);
    }

    /// And it says so. An un-ingested pile is surfaced rather than swept or hidden, because it
    /// is somebody's decision to make and they cannot make it without being told.
    #[test]
    fn surfaces_the_old_logs_it_will_not_touch() {
        let install = swept_install();

        let report =
            retention_report(&install.database, Some(&install.wow), None, SWEEP_NOW).unwrap();

        assert!(
            !report.enabled,
            "off, and previewing what turning it on would do"
        );
        assert_eq!(report.days, retention::DEFAULT_RETAIN_DAYS);
        assert_eq!(report.doomed.count, 0);
        assert_eq!(report.unread.count, 2);
        assert_eq!(
            report
                .unread
                .files
                .iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>(),
            [
                "WoWCombatLog-111423_201500.txt",
                "WoWCombatLog-112123_210300.txt"
            ]
        );
    }

    /// Once they have been read the same two files move to the other pile, and the report is
    /// what a reader is shown before the switch is thrown.
    #[test]
    fn previews_what_a_sweep_would_delete_before_it_is_switched_on() {
        let install = swept_install();
        install.collect(SWEEP_NOW);

        let report =
            retention_report(&install.database, Some(&install.wow), None, SWEEP_NOW).unwrap();

        assert_eq!(report.doomed.count, 2);
        assert!(report.doomed.bytes > 0);
        assert_eq!(report.unread.count, 0);
    }

    /// The ledger is what the report shows afterwards, so "Chronie deleted my logs" has an
    /// answer sitting on the screen that did it.
    #[test]
    fn reports_what_it_has_already_deleted() {
        let install = swept_install();
        install.collect_with(
            Options {
                retain_log_days: Some(7),
                ..Options::default()
            },
            SWEEP_NOW,
        );

        let report =
            retention_report(&install.database, Some(&install.wow), Some(7), SWEEP_NOW).unwrap();

        assert!(report.enabled);
        assert_eq!(report.removed.len(), 2);
        assert_eq!(report.doomed.count, 0, "there is nothing left to take");
        assert_eq!(report.removed[0].retain_days, 7);
        assert_eq!(report.removed[0].deleted_at, SWEEP_NOW);
    }

    /// Before a game folder has been chosen there is no folder to look in, and the honest
    /// report is an empty one rather than a failure.
    #[test]
    fn reports_nothing_when_there_is_no_install_to_look_at() {
        let install = swept_install();

        let report = retention_report(&install.database, None, None, SWEEP_NOW).unwrap();

        assert_eq!(report.doomed.count, 0);
        assert_eq!(report.unread.count, 0);
        assert!(report.removed.is_empty());
    }
}
