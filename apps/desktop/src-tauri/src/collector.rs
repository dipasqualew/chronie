use crate::activity;
use crate::captures::{self, Marker, Stored, Wanted};
use crate::combatlog;
use crate::icons;
use crate::logfile::{self, Fight, Fought, MapBounds, Position, Reading, Resume, Sampled};
use crate::retention;
use chrono::{DateTime, Datelike, Local, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_initial.sql"),
    include_str!("../migrations/0002_activities.sql"),
    include_str!("../migrations/0003_lockouts.sql"),
    include_str!("../migrations/0004_equipsets.sql"),
    include_str!("../migrations/0005_holdings.sql"),
    include_str!("../migrations/0006_captures.sql"),
    include_str!("../migrations/0007_account_rollups.sql"),
    include_str!("../migrations/0008_combat_logs.sql"),
    include_str!("../migrations/0009_capture_subjects.sql"),
    include_str!("../migrations/0010_capture_notes.sql"),
    include_str!("../migrations/0011_gold.sql"),
    include_str!("../migrations/0012_log_retention.sql"),
];
const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

#[derive(Debug, Clone, Serialize)]
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
}

#[derive(Debug, Clone, PartialEq)]
enum Key {
    Text(String),
    Index(i64),
}

struct LuaReader<'a> {
    text: &'a [u8],
    pos: usize,
}

impl<'a> LuaReader<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text: text.as_bytes(),
            pos: 0,
        }
    }

    fn error(&self, message: &str) -> String {
        let line = self.text[..self.pos.min(self.text.len())]
            .iter()
            .filter(|byte| **byte == b'\n')
            .count()
            + 1;
        format!("{message} at line {line}")
    }

    fn skip_trivia(&mut self) {
        loop {
            while self.pos < self.text.len() && self.text[self.pos].is_ascii_whitespace() {
                self.pos += 1;
            }
            if !self
                .text
                .get(self.pos..)
                .is_some_and(|rest| rest.starts_with(b"--"))
            {
                break;
            }
            self.pos += 2;
            if self
                .text
                .get(self.pos..)
                .is_some_and(|rest| rest.starts_with(b"[["))
            {
                self.pos += 2;
                while self.pos + 1 < self.text.len() && &self.text[self.pos..self.pos + 2] != b"]]"
                {
                    self.pos += 1;
                }
                self.pos = (self.pos + 2).min(self.text.len());
            } else {
                while self.pos < self.text.len() && self.text[self.pos] != b'\n' {
                    self.pos += 1;
                }
            }
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_trivia();
        self.text.get(self.pos).copied()
    }

    fn expect(&mut self, expected: u8) -> Result<(), String> {
        if self.peek() != Some(expected) {
            return Err(self.error(&format!("expected {:?}", expected as char)));
        }
        self.pos += 1;
        Ok(())
    }

    fn name(&mut self) -> Result<String, String> {
        self.skip_trivia();
        let start = self.pos;
        while self.pos < self.text.len()
            && (self.text[self.pos].is_ascii_alphanumeric() || self.text[self.pos] == b'_')
        {
            self.pos += 1;
        }
        if start == self.pos {
            Err(self.error("expected a name"))
        } else {
            Ok(String::from_utf8_lossy(&self.text[start..self.pos]).into_owned())
        }
    }

    fn string(&mut self) -> Result<String, String> {
        let quote = self.text[self.pos];
        self.pos += 1;
        let mut out = Vec::new();
        while self.pos < self.text.len() {
            let byte = self.text[self.pos];
            self.pos += 1;
            if byte == quote {
                return String::from_utf8(out).map_err(|_| self.error("invalid UTF-8 string"));
            }
            if byte != b'\\' {
                out.push(byte);
                continue;
            }
            let escaped = *self
                .text
                .get(self.pos)
                .ok_or_else(|| self.error("unterminated escape"))?;
            self.pos += 1;
            if escaped.is_ascii_digit() {
                let mut digits = vec![escaped];
                while digits.len() < 3
                    && self
                        .text
                        .get(self.pos)
                        .is_some_and(|next| next.is_ascii_digit())
                {
                    digits.push(self.text[self.pos]);
                    self.pos += 1;
                }
                let parsed = String::from_utf8_lossy(&digits)
                    .parse::<u8>()
                    .map_err(|_| self.error("bad decimal escape"))?;
                out.push(parsed);
            } else {
                out.push(match escaped {
                    b'n' => b'\n',
                    b'r' => b'\r',
                    b't' => b'\t',
                    b'a' => 7,
                    b'b' => 8,
                    b'f' => 12,
                    b'v' => 11,
                    other => other,
                });
            }
        }
        Err(self.error("unterminated string"))
    }

    fn number(&mut self) -> Result<Value, String> {
        self.skip_trivia();
        let start = self.pos;
        if self
            .text
            .get(self.pos)
            .is_some_and(|byte| matches!(byte, b'+' | b'-'))
        {
            self.pos += 1;
        }
        while self.pos < self.text.len() {
            let byte = self.text[self.pos];
            if !(byte.is_ascii_hexdigit()
                || matches!(
                    byte,
                    b'.' | b'x' | b'X' | b'e' | b'E' | b'p' | b'P' | b'+' | b'-'
                ))
            {
                break;
            }
            if matches!(byte, b'+' | b'-')
                && self.pos > start
                && !matches!(self.text[self.pos - 1], b'e' | b'E' | b'p' | b'P')
            {
                break;
            }
            self.pos += 1;
        }
        let literal = String::from_utf8_lossy(&self.text[start..self.pos]);
        let negative = literal.starts_with('-');
        let unsigned = literal.trim_start_matches(['+', '-']);
        if let Some(hex) = unsigned
            .strip_prefix("0x")
            .or_else(|| unsigned.strip_prefix("0X"))
        {
            let parsed =
                i64::from_str_radix(hex, 16).map_err(|_| self.error("bad hexadecimal number"))?;
            return Ok(Value::from(if negative { -parsed } else { parsed }));
        }
        if literal.contains(['.', 'e', 'E']) {
            let parsed = literal
                .parse::<f64>()
                .map_err(|_| self.error("bad number"))?;
            serde_json::Number::from_f64(parsed)
                .map(Value::Number)
                .ok_or_else(|| self.error("bad number"))
        } else {
            literal
                .parse::<i64>()
                .map(Value::from)
                .map_err(|_| self.error("bad number"))
        }
    }

    fn value(&mut self) -> Result<Value, String> {
        match self.peek() {
            Some(b'{') => self.table(),
            Some(b'"' | b'\'') => self.string().map(Value::String),
            Some(byte) if byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.') => {
                self.number()
            }
            Some(_) => match self.name()?.as_str() {
                "true" => Ok(Value::Bool(true)),
                "false" => Ok(Value::Bool(false)),
                "nil" => Ok(Value::Null),
                other => Err(self.error(&format!("unexpected value {other:?}"))),
            },
            None => Err(self.error("expected a value")),
        }
    }

    fn table(&mut self) -> Result<Value, String> {
        self.expect(b'{')?;
        let mut entries = Vec::new();
        let mut next_index = 1_i64;
        loop {
            match self.peek() {
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                None => return Err(self.error("unterminated table")),
                _ => {}
            }
            let (key, value) = if self.peek() == Some(b'[') {
                self.pos += 1;
                let key_value = self.value()?;
                self.expect(b']')?;
                self.expect(b'=')?;
                let key = match key_value {
                    Value::String(text) => Key::Text(text),
                    Value::Number(number) => Key::Index(
                        number
                            .as_i64()
                            .ok_or_else(|| self.error("bad table index"))?,
                    ),
                    _ => return Err(self.error("unsupported table key")),
                };
                (key, self.value()?)
            } else {
                let mark = self.pos;
                if self
                    .peek()
                    .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
                {
                    let name = self.name()?;
                    if self.peek() == Some(b'=') {
                        self.pos += 1;
                        (Key::Text(name), self.value()?)
                    } else {
                        self.pos = mark;
                        let value = self.value()?;
                        let key = Key::Index(next_index);
                        next_index += 1;
                        (key, value)
                    }
                } else {
                    let value = self.value()?;
                    let key = Key::Index(next_index);
                    next_index += 1;
                    (key, value)
                }
            };
            entries.push((key, value));
            if self.peek().is_some_and(|byte| matches!(byte, b',' | b';')) {
                self.pos += 1;
            }
        }
        table_value(entries)
    }
}

fn table_value(entries: Vec<(Key, Value)>) -> Result<Value, String> {
    if entries.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    let array = entries
        .iter()
        .enumerate()
        .all(|(index, (key, _))| *key == Key::Index(index as i64 + 1));
    if array {
        return Ok(Value::Array(
            entries.into_iter().map(|(_, value)| value).collect(),
        ));
    }
    let mut object = Map::new();
    for (key, value) in entries {
        let key = match key {
            Key::Text(text) => text,
            Key::Index(index) => index.to_string(),
        };
        object.insert(key, value);
    }
    Ok(Value::Object(object))
}

pub fn read_saved_variable(text: &str, variable: &str) -> Result<Option<Value>, String> {
    let mut reader = LuaReader::new(text);
    while reader.peek().is_some() {
        let name = reader.name()?;
        reader.expect(b'=')?;
        let value = reader.value()?;
        if name == variable {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

pub fn resolve_wow_path(input: &Path) -> Result<PathBuf, String> {
    if input.join("WTF").is_dir() {
        return Ok(input.to_path_buf());
    }
    let retail = input.join("_retail_");
    if retail.join("WTF").is_dir() {
        return Ok(retail);
    }
    Err(format!(
        "No WTF folder found under {} or its _retail_ folder.",
        input.display()
    ))
}

pub fn account_files(wow_path: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let account = wow_path.join("WTF").join("Account");
    let Ok(accounts) = fs::read_dir(account) else {
        return files;
    };
    for entry in accounts.flatten() {
        let path = entry.path().join("SavedVariables").join("chronie.lua");
        if path.is_file() {
            files.push(path);
        }
    }
    files.sort();
    files
}

fn normalized(mut segment: Value) -> Option<Value> {
    let object = segment.as_object_mut()?;
    if !object.get("id").is_some_and(Value::is_string)
        || !object.get("character").is_some_and(Value::is_string)
        || !object.get("endedAt").is_some_and(Value::is_number)
    {
        return None;
    }
    let ended = object["endedAt"].as_i64()?;
    object.entry("startedAt").or_insert(Value::from(ended));
    object.entry("day").or_insert_with(|| {
        DateTime::from_timestamp(ended, 0)
            .map(|date| Value::String(date.with_timezone(&Local).format("%Y-%m-%d").to_string()))
            .unwrap_or(Value::String("Unknown".into()))
    });
    for (key, default) in [
        ("instance", Value::String("Unknown".into())),
        ("difficulty", Value::String(String::new())),
        ("instanceType", Value::String(String::new())),
        ("seconds", Value::from(0)),
        ("lootValue", Value::from(0)),
        ("goldDiff", Value::from(0)),
        ("currencyTotal", Value::from(0)),
        ("reputationTotal", Value::from(0)),
        ("housingXP", Value::from(0)),
    ] {
        object.entry(key).or_insert(default);
    }
    for key in [
        "transmogs",
        "currencies",
        "reputation",
        "achievements",
        "levelUps",
        "mounts",
        "pets",
        "quests",
        "toys",
        "housingItems",
        "housingLevelUps",
        "encounters",
        "equipsetChanges",
    ] {
        if !object.get(key).is_some_and(Value::is_array) {
            object.insert(key.into(), Value::Array(Vec::new()));
        }
    }
    // `keystone` and `experience` are deliberately left absent when the segment carried
    // none: the inference reads the absence of a keystone as "this was not a Mythic+ run",
    // which an empty stand-in would destroy.
    for key in ["keystone", "experience"] {
        if !object.get(key).is_some_and(Value::is_object) {
            object.remove(key);
        }
    }
    Some(segment)
}

fn open_database(path: &Path) -> Result<Connection, String> {
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
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(migration)
            .map_err(|error| error.to_string())?;
        transaction
            .pragma_update(None, "user_version", (index + 1) as i64)
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

fn account_key(path: &Path) -> Option<String> {
    path.parent()?
        .parent()?
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

fn split_character(source_key: &str) -> (&str, &str) {
    source_key.split_once('-').unwrap_or((source_key, ""))
}

fn integer(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn optional_integer(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn optional_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn optional_boolean(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_bool).map(i64::from)
}

fn upsert_account(
    transaction: &Transaction<'_>,
    source_key: &str,
    source_modified_ns: Option<i64>,
    source_size: Option<i64>,
    now: i64,
) -> Result<i64, String> {
    transaction
        .execute(
            "INSERT INTO accounts (
                 source_key, first_seen_at, last_seen_at, source_modified_ns, source_size
             ) VALUES (?1, ?2, ?2, ?3, ?4)
             ON CONFLICT(source_key) DO UPDATE SET
                 last_seen_at = excluded.last_seen_at,
                 source_modified_ns = excluded.source_modified_ns,
                 source_size = excluded.source_size",
            params![source_key, now, source_modified_ns, source_size],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .query_row(
            "SELECT id FROM accounts WHERE source_key = ?1",
            [source_key],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn upsert_character(
    transaction: &Transaction<'_>,
    account_id: i64,
    segment: &Value,
    now: i64,
) -> Result<i64, String> {
    let source_key = segment["character"].as_str().expect("normalized character");
    upsert_character_key(
        transaction,
        account_id,
        source_key,
        optional_text(segment, "classFile"),
        optional_integer(segment, "level"),
        now,
    )
}

/// A character named by nothing more than its "Name-Realm" key.
///
/// Lockouts are recorded against characters that may never have produced a segment — a bank
/// alt saved to last week's raid is exactly the character worth knowing is still free — so
/// the roster needs a way in that does not go through a visit.
fn upsert_character_key(
    transaction: &Transaction<'_>,
    account_id: i64,
    source_key: &str,
    class_file: Option<&str>,
    level: Option<i64>,
    now: i64,
) -> Result<i64, String> {
    let (name, realm) = split_character(source_key);
    transaction
        .execute(
            "INSERT INTO characters (
                 account_id, source_key, name, realm, class_file, last_level,
                 first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(account_id, source_key) DO UPDATE SET
                 name = excluded.name,
                 realm = excluded.realm,
                 class_file = COALESCE(excluded.class_file, characters.class_file),
                 last_level = COALESCE(excluded.last_level, characters.last_level),
                 last_seen_at = excluded.last_seen_at",
            params![account_id, source_key, name, realm, class_file, level, now],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .query_row(
            "SELECT id FROM characters WHERE account_id = ?1 AND source_key = ?2",
            params![account_id, source_key],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

/// One account's lockout tables, which only mean anything read together: `activities` says
/// what is true of each lockable thing, `characters` says who is locked to what, and
/// `roster` names the characters themselves — including ones with nothing saved at all,
/// which are precisely the ones worth knowing are still free.
#[derive(Debug, Default)]
struct LockoutFeed {
    activities: Value,
    characters: Value,
    roster: Value,
}

impl LockoutFeed {
    fn read(saved: &Value) -> Self {
        let table = |key: &str| saved.get(key).cloned().unwrap_or(Value::Null);
        Self {
            activities: table("activities"),
            characters: table("characters"),
            roster: table("roster"),
        }
    }
}

/// The entries of a Lua table that was written with string keys. An empty Lua table is
/// indistinguishable from an empty list, so anything that is not an object is simply no
/// entries rather than an error.
fn entries(value: &Value) -> impl Iterator<Item = (&String, &Value)> {
    value.as_object().into_iter().flat_map(Map::iter)
}

/// The kind of thing an activity is, from the activity record when the addon wrote one and
/// from the lockout itself for saves that predate the activity table. Anything unrecognised
/// falls back to the one distinction every save has always carried, because the column is
/// constrained and a stray kind would fail the whole sync rather than one row.
fn lockout_kind(record: &Value, fallback: &Value) -> &'static str {
    match optional_text(record, "kind").or_else(|| optional_text(fallback, "kind")) {
        Some("raid") => "raid",
        Some("dungeon") => "dungeon",
        Some("world_boss") => "world_boss",
        _ => {
            let is_raid = record
                .get("isRaid")
                .or_else(|| fallback.get("isRaid"))
                .and_then(Value::as_bool)
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
fn lockout_period(record: &Value, kind: &str) -> &'static str {
    match optional_text(record, "period") {
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
    record: &Value,
    fallback: &Value,
    now: i64,
) -> Result<i64, String> {
    let name = optional_text(record, "activity")
        .or_else(|| optional_text(fallback, "activity"))
        .or_else(|| optional_text(fallback, "instance"))
        .unwrap_or(source_key);
    let kind = lockout_kind(record, fallback);
    transaction
        .execute(
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
        )
        .map_err(|error| error.to_string())?;
    transaction
        .query_row(
            "SELECT id FROM lockout_activities WHERE account_id = ?1 AND source_key = ?2",
            params![account_id, source_key],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn insert_lockout(
    transaction: &Transaction<'_>,
    activity_id: i64,
    character_id: i64,
    lockout: &Value,
    expires_at: i64,
    now: i64,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO lockouts (
                 activity_id, character_id, difficulty_id, difficulty, max_players,
                 expires_at, recorded_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                activity_id,
                character_id,
                optional_integer(lockout, "difficultyId").unwrap_or(0),
                optional_text(lockout, "difficulty").unwrap_or(""),
                optional_integer(lockout, "maxPlayers").unwrap_or(0),
                expires_at,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    let lockout_id = transaction.last_insert_rowid();

    for (position, encounter) in lockout
        .get("encounters")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let Some(name) = optional_text(encounter, "name") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO lockout_encounters (lockout_id, position, name, killed)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    lockout_id,
                    position as i64,
                    name,
                    optional_boolean(encounter, "killed").unwrap_or(0)
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Writes one account's lockouts as current state rather than as history.
///
/// The client only ever reports what is true right now, so a lockout missing from a scan
/// has lapsed and a character's rows are replaced wholesale. Activities are the exception:
/// they are never deleted, because what they record — the reset cadence — is learned across
/// scans and would be thrown away every time nobody happened to be locked to one.
fn sync_lockouts(
    transaction: &Transaction<'_>,
    account_id: i64,
    feed: &LockoutFeed,
    now: i64,
) -> Result<(), String> {
    for (character, info) in entries(&feed.roster) {
        upsert_character_key(
            transaction,
            account_id,
            character,
            optional_text(info, "classFile"),
            optional_integer(info, "level"),
            now,
        )?;
    }

    let mut activity_ids: HashMap<String, i64> = HashMap::new();
    for (key, record) in entries(&feed.activities) {
        let id = upsert_lockout_activity(transaction, account_id, key, record, &Value::Null, now)?;
        activity_ids.insert(key.clone(), id);
    }

    for (character, lockouts) in entries(&feed.characters) {
        let character_id =
            upsert_character_key(transaction, account_id, character, None, None, now)?;
        transaction
            .execute(
                "DELETE FROM lockouts WHERE character_id = ?1",
                [character_id],
            )
            .map_err(|error| error.to_string())?;

        for (slot, lockout) in entries(lockouts) {
            let Some(expires_at) = optional_integer(lockout, "expiry") else {
                continue;
            };
            // The map key is the slot a save is filed under — activity plus difficulty —
            // while the activity it belongs to is named on the lockout itself. A save
            // written before activities existed has no key, and rebuilding it the way the
            // addon does is what stops one raid becoming two activities here.
            let key = match optional_text(lockout, "key") {
                Some(key) => key.to_string(),
                None => format!(
                    "instance\0{}",
                    optional_text(lockout, "instance").unwrap_or(slot)
                ),
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
                        &Value::Null,
                        lockout,
                        now,
                    )?;
                    activity_ids.insert(key, id);
                    id
                }
            };
            insert_lockout(transaction, activity_id, character_id, lockout, expires_at, now)?;
        }
    }

    Ok(())
}

fn clear_outcomes(transaction: &Transaction<'_>, segment_id: i64) -> Result<(), String> {
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
        // equipset_slots hang off the change row and go with it.
        "equipset_changes",
    ] {
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE segment_id = ?1"),
                [segment_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Rebuilds the guesses for one segment, leaving everything the user did untouched.
///
/// Only 'inferred' rows are thrown away and recomputed, so a better rule set reaches all of
/// history on the next sync. A kind the user suppressed — by deleting the guess or by
/// editing it into a correction of their own — is skipped, which is what makes an edit
/// survive a sync instead of being quietly overwritten by the guess it replaced.
fn refresh_activities(
    transaction: &Transaction<'_>,
    segment_id: i64,
    segment: &Value,
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

fn events<'a>(segment: &'a Value, key: &str) -> &'a [Value] {
    segment
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn insert_outcomes(
    transaction: &Transaction<'_>,
    character_id: i64,
    segment_id: i64,
    segment: &Value,
) -> Result<(), String> {
    clear_outcomes(transaction, segment_id)?;

    for (position, event) in events(segment, "transmogs").iter().enumerate() {
        let Some(item_id) = optional_integer(event, "id") else {
            continue;
        };
        let acquisition_kind = match event.get("newAppearance").and_then(Value::as_bool) {
            Some(true) => "appearance",
            Some(false) => "source",
            None => "unknown",
        };
        transaction
            .execute(
                "INSERT INTO transmogs (
                     segment_id, position, item_id, source_id, appearance_id,
                     collected_at, acquisition_kind
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    segment_id,
                    position as i64,
                    item_id,
                    optional_integer(event, "sourceID"),
                    optional_integer(event, "appearanceID"),
                    optional_integer(event, "at"),
                    acquisition_kind
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for (position, event) in events(segment, "achievements").iter().enumerate() {
        let Some(achievement_id) = optional_integer(event, "id") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO achievements (
                     segment_id, position, achievement_id, name, earned_at, account_first
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    segment_id,
                    position as i64,
                    achievement_id,
                    optional_text(event, "name"),
                    optional_integer(event, "at"),
                    optional_boolean(event, "accountFirst")
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for (position, event) in events(segment, "quests").iter().enumerate() {
        let Some(quest_id) = optional_integer(event, "id") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO quests (
                     segment_id, position, quest_id, name, completed_at,
                     character_first, account_first
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    segment_id,
                    position as i64,
                    quest_id,
                    optional_text(event, "name"),
                    optional_integer(event, "at"),
                    optional_boolean(event, "characterFirst"),
                    optional_boolean(event, "accountFirst")
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for event in events(segment, "currencies") {
        let Some(currency_id) = optional_integer(event, "id") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO currency_gains (segment_id, currency_id, name, amount, total)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    segment_id,
                    currency_id,
                    optional_text(event, "name").unwrap_or("Unknown"),
                    integer(event, "amount"),
                    optional_integer(event, "total")
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for event in events(segment, "reputation") {
        let Some(faction) = optional_text(event, "faction") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO reputation_gains (
                     segment_id, faction, amount, standing, standing_current, standing_max
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    segment_id,
                    faction,
                    integer(event, "amount"),
                    optional_text(event, "standing"),
                    optional_integer(event, "current"),
                    optional_integer(event, "max")
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for (position, event) in events(segment, "levelUps").iter().enumerate() {
        let Some(level) = optional_integer(event, "level") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO level_ups (segment_id, position, level, reached_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    segment_id,
                    position as i64,
                    level,
                    optional_integer(event, "at")
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for (position, event) in events(segment, "mounts").iter().enumerate() {
        let Some(mount_id) = optional_integer(event, "id") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO mounts (segment_id, position, mount_id, name, collected_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    segment_id,
                    position as i64,
                    mount_id,
                    optional_text(event, "name"),
                    optional_integer(event, "at")
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for (position, event) in events(segment, "pets").iter().enumerate() {
        let Some(species_id) = optional_integer(event, "id") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO pets (
                     segment_id, position, species_id, name, collected_at, pet_guid
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    segment_id,
                    position as i64,
                    species_id,
                    optional_text(event, "name"),
                    optional_integer(event, "at"),
                    optional_text(event, "guid")
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for (position, event) in events(segment, "toys").iter().enumerate() {
        let Some(item_id) = optional_integer(event, "id") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO toys (segment_id, position, item_id, name, collected_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    segment_id,
                    position as i64,
                    item_id,
                    optional_text(event, "name"),
                    optional_integer(event, "at")
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for (position, event) in events(segment, "housingItems").iter().enumerate() {
        let Some(decor_id) = optional_integer(event, "id") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO housing_items (
                     segment_id, position, decor_id, name, collected_at, warband_first
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    segment_id,
                    position as i64,
                    decor_id,
                    optional_text(event, "name"),
                    optional_integer(event, "at"),
                    optional_boolean(event, "warbandFirst")
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for (position, event) in events(segment, "housingLevelUps").iter().enumerate() {
        let Some(level) = optional_integer(event, "level") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO housing_level_ups (segment_id, position, level, reached_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    segment_id,
                    position as i64,
                    level,
                    optional_integer(event, "at")
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    for (position, event) in events(segment, "encounters").iter().enumerate() {
        let Some(encounter_id) = optional_integer(event, "id") else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO encounters (
                     segment_id, position, encounter_id, name, ended_at,
                     difficulty_id, group_size, success
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    segment_id,
                    position as i64,
                    encounter_id,
                    optional_text(event, "name"),
                    optional_integer(event, "at"),
                    optional_integer(event, "difficultyId"),
                    optional_integer(event, "groupSize"),
                    optional_boolean(event, "success").unwrap_or(0)
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    if let Some(keystone) = segment.get("keystone").filter(|value| value.is_object()) {
        // A run with no level is not one the app can say anything useful about, and the
        // column is NOT NULL for exactly that reason.
        if let Some(level) = optional_integer(keystone, "level") {
            let affixes = keystone
                .get("affixes")
                .filter(|value| value.is_array())
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            transaction
                .execute(
                    "INSERT INTO keystone_runs (
                         segment_id, level, map_id, affixes_json, started_at,
                         completed_at, completed, duration_ms, on_time, upgrades
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        segment_id,
                        level,
                        optional_integer(keystone, "mapId"),
                        affixes.to_string(),
                        optional_integer(keystone, "startedAt"),
                        optional_integer(keystone, "completedAt"),
                        optional_boolean(keystone, "completed").unwrap_or(0),
                        optional_integer(keystone, "durationMs"),
                        optional_boolean(keystone, "onTime"),
                        optional_integer(keystone, "upgrades")
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
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
    segment: &Value,
) -> Result<(), String> {
    for (position, event) in events(segment, "equipsetChanges").iter().enumerate() {
        let Some(set_id) = optional_integer(event, "setId") else {
            continue;
        };
        // An unknown kind is not something the ledger can file, and the column's CHECK would
        // refuse it anyway; dropping it here keeps a bad row from failing the whole sync.
        let kind = match optional_text(event, "kind") {
            Some(kind @ ("created" | "deleted" | "updated")) => kind,
            _ => continue,
        };
        let changed_at = optional_integer(event, "at");
        transaction
            .execute(
                "INSERT INTO equipset_changes (
                     segment_id, position, character_id, set_id, name, kind, changed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    segment_id,
                    position as i64,
                    character_id,
                    set_id,
                    optional_text(event, "name").unwrap_or(""),
                    kind,
                    changed_at
                ],
            )
            .map_err(|error| error.to_string())?;
        let change_id = transaction.last_insert_rowid();

        for item in events(event, "items") {
            let Some(slot) = optional_integer(item, "slot") else {
                continue;
            };
            transaction
                .execute(
                    "INSERT INTO equipset_slots (
                         change_id, character_id, set_id, slot,
                         item_id, item_level, item_name, changed_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(change_id, slot) DO NOTHING",
                    params![
                        change_id,
                        character_id,
                        set_id,
                        slot,
                        optional_integer(item, "itemId"),
                        optional_integer(item, "itemLevel"),
                        optional_text(item, "itemName"),
                        changed_at
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn upsert_segment(
    transaction: &Transaction<'_>,
    character_id: i64,
    segment: &Value,
    now: i64,
) -> Result<bool, String> {
    let source_id = segment["id"].as_str().expect("normalized segment id");
    let existing: Option<i64> = transaction
        .query_row(
            "SELECT id FROM segments WHERE character_id = ?1 AND source_id = ?2",
            params![character_id, source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let ended_at = integer(segment, "endedAt");
    let experience = segment.get("experience").filter(|value| value.is_object());
    transaction
        .execute(
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
                segment["day"].as_str().unwrap_or("Unknown"),
                segment["instance"].as_str().unwrap_or("Unknown"),
                segment["instanceType"].as_str().unwrap_or(""),
                segment["difficulty"].as_str().unwrap_or(""),
                optional_integer(segment, "difficultyId"),
                integer(segment, "startedAt"),
                ended_at,
                integer(segment, "seconds"),
                optional_integer(segment, "level"),
                integer(segment, "lootValue"),
                integer(segment, "goldDiff"),
                integer(segment, "currencyTotal"),
                integer(segment, "reputationTotal"),
                integer(segment, "housingXP"),
                now,
                optional_integer(segment, "expansionTier"),
                optional_integer(segment, "latestExpansionTier"),
                experience.map(|value| integer(value, "gained")).unwrap_or(0),
                experience
                    .and_then(|value| value.get("percent"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                experience.and_then(|value| optional_integer(value, "startLevel")),
                experience.and_then(|value| optional_integer(value, "endLevel")),
            ],
        )
        .map_err(|error| error.to_string())?;
    let segment_id = existing.unwrap_or_else(|| transaction.last_insert_rowid());
    insert_outcomes(transaction, character_id, segment_id, segment)?;
    refresh_activities(transaction, segment_id, segment, now)?;
    Ok(existing.is_none())
}

/// Where Chronie keeps the images it has taken custody of: its own folder beside its own
/// database, so that a backup of one is a backup of the other.
pub fn store_root(database_path: &Path) -> PathBuf {
    database_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(captures::STORE_FOLDER)
}

/// One capture's image, copied into the store and verified, waiting for the row that names
/// it to be committed before the original is touched.
struct Ingested {
    stored: Stored,
    source_name: String,
    original: PathBuf,
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
fn ingest_images(
    connection: &Connection,
    wow_path: &Path,
    store_root: &Path,
    markers: &[&Marker],
) -> Result<HashMap<String, Ingested>, String> {
    let wanted = wanted_images(connection, markers)?;
    if wanted.is_empty() {
        return Ok(HashMap::new());
    }
    let shots = captures::folder(&wow_path.join(captures::GAME_FOLDER));
    let mut ingested = HashMap::new();
    for (source_id, path) in captures::pair(&wanted, &shots) {
        let Ok(stored) = captures::store(&path, store_root) else {
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
fn upsert_capture(
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
fn deleted_captures(connection: &Connection) -> Result<HashSet<String>, String> {
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
fn record_images(
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
fn link_captures(transaction: &Transaction<'_>) -> Result<(), String> {
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
fn link_capture_achievements(transaction: &Transaction<'_>) -> Result<(), String> {
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

/* ---------- what the client's own combat log says ---------- */

/// How many new bytes of combat log one sync will get through.
///
/// A first pass over a season of logs is gigabytes, and doing it in one go is a sync that
/// looks like it has hung. This is the same work spread over a beat that comes round every
/// thirty seconds: nothing is skipped, nothing is read twice, and a backlog of a hundred
/// gigabytes clears in half an hour of the app simply being open.
const LOG_BYTES_PER_SYNC: u64 = 64 * 1024 * 1024;

/// The year to read a log's stamps with when its lines do not carry one.
///
/// The client names its files with the day it opened them — `WoWCombatLog-070926_182310.txt`
/// — which is the best answer available and is the file's own claim rather than a guess. When
/// the name does not say, the filesystem's date does, and after that there is only now.
fn log_year(found: &combatlog::Found) -> i32 {
    stamped_year(&found.file.name)
        .or_else(|| {
            found
                .file
                .modified
                .and_then(|at| DateTime::from_timestamp(at, 0))
                .map(|moment| moment.with_timezone(&Local).year())
        })
        .unwrap_or_else(|| Local::now().year())
}

/// The `MMDDYY_HHMMSS` in a log's name, as a year.
fn stamped_year(name: &str) -> Option<i32> {
    let stamp = name.split(['-', '.', '_']).collect::<Vec<_>>().join("_");
    let stamp = stamp.split('_').find(|part| {
        part.len() == 6 && part.bytes().all(|byte| byte.is_ascii_digit())
    })?;
    stamp[4..6].parse::<i32>().ok().map(|year| 2000 + year)
}

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

/// Reads what is new in every combat log this install has, and files what it finds.
///
/// Oldest first, on a shared byte budget, so that a backlog is worked through in the order it
/// was written and no single sync disappears into it.
///
/// A file that cannot be read is skipped rather than fatal, and the next sync tries again: a
/// log can be deleted between the folder being listed and the file being opened, and a night
/// of segments is worth more than refusing them all over one file that went away. A database
/// error is a different thing and is passed up.
fn ingest_logs(connection: &mut Connection, wow_path: &Path, now: i64) -> Result<(), String> {
    let mut budget = LOG_BYTES_PER_SYNC;
    let mut anything = false;
    for found in combatlog::logs(wow_path) {
        if budget == 0 {
            break;
        }
        let (_, resume) = log_resume(connection, &found.file.name)?;
        let mut reader = logfile::Reader::new(log_year(&found), logfile::Zone::Local);
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
fn sweep_logs(
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

/// One account's SavedVariables file, parsed and ready to be written to the database.
struct Incoming {
    source_key: String,
    source_modified_ns: Option<i64>,
    source_size: Option<i64>,
    segments: Vec<Value>,
    lockouts: LockoutFeed,
    holdings: Value,
    warband: Value,
    markers: Vec<Marker>,
}

/// What each character was last seen holding, replacing whatever it last said.
///
/// Wholesale per character rather than row by row, for the same reason the addon writes it
/// that way: this is a snapshot of where one character stands, and half of an old snapshot
/// beside half of a new one is a position no character was ever in. Only the character the
/// snapshot belongs to is touched — the client can only ever read the character in front of
/// it, so nothing here knows anything about the others.
fn sync_holdings(
    transaction: &Transaction<'_>,
    account_id: i64,
    holdings: &Value,
    now: i64,
) -> Result<(), String> {
    for (character, snapshot) in entries(holdings) {
        let character_id =
            upsert_character_key(transaction, account_id, character, None, None, now)?;
        transaction
            .execute(
                "DELETE FROM character_currencies WHERE character_id = ?1",
                [character_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM character_standings WHERE character_id = ?1",
                [character_id],
            )
            .map_err(|error| error.to_string())?;

        let currencies = snapshot.get("currencies").cloned().unwrap_or(Value::Null);
        for (key, held) in entries(&currencies) {
            // The addon keys these by the client's own currency id, which arrives as a Lua
            // table key and so as a string. One that is not a number is not a currency.
            let Ok(currency_id) = key.parse::<i64>() else {
                continue;
            };
            let Some(total) = optional_integer(held, "total") else {
                continue;
            };
            transaction
                .execute(
                    "INSERT INTO character_currencies (
                         character_id, currency_id, name, total, observed_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        character_id,
                        currency_id,
                        optional_text(held, "name"),
                        total,
                        optional_integer(held, "at")
                    ],
                )
                .map_err(|error| error.to_string())?;
        }

        // Absent rather than zero when the character has never reported one: a row saying a
        // character holds nothing is a claim, and an old history has simply never been asked.
        if let Some(total) = snapshot.get("gold").and_then(|gold| optional_integer(gold, "total"))
        {
            transaction
                .execute(
                    "INSERT OR REPLACE INTO character_gold (character_id, total, observed_at)
                     VALUES (?1, ?2, ?3)",
                    params![
                        character_id,
                        total,
                        snapshot
                            .get("gold")
                            .and_then(|gold| optional_integer(gold, "at"))
                    ],
                )
                .map_err(|error| error.to_string())?;
        }

        let factions = snapshot.get("factions").cloned().unwrap_or(Value::Null);
        for (faction, held) in entries(&factions) {
            transaction
                .execute(
                    "INSERT INTO character_standings (
                         character_id, faction, standing, standing_current, standing_max,
                         ladder_rank, ladder, observed_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        character_id,
                        faction,
                        optional_text(held, "standing"),
                        optional_integer(held, "current"),
                        optional_integer(held, "max"),
                        optional_integer(held, "rank"),
                        optional_text(held, "system"),
                        optional_integer(held, "at")
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// The warband bank's balance, which is the account's rather than any character's.
///
/// Replaced outright each sync. There is nothing to merge: the addon reads one live pot, so a
/// newer reading is simply a better one, and an account whose file has never carried the key
/// keeps no row at all rather than gaining a zero it never claimed.
fn sync_warband(
    transaction: &Transaction<'_>,
    account_id: i64,
    warband: &Value,
) -> Result<(), String> {
    let Some(gold) = optional_integer(warband, "gold") else {
        return Ok(());
    };
    transaction
        .execute(
            "INSERT OR REPLACE INTO account_gold (account_id, warband, observed_at)
             VALUES (?1, ?2, ?3)",
            params![account_id, gold, optional_integer(warband, "at")],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn collect(
    wow_path: &Path,
    database_path: &Path,
    now: i64,
    options: Options,
) -> Result<SyncResult, String> {
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
            .optional()
            .map_err(|error| error.to_string())?;
        if previous == Some((source_modified_ns, source_size)) {
            continue;
        }
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        let saved = read_saved_variable(&text, "ChronieDB")?.unwrap_or_default();
        let segments = saved
            .get("segments")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        incoming.push(Incoming {
            source_key,
            source_modified_ns,
            source_size,
            segments: segments
                .iter()
                .cloned()
                .filter_map(normalized)
                .collect::<Vec<_>>(),
            lockouts: LockoutFeed::read(&saved),
            holdings: saved.get("holdings").cloned().unwrap_or(Value::Null),
            // Beside the per-character snapshots rather than inside them: the addon keys
            // `holdings` by character, and a warband entry in there would arrive here as a
            // character named "warband".
            warband: saved.get("warband").cloned().unwrap_or(Value::Null),
            markers: captures::markers(&saved),
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
    let ingested = ingest_images(&connection, wow_path, &store_root, &markers)?;
    drop(markers);

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
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
    transaction.commit().map_err(|error| error.to_string())?;

    // After the segments are in, because attaching a position to the visit it was recorded
    // during needs that visit to exist — and a sync that read a log first would leave every
    // point from the session that just ended waiting another thirty seconds for no reason.
    ingest_logs(&mut connection, wow_path, now)?;

    // Immediately after the read that decides it, and only when somebody has asked for it. A
    // log is eligible because a cursor says it was read to its end, so the sweep is worth
    // nothing before that cursor is up to date and is dangerous if it ever runs instead.
    if let Some(days) = options.retain_log_days {
        sweep_logs(&mut connection, wow_path, days, now)?;
    }

    // Last of all, and only for images a committed row now names. A file deleted here is one
    // Chronie has already read, copied, hashed, read back and written down.
    if !options.keep_originals {
        for image in ingested.values() {
            let _ = fs::remove_file(&image.original);
        }
    }

    let segment_count: usize = connection
        .query_row("SELECT COUNT(*) FROM segments", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(SyncResult {
        added,
        updated,
        segment_count,
    })
}

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
        "SELECT segment_id, species_id, name, collected_at, pet_guid
         FROM pets ORDER BY segment_id, position",
        "pets",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "name": row.get::<_, Option<String>>(2)?,
                "at": row.get::<_, Option<i64>>(3)?,
                "guid": row.get::<_, Option<String>>(4)?
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
                row.get::<_, Option<i64>>(6)?.map(|slot| serde_json::json!({
                    "slot": slot,
                    "itemId": row.get::<_, Option<i64>>(7).unwrap_or(None),
                    "itemLevel": row.get::<_, Option<i64>>(8).unwrap_or(None),
                    "itemName": row.get::<_, Option<String>>(9).unwrap_or(None),
                    "previousItemId": row.get::<_, Option<i64>>(10).unwrap_or(None),
                    "previousItemLevel": row.get::<_, Option<i64>>(11).unwrap_or(None),
                    "previousItemName": row.get::<_, Option<String>>(12).unwrap_or(None),
                })),
            ))
        })
        .map_err(|error| error.to_string())?;
    // The join hands back one row per slot, so a change with three slots arrives three
    // times. Changes come out grouped and in order, so the last one built is the one a
    // slot belongs to and no lookup table is needed.
    let mut open: Option<(i64, i64, Value)> = None;
    for row in rows {
        let (segment_id, change_id, change, slot) = row.map_err(|error| error.to_string())?;
        if open.as_ref().is_none_or(|(_, open_id, _)| *open_id != change_id) {
            if let Some((previous_segment, _, built)) = open.take() {
                push_event(&mut segments, &indices, previous_segment, "equipsetChanges", built);
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
        push_event(&mut segments, &indices, segment_id, "equipsetChanges", built);
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

    let holdings = account_holdings(&connection)?;

    Ok(serde_json::json!({
        "generatedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "knownActivityKinds": activity::KNOWN_KINDS,
        "segments": segments,
        "holdings": holdings,
    }))
}

/// What the account as a whole holds, aggregated from the per-character snapshots.
///
/// Aggregated here rather than in the addon because here it can be done for real: the
/// database holds every character the account has ever synced, where the client can only see
/// the one in front of it. The per-character rows travel with the rollup instead of being
/// summarised away — a total that cannot be broken back down into who holds what is a number
/// nobody can check, and the ages are what say how much of it is stale.
fn account_holdings(connection: &Connection) -> Result<Value, String> {
    let mut statement = connection
        .prepare(
            "SELECT h.currency_id, h.name, h.total, h.observed_at, c.source_key
             FROM character_currencies h
             JOIN characters c ON c.id = h.character_id
             ORDER BY h.currency_id, c.source_key",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut currencies: Vec<Value> = Vec::new();
    for row in rows {
        let (currency_id, name, total, observed_at, character) =
            row.map_err(|error| error.to_string())?;
        let holder = serde_json::json!({
            "character": character,
            "total": total,
            "at": observed_at,
        });
        match currencies
            .last_mut()
            .filter(|entry| entry["id"] == currency_id)
        {
            Some(entry) => {
                entry["total"] = serde_json::json!(entry["total"].as_i64().unwrap_or(0) + total);
                // The eldest reading in the sum, which is the weakest claim in it.
                if let Some(at) = observed_at {
                    if entry["oldest"].as_i64().is_none_or(|oldest| at < oldest) {
                        entry["oldest"] = serde_json::json!(at);
                    }
                }
                if entry["name"].is_null() {
                    entry["name"] = serde_json::json!(name);
                }
                if let Some(holders) = entry["characters"].as_array_mut() {
                    holders.push(holder);
                }
            }
            None => currencies.push(serde_json::json!({
                "id": currency_id,
                "name": name,
                "total": total,
                "oldest": observed_at,
                "characters": [holder],
            })),
        }
    }
    drop(statement);

    let mut statement = connection
        .prepare(
            "SELECT s.faction, s.standing, s.standing_current, s.standing_max,
                    s.ladder_rank, s.ladder, s.observed_at, c.source_key
             FROM character_standings s
             JOIN characters c ON c.id = s.character_id
             ORDER BY s.faction, c.source_key",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                serde_json::json!({
                    "character": row.get::<_, String>(7)?,
                    "standing": row.get::<_, Option<String>>(1)?,
                    "current": row.get::<_, Option<i64>>(2)?,
                    "max": row.get::<_, Option<i64>>(3)?,
                    "rank": row.get::<_, Option<i64>>(4)?,
                    "system": row.get::<_, Option<String>>(5)?,
                    "at": row.get::<_, Option<i64>>(6)?,
                }),
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut factions: Vec<Value> = Vec::new();
    for row in rows {
        let (faction, held) = row.map_err(|error| error.to_string())?;
        match factions
            .last_mut()
            .filter(|entry| entry["faction"] == faction)
        {
            Some(entry) => {
                if let Some(seen) = entry["characters"].as_array_mut() {
                    seen.push(held);
                }
            }
            None => factions.push(serde_json::json!({
                "faction": faction,
                "characters": [held],
            })),
        }
    }
    drop(statement);

    for entry in &mut factions {
        let seen = entry["characters"].as_array().cloned().unwrap_or_default();
        entry["best"] = best_standing(&seen);
    }

    Ok(serde_json::json!({
        "currencies": currencies,
        "factions": factions,
        "gold": account_gold(connection)?,
    }))
}

/// What the account is worth in gold: every wallet that has reported, and the warband bank.
///
/// The pot is added once rather than per character, because there is one of it. Everything
/// here is in copper, the unit the client counts in and the unit every other money figure in
/// this schema is already stored as.
///
/// Null when nothing has ever been read. A total of zero is a claim about an account, and an
/// account nobody has collected from has not made it.
fn account_gold(connection: &Connection) -> Result<Value, String> {
    let mut statement = connection
        .prepare(
            "SELECT c.source_key, g.total, g.observed_at
             FROM character_gold g
             JOIN characters c ON c.id = g.character_id
             ORDER BY c.source_key",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut characters: Vec<Value> = Vec::new();
    let mut wallets = 0;
    let mut oldest: Option<i64> = None;
    for row in rows {
        let (character, total, observed_at) = row.map_err(|error| error.to_string())?;
        wallets += total;
        if let Some(at) = observed_at {
            if oldest.is_none_or(|eldest| at < eldest) {
                oldest = Some(at);
            }
        }
        characters.push(serde_json::json!({
            "character": character,
            "total": total,
            "at": observed_at,
        }));
    }
    drop(statement);

    // Summed across accounts, the same way the wallets above are. Two accounts synced into one
    // history have two warband banks, and the roster's worth is both of them.
    let (warband, warband_at) = connection
        .query_row(
            "SELECT SUM(warband), MIN(observed_at) FROM account_gold",
            [],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;

    if characters.is_empty() && warband.is_none() {
        return Ok(Value::Null);
    }

    // The warband reading ages the total the same way a wallet does.
    if let Some(at) = warband_at {
        if oldest.is_none_or(|eldest| at < eldest) {
            oldest = Some(at);
        }
    }

    Ok(serde_json::json!({
        "characters": characters,
        "wallets": wallets,
        "warband": warband,
        "warbandAt": warband_at,
        "total": wallets + warband.unwrap_or(0),
        "oldest": oldest,
    }))
}

/// The furthest along any character has been seen with one faction.
///
/// Judged on the ladder most of them were read off, and never across two. A rank only means
/// anything against the same ladder: a client build that could not reach the friendship API
/// falls back to the reaction ladder, whose ranks run 1 to 8 against a friendship's several
/// thousand, and ranking those two against each other crowns the worse standing. The addon's
/// own store decides it the same way, and has to, because it answers the same question
/// without a database to do it in.
///
/// Null when no character's standing carries a rank at all — a faction the client would name
/// but not place has nothing to be judged on, which is not the same as nobody being ahead.
fn best_standing(seen: &[Value]) -> Value {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for held in seen {
        if held["rank"].as_i64().is_some() {
            if let Some(ladder) = held["system"].as_str() {
                *counts.entry(ladder).or_default() += 1;
            }
        }
    }
    // Ties break on the ladder's name so that which one wins never depends on the order the
    // rows happened to arrive in.
    let Some(ladder) = counts
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| right.0.cmp(left.0)))
        .map(|(ladder, _)| ladder.to_string())
    else {
        return Value::Null;
    };

    seen.iter()
        .filter(|held| {
            held["rank"].as_i64().is_some() && held["system"].as_str() == Some(ladder.as_str())
        })
        .max_by_key(|held| {
            (
                held["rank"].as_i64().unwrap_or(0),
                held["current"].as_i64().unwrap_or(0),
                // Rows arrive sorted by character, so reversing the name breaks a full tie
                // towards the first of them and the answer never depends on row order.
                std::cmp::Reverse(held["character"].as_str().unwrap_or("").to_string()),
            )
        })
        .cloned()
        .unwrap_or(Value::Null)
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
    let segment = segment_value(&transaction, segment_id)?;
    refresh_activities(&transaction, segment_id, &segment, now)?;
    transaction.commit().map_err(|error| error.to_string())
}

/* ---------- what somebody does to a capture ---------- */

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
fn segment_value(transaction: &Transaction<'_>, segment_id: i64) -> Result<Value, String> {
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
                Ok(serde_json::json!({
                    "instance": row.get::<_, String>(0)?,
                    "instanceType": row.get::<_, String>(1)?,
                    "difficulty": row.get::<_, String>(2)?,
                    "difficultyId": row.get::<_, Option<i64>>(3)?,
                    "seconds": row.get::<_, i64>(4)?,
                    "expansionTier": row.get::<_, Option<i64>>(5)?,
                    "latestExpansionTier": row.get::<_, Option<i64>>(6)?,
                    "experience": (gained != 0).then(|| serde_json::json!({
                        "gained": gained,
                        "percent": row.get::<_, f64>(8).unwrap_or(0.0),
                        "startLevel": row.get::<_, Option<i64>>(9).unwrap_or(None),
                        "endLevel": row.get::<_, Option<i64>>(10).unwrap_or(None),
                    })),
                }))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "That segment no longer exists.".to_string())?;

    let mut statement = transaction
        .prepare(
            "SELECT success FROM encounters WHERE segment_id = ?1 ORDER BY position",
        )
        .map_err(|error| error.to_string())?;
    let encounters = statement
        .query_map([segment_id], |row| {
            Ok(serde_json::json!({ "id": 0, "success": row.get::<_, i64>(0)? != 0 }))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    segment["encounters"] = Value::Array(encounters);

    let levels: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM level_ups WHERE segment_id = ?1",
            [segment_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    segment["levelUps"] = Value::Array(vec![serde_json::json!({}); levels as usize]);

    let keystone: Option<Value> = transaction
        .query_row(
            "SELECT level, map_id, affixes_json, completed, duration_ms, on_time, upgrades
             FROM keystone_runs WHERE segment_id = ?1",
            [segment_id],
            |row| {
                let affixes: String = row.get(2)?;
                Ok(serde_json::json!({
                    "level": row.get::<_, i64>(0)?,
                    "mapId": row.get::<_, Option<i64>>(1)?,
                    "affixes": serde_json::from_str::<Value>(&affixes)
                        .unwrap_or_else(|_| Value::Array(Vec::new())),
                    "completed": row.get::<_, i64>(3)? != 0,
                    "durationMs": row.get::<_, Option<i64>>(4)?,
                    "onTime": row.get::<_, Option<i64>>(5)?.map(|value| value != 0),
                    "upgrades": row.get::<_, Option<i64>>(6)?,
                }))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(keystone) = keystone {
        segment["keystone"] = keystone;
    }
    Ok(segment)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;
    use std::fs;

    const DAY_SECONDS: i64 = 86_400;

    #[test]
    fn reads_nested_saved_variables_without_game_runtime() {
        let parsed = read_saved_variable(
            r#"Other = { 1 }
ChronieDB = { ["segments"] = { { ["id"] = "synthetic-1", ["enabled"] = true, ["score"] = -2.5 } } }"#,
            "ChronieDB",
        ).unwrap().unwrap();
        assert_eq!(parsed["segments"][0]["id"], "synthetic-1");
        assert_eq!(parsed["segments"][0]["enabled"], true);
        assert_eq!(parsed["segments"][0]["score"], -2.5);
    }

    #[test]
    fn reports_bad_lua_with_a_line_number() {
        let error =
            read_saved_variable("ChronieDB = {\n  {\n nonsense nonsense", "ChronieDB").unwrap_err();
        assert!(error.contains("line 3"), "{error}");
    }

    #[test]
    fn resolves_an_install_root_or_retail_folder() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("_retail_").join("WTF")).unwrap();
        assert_eq!(
            resolve_wow_path(temp.path()).unwrap(),
            temp.path().join("_retail_")
        );
        assert_eq!(
            resolve_wow_path(&temp.path().join("_retail_")).unwrap(),
            temp.path().join("_retail_")
        );
    }

    #[test]
    fn collects_typed_segments_without_expiring_history() {
        let temp = tempfile::tempdir().unwrap();
        let wow = temp.path().join("_retail_");
        let saved = wow.join("WTF/Account/TEST/SavedVariables");
        fs::create_dir_all(&saved).unwrap();
        let now = 2_000_000_000_i64;
        fs::write(
            saved.join("chronie.lua"),
            format!(
                r#"
ChronieDB = {{ ["segments"] = {{
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
}} }}"#,
                now - 8 * DAY_SECONDS
            ),
        )
        .unwrap();
        let database = temp.path().join("data/chronie.sqlite3");
        let result = collect(&wow, &database, now, Options::default()).unwrap();
        assert_eq!(result.added, 2);
        assert_eq!(result.updated, 0);
        assert_eq!(result.segment_count, 2);

        let payload = dashboard(&database).unwrap();
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
        let connection = open_database(&database).unwrap();
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

        let unchanged = collect(&wow, &database, now + 1, Options::default()).unwrap();
        assert_eq!(unchanged.added, 0);
        assert_eq!(unchanged.updated, 0);
        assert_eq!(unchanged.segment_count, 2);

        fs::write(
            saved.join("chronie.lua"),
            r#"ChronieDB = { ["segments"] = {} }"#,
        )
        .unwrap();
        let result = collect(&wow, &database, now + DAY_SECONDS, Options::default()).unwrap();
        assert_eq!(result.segment_count, 2);
        assert_eq!(dashboard(&database).unwrap()["segments"][1]["id"], "old");
    }

    /// A wow folder holding one segment, written the way the addon writes it. Returns the
    /// paths so a test can sync, edit, and sync again against real storage.
    fn synthetic_install(segment_lua: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let wow = temp.path().join("_retail_");
        let saved = wow.join("WTF/Account/TEST/SavedVariables");
        fs::create_dir_all(&saved).unwrap();
        fs::write(
            saved.join("chronie.lua"),
            format!(r#"ChronieDB = {{ ["segments"] = {{ {segment_lua} }} }}"#),
        )
        .unwrap();
        let database = temp.path().join("data/chronie.sqlite3");
        (temp, wow, database)
    }

    /// The same file re-read; the collector skips a source whose size and timestamp are
    /// unchanged, so a test that wants a second pass has to make the file look different.
    fn touch(wow: &Path, segment_lua: &str) {
        let path = wow.join("WTF/Account/TEST/SavedVariables/chronie.lua");
        fs::write(
            &path,
            format!(r#"ChronieDB = {{ ["segments"] = {{ {segment_lua} }} }}  -- touched"#),
        )
        .unwrap();
    }

    fn activities_of(database: &Path) -> Vec<Value> {
        dashboard(database).unwrap()["segments"][0]["activities"]
            .as_array()
            .expect("an activities array")
            .clone()
    }

    const RAID_SEGMENT: &str = r#"
      { ["id"] = "raid-1", ["character"] = "Aster-Vale", ["instance"] = "Ulduar",
        ["instanceType"] = "raid", ["difficulty"] = "25 Player",
        ["expansionTier"] = 3, ["latestExpansionTier"] = 11,
        ["endedAt"] = 2000000000, ["startedAt"] = 1999990000, ["seconds"] = 10000,
        ["encounters"] = {
          { ["id"] = 745, ["name"] = "Flame Leviathan", ["success"] = true },
          { ["id"] = 746, ["name"] = "Ignis", ["success"] = false }
        } }
    "#;

    /// Two segments, each carrying one change to the same equipment set, written the way
    /// the addon writes them. The pair is the point: what the second change replaced can
    /// only come from the first, because nothing ever stores a "before".
    const EQUIPSET_SEGMENTS: &str = r#"
      { ["id"] = "set-1", ["character"] = "Aster-Vale", ["instance"] = "Valdrakken",
        ["instanceType"] = "none", ["endedAt"] = 2000000000, ["startedAt"] = 1999990000,
        ["equipsetChanges"] = {
          { ["setId"] = 3, ["name"] = "Raid", ["kind"] = "created", ["at"] = 1999990500,
            ["items"] = {
              { ["slot"] = 1, ["itemId"] = 100, ["itemLevel"] = 623,
                ["itemName"] = "Tideglass Crown" },
              { ["slot"] = 5, ["itemId"] = 200, ["itemLevel"] = 619,
                ["itemName"] = "Tideglass Robe" }
            } }
        } },
      { ["id"] = "set-2", ["character"] = "Aster-Vale", ["instance"] = "Valdrakken",
        ["instanceType"] = "none", ["endedAt"] = 2000100000, ["startedAt"] = 2000090000,
        ["equipsetChanges"] = {
          { ["setId"] = 3, ["name"] = "Raid", ["kind"] = "updated", ["at"] = 2000090500,
            ["items"] = {
              { ["slot"] = 1, ["itemId"] = 101, ["itemLevel"] = 639,
                ["itemName"] = "Deepwater Crown" }
            } }
        } }
    "#;

    #[test]
    fn stores_what_happened_to_an_equipment_set_and_what_each_slot_holds() {
        let (_temp, wow, database) = synthetic_install(EQUIPSET_SEGMENTS);

        collect(&wow, &database, 2_000_100_000, Options::default()).unwrap();

        let payload = dashboard(&database).unwrap();
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

    /// The whole reason the ledger stores only the state after a change: the row behind is
    /// the before, so an edit knows what it replaced without anyone writing it down twice.
    #[test]
    fn reads_what_a_slot_replaced_out_of_the_row_behind_it() {
        let (_temp, wow, database) = synthetic_install(EQUIPSET_SEGMENTS);

        collect(&wow, &database, 2_000_100_000, Options::default()).unwrap();

        let payload = dashboard(&database).unwrap();
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
        let (_temp, wow, database) = synthetic_install(cleared);

        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        let item = &dashboard(&database).unwrap()["segments"][0]["equipsetChanges"][0]["items"][0];
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
        let (_temp, wow, database) = synthetic_install(empty);

        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        let change = &dashboard(&database).unwrap()["segments"][0]["equipsetChanges"][0];
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
        let (_temp, wow, database) = synthetic_install(shared);

        collect(&wow, &database, 2_000_100_000, Options::default()).unwrap();

        let payload = dashboard(&database).unwrap();
        // Brann's creation is newest. It must not have inherited Aster's item as its before.
        let brann = &payload["segments"][0]["equipsetChanges"][0]["items"][0];
        assert_eq!(brann["itemId"], 500);
        assert_eq!(brann["previousItemId"], Value::Null);
    }

    /// Re-reading the same file rewrites a segment's rows, and the ledger must not grow a
    /// second copy of a change that already happened.
    #[test]
    fn does_not_double_a_change_when_the_same_segment_is_synced_again() {
        let (_temp, wow, database) = synthetic_install(EQUIPSET_SEGMENTS);
        collect(&wow, &database, 2_000_100_000, Options::default()).unwrap();

        touch(&wow, EQUIPSET_SEGMENTS);
        collect(&wow, &database, 2_000_100_001, Options::default()).unwrap();

        let connection = open_database(&database).unwrap();
        let changes: i64 = connection
            .query_row("SELECT COUNT(*) FROM equipset_changes", [], |row| row.get(0))
            .unwrap();
        let slots: i64 = connection
            .query_row("SELECT COUNT(*) FROM equipset_slots", [], |row| row.get(0))
            .unwrap();
        assert_eq!((changes, slots), (2, 3));

        let edit = &dashboard(&database).unwrap()["segments"][0]["equipsetChanges"][0];
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
        let (_temp, wow, database) = synthetic_install(nonsense);

        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        let segment = &dashboard(&database).unwrap()["segments"][0];
        assert_eq!(segment["equipsetChanges"], serde_json::json!([]));
        assert_eq!(segment["lootValue"], 40);
    }

    /// A history recorded before equipment sets were tracked has no such rows, and every
    /// reader of the payload is written to expect the key regardless.
    #[test]
    fn gives_a_segment_that_saw_no_set_change_an_empty_list() {
        let (_temp, wow, database) = synthetic_install(RAID_SEGMENT);

        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        assert_eq!(
            dashboard(&database).unwrap()["segments"][0]["equipsetChanges"],
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
        let (_temp, wow, database) = synthetic_install(HOLDING_SEGMENT);

        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        let segment = &dashboard(&database).unwrap()["segments"][0];
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
        let (_temp, wow, database) = synthetic_install(HOLDING_SEGMENT);

        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        let segment = &dashboard(&database).unwrap()["segments"][0];
        let currency = &segment["currencies"][1];
        assert_eq!(currency["name"], "Weathered Relic");
        assert_eq!(currency["amount"], 3);
        assert_eq!(currency["total"], Value::Null);
        assert!(
            currency.as_object().expect("a currency object").contains_key("total"),
            "the key has to be there and null, not missing: {currency}"
        );

        let faction = &segment["reputation"][1];
        assert_eq!(faction["faction"], "Lamplighters");
        assert_eq!(faction["standing"], Value::Null);
        assert_eq!(faction["current"], Value::Null);
        assert_eq!(faction["max"], Value::Null);
        let keys = faction.as_object().expect("a reputation object");
        for key in ["standing", "current", "max"] {
            assert!(keys.contains_key(key), "{key} has to be there and null: {faction}");
        }
    }

    /// A history collected before the holdings were kept has rows in both tables and no
    /// columns to put them in. The migration has to widen those tables under the rows that
    /// are already there rather than demanding a fresh install — and what it cannot know
    /// about an old row is exactly what a null says.
    #[test]
    fn migrates_a_database_written_before_holdings_were_kept() {
        let (_temp, wow, database) = synthetic_install(HOLDING_SEGMENT);
        {
            fs::create_dir_all(database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..4] {
                transaction.execute_batch(migration).unwrap();
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
            transaction.pragma_update(None, "user_version", 4_i64).unwrap();
            transaction.commit().unwrap();
        }

        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        let payload = dashboard(&database).unwrap();
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
        let (_temp, wow, database) = synthetic_install(keystone);

        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        let segment = &dashboard(&database).unwrap()["segments"][0];
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
    fn stores_encounters_with_their_wipes_and_guesses_a_legacy_raid() {
        let (_temp, wow, database) = synthetic_install(RAID_SEGMENT);

        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        let segment = &dashboard(&database).unwrap()["segments"][0];
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
        let (_temp, wow, database) = synthetic_install(RAID_SEGMENT);
        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();
        let segment_id = dashboard(&database).unwrap()["segments"][0]["segmentId"]
            .as_i64()
            .unwrap();
        let inferred = activities_of(&database);
        let inferred_id = inferred[0]["id"].as_i64().unwrap();

        // The user throws the guess away and files two corrections of their own.
        delete_activity(&database, inferred_id, 2_000_000_100).unwrap();
        add_activity(
            &database,
            segment_id,
            "transmog_farm",
            &serde_json::json!({ "note": "chasing the Val'anyr shards" }),
            2_000_000_200,
        )
        .unwrap();
        add_activity(
            &database,
            segment_id,
            "progress_raid",
            &serde_json::json!({ "bossesKilled": 9 }),
            2_000_000_300,
        )
        .unwrap();

        touch(&wow, RAID_SEGMENT);
        collect(&wow, &database, 2_000_000_400, Options::default()).unwrap();

        let after = activities_of(&database);
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
        let (_temp, wow, database) = synthetic_install(RAID_SEGMENT);
        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();
        let inferred_id = activities_of(&database)[0]["id"].as_i64().unwrap();

        update_activity(
            &database,
            inferred_id,
            "progress_raid",
            &serde_json::json!({ "bossesKilled": 4, "wipes": 12 }),
            2_000_000_100,
        )
        .unwrap();
        touch(&wow, RAID_SEGMENT);
        collect(&wow, &database, 2_000_000_200, Options::default()).unwrap();

        let after = activities_of(&database);
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
        let (_temp, wow, database) = synthetic_install(RAID_SEGMENT);
        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();
        assert_eq!(activities_of(&database)[0]["metadata"]["bossesKilled"], 1);

        // The same segment, filed again after the group killed a second boss.
        touch(
            &wow,
            &RAID_SEGMENT.replace(
                r#"{ ["id"] = 746, ["name"] = "Ignis", ["success"] = false }"#,
                r#"{ ["id"] = 746, ["name"] = "Ignis", ["success"] = true }"#,
            ),
        );
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let after = activities_of(&database);
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
        let (_temp, wow, database) = synthetic_install(RAID_SEGMENT);
        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();
        let segment_id = dashboard(&database).unwrap()["segments"][0]["segmentId"]
            .as_i64()
            .unwrap();
        delete_activity(
            &database,
            activities_of(&database)[0]["id"].as_i64().unwrap(),
            2_000_000_100,
        )
        .unwrap();
        add_activity(
            &database,
            segment_id,
            "transmog_farm",
            &serde_json::json!({}),
            2_000_000_200,
        )
        .unwrap();
        assert_eq!(activities_of(&database).len(), 1);

        reset_activities(&database, segment_id, 2_000_000_300).unwrap();

        let after = activities_of(&database);
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
        let (_temp, wow, database) = synthetic_install(keystone);
        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();
        let segment_id = dashboard(&database).unwrap()["segments"][0]["segmentId"]
            .as_i64()
            .unwrap();
        delete_activity(
            &database,
            activities_of(&database)[0]["id"].as_i64().unwrap(),
            2_000_000_100,
        )
        .unwrap();

        reset_activities(&database, segment_id, 2_000_000_200).unwrap();

        let after = activities_of(&database);
        assert_eq!(after[0]["kind"], "mythic_plus");
        assert_eq!(after[0]["metadata"]["keystoneLevel"], 9);
        assert_eq!(after[0]["metadata"]["timed"], false);
        assert_eq!(after[0]["metadata"]["durationSeconds"], 2400);
    }

    /// An existing database predates the activities schema entirely; the migration has to
    /// carry it forward rather than demanding a fresh install.
    #[test]
    fn migrates_a_database_written_before_activities_existed() {
        let (_temp, wow, database) = synthetic_install(RAID_SEGMENT);
        {
            fs::create_dir_all(database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&database).unwrap();
            let transaction = connection.transaction().unwrap();
            transaction.execute_batch(MIGRATIONS[0]).unwrap();
            transaction.pragma_update(None, "user_version", 1_i64).unwrap();
            transaction.commit().unwrap();
        }

        collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        assert_eq!(activities_of(&database)[0]["kind"], "legacy_raid");
    }

    /// Writes one account file holding only the addon's lockout tables, and collects it.
    /// Returns the paths so a test can write a second file and collect again.
    fn collect_lockouts(temp: &Path, body: &str, now: i64) -> PathBuf {
        let wow = temp.join("_retail_");
        let saved = wow.join("WTF/Account/TEST/SavedVariables");
        fs::create_dir_all(&saved).unwrap();
        fs::write(saved.join("chronie.lua"), format!("ChronieDB = {{ {body} }}")).unwrap();
        let database = temp.join("data/chronie.sqlite3");
        collect(&wow, &database, now, Options::default()).unwrap();
        database
    }

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
        let temp = tempfile::tempdir().unwrap();
        let database = collect_lockouts(temp.path(), ULDUAR_AND_DOOMWALKER, 2_000_000_000);

        assert_eq!(
            lockouts_of(&database),
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
        let temp = tempfile::tempdir().unwrap();
        let database = collect_lockouts(temp.path(), ULDUAR_AND_DOOMWALKER, 2_000_000_000);

        let connection = open_database(&database).unwrap();
        let mut statement = connection
            .prepare("SELECT name, killed FROM lockout_encounters ORDER BY position")
            .unwrap();
        let bosses = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
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
        let temp = tempfile::tempdir().unwrap();
        let database = collect_lockouts(temp.path(), ULDUAR_AND_DOOMWALKER, 2_000_000_000);

        let (class, level): (Option<String>, Option<i64>) = open_database(&database)
            .unwrap()
            .query_row(
                "SELECT class_file, last_level FROM characters WHERE source_key = 'Brin-Vale'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(class.as_deref(), Some("DRUID"));
        assert_eq!(level, Some(70));
        assert_eq!(count_of(&database, "segments"), 0);
    }

    #[test]
    fn keeps_two_difficulties_of_one_raid_as_two_lockouts_of_one_activity() {
        let temp = tempfile::tempdir().unwrap();
        let database = collect_lockouts(
            temp.path(),
            r#"
["characters"] = {
  ["Aster-Vale"] = {
    ["instance\0Ulduar\0003"] = { ["key"] = "instance\0Ulduar", ["activity"] = "Ulduar",
       ["kind"] = "raid", ["difficultyId"] = 3, ["expiry"] = 2000100000 },
    ["instance\0Ulduar\0004"] = { ["key"] = "instance\0Ulduar", ["activity"] = "Ulduar",
       ["kind"] = "raid", ["difficultyId"] = 4, ["expiry"] = 2000200000 },
  },
}"#,
            2_000_000_000,
        );

        assert_eq!(count_of(&database, "lockouts"), 2);
        assert_eq!(count_of(&database, "lockout_activities"), 1);
    }

    /// The client only ever reports what is true now, so a lockout that has dropped off the
    /// scan has lapsed. Leaving it behind would report a free character as barred.
    #[test]
    fn forgets_a_lockout_the_addon_stopped_reporting() {
        let temp = tempfile::tempdir().unwrap();
        let database = collect_lockouts(temp.path(), ULDUAR_AND_DOOMWALKER, 2_000_000_000);
        assert_eq!(count_of(&database, "lockouts"), 2);

        let wow = temp.path().join("_retail_");
        fs::write(
            wow.join("WTF/Account/TEST/SavedVariables/chronie.lua"),
            r#"ChronieDB = { ["characters"] = { ["Aster-Vale"] = {
                 ["instance\0Ulduar\0004"] = { ["key"] = "instance\0Ulduar",
                    ["activity"] = "Ulduar", ["kind"] = "raid", ["difficultyId"] = 4,
                    ["expiry"] = 2000100000 } } } }"#,
        )
        .unwrap();
        collect(&wow, &database, 2_000_300_000, Options::default()).unwrap();

        assert_eq!(
            lockouts_of(&database)
                .into_iter()
                .map(|row| row.0)
                .collect::<Vec<_>>(),
            vec!["Ulduar".to_string()]
        );
        assert_eq!(count_of(&database, "lockout_encounters"), 0);
    }

    /// An activity outlives every lockout on it, because what it records — the cadence — is
    /// learned across scans and would otherwise be thrown away every quiet week.
    #[test]
    fn keeps_an_activity_after_the_last_lockout_on_it_is_gone() {
        let temp = tempfile::tempdir().unwrap();
        let database = collect_lockouts(temp.path(), ULDUAR_AND_DOOMWALKER, 2_000_000_000);

        let wow = temp.path().join("_retail_");
        fs::write(
            wow.join("WTF/Account/TEST/SavedVariables/chronie.lua"),
            r#"ChronieDB = { ["activities"] = { ["instance\0Ulduar"] = { ["activity"] = "Ulduar",
                 ["kind"] = "raid", ["period"] = "weekly" } },
                 ["characters"] = { ["Aster-Vale"] = { } } }"#,
        )
        .unwrap();
        collect(&wow, &database, 2_000_300_000, Options::default()).unwrap();

        assert_eq!(count_of(&database, "lockouts"), 0);
        assert_eq!(count_of(&database, "lockout_activities"), 2);
    }

    /// A cadence already worked out is not unlearned by a file that could not state one.
    #[test]
    fn keeps_a_known_cadence_when_a_later_file_cannot_state_one() {
        let temp = tempfile::tempdir().unwrap();
        let database = collect_lockouts(temp.path(), ULDUAR_AND_DOOMWALKER, 2_000_000_000);

        let wow = temp.path().join("_retail_");
        fs::write(
            wow.join("WTF/Account/TEST/SavedVariables/chronie.lua"),
            r#"ChronieDB = { ["activities"] = { ["instance\0Ulduar"] = { ["activity"] = "Ulduar",
                 ["kind"] = "raid" } } }"#,
        )
        .unwrap();
        collect(&wow, &database, 2_000_300_000, Options::default()).unwrap();

        assert_eq!(cadence_of(&database, "Ulduar"), "weekly");
    }

    /// The cadence follows from the kind, so a save that never stated one still lands on the
    /// right answer rather than on 'unknown'.
    #[test]
    fn reads_a_cadence_off_the_kind_when_the_addon_did_not_state_one() {
        let temp = tempfile::tempdir().unwrap();
        let database = collect_lockouts(
            temp.path(),
            r#"
["activities"] = {
  ["instance\0Ulduar"] = { ["activity"] = "Ulduar", ["kind"] = "raid" },
  ["instance\0Deadmines"] = { ["activity"] = "Deadmines", ["kind"] = "dungeon" },
  ["worldboss\00017711"] = { ["activity"] = "Doomwalker", ["kind"] = "world_boss" },
}"#,
            2_000_000_000,
        );

        assert_eq!(cadence_of(&database, "Ulduar"), "weekly");
        assert_eq!(cadence_of(&database, "Deadmines"), "daily");
        assert_eq!(cadence_of(&database, "Doomwalker"), "weekly");
    }

    /// A file from before activities were recorded separately names only the instance. It
    /// must land on the same activity a freshly written one does, or one raid becomes two.
    #[test]
    fn files_a_pre_activity_save_under_the_activity_a_current_one_would_use() {
        let temp = tempfile::tempdir().unwrap();
        let database = collect_lockouts(
            temp.path(),
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
            2_000_000_000,
        );

        assert_eq!(count_of(&database, "lockout_activities"), 1);
        assert_eq!(count_of(&database, "lockouts"), 2);
        assert_eq!(lockouts_of(&database)[0].1, "raid");
    }

    /// Lockouts ride the same file as segments, and neither may cost the other.
    #[test]
    fn collects_lockouts_and_segments_out_of_one_file() {
        let temp = tempfile::tempdir().unwrap();
        let wow = temp.path().join("_retail_");
        let saved = wow.join("WTF/Account/TEST/SavedVariables");
        fs::create_dir_all(&saved).unwrap();
        fs::write(
            saved.join("chronie.lua"),
            r#"ChronieDB = {
                 ["segments"] = { { ["id"] = "kept", ["character"] = "Aster-Vale",
                    ["instance"] = "Ulduar", ["endedAt"] = 1999999000 } },
                 ["characters"] = { ["Aster-Vale"] = {
                    ["instance\0Ulduar\0004"] = { ["key"] = "instance\0Ulduar",
                       ["activity"] = "Ulduar", ["kind"] = "raid", ["difficultyId"] = 4,
                       ["expiry"] = 2000100000 } } } }"#,
        )
        .unwrap();
        let database = temp.path().join("data/chronie.sqlite3");

        let result = collect(&wow, &database, 2_000_000_000, Options::default()).unwrap();

        assert_eq!(result.added, 1);
        assert_eq!(count_of(&database, "lockouts"), 1);
        // One character, reached from both directions.
        assert_eq!(count_of(&database, "characters"), 1);
    }

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

    /// A wow folder with all three of the places a capture lives on disk: the entries store,
    /// the segments beside it, and the folder the client leaves its screenshots in.
    fn capture_install(
        entries_lua: &str,
        segments_lua: &str,
    ) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let wow = temp.path().join("_retail_");
        fs::create_dir_all(wow.join("WTF/Account/TEST/SavedVariables")).unwrap();
        fs::create_dir_all(wow.join(captures::GAME_FOLDER)).unwrap();
        let database = temp.path().join("data/chronie.sqlite3");
        write_saved(&wow, entries_lua, segments_lua, "");
        (temp, wow, database)
    }

    /// The same store rewritten. The trailing note is what makes the file look different to a
    /// collector that skips a source whose size and timestamp are unchanged.
    fn write_saved(wow: &Path, entries_lua: &str, segments_lua: &str, note: &str) {
        fs::write(
            wow.join("WTF/Account/TEST/SavedVariables/chronie.lua"),
            format!(
                r#"ChronieDB = {{ ["segments"] = {{ {segments_lua} }},
                                  ["entries"] = {{ {entries_lua} }} }} {note}"#
            ),
        )
        .unwrap();
    }

    /// A file in the game's screenshot folder, under the name the client would give it.
    fn screenshot(wow: &Path, stamp: &str, bytes: &[u8]) -> PathBuf {
        let path = wow
            .join(captures::GAME_FOLDER)
            .join(format!("WoWScrnShot_{stamp}.jpg"));
        fs::write(&path, bytes).unwrap();
        path
    }

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
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        let original = screenshot(&wow, "111423_120000", b"a picture of Ulduar");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let connection = open_database(&database).unwrap();
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

        let stored = store_root(&database).join(&file_path);
        assert_eq!(fs::read(&stored).unwrap(), b"a picture of Ulduar");
        assert!(
            file_path.starts_with(&format!("{}/", &hash[..2])),
            "named for its own contents: {file_path}"
        );
        assert!(!original.exists(), "the game's copy is moved, not left");
    }

    #[test]
    fn ingests_the_same_capture_only_once_however_often_it_is_read() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        let first = capture_row(&database, "TEST|2000000000|1");

        // The same entries and the same segment, read again because something else in the
        // file changed. The image it names is long gone from the game's folder by now, which
        // is exactly the trap: nothing here may conclude the image is missing.
        write_saved(&wow, CAPTURE_ENTRY, CAPTURE_SEGMENT, "-- touched");
        collect(&wow, &database, 2_000_000_200, Options::default()).unwrap();

        assert_eq!(count_of(&database, "captures"), 1);
        // The same rowid, so the row was never deleted and rebuilt the way a segment's
        // children are — which is the whole reason captures are not one of them.
        assert_eq!(capture_row(&database, "TEST|2000000000|1"), first);
        assert_eq!(stored_files(&store_root(&database)), 1);
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
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");
        collect(&wow, &database, 2_000_000_100, keep).unwrap();

        write_saved(&wow, CAPTURE_ENTRY, CAPTURE_SEGMENT, "-- touched");
        collect(&wow, &database, 2_000_000_200, keep).unwrap();

        let ingested_at: i64 = open_database(&database)
            .unwrap()
            .query_row("SELECT ingested_at FROM captures", [], |row| row.get(0))
            .unwrap();
        assert_eq!(ingested_at, 2_000_000_100, "taken custody of once");
    }

    #[test]
    fn records_a_marker_whose_file_cannot_be_found() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let (_, state, file_path, _) = capture_row(&database, "TEST|2000000000|1");
        assert_eq!(state, "missing");
        assert_eq!(file_path, None);
    }

    #[test]
    fn looks_again_for_an_image_that_was_not_there_the_first_time() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        assert_eq!(capture_row(&database, "TEST|2000000000|1").1, "missing");

        // Written afterwards, and SavedVariables untouched — so this sync reads no markers at
        // all and still has to go looking on behalf of the row that is waiting.
        screenshot(&wow, "111423_120000", b"late");
        collect(&wow, &database, 2_000_000_200, Options::default()).unwrap();

        let (_, state, file_path, _) = capture_row(&database, "TEST|2000000000|1");
        assert_eq!(state, "stored");
        assert_eq!(
            fs::read(store_root(&database).join(file_path.unwrap())).unwrap(),
            b"late"
        );
    }

    #[test]
    fn attaches_a_capture_to_a_segment_that_arrives_after_it() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, "");
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        let (_, state, _, segment) = capture_row(&database, "TEST|2000000000|1");
        assert_eq!(state, "stored", "the image does not wait for the segment");
        assert_eq!(segment, None);

        write_saved(&wow, CAPTURE_ENTRY, CAPTURE_SEGMENT, "-- touched");
        collect(&wow, &database, 2_000_000_200, Options::default()).unwrap();

        assert!(capture_row(&database, "TEST|2000000000|1").3.is_some());
    }

    #[test]
    fn keeps_a_capture_after_the_segment_it_named_is_gone() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        open_database(&database)
            .unwrap()
            .execute("DELETE FROM segments", [])
            .unwrap();

        // Unattached, not deleted. The link is a link; the photograph is nobody's child.
        let (_, state, file_path, segment) = capture_row(&database, "TEST|2000000000|1");
        assert_eq!(state, "stored");
        assert_eq!(segment, None);
        assert!(store_root(&database).join(file_path.unwrap()).is_file());
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
        let (_temp, wow, database) = capture_install(
            CAPTURE_ENTRY_OF_ACHIEVEMENT,
            CAPTURE_SEGMENT_WITH_ACHIEVEMENTS,
        );
        screenshot(&wow, "111423_120000", b"a picture of Observed");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let (trigger, source, achievement) = capture_subject(&database, "TEST|2000000000|1");
        assert_eq!(trigger.as_deref(), Some("accountFirstAchievement"));
        assert_eq!(source, Some(4001));

        // The one it names, not merely one of the segment's.
        let earned: i64 = open_database(&database)
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
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        assert_eq!(
            capture_subject(&database, "TEST|2000000000|1"),
            (None, None, None)
        );
    }

    /// The reason the link is re-resolved rather than written once: `clear_outcomes` deletes
    /// and reinserts the achievements of every segment the file still describes, on every
    /// single sync. Their rowids do not survive one, so a link left alone would end up
    /// pointing at whatever row inherited its number — a real achievement, and the wrong one.
    #[test]
    fn follows_the_achievement_through_the_rebuild_every_sync_does_to_it() {
        let (_temp, wow, database) = capture_install(
            CAPTURE_ENTRY_OF_ACHIEVEMENT,
            CAPTURE_SEGMENTS_SIDE_BY_SIDE,
        );
        screenshot(&wow, "111423_120000", b"a picture of Observed");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        let first = capture_subject(&database, "TEST|2000000000|1").2.unwrap();

        write_saved(
            &wow,
            CAPTURE_ENTRY_OF_ACHIEVEMENT,
            CAPTURE_SEGMENTS_SIDE_BY_SIDE,
            "-- touched",
        );
        collect(&wow, &database, 2_000_000_200, Options::default()).unwrap();

        let rebuilt = capture_subject(&database, "TEST|2000000000|1").2.unwrap();
        assert_ne!(
            rebuilt, first,
            "the rebuild was expected to move the row this test is about"
        );
        let earned: i64 = open_database(&database)
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
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY_OF_ACHIEVEMENT, "");
        screenshot(&wow, "111423_120000", b"a picture of Observed");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        let (trigger, source, achievement) = capture_subject(&database, "TEST|2000000000|1");
        assert_eq!(trigger.as_deref(), Some("accountFirstAchievement"));
        assert_eq!(source, Some(4001), "the id it is waiting to resolve");
        assert_eq!(achievement, None);

        write_saved(
            &wow,
            CAPTURE_ENTRY_OF_ACHIEVEMENT,
            CAPTURE_SEGMENT_WITH_ACHIEVEMENTS,
            "-- touched",
        );
        collect(&wow, &database, 2_000_000_200, Options::default()).unwrap();

        assert!(capture_subject(&database, "TEST|2000000000|1").2.is_some());
    }

    /// A segment ages out of the rolling week and takes its achievements with it. The
    /// photograph is nobody's child: it is left unattached, and it still says what it was of.
    #[test]
    fn keeps_a_capture_after_the_achievement_it_named_is_gone() {
        let (_temp, wow, database) = capture_install(
            CAPTURE_ENTRY_OF_ACHIEVEMENT,
            CAPTURE_SEGMENT_WITH_ACHIEVEMENTS,
        );
        screenshot(&wow, "111423_120000", b"a picture of Observed");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let connection = open_database(&database).unwrap();
        connection.execute("DELETE FROM achievements", []).unwrap();

        let (trigger, source, achievement) = capture_subject(&database, "TEST|2000000000|1");
        assert_eq!(achievement, None, "the foreign key let go rather than held");
        assert_eq!(trigger.as_deref(), Some("accountFirstAchievement"));
        assert_eq!(source, Some(4001));
        assert_eq!(count_of(&database, "captures"), 1);
    }

    #[test]
    fn records_an_entry_that_asked_for_no_picture() {
        let note = r#"
          { ["id"] = "TEST|2000000000|2", ["at"] = 2000000000,
            ["stamp"] = "111423_120000", ["character"] = "Aster-Vale", ["author"] = "TEST" }
        "#;
        let (_temp, wow, database) = capture_install(note, CAPTURE_SEGMENT);
        let bystander = screenshot(&wow, "111423_120000", b"somebody else's shot");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let (_, state, file_path, _) = capture_row(&database, "TEST|2000000000|2");
        assert_eq!(state, "none");
        assert_eq!(file_path, None);
        assert!(bystander.exists(), "an entry with no image claims no file");
    }

    #[test]
    fn leaves_the_players_own_archive_where_it_is() {
        let (_temp, wow, database) = capture_install("", CAPTURE_SEGMENT);
        let archive = [
            screenshot(&wow, "010119_080000", b"a screenshot from 2019"),
            screenshot(&wow, "070420_211500", b"and one from 2020"),
            screenshot(&wow, "111423_120000", b"and one from today"),
        ];

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        // Marker-driven, all the way down. Thousands of files nothing has a marker for are
        // not orphans to be swept up; ingesting them is a different feature entirely.
        assert_eq!(count_of(&database, "captures"), 0);
        assert_eq!(stored_files(&store_root(&database)), 0);
        assert!(archive.iter().all(|path| path.is_file()));
    }

    #[test]
    fn keeps_the_games_own_copy_when_the_setting_asks_it_to() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        let original = screenshot(&wow, "111423_120000", b"a picture of Ulduar");

        collect(
            &wow,
            &database,
            2_000_000_100,
            Options {
                keep_originals: true,
                ..Options::default()
            },
        )
        .unwrap();

        let (_, state, file_path, _) = capture_row(&database, "TEST|2000000000|1");
        assert_eq!(state, "stored");
        assert_eq!(fs::read(&original).unwrap(), b"a picture of Ulduar");
        assert_eq!(
            fs::read(store_root(&database).join(file_path.unwrap())).unwrap(),
            b"a picture of Ulduar"
        );
    }

    #[test]
    fn migrates_a_database_written_before_captures_were_kept() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");
        {
            fs::create_dir_all(database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..5] {
                transaction.execute_batch(migration).unwrap();
            }
            transaction.pragma_update(None, "user_version", 5_i64).unwrap();
            transaction.commit().unwrap();
        }

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        assert_eq!(capture_row(&database, "TEST|2000000000|1").1, "stored");
    }

    /// The subject columns arrive by ALTER TABLE onto a table that already has rows in it,
    /// which is the case a fresh database never exercises. The photographs somebody already
    /// has must survive it and the new ones must be filed against what they are of.
    #[test]
    fn migrates_a_database_written_before_a_capture_could_say_what_it_was_of() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");
        {
            fs::create_dir_all(database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..8] {
                transaction.execute_batch(migration).unwrap();
            }
            transaction.pragma_update(None, "user_version", 8_i64).unwrap();
            transaction.commit().unwrap();
        }
        // A photograph taken and stored under the old schema, before the columns existed.
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        assert_eq!(capture_row(&database, "TEST|2000000000|1").1, "stored");

        write_saved(
            &wow,
            CAPTURE_ENTRY_OF_ACHIEVEMENT,
            CAPTURE_SEGMENT_WITH_ACHIEVEMENTS,
            "-- touched",
        );
        collect(&wow, &database, 2_000_000_200, Options::default()).unwrap();

        let (trigger, source, achievement) = capture_subject(&database, "TEST|2000000000|1");
        assert_eq!(trigger.as_deref(), Some("accountFirstAchievement"));
        assert_eq!(source, Some(4001));
        assert!(achievement.is_some());
        assert_eq!(capture_row(&database, "TEST|2000000000|1").1, "stored");
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
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY_WITH_NOTE, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        assert_eq!(capture_note(&database, "TEST|2000000000|1").0.as_deref(), Some("first Yogg kill"));
        // And nothing claims the app wrote it, which is what leaves the game free to correct
        // it on a later sync.
        assert_eq!(capture_note(&database, "TEST|2000000000|1").1, None);
        assert_eq!(dashboard_captures(&database)[0]["note"], "first Yogg kill");
    }

    // The marker keeps whatever was typed in game for as long as the entry exists, and it is
    // read again on every single sync. An edit that a logout undid would be worse than no
    // editing at all: somebody would type the sentence, see it, and lose it silently.
    #[test]
    fn keeps_an_edited_note_through_the_syncs_that_read_the_marker_again() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY_WITH_NOTE, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        let capture_id = capture_row(&database, "TEST|2000000000|1").0;

        set_capture_note(&database, capture_id, "  Yogg-Saron, no lights  ", 2_000_000_200).unwrap();
        write_saved(&wow, CAPTURE_ENTRY_WITH_NOTE, CAPTURE_SEGMENT, "-- touched");
        collect(&wow, &database, 2_000_000_300, Options::default()).unwrap();

        let (note, edited) = capture_note(&database, "TEST|2000000000|1");
        assert_eq!(note.as_deref(), Some("Yogg-Saron, no lights"));
        assert_eq!(edited, Some(2_000_000_200));
    }

    // Clearing is an edit like any other, and the state it leaves behind is the one a capture
    // nobody ever wrote about is in — which is why it has to be the same NULL and not an
    // empty string that every reader downstream would have to know about.
    #[test]
    fn keeps_a_note_cleared_rather_than_letting_the_next_sync_put_it_back() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY_WITH_NOTE, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        let capture_id = capture_row(&database, "TEST|2000000000|1").0;

        set_capture_note(&database, capture_id, "   ", 2_000_000_200).unwrap();
        write_saved(&wow, CAPTURE_ENTRY_WITH_NOTE, CAPTURE_SEGMENT, "-- touched");
        collect(&wow, &database, 2_000_000_300, Options::default()).unwrap();

        assert_eq!(capture_note(&database, "TEST|2000000000|1").0, None);
    }

    // The same rules the addon holds a typed note to, applied to the app's own field, so that
    // "a stored note holds no pipe" is true of every note however it was written.
    #[test]
    fn cleans_a_note_typed_in_the_app_the_way_the_game_cleans_one() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        let capture_id = capture_row(&database, "TEST|2000000000|1").0;

        set_capture_note(
            &database,
            capture_id,
            "got |cffa335ee|Hitem:19019|h[Thunderfury]|h|r\nat last",
            2_000_000_200,
        )
        .unwrap();

        // Down to the `r` left behind by `|r`, which `ns.entryText` also leaves: it strips the
        // pipe and keeps what follows, and the two implementations agreeing is worth more than
        // either of them being tidier than the other.
        assert_eq!(
            capture_note(&database, "TEST|2000000000|1").0.as_deref(),
            Some("got [Thunderfury]r at last"),
        );
    }

    #[test]
    fn refuses_to_write_a_note_on_a_capture_that_is_gone() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let error = set_capture_note(&database, 9999, "nothing to say", 2_000_000_200).unwrap_err();
        assert!(error.contains("no longer in Chronie's history"), "{error}");
    }

    // Deleting is the row and the file together, and it stays deleted: `db.entries` never
    // prunes, so the marker for this capture is read again on every sync for as long as the
    // player keeps that file. A photograph that came back as a broken tile after being thrown
    // away would be worse than one that could not be thrown away at all.
    #[test]
    fn deletes_the_row_and_the_file_and_does_not_ingest_it_again() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        let (capture_id, _, file_path, _) = capture_row(&database, "TEST|2000000000|1");
        let store = store_root(&database);
        let image = store.join(file_path.unwrap());
        assert!(image.is_file());

        delete_capture(&database, capture_id, 2_000_000_200).unwrap();

        assert!(!image.exists(), "the file goes with the row");
        assert_eq!(count_of(&database, "captures"), 0);

        // The marker is still in the file, and the original is still where the player left it
        // — which is exactly the case a sync would otherwise ingest all over again.
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");
        write_saved(&wow, CAPTURE_ENTRY, CAPTURE_SEGMENT, "-- touched");
        collect(&wow, &database, 2_000_000_300, Options::default()).unwrap();

        assert_eq!(count_of(&database, "captures"), 0);
        assert!(!image.exists());
    }

    // The store is content-addressed, so two captures of identical bytes are one file. Deleting
    // one of them must not blank the other, which would be a picture nobody asked to lose.
    #[test]
    fn keeps_a_file_a_second_capture_still_names() {
        let twins = format!("{CAPTURE_ENTRY}, {}", r#"
          { ["id"] = "TEST|2000000001|2", ["schema"] = 1, ["at"] = 2000000001,
            ["stamp"] = "111423_120001", ["character"] = "Aster-Vale", ["author"] = "TEST",
            ["segment"] = "Aster-Vale|1999990000|Ulduar", ["hasImage"] = true }
        "#);
        let (_temp, wow, database) = capture_install(&twins, CAPTURE_SEGMENT);
        screenshot(&wow, "111423_120000", b"the very same picture");
        screenshot(&wow, "111423_120001", b"the very same picture");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        let first = capture_row(&database, "TEST|2000000000|1");
        let second = capture_row(&database, "TEST|2000000001|2");
        assert_eq!(first.2, second.2, "one file, named by both rows");
        let image = store_root(&database).join(second.2.clone().unwrap());

        delete_capture(&database, first.0, 2_000_000_200).unwrap();

        assert_eq!(count_of(&database, "captures"), 1);
        assert!(image.is_file(), "the surviving capture still has its picture");
    }

    #[test]
    fn deletes_a_capture_that_has_already_gone_without_complaining() {
        let (_temp, wow, database) = capture_install(CAPTURE_ENTRY, CAPTURE_SEGMENT);
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        delete_capture(&database, 9999, 2_000_000_200).unwrap();
    }

    // What the window is drawn from. The state of the image travels with every row because
    // the three ways there is no picture — one is coming, none was asked for, the file was
    // never found — are three different things to say and not one blank tile.
    #[test]
    fn hands_the_window_the_captures_of_the_segment_they_were_taken_in() {
        let entries = format!("{CAPTURE_ENTRY_WITH_NOTE}, {}", r#"
          { ["id"] = "TEST|2000000050|2", ["schema"] = 1, ["at"] = 2000000050,
            ["stamp"] = "111423_130000", ["character"] = "Aster-Vale", ["author"] = "TEST",
            ["segment"] = "Aster-Vale|1999990000|Ulduar", ["hasImage"] = true }
        "#);
        let (_temp, wow, database) = capture_install(&entries, CAPTURE_SEGMENT);
        // Only the first has a file waiting for it; the second is a marker whose picture was
        // never found, which is a row the window has to show and explain rather than drop.
        screenshot(&wow, "111423_120000", b"a picture of Ulduar");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let captures = dashboard_captures(&database);
        assert_eq!(captures.len(), 2);
        assert_eq!(captures[0]["sourceId"], "TEST|2000000000|1");
        assert_eq!(captures[0]["imageState"], "stored");
        assert_eq!(captures[0]["note"], "first Yogg kill");
        assert_eq!(captures[0]["byteSize"], 19);
        assert_eq!(captures[1]["imageState"], "missing");
        assert_eq!(captures[1]["note"], Value::Null);
    }

    /// An install whose SavedVariables carry the addon's per-character snapshot and nothing
    /// else. No segments on purpose: what a character holds is a fact about the character,
    /// and it has to reach the database whether or not that character has filed a segment.
    fn holdings_install(holdings_lua: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let wow = temp.path().join("_retail_");
        let saved = wow.join("WTF/Account/TEST/SavedVariables");
        fs::create_dir_all(&saved).unwrap();
        fs::write(
            saved.join("chronie.lua"),
            format!(r#"ChronieDB = {{ ["holdings"] = {{ {holdings_lua} }} }}"#),
        )
        .unwrap();
        let database = temp.path().join("data/chronie.sqlite3");
        (temp, wow, database)
    }

    fn rewrite_holdings(wow: &Path, holdings_lua: &str) {
        fs::write(
            wow.join("WTF/Account/TEST/SavedVariables/chronie.lua"),
            format!(r#"ChronieDB = {{ ["holdings"] = {{ {holdings_lua} }} }} -- touched"#),
        )
        .unwrap();
    }

    const TWO_CHARACTERS: &str = r#"
        ["Alt-Ravencrest"] = {
            ["updatedAt"] = 2000000000,
            ["currencies"] = {
                [3008] = { ["name"] = "Valorstones", ["total"] = 800, ["at"] = 1999913600 },
            },
            ["factions"] = {
                ["Dream Wardens"] = {
                    ["standing"] = "Renown 22", ["current"] = 100, ["max"] = 2500,
                    ["rank"] = 22, ["system"] = "renown", ["at"] = 1999913600,
                },
            },
        },
        ["Main-Ravencrest"] = {
            ["updatedAt"] = 2000000000,
            ["currencies"] = {
                [3008] = { ["name"] = "Valorstones", ["total"] = 1200, ["at"] = 2000000000 },
                [2245] = { ["name"] = "Flightstones", ["total"] = 400, ["at"] = 2000000000 },
            },
            ["factions"] = {
                ["Dream Wardens"] = {
                    ["standing"] = "Renown 8", ["current"] = 500, ["max"] = 2500,
                    ["rank"] = 8, ["system"] = "renown", ["at"] = 2000000000,
                },
            },
        },
    "#;

    #[test]
    fn sums_a_currency_across_every_character_that_holds_any() {
        let (_temp, wow, database) = holdings_install(TWO_CHARACTERS);

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let holdings = &dashboard(&database).unwrap()["holdings"];
        let valorstones = &holdings["currencies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == 3008)
            .cloned()
            .unwrap();
        assert_eq!(valorstones["total"], 2000);
        assert_eq!(valorstones["name"], "Valorstones");
        // The total breaks back down into who holds what, and says how old the eldest of
        // those readings is — a sum nobody can check is a number nobody should trust.
        assert_eq!(valorstones["characters"].as_array().unwrap().len(), 2);
        assert_eq!(valorstones["characters"][0]["character"], "Alt-Ravencrest");
        assert_eq!(valorstones["characters"][0]["total"], 800);
        assert_eq!(valorstones["oldest"], 1_999_913_600_i64);
    }

    #[test]
    fn crowns_the_character_that_has_got_furthest_with_a_faction() {
        let (_temp, wow, database) = holdings_install(TWO_CHARACTERS);

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let holdings = &dashboard(&database).unwrap()["holdings"];
        let wardens = &holdings["factions"][0];
        assert_eq!(wardens["faction"], "Dream Wardens");
        assert_eq!(wardens["best"]["character"], "Alt-Ravencrest");
        assert_eq!(wardens["best"]["standing"], "Renown 22");
        assert_eq!(wardens["characters"].as_array().unwrap().len(), 2);
    }

    /// A build that cannot reach the friendship API falls back to the reaction ladder, whose
    /// ranks run 1 to 8 against a friendship's several thousand. Judging the two against each
    /// other would crown whichever ladder counts higher rather than whichever character is
    /// further along, so the odd reading out is set aside — listed, never crowned.
    #[test]
    fn judges_a_faction_on_the_ladder_most_of_its_characters_were_read_off() {
        let (_temp, wow, database) = holdings_install(
            r#"
            ["Main-Ravencrest"] = { ["factions"] = { ["Brann Bronzebeard"] = {
                ["standing"] = "Best Friend", ["rank"] = 8400, ["system"] = "friendship",
            } } },
            ["Second-Ravencrest"] = { ["factions"] = { ["Brann Bronzebeard"] = {
                ["standing"] = "Pal", ["rank"] = 1200, ["system"] = "friendship",
            } } },
            ["Odd-Ravencrest"] = { ["factions"] = { ["Brann Bronzebeard"] = {
                ["standing"] = "Honored", ["rank"] = 6, ["system"] = "reaction",
            } } },
        "#,
        );

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let brann = &dashboard(&database).unwrap()["holdings"]["factions"][0];
        assert_eq!(brann["best"]["character"], "Main-Ravencrest");
        assert_eq!(brann["characters"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn leaves_a_faction_uncrowned_when_no_standing_can_be_placed_on_a_ladder() {
        let (_temp, wow, database) = holdings_install(
            r#"["Main-Ravencrest"] = { ["factions"] = { ["Hallowfall Arathi"] = {
                ["standing"] = "Honored",
            } } },"#,
        );

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let arathi = &dashboard(&database).unwrap()["holdings"]["factions"][0];
        // Null rather than the only row there is: nothing here can be ranked, which is not
        // the same as this character being the one out in front.
        assert!(arathi["best"].is_null());
        assert_eq!(arathi["characters"].as_array().unwrap().len(), 1);
    }

    /// A snapshot is where one character stands, not a log of where it has stood. Half of an
    /// old one beside half of a new one is a position no character was ever in.
    #[test]
    fn replaces_a_characters_snapshot_rather_than_layering_on_it() {
        let (_temp, wow, database) = holdings_install(TWO_CHARACTERS);
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        rewrite_holdings(
            &wow,
            r#"["Main-Ravencrest"] = { ["currencies"] = {
                [3008] = { ["name"] = "Valorstones", ["total"] = 50, ["at"] = 2000100000 },
            } },"#,
        );
        collect(&wow, &database, 2_000_100_100, Options::default()).unwrap();

        let currencies = dashboard(&database).unwrap()["holdings"]["currencies"]
            .as_array()
            .cloned()
            .unwrap();
        let valorstones = currencies
            .iter()
            .find(|entry| entry["id"] == 3008)
            .cloned()
            .unwrap();
        // 800 from the alt, which said nothing this time and so still stands, and 50 from
        // the main, which replaced its 1,200 rather than adding to it.
        assert_eq!(valorstones["total"], 850);
        // Flightstones went with the snapshot it belonged to.
        assert!(!currencies.iter().any(|entry| entry["id"] == 2245));
    }

    #[test]
    fn has_nothing_to_roll_up_before_any_character_has_reported() {
        let (_temp, wow, database) = synthetic_install(EQUIPSET_SEGMENTS);

        collect(&wow, &database, 2_000_100_000, Options::default()).unwrap();

        let holdings = &dashboard(&database).unwrap()["holdings"];
        assert_eq!(holdings["currencies"].as_array().unwrap().len(), 0);
        assert_eq!(holdings["factions"].as_array().unwrap().len(), 0);
        // Null rather than a total of nought: a history nobody has read a wallet into has
        // not claimed the account is broke, it has simply never been asked.
        assert!(holdings["gold"].is_null());
    }

    /// The same install as `holdings_install`, plus the account's own warband pot.
    ///
    /// The pot sits at the top level of the file rather than inside `holdings`, because the
    /// addon keys `holdings` by character and a "warband" entry in there would arrive at the
    /// collector as a character of that name.
    fn gold_install(
        holdings_lua: &str,
        warband_lua: &str,
    ) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let wow = temp.path().join("_retail_");
        let saved = wow.join("WTF/Account/TEST/SavedVariables");
        fs::create_dir_all(&saved).unwrap();
        fs::write(
            saved.join("chronie.lua"),
            format!(
                r#"ChronieDB = {{ ["holdings"] = {{ {holdings_lua} }},
                   ["warband"] = {warband_lua} }}"#
            ),
        )
        .unwrap();
        let database = temp.path().join("data/chronie.sqlite3");
        (temp, wow, database)
    }

    /// Three characters carrying different amounts, read at different moments — which is the
    /// ordinary case, because a roster is a set of characters last played on different days.
    const THREE_WALLETS: &str = r#"
        ["Alt-Ravencrest"] = { ["gold"] = { ["total"] = 40000, ["at"] = 1999913600 } },
        ["Bank-Ravencrest"] = { ["gold"] = { ["total"] = 35000, ["at"] = 2000000000 } },
        ["Main-Ravencrest"] = { ["gold"] = { ["total"] = 125000, ["at"] = 2000000000 } },
    "#;

    /// The mistake the whole design exists to prevent. Every character reads the same warband
    /// bank, so a total that folded the pot into each character's row would be out by the size
    /// of the roster — and out by more the more alts somebody has.
    #[test]
    fn adds_the_wallets_up_and_counts_the_warband_bank_exactly_once() {
        let (_temp, wow, database) =
            gold_install(THREE_WALLETS, r#"{ ["gold"] = 500000, ["at"] = 1999900000 }"#);

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let gold = &dashboard(&database).unwrap()["holdings"]["gold"];
        assert_eq!(gold["wallets"], 200_000);
        assert_eq!(gold["warband"], 500_000);
        assert_eq!(gold["total"], 700_000);
        // The sum breaks back down into who holds what, sorted, so a reader can check it.
        assert_eq!(gold["characters"].as_array().unwrap().len(), 3);
        assert_eq!(gold["characters"][0]["character"], "Alt-Ravencrest");
        assert_eq!(gold["characters"][0]["total"], 40_000);
        // The pot's reading is the eldest of the four and ages the total like a wallet does.
        assert_eq!(gold["warbandAt"], 1_999_900_000_i64);
        assert_eq!(gold["oldest"], 1_999_900_000_i64);
    }

    /// A newer reading of one live pot is simply a better one, and a wallet the character has
    /// spent from must be able to fall. Neither is a movement to be added to what came before.
    #[test]
    fn replaces_a_balance_rather_than_adding_to_it() {
        let (_temp, wow, database) =
            gold_install(THREE_WALLETS, r#"{ ["gold"] = 500000, ["at"] = 1999900000 }"#);
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        fs::write(
            wow.join("WTF/Account/TEST/SavedVariables/chronie.lua"),
            r#"ChronieDB = { ["holdings"] = {
                 ["Main-Ravencrest"] = { ["gold"] = { ["total"] = 0, ["at"] = 2000100000 } },
               }, ["warband"] = { ["gold"] = 10000, ["at"] = 2000100000 } } -- touched"#,
        )
        .unwrap();
        collect(&wow, &database, 2_000_100_100, Options::default()).unwrap();

        let gold = &dashboard(&database).unwrap()["holdings"]["gold"];
        // The main spent everything it had; the two who said nothing this time still stand.
        assert_eq!(gold["wallets"], 75_000);
        assert_eq!(gold["warband"], 10_000);
        assert_eq!(gold["total"], 85_000);
    }

    /// An account whose client has no warband bank to ask reports the wallets and says
    /// nothing about a pot, rather than adding a zero nobody read.
    #[test]
    fn reports_the_wallets_alone_when_no_warband_bank_has_answered() {
        let (_temp, wow, database) = holdings_install(
            r#"["Main-Ravencrest"] = { ["gold"] = { ["total"] = 125000, ["at"] = 2000000000 } },"#,
        );

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let gold = &dashboard(&database).unwrap()["holdings"]["gold"];
        assert_eq!(gold["total"], 125_000);
        assert!(gold["warband"].is_null());
        assert!(gold["warbandAt"].is_null());
    }

    /// A history collected before gold was a balance has no tables to put one in. The
    /// migration has to add them under the rows already there rather than demanding a fresh
    /// install — and what it cannot know about that history is exactly what a null says.
    #[test]
    fn migrates_a_database_written_before_gold_was_kept() {
        let (_temp, wow, database) = gold_install(
            THREE_WALLETS,
            r#"{ ["gold"] = 500000, ["at"] = 1999900000 }"#,
        );
        {
            fs::create_dir_all(database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..10] {
                transaction.execute_batch(migration).unwrap();
            }
            transaction
                .execute_batch(
                    "INSERT INTO accounts (id, source_key, first_seen_at, last_seen_at)
                       VALUES (1, 'legacy', 1900000000, 1900000000);
                     INSERT INTO characters (id, account_id, source_key, name, realm,
                                             first_seen_at, last_seen_at)
                       VALUES (1, 1, 'Brin-Vale', 'Brin', 'Vale', 1900000000, 1900000000);",
                )
                .unwrap();
            transaction.pragma_update(None, "user_version", 10_i64).unwrap();
            transaction.commit().unwrap();
        }
        // Nothing read yet under the old schema: a character with a history and no balance.
        assert!(dashboard(&database).unwrap()["holdings"]["gold"].is_null());

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        // And the same database, migrated in place, carrying the readings that just arrived.
        let gold = &dashboard(&database).unwrap()["holdings"]["gold"];
        assert_eq!(gold["total"], 700_000);
        // Brin-Vale predates the reading and has no row, which is not a wallet of nothing.
        assert!(!gold["characters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|holder| holder["character"] == "Brin-Vale"));
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
    }

    /* ---------- what the client's own combat log says ---------- */

    /// One of the checked-in synthetic logs, laid down in a game folder under the name the
    /// client would have given it. No real log and no install: everything the collector does
    /// with a combat log is driven by the same files `logfile` is tested against.
    fn plant_log(wow: &Path, fixture: &str, name: &str) {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/combatlog")
            .join(fixture);
        let logs = wow.join("Logs");
        fs::create_dir_all(&logs).unwrap();
        fs::copy(source, logs.join(name)).unwrap();
    }

    /// The instant a line of `raid-night.txt` names, in epoch seconds. The fixture states its
    /// own offset on every line, so this is the same instant wherever the tests run.
    fn raid_second(hour: u32, minute: u32, second: u32) -> i64 {
        chrono::FixedOffset::east_opt(-5 * 3600)
            .unwrap()
            .with_ymd_and_hms(2023, 11, 14, hour, minute, second)
            .unwrap()
            .timestamp()
    }

    /// A segment covering part of that night, written the way the addon writes one.
    fn night_segment(id: &str, character: &str, from: i64, to: i64) -> String {
        format!(
            r#"
      {{ ["id"] = "{id}", ["character"] = "{character}", ["instance"] = "Amirdrassil",
        ["instanceType"] = "raid", ["difficulty"] = "Mythic",
        ["endedAt"] = {to}, ["startedAt"] = {from}, ["seconds"] = {} }}
    "#,
            to - from
        )
    }

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
        let (_temp, wow, database) = synthetic_install(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        ));
        plant_log(&wow, "raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        assert_eq!(count_of(&database, "log_positions"), 6);
        assert_eq!(count_of(&database, "log_maps"), 1);
        assert_eq!(count_of(&database, "log_fights"), 2);
        // Three at the first pull and two at the second.
        assert_eq!(count_of(&database, "log_combatants"), 5);
        let connection = open_database(&database).unwrap();
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
        let (_temp, wow, database) = synthetic_install(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        ));
        plant_log(&wow, "raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let connection = open_database(&database).unwrap();
        let segment: i64 = connection
            .query_row("SELECT id FROM segments WHERE source_id = 'night-1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            rows_of::<i64>(&database, "SELECT segment_id FROM log_positions"),
            vec![segment; 6]
        );
        assert_eq!(
            rows_of::<i64>(&database, "SELECT segment_id FROM log_fights"),
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
        let (_temp, wow, database) = synthetic_install(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        ));
        plant_log(&wow, "raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let connection = open_database(&database).unwrap();
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
        let (_temp, wow, database) = synthetic_install(&format!("{bystander}, {played}"));
        plant_log(&wow, "raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        let placed = rows_of::<String>(
            &database,
            "SELECT DISTINCT s.source_id FROM log_positions p JOIN segments s ON s.id = p.segment_id",
        );
        assert_eq!(placed, ["played"]);
    }

    /// The log is read on every sync and the file has not changed. Reading it again must cost
    /// nothing and must not double anything.
    #[test]
    fn does_not_read_a_log_it_has_already_read() {
        let (_temp, wow, database) = synthetic_install(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        ));
        plant_log(&wow, "raid-night.txt", "WoWCombatLog-111423_201500.txt");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        collect(&wow, &database, 2_000_000_200, Options::default()).unwrap();

        assert_eq!(count_of(&database, "log_positions"), 6);
        assert_eq!(count_of(&database, "log_fights"), 2);
        assert_eq!(count_of(&database, "log_combatants"), 5);
        let lines: i64 = open_database(&database)
            .unwrap()
            .query_row("SELECT lines_read FROM combat_logs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(lines, 28, "the file was read a second time");
    }

    /// The ordinary case while somebody is playing: the file grows between two syncs, and the
    /// line it was halfway through writing at the first one is whole by the second.
    #[test]
    fn reads_only_what_was_added_to_a_log_that_grew() {
        let (_temp, wow, database) = synthetic_install(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            1_714_600_000,
            1_714_610_000,
        ));
        plant_log(&wow, "partial-tail.txt", "WoWCombatLog-050124_221000.txt");
        collect(&wow, &database, 1_714_610_100, Options::default()).unwrap();
        assert_eq!(count_of(&database, "log_fights"), 0, "a half-written line was read");

        plant_log(&wow, "partial-tail-complete.txt", "WoWCombatLog-050124_221000.txt");
        collect(&wow, &database, 1_714_610_200, Options::default()).unwrap();

        assert_eq!(count_of(&database, "log_fights"), 1);
        assert_eq!(count_of(&database, "log_positions"), 1);
        let (lines, restarts): (i64, i64) = open_database(&database)
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
        let (_temp, wow, database) = synthetic_install(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            1_718_200_000,
            1_718_300_000,
        ));
        plant_log(&wow, "rotated-before.txt", "WoWCombatLog.txt");
        collect(&wow, &database, 1_718_300_100, Options::default()).unwrap();
        assert_eq!(count_of(&database, "log_fights"), 1);

        plant_log(&wow, "rotated-after.txt", "WoWCombatLog.txt");
        collect(&wow, &database, 1_718_300_200, Options::default()).unwrap();

        let (restarts, lines): (i64, i64) = open_database(&database)
            .unwrap()
            .query_row("SELECT restarts, lines_read FROM combat_logs", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(restarts, 1);
        assert_eq!(lines, 7, "the restart should count the new file's lines only");
        let names = rows_of::<String>(
            &database,
            "SELECT DISTINCT name FROM log_fights ORDER BY name",
        );
        assert_eq!(names, ["Fyrakk the Blazing", "Gnarlroot"]);
    }

    /// A log rotated more than once. The tally of restarts is a count and not a flag, and the
    /// line count it resets has to be reset by the second rotation exactly as by the first —
    /// otherwise the number quietly becomes the sum of two files that never coexisted.
    #[test]
    fn counts_every_rotation_rather_than_the_first_one() {
        let (_temp, wow, database) = synthetic_install("");
        plant_log(&wow, "rotated-before.txt", "WoWCombatLog.txt");
        collect(&wow, &database, 1_718_300_100, Options::default()).unwrap();
        plant_log(&wow, "rotated-after.txt", "WoWCombatLog.txt");
        collect(&wow, &database, 1_718_300_200, Options::default()).unwrap();
        plant_log(&wow, "raid-night.txt", "WoWCombatLog.txt");

        collect(&wow, &database, 1_718_300_300, Options::default()).unwrap();

        let (restarts, lines): (i64, i64) = open_database(&database)
            .unwrap()
            .query_row("SELECT restarts, lines_read FROM combat_logs", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(restarts, 2);
        assert_eq!(lines, 28, "the tally carried lines from a file that is gone");
    }

    /// A log with advanced logging off carries no positions and no map bounds, and every other
    /// thing in it is still worth having. What it must not do is fail.
    #[test]
    fn stores_a_log_written_without_advanced_logging_for_what_it_does_carry() {
        let (_temp, wow, database) = synthetic_install(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            1_700_600_000,
            1_700_610_000,
        ));
        plant_log(&wow, "advanced-off.txt", "WoWCombatLog-112123_210300.txt");

        collect(&wow, &database, 1_700_610_100, Options::default()).unwrap();

        assert_eq!(count_of(&database, "log_positions"), 0);
        assert_eq!(count_of(&database, "log_maps"), 0);
        assert_eq!(count_of(&database, "log_fights"), 1);
        let advanced: i64 = open_database(&database)
            .unwrap()
            .query_row("SELECT advanced FROM combat_logs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(advanced, 0);
    }

    /// A night is several files, because the client splits a log per session. All of them get
    /// read, each with its own cursor.
    #[test]
    fn reads_every_log_in_the_folder_and_keeps_a_cursor_for_each() {
        let (_temp, wow, database) = synthetic_install(RAID_SEGMENT);
        plant_log(&wow, "raid-night.txt", "WoWCombatLog-111423_201500.txt");
        plant_log(&wow, "mythic-plus.txt", "WoWCombatLog-120223_190000.txt");
        plant_log(&wow, "advanced-off.txt", "WoWCombatLog-112123_210300.txt");
        // Everything else in the folder is not a combat log and is not to be touched.
        fs::write(wow.join("Logs/Client.log"), b"not a combat log at all").unwrap();

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        assert_eq!(count_of(&database, "combat_logs"), 3);
        let kinds = rows_of::<String>(
            &database,
            "SELECT kind FROM log_fights ORDER BY kind, started_at",
        );
        assert_eq!(kinds, ["encounter", "encounter", "encounter", "encounter", "keystone"]);
        assert!(open_database(&database)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM combat_logs WHERE byte_offset < byte_size",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap()
            == 0);
    }

    /// A capture, a lockout, an equipment set and now a combat log all arrive through the same
    /// sync. A database written before this shape existed has to grow into it without being
    /// rebuilt, and without losing what it already held.
    #[test]
    fn migrates_a_database_written_before_combat_logs_were_read() {
        let (_temp, wow, database) = synthetic_install(&night_segment(
            "night-1",
            "Alyndra-Ravencrest",
            raid_second(20, 10, 0),
            raid_second(20, 30, 0),
        ));
        plant_log(&wow, "raid-night.txt", "WoWCombatLog-111423_201500.txt");
        {
            fs::create_dir_all(database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..7] {
                transaction.execute_batch(migration).unwrap();
            }
            transaction.pragma_update(None, "user_version", 7_i64).unwrap();
            transaction.commit().unwrap();
        }

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        assert_eq!(count_of(&database, "log_positions"), 6);
        assert_eq!(count_of(&database, "segments"), 1);
    }

    /// A log read before the visit it belongs to has been filed is the ordinary case, not the
    /// exception: the client writes SavedVariables at logout and the log while playing. The
    /// points wait, and the sync that finally sees the segment attaches them.
    #[test]
    fn attaches_a_track_to_a_visit_that_is_filed_after_it() {
        let (_temp, wow, database) = synthetic_install("");
        plant_log(&wow, "raid-night.txt", "WoWCombatLog-111423_201500.txt");
        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();
        assert_eq!(count_of(&database, "log_positions"), 6);
        assert_eq!(
            rows_of::<Option<i64>>(&database, "SELECT segment_id FROM log_positions"),
            vec![None; 6]
        );

        touch(
            &wow,
            &night_segment(
                "night-1",
                "Alyndra-Ravencrest",
                raid_second(20, 10, 0),
                raid_second(20, 30, 0),
            ),
        );
        collect(&wow, &database, 2_000_000_200, Options::default()).unwrap();

        assert!(rows_of::<Option<i64>>(&database, "SELECT segment_id FROM log_positions")
            .iter()
            .all(Option::is_some));
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
        let (_temp, wow, database) = synthetic_install(&format!("{early}, {late}"));
        plant_log(&wow, "raid-night.txt", "WoWCombatLog-111423_201500.txt");

        collect(&wow, &database, 2_000_000_100, Options::default()).unwrap();

        // The first pull runs 20:16:00 to 20:16:30: ten seconds in `early`, nineteen in `late`.
        let placed = rows_of::<String>(
            &database,
            "SELECT s.source_id FROM log_fights f JOIN segments s ON s.id = f.segment_id
             ORDER BY f.started_at",
        );
        assert_eq!(placed, ["late", "late"]);
    }

    /// The name the client gives a file is the only thing that says which year its stamps are
    /// in, for a log old enough not to state one.
    #[test]
    fn reads_the_year_out_of_the_name_the_client_gave_the_file() {
        assert_eq!(stamped_year("WoWCombatLog-070926_182310.txt"), Some(2026));
        assert_eq!(stamped_year("WoWCombatLog-111423_201500.txt"), Some(2023));
        assert_eq!(stamped_year("WoWCombatLog.txt"), None);
        assert_eq!(stamped_year("WoWCombatLog-notadate.txt"), None);
    }

    /* ---------- clearing the logs up again ---------- */

    /// When the sweep runs, in the same epoch seconds every other test in here uses.
    const SWEEP_NOW: i64 = 2_000_000_100;

    /// Backdates a planted log the way the filesystem dates one written weeks ago. The age is
    /// the only thing the rule reads off a file, and nothing in a fixture's contents affects
    /// it — which is the point, the content timestamps being the unreliable ones.
    fn backdate(wow: &Path, name: &str, at: i64) {
        fs::File::options()
            .write(true)
            .open(wow.join("Logs").join(name))
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(at as u64))
            .unwrap();
    }

    fn exists(wow: &Path, name: &str) -> bool {
        wow.join("Logs").join(name).is_file()
    }

    /// A folder with an old log, a slightly less old one, and a current one, all read.
    fn swept_install() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let (temp, wow, database) = synthetic_install(RAID_SEGMENT);
        plant_log(&wow, "raid-night.txt", "WoWCombatLog-111423_201500.txt");
        plant_log(&wow, "mythic-plus.txt", "WoWCombatLog-120223_190000.txt");
        plant_log(&wow, "advanced-off.txt", "WoWCombatLog-112123_210300.txt");
        backdate(&wow, "WoWCombatLog-111423_201500.txt", SWEEP_NOW - 30 * DAY_SECONDS);
        backdate(&wow, "WoWCombatLog-112123_210300.txt", SWEEP_NOW - 20 * DAY_SECONDS);
        backdate(&wow, "WoWCombatLog-120223_190000.txt", SWEEP_NOW - 3_600);
        (temp, wow, database)
    }

    /// The ordinary case, through the sync that does it: two logs read to their end weeks ago
    /// go, the one the client is writing stays, and the going is written down.
    #[test]
    fn deletes_the_old_logs_it_has_read_and_records_every_one() {
        let (_temp, wow, database) = swept_install();

        collect(
            &wow,
            &database,
            SWEEP_NOW,
            Options {
                retain_log_days: Some(7),
                ..Options::default()
            },
        )
        .unwrap();

        assert!(!exists(&wow, "WoWCombatLog-111423_201500.txt"));
        assert!(!exists(&wow, "WoWCombatLog-112123_210300.txt"));
        assert!(exists(&wow, "WoWCombatLog-120223_190000.txt"), "the active log");
        let deleted = rows_of::<String>(
            &database,
            "SELECT name FROM log_deletions ORDER BY name",
        );
        assert_eq!(
            deleted,
            ["WoWCombatLog-111423_201500.txt", "WoWCombatLog-112123_210300.txt"]
        );
        let (bytes, lines, days, at): (i64, i64, i64, i64) = open_database(&database)
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
    /// positions, its fights and its cursor exactly where they were — the night happened
    /// whether or not the bytes that recorded it still exist.
    #[test]
    fn keeps_everything_it_learned_from_a_log_it_deleted() {
        let (_temp, wow, database) = swept_install();

        collect(
            &wow,
            &database,
            SWEEP_NOW,
            Options {
                retain_log_days: Some(7),
                ..Options::default()
            },
        )
        .unwrap();

        // The cursor row survives the file, and so does everything hanging off it — which is
        // the whole reason the sweeper does not delete that row along with the bytes.
        assert_eq!(count_of(&database, "combat_logs"), 3);
        let (positions, fights): (i64, i64) = open_database(&database)
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
        assert_eq!(positions, 6, "the track read out of a log that is now gone");
        assert_eq!(fights, 2);
    }

    /// Off is off. The same folder, the same ages, and nothing is touched.
    #[test]
    fn deletes_nothing_at_all_until_somebody_turns_it_on() {
        let (_temp, wow, database) = swept_install();

        collect(&wow, &database, SWEEP_NOW, Options::default()).unwrap();

        assert!(exists(&wow, "WoWCombatLog-111423_201500.txt"));
        assert!(exists(&wow, "WoWCombatLog-112123_210300.txt"));
        assert_eq!(count_of(&database, "log_deletions"), 0);
    }

    /// The case the whole feature is built around. Three weeks of logs somebody wrote before
    /// Chronie could read one: old enough by any window, and read by nothing. A sweeper that
    /// went by age would take all of them, permanently, and nobody would find out until they
    /// went looking for a raid night that no longer exists.
    #[test]
    fn never_deletes_an_old_log_that_was_never_ingested() {
        let (_temp, wow, database) = swept_install();
        let mut connection = open_database(&database).unwrap();

        sweep_logs(&mut connection, &wow, 7, SWEEP_NOW).unwrap();

        assert!(exists(&wow, "WoWCombatLog-111423_201500.txt"));
        assert!(exists(&wow, "WoWCombatLog-112123_210300.txt"));
        assert!(exists(&wow, "WoWCombatLog-120223_190000.txt"));
        assert_eq!(count_of(&database, "log_deletions"), 0);
    }

    /// And it says so. An un-ingested pile is surfaced rather than swept or hidden, because it
    /// is somebody's decision to make and they cannot make it without being told.
    #[test]
    fn surfaces_the_old_logs_it_will_not_touch() {
        let (_temp, wow, database) = swept_install();

        let report = retention_report(&database, Some(&wow), None, SWEEP_NOW).unwrap();

        assert!(!report.enabled, "off, and previewing what turning it on would do");
        assert_eq!(report.days, retention::DEFAULT_RETAIN_DAYS);
        assert_eq!(report.doomed.count, 0);
        assert_eq!(report.unread.count, 2);
        assert_eq!(
            report.unread.files.iter().map(|file| file.name.as_str()).collect::<Vec<_>>(),
            ["WoWCombatLog-111423_201500.txt", "WoWCombatLog-112123_210300.txt"]
        );
    }

    /// Once they have been read the same two files move to the other pile, and the report is
    /// what a reader is shown before the switch is thrown.
    #[test]
    fn previews_what_a_sweep_would_delete_before_it_is_switched_on() {
        let (_temp, wow, database) = swept_install();
        collect(&wow, &database, SWEEP_NOW, Options::default()).unwrap();

        let report = retention_report(&database, Some(&wow), None, SWEEP_NOW).unwrap();

        assert_eq!(report.doomed.count, 2);
        assert!(report.doomed.bytes > 0);
        assert_eq!(report.unread.count, 0);
    }

    /// The ledger is what the report shows afterwards, so "Chronie deleted my logs" has an
    /// answer sitting on the screen that did it.
    #[test]
    fn reports_what_it_has_already_deleted() {
        let (_temp, wow, database) = swept_install();
        collect(
            &wow,
            &database,
            SWEEP_NOW,
            Options {
                retain_log_days: Some(7),
                ..Options::default()
            },
        )
        .unwrap();

        let report = retention_report(&database, Some(&wow), Some(7), SWEEP_NOW).unwrap();

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
        let (_temp, _wow, database) = swept_install();

        let report = retention_report(&database, None, None, SWEEP_NOW).unwrap();

        assert_eq!(report.doomed.count, 0);
        assert_eq!(report.unread.count, 0);
        assert!(report.removed.is_empty());
    }
}
