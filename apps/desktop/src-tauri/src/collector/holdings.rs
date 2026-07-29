//! What each character is carrying.
//!
//! Written wholesale per character, because that is what it is: a snapshot of where one
//! character stands, and half of an old one beside half of a new one is a position nobody was
//! ever in. Reading it back is the other half of this module — a roster's worth of snapshots
//! rolled up into what the account holds, which is not a sum in every case: a warband bank and
//! an account-wide currency are one pot seen from several characters, and counting one of
//! those once per character is the mistake the shape here exists to prevent.

use super::roster::upsert_character_key;
use crate::saved_variables::{RawHoldingSnapshot, RawWarband};
use rusqlite::{params, Connection, Transaction};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

/// What each character was last seen holding, replacing whatever it last said.
///
/// Wholesale per character rather than row by row, for the same reason the addon writes it
/// that way: this is a snapshot of where one character stands, and half of an old snapshot
/// beside half of a new one is a position no character was ever in. Only the character the
/// snapshot belongs to is touched — the client can only ever read the character in front of
/// it, so nothing here knows anything about the others.
pub(super) fn sync_holdings(
    transaction: &Transaction<'_>,
    account_id: i64,
    holdings: &BTreeMap<String, RawHoldingSnapshot>,
    now: i64,
) -> Result<(), String> {
    for (character, snapshot) in holdings {
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

        for (key, held) in &snapshot.currencies {
            // The addon keys these by the client's own currency id, which arrives as a Lua
            // table key and so as a string. One that is not a number is not a currency.
            let Ok(currency_id) = key.parse::<i64>() else {
                continue;
            };
            let Some(total) = held.total else {
                continue;
            };
            transaction
                .execute(
                    "INSERT INTO character_currencies (
                         character_id, currency_id, name, total, observed_at, account_wide
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        character_id,
                        currency_id,
                        held.name.as_deref(),
                        total,
                        held.at,
                        // The addon writes the flag only when it is set, so an absent one is
                        // a currency this character's own — which is what the column's
                        // default already says for every row written before it existed.
                        i64::from(held.account_wide.unwrap_or(false))
                    ],
                )
                .map_err(|error| error.to_string())?;
        }

        // Absent rather than zero when the character has never reported one: a row saying a
        // character holds nothing is a claim, and an old history has simply never been asked.
        if let Some(gold) = &snapshot.gold {
            if let Some(total) = gold.total {
                transaction
                    .execute(
                        "INSERT OR REPLACE INTO character_gold (character_id, total, observed_at)
                         VALUES (?1, ?2, ?3)",
                        params![character_id, total, gold.at],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }

        for (faction, held) in &snapshot.factions {
            transaction
                .execute(
                    "INSERT INTO character_standings (
                         character_id, faction, standing, standing_current, standing_max,
                         ladder_rank, ladder, observed_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        character_id,
                        faction,
                        held.standing.as_deref(),
                        held.current,
                        held.max,
                        held.rank,
                        held.system.as_deref(),
                        held.at
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
pub(super) fn sync_warband(
    transaction: &Transaction<'_>,
    account_id: i64,
    warband: &RawWarband,
) -> Result<(), String> {
    let Some(gold) = warband.gold else {
        return Ok(());
    };
    transaction
        .execute(
            "INSERT OR REPLACE INTO account_gold (account_id, warband, observed_at)
             VALUES (?1, ?2, ?3)",
            params![account_id, gold, warband.at],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// What the account as a whole holds, aggregated from the per-character snapshots.
///
/// Aggregated here rather than in the addon because here it can be done for real: the
/// database holds every character the account has ever synced, where the client can only see
/// the one in front of it. The per-character rows travel with the rollup instead of being
/// summarised away — a total that cannot be broken back down into who holds what is a number
/// nobody can check, and the ages are what say how much of it is stale.
pub(super) fn account_holdings(connection: &Connection) -> Result<Value, String> {
    let mut statement = connection
        .prepare(
            "SELECT h.currency_id, h.name, h.total, h.observed_at, c.source_key, h.account_wide
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
                row.get::<_, i64>(5)? != 0,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut currencies: Vec<Value> = Vec::new();
    for row in rows {
        let (currency_id, name, total, observed_at, character, account_wide) =
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
                // Being shared is a fact about the currency rather than about the character
                // that looked, so one row that says so settles it for all of them: a row
                // written before the addon ever collected the flag is an unasked question,
                // not a "no".
                if account_wide {
                    entry["accountWide"] = serde_json::json!(true);
                }
                if let Some(holders) = entry["characters"].as_array_mut() {
                    holders.push(holder);
                }
            }
            None => currencies.push(serde_json::json!({
                "id": currency_id,
                "name": name,
                "total": total,
                "accountWide": account_wide,
                "oldest": observed_at,
                "characters": [holder],
            })),
        }
    }
    drop(statement);

    for entry in &mut currencies {
        if entry["accountWide"] == serde_json::json!(true) {
            share_one_pot(entry);
        }
    }

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

/// Rewrites a warband currency's rollup as the one pot it actually is.
///
/// The client answers every character that asks with the account's shared quantity, so the
/// per-character rows are one number reported several times rather than several holdings, and
/// the sum they arrived as multiplied the pot by the size of the roster. The freshest of them
/// is the reading to believe — the others are the same pot out of date — and being the whole
/// claim rather than one term of a sum, it is also what dates the total. Everywhere else
/// `oldest` names the weakest link in an addition; here there is no addition to weaken.
///
/// The rows themselves stay, because they are what says the number was checked from more than
/// one place and how long ago each character last saw it.
///
/// Ties on the timestamp — and a currency nobody has stamped at all — fall to the first
/// character in the list, which the query has already put in `source_key` order, so which
/// reading wins never depends on how rows came back.
fn share_one_pot(entry: &mut Value) {
    let freshest = entry["characters"]
        .as_array()
        .and_then(|holders| {
            holders.iter().fold(None::<&Value>, |best, holder| match best {
                Some(best)
                    if holder["at"].as_i64().unwrap_or(i64::MIN)
                        <= best["at"].as_i64().unwrap_or(i64::MIN) =>
                {
                    Some(best)
                }
                _ => Some(holder),
            })
        })
        .cloned();
    let Some(freshest) = freshest else {
        return;
    };
    entry["total"] = freshest["total"].clone();
    entry["oldest"] = freshest["at"].clone();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::database::MIGRATIONS;

    use crate::collector::testing::*;

    use std::fs;

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
        let install = Install::of(&SavedVariables::new().holdings(TWO_CHARACTERS));

        install.collect(2_000_000_100);

        let holdings = &install.dashboard()["holdings"];
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
        // A currency nobody has said is shared is every character's own, and summing it is
        // the right answer rather than the bug.
        assert_eq!(valorstones["accountWide"], false);
    }

    /// A history collected before the shared flag existed has no column to put one in. The
    /// migration has to widen the table under the rows already there, and every currency in
    /// it reads as the character's own until a walk says otherwise — which is what those
    /// rows were actually recorded as meaning.
    #[test]
    fn migrates_a_database_written_before_a_currency_could_be_shared() {
        let install = Install::of(&SavedVariables::new().holdings(
            r#"["Main-Ravencrest"] = { ["currencies"] = {
                [2032] = {
                    ["name"] = "Trader's Tender", ["total"] = 1500,
                    ["accountWide"] = true, ["at"] = 2000000000,
                },
            } },"#,
        ));
        {
            fs::create_dir_all(install.database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&install.database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..12] {
                transaction.execute_batch(migration.sql).unwrap();
            }
            transaction
                .execute_batch(
                    "INSERT INTO accounts (id, source_key, first_seen_at, last_seen_at)
                       VALUES (1, 'legacy', 1900000000, 1900000000);
                     INSERT INTO characters (id, account_id, source_key, name, realm,
                                             first_seen_at, last_seen_at)
                       VALUES (1, 1, 'Brin-Vale', 'Brin', 'Vale', 1900000000, 1900000000);
                     INSERT INTO character_currencies
                         (character_id, currency_id, name, total, observed_at)
                       VALUES (1, 2032, 'Trader''s Tender', 2000, 1900000000);",
                )
                .unwrap();
            transaction
                .pragma_update(None, "user_version", 12_i64)
                .unwrap();
            transaction.commit().unwrap();
        }

        install.collect(2_000_000_100);

        let tender = &install.dashboard()["holdings"]["currencies"][0];
        // Brin-Vale's row survived the migration and is still listed — but the character
        // that has actually read the flag is the one that settles what the number means.
        assert_eq!(tender["characters"].as_array().unwrap().len(), 2);
        assert_eq!(tender["accountWide"], true);
        assert_eq!(tender["total"], 1500);
    }

    /// A warband currency is one pot that every character reads through the same call, so
    /// the per-character rows are the same number reported several times rather than several
    /// holdings to add up. Summing them multiplies the pot by the size of the roster.
    #[test]
    fn counts_an_account_wide_currency_once_rather_than_once_per_character() {
        let install = Install::of(&SavedVariables::new().holdings(
            r#"
            ["Alt-Ravencrest"] = { ["currencies"] = {
                [2032] = {
                    ["name"] = "Trader's Tender", ["total"] = 2000,
                    ["accountWide"] = true, ["at"] = 1999913600,
                },
            } },
            ["Main-Ravencrest"] = { ["currencies"] = {
                [2032] = {
                    ["name"] = "Trader's Tender", ["total"] = 1500,
                    ["accountWide"] = true, ["at"] = 2000000000,
                },
            } },
        "#,
        ));

        install.collect(2_000_000_100);

        let tender = &install.dashboard()["holdings"]["currencies"][0];
        // The freshest reading, not the sum and not the eldest: the older row is the same
        // pot out of date rather than a second holding.
        assert_eq!(tender["total"], 1500);
        assert_eq!(tender["accountWide"], true);
        assert_eq!(tender["oldest"], 2_000_000_000_i64);
        // Both characters still travel with it, because the list is what says the number was
        // checked from more than one place.
        assert_eq!(tender["characters"].as_array().unwrap().len(), 2);
    }

    /// Whether a currency is shared is a fact about the currency rather than about the
    /// character that looked, so a snapshot written before the addon ever collected the flag
    /// is an unasked question rather than a "no".
    #[test]
    fn treats_a_currency_as_shared_once_any_character_has_read_the_flag() {
        let install = Install::of(&SavedVariables::new().holdings(
            r#"
            ["Alt-Ravencrest"] = { ["currencies"] = {
                [2032] = { ["name"] = "Trader's Tender", ["total"] = 2000, ["at"] = 1999913600 },
            } },
            ["Main-Ravencrest"] = { ["currencies"] = {
                [2032] = {
                    ["name"] = "Trader's Tender", ["total"] = 2000,
                    ["accountWide"] = true, ["at"] = 2000000000,
                },
            } },
        "#,
        ));

        install.collect(2_000_000_100);

        let tender = &install.dashboard()["holdings"]["currencies"][0];
        assert_eq!(tender["accountWide"], true);
        assert_eq!(tender["total"], 2000);
    }

    #[test]
    fn crowns_the_character_that_has_got_furthest_with_a_faction() {
        let install = Install::of(&SavedVariables::new().holdings(TWO_CHARACTERS));

        install.collect(2_000_000_100);

        let holdings = &install.dashboard()["holdings"];
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
        let install = Install::of(&SavedVariables::new().holdings(
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
        ));

        install.collect(2_000_000_100);

        let brann = &install.dashboard()["holdings"]["factions"][0];
        assert_eq!(brann["best"]["character"], "Main-Ravencrest");
        assert_eq!(brann["characters"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn leaves_a_faction_uncrowned_when_no_standing_can_be_placed_on_a_ladder() {
        let install = Install::of(&SavedVariables::new().holdings(
            r#"["Main-Ravencrest"] = { ["factions"] = { ["Hallowfall Arathi"] = {
                ["standing"] = "Honored",
            } } },"#,
        ));

        install.collect(2_000_000_100);

        let arathi = &install.dashboard()["holdings"]["factions"][0];
        // Null rather than the only row there is: nothing here can be ranked, which is not
        // the same as this character being the one out in front.
        assert!(arathi["best"].is_null());
        assert_eq!(arathi["characters"].as_array().unwrap().len(), 1);
    }

    /// A snapshot is where one character stands, not a log of where it has stood. Half of an
    /// old one beside half of a new one is a position no character was ever in.
    #[test]
    fn replaces_a_characters_snapshot_rather_than_layering_on_it() {
        let install = Install::of(&SavedVariables::new().holdings(TWO_CHARACTERS));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().holdings(
            r#"["Main-Ravencrest"] = { ["currencies"] = {
                [3008] = { ["name"] = "Valorstones", ["total"] = 50, ["at"] = 2000100000 },
            } },"#,
        ));
        install.collect(2_000_100_100);

        let currencies = install.dashboard()["holdings"]["currencies"]
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
        let install = Install::of(&SavedVariables::new().segments(EQUIPSET_SEGMENTS));

        install.collect(2_000_100_000);

        let holdings = &install.dashboard()["holdings"];
        assert_eq!(holdings["currencies"].as_array().unwrap().len(), 0);
        assert_eq!(holdings["factions"].as_array().unwrap().len(), 0);
        // Null rather than a total of nought: a history nobody has read a wallet into has
        // not claimed the account is broke, it has simply never been asked.
        assert!(holdings["gold"].is_null());
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
        let install = Install::of(
            &SavedVariables::new()
                .holdings(THREE_WALLETS)
                .warband(r#"{ ["gold"] = 500000, ["at"] = 1999900000 }"#),
        );

        install.collect(2_000_000_100);

        let gold = &install.dashboard()["holdings"]["gold"];
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
        let install = Install::of(
            &SavedVariables::new()
                .holdings(THREE_WALLETS)
                .warband(r#"{ ["gold"] = 500000, ["at"] = 1999900000 }"#),
        );
        install.collect(2_000_000_100);

        install.rewrite(
            &SavedVariables::new()
                .holdings(
                    r#"["Main-Ravencrest"] = { ["gold"] = { ["total"] = 0, ["at"] = 2000100000 } },"#,
                )
                .warband(r#"{ ["gold"] = 10000, ["at"] = 2000100000 }"#),
        );
        install.collect(2_000_100_100);

        let gold = &install.dashboard()["holdings"]["gold"];
        // The main spent everything it had; the two who said nothing this time still stand.
        assert_eq!(gold["wallets"], 75_000);
        assert_eq!(gold["warband"], 10_000);
        assert_eq!(gold["total"], 85_000);
    }

    /// An account whose client has no warband bank to ask reports the wallets and says
    /// nothing about a pot, rather than adding a zero nobody read.
    #[test]
    fn reports_the_wallets_alone_when_no_warband_bank_has_answered() {
        let install = Install::of(&SavedVariables::new().holdings(
            r#"["Main-Ravencrest"] = { ["gold"] = { ["total"] = 125000, ["at"] = 2000000000 } },"#,
        ));

        install.collect(2_000_000_100);

        let gold = &install.dashboard()["holdings"]["gold"];
        assert_eq!(gold["total"], 125_000);
        assert!(gold["warband"].is_null());
        assert!(gold["warbandAt"].is_null());
    }

    /// A history collected before gold was a balance has no tables to put one in. The
    /// migration has to add them under the rows already there rather than demanding a fresh
    /// install — and what it cannot know about that history is exactly what a null says.
    #[test]
    fn migrates_a_database_written_before_gold_was_kept() {
        let install = Install::of(
            &SavedVariables::new()
                .holdings(THREE_WALLETS)
                .warband(r#"{ ["gold"] = 500000, ["at"] = 1999900000 }"#),
        );
        {
            fs::create_dir_all(install.database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&install.database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..10] {
                transaction.execute_batch(migration.sql).unwrap();
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
            transaction
                .pragma_update(None, "user_version", 10_i64)
                .unwrap();
            transaction.commit().unwrap();
        }
        // Nothing read yet under the old schema: a character with a history and no balance.
        assert!(install.dashboard()["holdings"]["gold"].is_null());

        install.collect(2_000_000_100);

        // And the same database, migrated in place, carrying the readings that just arrived.
        let gold = &install.dashboard()["holdings"]["gold"];
        assert_eq!(gold["total"], 700_000);
        // Brin-Vale predates the reading and has no row, which is not a wallet of nothing.
        assert!(!gold["characters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|holder| holder["character"] == "Brin-Vale"));
    }
}
