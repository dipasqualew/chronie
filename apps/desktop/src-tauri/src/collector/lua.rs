//! The SavedVariables file as text.
//!
//! The client writes Lua, and there is no Lua here to read it with, so this is a reader for
//! exactly the subset the client writes: a global assignment holding nested tables of
//! strings, numbers and booleans. What those tables mean is [`crate::saved_variables`]'s
//! business; this module stops at a [`serde_json::Value`].
//!
//! Beside it, the two questions about where a file is: which folder of an install holds
//! `WTF/`, and which files under it are accounts.

use serde_json::{Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

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

pub(super) fn account_files(wow_path: &Path) -> Vec<PathBuf> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::read_model::dashboard;
    use crate::collector::testing::*;
    use crate::collector::{collect, Options};

    use std::fs;

    #[test]
    fn reads_nested_saved_variables_without_game_runtime() {
        let parsed = read_saved_variable(
            r#"Other = { 1 }
ChronieDB = { ["segments"] = { { ["id"] = "synthetic-1", ["enabled"] = true, ["score"] = -2.5 } } }"#,
            "ChronieDB",
        )
        .unwrap()
        .unwrap();
        assert_eq!(parsed["segments"][0]["id"], "synthetic-1");
        assert_eq!(parsed["segments"][0]["enabled"], true);
        assert_eq!(parsed["segments"][0]["score"], -2.5);
    }

    #[test]
    fn imports_an_independently_written_historical_saved_variables_file() {
        let temp = tempfile::tempdir().unwrap();
        let wow = temp.path().join("_retail_");
        let saved = wow.join("WTF/Account/TEST/SavedVariables");
        fs::create_dir_all(&saved).unwrap();
        fs::write(
            saved.join("chronie.lua"),
            include_str!("../../fixtures/savedvariables/legacy.lua"),
        )
        .unwrap();
        let database = temp.path().join("chronie.db");

        collect(&wow, &database, 1_700_000_100, Options::default()).unwrap();

        assert_eq!(count_of(&database, "segments"), 1);
        assert_eq!(count_of(&database, "transmogs"), 1);
        assert_eq!(count_of(&database, "achievements"), 0);
        let payload = dashboard(&database).unwrap();
        assert_eq!(payload["segments"][0]["id"], "old-1");
        assert_eq!(payload["segments"][0]["instance"], "Unknown");
        assert_eq!(payload["segments"][0]["lootValue"], 0);
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
}
