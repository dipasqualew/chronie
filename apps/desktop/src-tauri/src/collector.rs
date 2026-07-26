use crate::activity;
use chrono::{DateTime, Local, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_initial.sql"),
    include_str!("../migrations/0002_activities.sql"),
    include_str!("../migrations/0003_lockouts.sql"),
];
const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub added: usize,
    pub updated: usize,
    pub segment_count: usize,
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
                "INSERT INTO currency_gains (segment_id, currency_id, name, amount)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    segment_id,
                    currency_id,
                    optional_text(event, "name").unwrap_or("Unknown"),
                    integer(event, "amount")
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
                "INSERT INTO reputation_gains (segment_id, faction, amount)
                 VALUES (?1, ?2, ?3)",
                params![segment_id, faction, integer(event, "amount")],
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
    insert_outcomes(transaction, segment_id, segment)?;
    refresh_activities(transaction, segment_id, segment, now)?;
    Ok(existing.is_none())
}

/// One account's SavedVariables file, parsed and ready to be written to the database.
struct Incoming {
    source_key: String,
    source_modified_ns: Option<i64>,
    source_size: Option<i64>,
    segments: Vec<Value>,
    lockouts: LockoutFeed,
}

pub fn collect(wow_path: &Path, database_path: &Path, now: i64) -> Result<SyncResult, String> {
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
        });
    }

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
    }
    transaction.commit().map_err(|error| error.to_string())?;
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
                    "encounters": [],
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
        "SELECT segment_id, currency_id, name, amount
         FROM currency_gains ORDER BY segment_id, name",
        "currencies",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "id": row.get::<_, i64>(1)?,
                "name": row.get::<_, String>(2)?,
                "amount": row.get::<_, i64>(3)?
            })
        ))
    );
    load_rows!(
        "SELECT segment_id, faction, amount
         FROM reputation_gains ORDER BY segment_id, faction",
        "reputation",
        |row| Ok((
            row.get::<_, i64>(0)?,
            serde_json::json!({
                "faction": row.get::<_, String>(1)?,
                "amount": row.get::<_, i64>(2)?
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

    Ok(serde_json::json!({
        "generatedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "knownActivityKinds": activity::KNOWN_KINDS,
        "segments": segments,
    }))
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
        let result = collect(&wow, &database, now).unwrap();
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

        let unchanged = collect(&wow, &database, now + 1).unwrap();
        assert_eq!(unchanged.added, 0);
        assert_eq!(unchanged.updated, 0);
        assert_eq!(unchanged.segment_count, 2);

        fs::write(
            saved.join("chronie.lua"),
            r#"ChronieDB = { ["segments"] = {} }"#,
        )
        .unwrap();
        let result = collect(&wow, &database, now + DAY_SECONDS).unwrap();
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

        collect(&wow, &database, 2_000_000_000).unwrap();

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

        collect(&wow, &database, 2_000_000_000).unwrap();

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
        collect(&wow, &database, 2_000_000_000).unwrap();
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
        collect(&wow, &database, 2_000_000_400).unwrap();

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
        collect(&wow, &database, 2_000_000_000).unwrap();
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
        collect(&wow, &database, 2_000_000_200).unwrap();

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
        collect(&wow, &database, 2_000_000_000).unwrap();
        assert_eq!(activities_of(&database)[0]["metadata"]["bossesKilled"], 1);

        // The same segment, filed again after the group killed a second boss.
        touch(
            &wow,
            &RAID_SEGMENT.replace(
                r#"{ ["id"] = 746, ["name"] = "Ignis", ["success"] = false }"#,
                r#"{ ["id"] = 746, ["name"] = "Ignis", ["success"] = true }"#,
            ),
        );
        collect(&wow, &database, 2_000_000_100).unwrap();

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
        collect(&wow, &database, 2_000_000_000).unwrap();
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
        collect(&wow, &database, 2_000_000_000).unwrap();
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

        collect(&wow, &database, 2_000_000_000).unwrap();

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
        collect(&wow, &database, now).unwrap();
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
        collect(&wow, &database, 2_000_300_000).unwrap();

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
        collect(&wow, &database, 2_000_300_000).unwrap();

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
        collect(&wow, &database, 2_000_300_000).unwrap();

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

        let result = collect(&wow, &database, 2_000_000_000).unwrap();

        assert_eq!(result.added, 1);
        assert_eq!(count_of(&database, "lockouts"), 1);
        // One character, reached from both directions.
        assert_eq!(count_of(&database, "characters"), 1);
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
}
