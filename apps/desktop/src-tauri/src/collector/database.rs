//! The file everything else is written into.
//!
//! Opening a database is never only opening it: the connection is put into the mode the rest
//! of the app assumes, and the schema is brought up to date before anything is allowed to
//! read a table. The migrations themselves are the timestamped files under `migrations/`,
//! embedded by `build.rs` — a feature adds one file and this module runs whatever it finds.
//!
//! The other half is a database as a thing somebody carries between machines: summarising one
//! without touching it, copying a live one consistently, and putting an arriving one in place
//! of the app's own.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone, Copy)]
pub(super) struct Migration {
    pub(super) name: &'static str,
    pub(super) sql: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

pub(super) fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(|error| error.to_string())?;
    migrate(&mut connection)?;
    Ok(connection)
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "Database schema version {version} is newer than this app supports."
        ));
    }

    // Before timestamped names, `user_version = N` meant the first N migrations in the
    // numbered list had run. Seed those names once, inside the same database, so an existing
    // install crosses to per-file history without executing any schema change twice.
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS chronie_migrations (
                 name TEXT PRIMARY KEY NOT NULL
             );",
        )
        .map_err(|error| error.to_string())?;
    let mut applied = {
        let mut statement = transaction
            .prepare("SELECT name FROM chronie_migrations")
            .map_err(|error| error.to_string())?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|error| error.to_string())?;
        names
    };
    if applied.is_empty() && version > 0 {
        for migration in MIGRATIONS.iter().take(version as usize) {
            transaction
                .execute(
                    "INSERT INTO chronie_migrations (name) VALUES (?1)",
                    [migration.name],
                )
                .map_err(|error| error.to_string())?;
            applied.insert(migration.name.to_string());
        }
    }
    let known = MIGRATIONS
        .iter()
        .map(|migration| migration.name)
        .collect::<HashSet<_>>();
    if let Some(name) = applied.iter().find(|name| !known.contains(name.as_str())) {
        return Err(format!(
            "Database migration {name} is newer than this app supports."
        ));
    }
    transaction.commit().map_err(|error| error.to_string())?;

    let mut applied_count = applied.len() as i64;
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| !applied.contains(migration.name))
    {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(migration.sql)
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO chronie_migrations (name) VALUES (?1)",
                [migration.name],
            )
            .map_err(|error| error.to_string())?;
        applied_count += 1;
        transaction
            .pragma_update(None, "user_version", applied_count)
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn initialize(database_path: &Path) -> Result<(), String> {
    open_database(database_path).map(|_| ())
}

/// What a database holds, in the terms somebody deciding what to do with it would use.
///
/// This is what travels ahead of a database being handed to another machine: the receiver is
/// about to lose everything it has, and "1,204 segments up to the 26th" is the only thing
/// that tells them whether that is the trade they meant to make.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub segment_count: i64,
    pub character_count: i64,
    /// The last day anything was recorded on. `None` for a database holding no segments.
    pub newest_day: Option<String>,
}

/// A file beside `path` with `suffix` appended to its whole name — how SQLite names the
/// write-ahead log and shared-memory files that belong to a database.
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Writes a self-contained copy of a live database to `destination`.
///
/// Not a file copy: the database runs in WAL mode, so the bytes on disk are only half the
/// story until the log is folded back in, and copying the three files separately at three
/// different moments is how a torn database is made. `VACUUM INTO` asks SQLite for a
/// consistent snapshot of the whole thing as one plain file, which is both the correct copy
/// and the compact one — no free pages and no log to carry.
pub fn snapshot(database_path: &Path, destination: &Path) -> Result<(), String> {
    let target = destination
        .to_str()
        .ok_or("The snapshot's path is not text SQLite can be given.")?;
    // SQLite refuses to write over an existing file, which is the right rule and the wrong
    // one for a scratch file the caller has already made.
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| error.to_string())?;
    }
    let connection = open_database(database_path)?;
    connection
        .execute("VACUUM INTO ?1", params![target])
        .map(|_| ())
        .map_err(|error| format!("Could not copy the database: {error}"))
}

fn unknown_migration(connection: &Connection) -> Result<Option<String>, rusqlite::Error> {
    let has_history: bool = connection.query_row(
        "SELECT EXISTS (
             SELECT 1 FROM sqlite_schema
             WHERE type = 'table' AND name = 'chronie_migrations'
         )",
        [],
        |row| row.get(0),
    )?;
    if !has_history {
        return Ok(None);
    }

    let known = MIGRATIONS
        .iter()
        .map(|migration| migration.name)
        .collect::<HashSet<_>>();
    let mut statement = connection.prepare("SELECT name FROM chronie_migrations ORDER BY name")?;
    let names = statement.query_map([], |row| row.get::<_, String>(0))?;
    for name in names {
        let name = name?;
        if !known.contains(name.as_str()) {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// Reads a database file without touching it, and refuses anything that is not one of ours.
///
/// Deliberately not [`open_database`]: this is the gate a database arriving from another
/// machine has to pass, and opening it the ordinary way would migrate it — writing to a file
/// that has not yet earned the right to replace anything. A schema newer than this build
/// understands is refused here rather than half-read later.
pub fn summarize(database_path: &Path) -> Result<Summary, String> {
    let connection = Connection::open_with_flags(
        database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|error| format!("Could not open the database: {error}"))?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| "That file is not a Chronie database.".to_string())?;
    if version == 0 {
        return Err("That file is not a Chronie database.".into());
    }
    if version > SCHEMA_VERSION {
        return Err(format!(
            "That database was written by a newer Chronie (schema {version}, this build reads {SCHEMA_VERSION}). Update this Chronie first."
        ));
    }
    if let Some(name) = unknown_migration(&connection)
        .map_err(|_| "That file is not a Chronie database.".to_string())?
    {
        return Err(format!(
            "That database was written by a newer Chronie (migration {name} is unknown to this build). Update this Chronie first."
        ));
    }
    let counts = connection
        .query_row(
            "SELECT
                 (SELECT COUNT(*) FROM segments),
                 (SELECT COUNT(*) FROM characters),
                 (SELECT MAX(ended_day) FROM segments)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "That database has no Chronie history in it.".to_string())?;
    Ok(Summary {
        segment_count: counts.0,
        character_count: counts.1,
        newest_day: counts.2,
    })
}

/// Puts `incoming` in place of the app's database, keeping the old one beside it.
///
/// The replacement is judged before anything is moved, so a file that turns out not to be a
/// database leaves the existing history exactly where it was. What is displaced is not
/// deleted either: it is checkpointed so the file stands on its own, then renamed aside as
/// `chronie.replaced.sqlite3`, which is what somebody who accepted the wrong transfer needs.
/// The stale log beside it goes, though — leaving one would have SQLite replay another
/// database's writes onto this one.
pub fn install_database(incoming: &Path, database_path: &Path) -> Result<Summary, String> {
    let summary = summarize(incoming)?;
    if let Some(parent) = database_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let replaced = database_path.with_extension("replaced.sqlite3");
    if database_path.is_file() {
        if let Ok(connection) = Connection::open(database_path) {
            let _ = connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        }
        if replaced.exists() {
            fs::remove_file(&replaced).map_err(|error| error.to_string())?;
        }
        fs::rename(database_path, &replaced)
            .map_err(|error| format!("Could not set the old database aside: {error}"))?;
    }
    let _ = fs::remove_file(sidecar(database_path, "-wal"));
    let _ = fs::remove_file(sidecar(database_path, "-shm"));
    let restore = || {
        if replaced.is_file() {
            let _ = fs::rename(&replaced, database_path);
        }
    };
    if let Err(error) = fs::rename(incoming, database_path) {
        restore();
        return Err(format!("Could not put the new database in place: {error}"));
    }
    // The sender may be an older build, in which case what has just landed is an older
    // schema. Carrying it forward is the same thing that happens to a database this app
    // has had all along.
    if let Err(error) = open_database(database_path) {
        let _ = fs::remove_file(database_path);
        restore();
        return Err(error);
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;

    #[test]
    fn migration_files_are_timestamped() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut names = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".sql"))
            .collect::<Vec<_>>();
        names.sort();

        assert!(!names.is_empty());
        for name in names {
            let (timestamp, description) = name
                .split_once('_')
                .unwrap_or_else(|| panic!("{name} has no timestamp separator"));
            assert_eq!(timestamp.len(), 13, "{name} does not use YYYYMMDDThhmm");
            assert_eq!(
                timestamp.as_bytes()[8],
                b'T',
                "{name} does not use YYYYMMDDThhmm"
            );
            assert!(
                timestamp
                    .bytes()
                    .enumerate()
                    .all(|(index, byte)| index == 8 || byte.is_ascii_digit()),
                "{name} does not use YYYYMMDDThhmm"
            );
            assert!(
                description.len() > ".sql".len() && description.ends_with(".sql"),
                "{name} has no description"
            );
        }
    }

    #[test]
    fn migrations_are_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("chronie.sqlite3");
        initialize(&database).unwrap();
        initialize(&database).unwrap();
        let connection = open_database(&database).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let recorded: i64 = connection
            .query_row("SELECT COUNT(*) FROM chronie_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(recorded, SCHEMA_VERSION);
    }

    #[test]
    fn turns_a_numbered_schema_version_into_timestamped_history() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("chronie.sqlite3");
        {
            let mut connection = Connection::open(&database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..10] {
                transaction.execute_batch(migration.sql).unwrap();
            }
            transaction
                .pragma_update(None, "user_version", 10_i64)
                .unwrap();
            transaction.commit().unwrap();
        }

        initialize(&database).unwrap();

        let connection = Connection::open(&database).unwrap();
        let mut statement = connection
            .prepare("SELECT name FROM chronie_migrations ORDER BY name")
            .unwrap();
        let recorded = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let expected = MIGRATIONS
            .iter()
            .map(|migration| migration.name.to_string())
            .collect::<Vec<_>>();
        assert_eq!(recorded, expected);
    }

    #[test]
    fn refuses_an_unknown_timestamped_migration() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("chronie.sqlite3");
        initialize(&database).unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "INSERT INTO chronie_migrations (name) VALUES ('20990101T0000_future.sql')",
                [],
            )
            .unwrap();
        drop(connection);

        let error = initialize(&database).unwrap_err();
        assert!(error.contains("20990101T0000_future.sql"), "{error}");
        let error = summarize(&database).unwrap_err();
        assert!(error.contains("20990101T0000_future.sql"), "{error}");
    }
}
