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

use crate::failure::{Context as _, Failure, FailureCode};

#[derive(Debug, Clone, Copy)]
pub(super) struct Migration {
    pub(super) name: &'static str,
    pub(super) sql: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

/// Opens the history, brings its schema up to date, and hands it over ready to read.
///
/// Every `?` here is a typed failure rather than a `to_string`, which is what makes two of these
/// conditions distinguishable from the window: `SQLITE_BUSY` is
/// [`FailureCode::HistoryBusy`] — a sync writing while a view reads, or a second copy of the app —
/// and a schema from the future is [`FailureCode::HistoryTooNew`]. The path is context and not
/// message, because it is a diagnostic and not something to put in front of a player.
pub(super) fn open_database(path: &Path) -> Result<Connection, Failure> {
    opened(path).with_context(|| format!("opening the history at {}", path.display()))
}

fn opened(path: &Path) -> Result<Connection, Failure> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
    )?;
    migrate(&mut connection)?;
    Ok(connection)
}

fn migrate(connection: &mut Connection) -> Result<(), Failure> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(Failure::of(FailureCode::HistoryTooNew).context(format!(
            "the file is at schema version {version} and this build knows {SCHEMA_VERSION}"
        )));
    }

    // Before timestamped names, `user_version = N` meant the first N migrations in the
    // numbered list had run. Seed those names once, inside the same database, so an existing
    // install crosses to per-file history without executing any schema change twice.
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS chronie_migrations (
                 name TEXT PRIMARY KEY NOT NULL
             );",
    )?;
    let mut applied = {
        let mut statement = transaction.prepare("SELECT name FROM chronie_migrations")?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<HashSet<_>, _>>()?;
        names
    };
    if applied.is_empty() && version > 0 {
        for migration in MIGRATIONS.iter().take(version as usize) {
            transaction.execute(
                "INSERT INTO chronie_migrations (name) VALUES (?1)",
                [migration.name],
            )?;
            applied.insert(migration.name.to_string());
        }
    }
    let known = MIGRATIONS
        .iter()
        .map(|migration| migration.name)
        .collect::<HashSet<_>>();
    if let Some(name) = applied.iter().find(|name| !known.contains(name.as_str())) {
        return Err(Failure::of(FailureCode::HistoryTooNew).context(format!(
            "the file has run migration {name}, which this build does not have"
        )));
    }
    transaction.commit()?;

    let mut applied_count = applied.len() as i64;
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| !applied.contains(migration.name))
    {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migration.sql)?;
        transaction.execute(
            "INSERT INTO chronie_migrations (name) VALUES (?1)",
            [migration.name],
        )?;
        applied_count += 1;
        transaction.pragma_update(None, "user_version", applied_count)?;
        transaction.commit()?;
    }
    Ok(())
}

pub fn initialize(database_path: &Path) -> Result<(), Failure> {
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
pub fn snapshot(database_path: &Path, destination: &Path) -> Result<(), Failure> {
    let target = destination
        .to_str()
        .ok_or("The snapshot's path is not text SQLite can be given.")?;
    // SQLite refuses to write over an existing file, which is the right rule and the wrong
    // one for a scratch file the caller has already made.
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    let connection = open_database(database_path)?;
    connection
        .execute("VACUUM INTO ?1", params![target])
        .map(|_| ())
        .context("copying the history into a file to send")
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
pub fn summarize(database_path: &Path) -> Result<Summary, Failure> {
    let not_ours = || {
        Failure::new(
            FailureCode::InvalidInput,
            "That file is not a Chronie database.",
        )
    };
    let connection = Connection::open_with_flags(
        database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .context("opening an arriving database to read what is in it")?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| not_ours().caused_by(error))?;
    if version == 0 {
        return Err(not_ours().context("it carries no schema version at all"));
    }
    // Refused rather than migrated, and refused with the code that says so — this is the one
    // condition on this screen where trying again is pointless and updating is the whole answer.
    if version > SCHEMA_VERSION {
        return Err(Failure::new(
            FailureCode::HistoryTooNew,
            "That history was written by a newer Chronie. Update this Chronie first.",
        )
        .context(format!(
            "the file is at schema version {version} and this build reads {SCHEMA_VERSION}"
        )));
    }
    if let Some(name) =
        unknown_migration(&connection).map_err(|error| not_ours().caused_by(error))?
    {
        return Err(Failure::new(
            FailureCode::HistoryTooNew,
            "That history was written by a newer Chronie. Update this Chronie first.",
        )
        .context(format!(
            "the file has run migration {name}, which this build does not have"
        )));
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
        .map_err(|error| {
            Failure::new(
                FailureCode::InvalidInput,
                "That database has no Chronie history in it.",
            )
            .caused_by(error)
        })?;
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
pub fn install_database(incoming: &Path, database_path: &Path) -> Result<Summary, Failure> {
    let summary = summarize(incoming)?;
    if let Some(parent) = database_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let replaced = database_path.with_extension("replaced.sqlite3");
    if database_path.is_file() {
        if let Ok(connection) = Connection::open(database_path) {
            let _ = connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        }
        if replaced.exists() {
            fs::remove_file(&replaced)?;
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
        return Err(Failure::from(error).context("putting the arriving history in place"));
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
        assert!(
            error.report().contains("20990101T0000_future.sql"),
            "{}",
            error.report()
        );
        let error = summarize(&database).unwrap_err();
        assert!(
            error.report().contains("20990101T0000_future.sql"),
            "{}",
            error.report()
        );
    }

    /// A history from the future is the one condition on this screen where trying again is
    /// pointless and updating is the whole answer — which is why it has a code of its own, and why
    /// the version numbers behind it stay in the log rather than going into an alert.
    #[test]
    fn a_history_from_a_newer_build_is_refused_by_name() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("chronie.sqlite3");
        initialize(&database).unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION + 5)
            .unwrap();
        drop(connection);

        for failure in [
            initialize(&database).unwrap_err(),
            summarize(&database).unwrap_err(),
        ] {
            assert_eq!(failure.code(), FailureCode::HistoryTooNew);
            assert!(!failure.code().retryable());
            assert!(
                !failure
                    .message()
                    .contains(&(SCHEMA_VERSION + 5).to_string()),
                "{}",
                failure.message()
            );
            assert!(
                failure
                    .report()
                    .contains(&format!("schema version {}", SCHEMA_VERSION + 5)),
                "{}",
                failure.report()
            );
        }
    }

    /// The operation reaches the log, which is the thing 234 `error.to_string()` calls could not do:
    /// a failure opening the history now says which file it was opening and what SQLite said about
    /// it, and the window still only sees a sentence.
    #[test]
    fn a_failure_opening_the_history_says_which_file_and_why() {
        let temp = tempfile::tempdir().unwrap();
        // A directory where the database file should be: SQLite cannot open it, and nothing in this
        // repository wrote the words it complains with.
        let database = temp.path().join("chronie.sqlite3");
        fs::create_dir(&database).unwrap();

        let failure = open_database(&database).unwrap_err();

        let report = failure.report();
        assert!(
            report.contains(&format!(
                "while opening the history at {}",
                database.display()
            )),
            "{report}"
        );
        assert!(report.len() > failure.message().len(), "{report}");
    }
}
