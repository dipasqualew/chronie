//! The walks this app asks the game to take, and what came of each.
//!
//! `collector::census` next door receives what the addon's census *found*. This is the other
//! direction and the smaller one: a reader who knows a reading is stale asking for it to be taken
//! again.
//!
//! **It exists because the addon's audit is deliberately conservative.** A pass is provoked by a
//! build change, a domain that was never whole, or the client's own counter saying there is more —
//! see `docs/account-census.md`, which argues at length for why none of those is a timer. What
//! none of them covers is a person who simply knows better, and until this there was no way for
//! them to say so short of waiting for something else to notice.
//!
//! The road is the one `ingamesets.rs` already proved: the app writes a Lua source file of the
//! addon's own, the addon reads it at load, and the answer comes back through SavedVariables at
//! logout. Nothing about it is immediate, which is the one thing the affordance in the app has to
//! say out loud — a request is picked up at the next login and answered at the next logout.
//!
//! This module is the shape, the file it writes and the answer it reads back.
//! `collector::census_requests` is the storage and `0026_census_requests.sql` is the table.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// A walk this app has asked for.
///
/// Named for its domain rather than shortened to `Request`, because the generated TypeScript is
/// one flat namespace: `ingamesets::Request` is already `Request` over there, and two structs of
/// that name would arrive as two declarations of one type.
///
/// The shape of a row of `census_requests` and of the entry written into the addon's folder — one
/// idea of what a request is, rather than one per hop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CensusRequest {
    pub id: i64,
    /// Which domains to walk, by the addon's own word for each. **Empty asks for every one the
    /// addon can walk**, which is what the Resync button sends.
    ///
    /// Named rather than implied because this is the seam a targeted probe arrives on: the app
    /// knows the whole catalogue out of DB2 and the addon does not, so "walk the appearances
    /// again" is a thing only this end can decide to ask for.
    pub domains: Vec<String>,
    pub created_at: i64,
    /// What the addon did about it: `walked`, or `unknown` for a request naming nothing that
    /// build can walk. Absent while it is still waiting to be seen, which is the state the app
    /// draws differently and the state that keeps it being written into the game.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// When the walk it asked for *ended*, which is the addon's own moment and not this app's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<i64>,
    /// What was actually walked, which is not always what was asked for: a build missing a
    /// domain's client calls cannot walk it however plainly the request named it.
    pub walked: Vec<String>,
}

/// One string as a Lua literal, safe to drop into a source file the game will execute.
///
/// Domain names are Chronie's own vocabulary rather than anything a person typed — "mounts",
/// "appearances" — so this is `trigger_literal`'s bargain rather than `lua_string`'s: only what a
/// domain name can actually be is let through, and a name that is not one is dropped rather than
/// escaped. There is then no quote, backslash, newline or comment marker left to get the escaping
/// wrong about, and a domain this addon has never heard of would do nothing anyway.
fn domain_literal(name: &str) -> Option<String> {
    let clean = !name.is_empty()
        && name
            .chars()
            .all(|character| character.is_ascii_alphabetic());
    clean.then(|| format!("\"{name}\""))
}

/// The contents of `src/CensusRequests.lua` for a given set of waiting requests.
///
/// Pure, so the thing that actually reaches somebody's game folder is testable without a game
/// folder — the same reason `ingamesets::requests_module` beside it is, and carried by the same
/// file-writing machinery.
///
/// The shape has to match the `ns.censusRequests` the shipped `src/CensusRequests.lua` declares,
/// because a hand-installed copy gets that one and must still load.
pub fn requests_module(issued_at: i64, requests: &[CensusRequest]) -> String {
    let mut body = String::new();
    for request in requests {
        let domains: Vec<String> = request
            .domains
            .iter()
            .filter_map(|name| domain_literal(name))
            .collect();
        body.push_str(&format!(
            "        {{ [\"id\"] = {}, [\"domains\"] = {{ {} }} }},\n",
            request.id,
            domains.join(", ")
        ));
    }
    format!(
        "local _, ns = ...\n\
         \n\
         -- Written by the Chronie desktop app. Each entry is a walk somebody asked for, and the\n\
         -- addon carries each one out once and remembers that it did. An empty `domains` asks\n\
         -- for every domain this build can walk. Editing it by hand lasts until the app next\n\
         -- writes it, which is whenever a resync is asked for or the addon is installed.\n\
         --\n\
         -- A request stays here until the addon has said what became of it, because the app has\n\
         -- no way to know the game ever loaded. See docs/account-census.md.\n\
         ns.censusRequests = {{\n\
         \x20   [\"issuedAt\"] = {issued_at},\n\
         \x20   [\"requests\"] = {{\n\
         {body}\
         \x20   }},\n\
         }}\n"
    )
}

/// What the addon said it did, read back out of SavedVariables.
///
/// Keyed by the request id the app gave it, which is the whole point of that id: the app can then
/// stop writing the request into the game's folder, and the screen can say when the walk somebody
/// asked for a week ago actually happened.
///
/// **The id is read out of the record and not off the key it was filed under**, for the reason
/// `ingamesets::outcomes` spells out: the addon files these as `done[id] = outcome`, and a Lua
/// table whose integer keys run from one is a *sequence*, which the parser hands back as a JSON
/// array with the keys gone. Trusting the key would work for every request except the first one
/// anybody ever sent.
pub fn outcomes(value: &Value) -> Vec<(i64, String, Option<i64>, Vec<String>)> {
    let done = match value.get("done") {
        // Either shape, because which one arrives is decided by what the ids happen to be.
        Some(Value::Object(table)) => table.values().collect::<Vec<_>>(),
        Some(Value::Array(rows)) => rows.iter().collect::<Vec<_>>(),
        _ => return Vec::new(),
    };
    let mut found: Vec<(i64, String, Option<i64>, Vec<String>)> = done
        .into_iter()
        .filter_map(|entry| {
            let id = number(entry.get("id"))?;
            let outcome = entry.get("outcome").and_then(Value::as_str)?.to_string();
            let walked = entry
                .get("domains")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|row| row.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            Some((id, outcome, number(entry.get("at")), walked))
        })
        .collect();
    found.sort_by_key(|(id, ..)| *id);
    found
}

/// One number out of a Lua value the addon wrote, when it really is one.
fn number(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(found) => found.as_i64().or_else(|| Some(found.as_f64()? as i64)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(id: i64, domains: &[&str]) -> CensusRequest {
        CensusRequest {
            id,
            domains: domains.iter().map(|name| name.to_string()).collect(),
            created_at: 0,
            outcome: None,
            applied_at: None,
            walked: Vec::new(),
        }
    }

    /// The module is Lua the game executes, so the shape it declares has to be the shape the
    /// shipped `src/CensusRequests.lua` declares — a hand-installed addon gets that one and must
    /// still load.
    #[test]
    fn writes_a_module_the_addon_can_load() {
        let lua = requests_module(1_700_000_000, &[request(4, &["mounts", "appearances"])]);

        assert!(lua.starts_with("local _, ns = ...\n"));
        assert!(lua.contains("ns.censusRequests = {"));
        assert!(lua.contains("[\"issuedAt\"] = 1700000000,"));
        assert!(
            lua.contains("[\"id\"] = 4, [\"domains\"] = { \"mounts\", \"appearances\" }"),
            "{lua}"
        );
    }

    /// What the Resync button sends: walk the lot. An empty list rather than an absent key,
    /// because the addon reads both the same way and one of them is shorter to read by eye.
    #[test]
    fn writes_a_request_that_names_no_domain() {
        let lua = requests_module(0, &[request(1, &[])]);

        assert!(lua.contains("[\"id\"] = 1, [\"domains\"] = {  }"), "{lua}");
    }

    /// Asking for nothing still has to be a module that loads: it is what gets written the moment
    /// the last request is answered, and a file that failed to parse would take the whole addon
    /// down with it.
    #[test]
    fn writes_a_module_that_asks_for_nothing() {
        let lua = requests_module(0, &[]);

        assert!(lua.contains("[\"requests\"] = {"));
        assert!(!lua.contains("[\"id\"]"));
    }

    /// A domain name is Chronie's own vocabulary and never a person's words, so anything that is
    /// not one is dropped rather than escaped — which leaves nothing in the file that could end
    /// the literal or start a comment. The rest of the request still travels.
    #[test]
    fn drops_a_domain_name_that_is_not_one() {
        let lua = requests_module(0, &[request(1, &["\" } print(1) --", "mounts", ""])]);

        assert!(lua.contains("[\"domains\"] = { \"mounts\" }"), "{lua}");
        assert!(!lua.contains("print(1)"));
    }

    #[test]
    fn reads_back_what_the_addon_did() {
        let found = outcomes(&json!({
            "done": {
                "2": { "id": 2, "outcome": "walked", "at": 1_700_000_000,
                       "domains": ["mounts", "achievements"] },
                "1": { "id": 1, "outcome": "unknown", "at": 1_600_000_000, "domains": [] },
            }
        }));

        assert_eq!(
            found,
            vec![
                (1, "unknown".to_string(), Some(1_600_000_000), Vec::new()),
                (
                    2,
                    "walked".to_string(),
                    Some(1_700_000_000),
                    vec!["mounts".to_string(), "achievements".to_string()]
                ),
            ]
        );
    }

    /// The shape the parser hands back whenever the ids happen to run from one — which is the
    /// first request anybody ever sends, and so the one case that must not be the broken one.
    #[test]
    fn reads_the_record_back_when_it_arrives_as_a_sequence() {
        let found = outcomes(&json!({
            "done": [
                { "id": 1, "outcome": "walked", "at": 20, "domains": ["mounts"] },
            ]
        }));

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, 1);
        assert_eq!(found[0].3, vec!["mounts".to_string()]);
    }

    /// An entry that names no outcome says nothing about what happened, and should not be allowed
    /// to mark a request answered.
    #[test]
    fn refuses_an_answer_that_says_nothing() {
        let found = outcomes(&json!({
            "done": { "1": { "id": 1, "at": 1 }, "2": { "id": 2, "outcome": "walked" } }
        }));

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, 2);
    }

    #[test]
    fn survives_a_record_the_addon_has_never_written() {
        assert!(outcomes(&json!({})).is_empty());
        assert!(outcomes(&Value::Null).is_empty());
    }
}
