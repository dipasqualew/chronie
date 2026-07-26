use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

const DAY_SECONDS: i64 = 86_400;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    pub sessions: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub added: usize,
    pub dropped: usize,
    pub session_count: usize,
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

fn normalized(mut session: Value) -> Option<Value> {
    let object = session.as_object_mut()?;
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
    ] {
        if !object.get(key).is_some_and(Value::is_array) {
            object.insert(key.into(), Value::Array(Vec::new()));
        }
    }
    Some(session)
}

pub fn load_database(path: &Path) -> Database {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn collect(
    wow_path: &Path,
    database_path: &Path,
    retain_days: i64,
    now: i64,
) -> Result<SyncResult, String> {
    let mut incoming = Vec::new();
    for path in account_files(wow_path) {
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        let Some(saved) = read_saved_variable(&text, "ChronieDB")? else {
            continue;
        };
        let Some(sessions) = saved.get("sessions").and_then(Value::as_array) else {
            continue;
        };
        incoming.extend(sessions.iter().cloned().filter_map(normalized));
    }
    let mut database = load_database(database_path);
    let mut by_id: HashMap<String, Value> = database
        .sessions
        .into_iter()
        .filter_map(|value| {
            let id = value.get("id")?.as_str()?.to_string();
            Some((id, value))
        })
        .collect();
    let mut added = 0;
    for value in incoming {
        let id = value["id"]
            .as_str()
            .expect("normalized session id")
            .to_string();
        if !by_id.contains_key(&id) {
            added += 1;
        }
        by_id.insert(id, value);
    }
    let before = by_id.len();
    let cutoff = now - retain_days * DAY_SECONDS;
    by_id.retain(|_, value| value["endedAt"].as_i64().unwrap_or(0) >= cutoff);
    let dropped = before - by_id.len();
    let mut ordered: BTreeMap<(std::cmp::Reverse<i64>, String), Value> = BTreeMap::new();
    for (id, value) in by_id {
        ordered.insert(
            (
                std::cmp::Reverse(value["endedAt"].as_i64().unwrap_or(0)),
                id,
            ),
            value,
        );
    }
    database.sessions = ordered.into_values().collect();
    if let Some(parent) = database_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        database_path,
        serde_json::to_vec_pretty(&database).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(SyncResult {
        added,
        dropped,
        session_count: database.sessions.len(),
    })
}

pub fn dashboard(database_path: &Path) -> Value {
    let database = load_database(database_path);
    serde_json::json!({
        "generatedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "retainDays": 7,
        "sessions": database.sessions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reads_nested_saved_variables_without_game_runtime() {
        let parsed = read_saved_variable(
            r#"Other = { 1 }
ChronieDB = { ["sessions"] = { { ["id"] = "synthetic-1", ["enabled"] = true, ["score"] = -2.5 } } }"#,
            "ChronieDB",
        ).unwrap().unwrap();
        assert_eq!(parsed["sessions"][0]["id"], "synthetic-1");
        assert_eq!(parsed["sessions"][0]["enabled"], true);
        assert_eq!(parsed["sessions"][0]["score"], -2.5);
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
    fn collects_merges_and_expires_synthetic_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let wow = temp.path().join("_retail_");
        let saved = wow.join("WTF/Account/TEST/SavedVariables");
        fs::create_dir_all(&saved).unwrap();
        let now = 2_000_000_000_i64;
        fs::write(
            saved.join("chronie.lua"),
            format!(
                r#"
ChronieDB = {{ ["sessions"] = {{
  {{ ["id"] = "kept", ["character"] = "Aster-Vale", ["instance"] = "Glass Caverns",
     ["endedAt"] = {now}, ["lootValue"] = 1200 }},
  {{ ["id"] = "old", ["character"] = "Brin-Vale", ["endedAt"] = {} }}
}} }}"#,
                now - 8 * DAY_SECONDS
            ),
        )
        .unwrap();
        let database = temp.path().join("data/sessions.json");
        let result = collect(&wow, &database, 7, now).unwrap();
        assert_eq!(result.added, 2);
        assert_eq!(result.dropped, 1);
        assert_eq!(load_database(&database).sessions[0]["id"], "kept");
    }
}
