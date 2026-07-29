//! The accounts and characters everything else hangs off.
//!
//! Every other table in the database is keyed on one of these two rows, and both are written
//! by whoever needs them first — a segment, a lockout, a snapshot of what somebody is
//! carrying — rather than by a pass of their own. A character is therefore reachable by two
//! routes: from a segment, which knows what class and race it was played as, and from a bare
//! "Name-Realm" key, which is all a lockout or a holding carries.

use crate::saved_variables::Segment;
use rusqlite::{params, Transaction};
use std::path::Path;

pub(super) fn account_key(path: &Path) -> Option<String> {
    path.parent()?
        .parent()?
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

fn split_character(source_key: &str) -> (&str, &str) {
    source_key.split_once('-').unwrap_or((source_key, ""))
}

pub(super) fn upsert_account(
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

pub(super) fn upsert_character(
    transaction: &Transaction<'_>,
    account_id: i64,
    segment: &Segment,
    now: i64,
) -> Result<i64, String> {
    upsert_character_key(
        transaction,
        account_id,
        &segment.character,
        segment.class_file.as_deref(),
        segment.level,
        now,
    )
}

/// A character named by nothing more than its "Name-Realm" key.
///
/// Lockouts are recorded against characters that may never have produced a segment — a bank
/// alt saved to last week's raid is exactly the character worth knowing is still free — so
/// the roster needs a way in that does not go through a visit.
pub(super) fn upsert_character_key(
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
