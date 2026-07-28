//! The transmog sets the player saved in the game, as the addon reports them.
//!
//! `customsets.rs` beside this is the reader's own wardrobe, assembled in this app. This is the
//! other one — what they already had in game — and the two are deliberately not the same thing,
//! because only one of them is Chronie's to change without asking. `0018_in_game_sets.sql` is
//! where these are stored, `collector.rs` is the SQL, and `inGameSets.ts` is the window.
//!
//! **The name of this module is a translation, and it is worth saying which way round.** The
//! game calls these *custom sets* — `C_TransmogCollection.NewCustomSet` and the rest, which is
//! the vocabulary the addon uses because the addon is talking to the game. This app has called
//! its own saved sets *custom sets* since before the game had any, and one word cannot mean both
//! on the same screen. So the addon writes `customSets` and everything from here inward reads
//! *in-game sets*. Nothing is lost in the crossing: the id, the name and the appearances are the
//! game's throughout.
//!
//! This module is the shapes and the reading and nothing else. It opens no game files, which is
//! why a set can be listed on a machine that has not got the game installed — see the migration
//! for what that costs, which is that it cannot be *opened* there.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The client's `TransmogSlot` enumeration, which runs 0 to 12 inclusive.
///
/// A bound rather than a vocabulary: nothing here needs to know that 11 is the main hand, only
/// that a slot outside this range is not a slot the game has and so is not something the addon
/// can have honestly read. See `0018_in_game_sets.sql` for the names.
const SLOTS: i64 = 13;

/// One appearance in a set, and where on the character it sits.
///
/// `secondary` and `illusion` are absent far more often than they are present — a slot has a
/// second appearance or an enchant illusion only if it is the kind of slot that can — and the
/// addon drops the `0` the client reports for "none", so absent here means nobody claimed
/// anything rather than "claimed to be zero".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub slot: i64,
    /// An `ItemModifiedAppearance` id — the same number a piece of a set saved in this app
    /// carries, which is what lets the two be drawn by one piece of code.
    pub appearance_id: i64,
    pub secondary_appearance_id: Option<i64>,
    pub illusion_id: Option<i64>,
}

/// One set the player saved in game.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InGameSet {
    /// The client's own id, which survives a rename and is what an edit names the set by.
    pub id: i64,
    pub name: String,
    /// The FileDataID of the picture the game shows it under, where it names one.
    pub icon: Option<i64>,
    /// When the addon last saw this character's wardrobe *differ*, rather than when it last
    /// looked — the addon only moves it when two looks disagree.
    pub observed_at: Option<i64>,
    /// What is in it, ascending by slot. Empty is ordinary: a set the player has named and not
    /// yet filled is a set, and the game will list it for them.
    pub slots: Vec<Slot>,
}

/// One character's sets, and every character the database has any for.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InGameSetsPayload {
    /// Keyed by the character the addon read them on, `Name-Realm`.
    ///
    /// Keyed by character even though the sets themselves belong to the account, because
    /// *whether Chronie has ever looked* is a fact about a character. A character nobody has
    /// played since Chronie was installed has no entry, which is the truth; folding them all
    /// into one list would let the last alt to log out speak for the whole roster.
    pub characters: Vec<CharacterSets>,
}

/// What one character was last seen to have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSets {
    pub character: String,
    pub sets: Vec<InGameSet>,
}

/// One number out of a Lua value the addon wrote, when it really is one.
///
/// Lua has one number type and the parser hands integers back as integers, but a table written
/// by a client that decided to store `4.0` would arrive as a float, so both are accepted and
/// anything else is not a number at all.
fn number(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(found) => found.as_i64().or_else(|| Some(found.as_f64()? as i64)),
        _ => None,
    }
}

/// One slot of one set, or nothing when the addon's row does not describe one.
///
/// A slot outside the client's own range is refused rather than stored. Everything downstream
/// treats the number as a place on the body, and a 47 would be drawn nowhere and reported as a
/// slot the reader does not have.
fn slot(value: &Value) -> Option<Slot> {
    let slot = number(value.get("slot"))?;
    if !(0..SLOTS).contains(&slot) {
        return None;
    }
    let appearance_id = number(value.get("appearance"))?;
    Some(Slot {
        slot,
        appearance_id,
        secondary_appearance_id: number(value.get("secondary")),
        illusion_id: number(value.get("illusion")),
    })
}

/// One set out of the addon's list, or nothing when the entry is not one.
///
/// The id is the only field that can fail the set: a set with no id cannot be matched against
/// what is already stored, cannot be named in an edit, and is not something the player can be
/// shown and then asked about. A missing *name* is survivable and left empty — the game's own
/// `GetCustomSetInfo` is documented as sometimes answering nothing — and the window says so.
fn set(value: &Value, observed_at: Option<i64>) -> Option<InGameSet> {
    let id = number(value.get("id"))?;
    let mut slots: Vec<Slot> = value
        .get("slots")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(slot).collect())
        .unwrap_or_default();
    // The addon already sorts these, and sorting again is not distrust of it: this is a file a
    // player can edit, and a set whose slots arrived shuffled would be stored shuffled and
    // drawn in an order the same wardrobe did not have yesterday.
    slots.sort_by_key(|held| held.slot);
    slots.dedup_by_key(|held| held.slot);
    Some(InGameSet {
        id,
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        icon: number(value.get("icon")),
        observed_at,
        slots,
    })
}

/// Every character's sets out of the `customSets` table the addon writes.
///
/// Shaped `{ ["Name-Realm"] = { at = …, sets = { … } } }`. A character whose entry is missing or
/// malformed contributes nothing rather than an empty list, which is the same distinction the
/// payload's own doc draws: never looked and looked-and-found-none are different, and only one
/// of them should overwrite what the database already knows about that character.
pub fn read(value: &Value) -> Vec<CharacterSets> {
    let Some(characters) = value.as_object() else {
        return Vec::new();
    };
    let mut found: Vec<CharacterSets> = characters
        .iter()
        .filter_map(|(character, entry)| {
            let observed_at = number(entry.get("at"));
            let rows = entry.get("sets").and_then(Value::as_array)?;
            let mut sets: Vec<InGameSet> =
                rows.iter().filter_map(|row| set(row, observed_at)).collect();
            sets.sort_by_key(|found| found.id);
            sets.dedup_by_key(|found| found.id);
            Some(CharacterSets {
                character: character.clone(),
                sets,
            })
        })
        .collect();
    // By name, so two syncs of an unchanged file write the same rows in the same order and a
    // diff of the database says nothing happened.
    found.sort_by(|left, right| left.character.cmp(&right.character));
    found
}

/* ---------- and the one thing this app says back ---------- */

/// An outfit this app has asked the game to hold on to.
///
/// The shape of a row of `transmog_set_requests` and its slots, and also the shape written into
/// the addon's own folder — one idea of what a send is, rather than one per hop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: i64,
    pub name: String,
    pub icon: Option<i64>,
    pub created_at: i64,
    /// What the addon did about it, once it has: `created`, `updated`, `full`, `refused` or
    /// `failed`. Absent while the request is still waiting to be seen, which is the state the
    /// window draws differently and the state that keeps it being written into the game.
    pub outcome: Option<String>,
    pub applied_at: Option<i64>,
    /// The client's id for the set that resulted, where one did.
    pub set_id: Option<i64>,
    pub slots: Vec<Slot>,
}

/// One string as a Lua literal, safe to drop into a source file the game will execute.
///
/// Escaped rather than filtered, which is the opposite of what `trigger_literal` does to a
/// capture trigger next door — and the difference is that a trigger name is Chronie's own
/// vocabulary while this is a name a person typed for their own outfit. Refusing the apostrophe
/// in "Winter's Edge" would be this app deciding what a player may call their clothes.
///
/// So every character that could end the literal, start a comment, or break the line is written
/// as an escape, and anything below a space becomes a decimal escape rather than travelling as
/// a raw control byte. `\\` goes first, or it would escape the backslashes the others add.
fn lua_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        match character {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            found if (found as u32) < 0x20 || found as u32 == 0x7f => {
                out.push_str(&format!("\\{}", found as u32));
            }
            found => out.push(found),
        }
    }
    out.push('"');
    out
}

/// The contents of `src/CustomSetRequests.lua` for a given set of waiting requests.
///
/// Pure, so that the thing which actually reaches somebody's game folder is testable without a
/// game folder — the same reason `settings_module` next door is pure, and the same file-writing
/// machinery carries it.
///
/// The shape has to match the `ns.customSetRequests` the shipped `src/CustomSetRequests.lua`
/// declares, because a hand-installed copy gets that one and must still load.
pub fn requests_module(issued_at: i64, requests: &[Request]) -> String {
    let mut body = String::new();
    for request in requests {
        let name = lua_string(&request.name);
        let icon = match request.icon {
            Some(icon) => format!("{icon}"),
            // Omitted rather than written as nil, because the addon reads a missing icon and a
            // nil one the same way and one of them is shorter to read by eye.
            None => String::new(),
        };
        let icon = if icon.is_empty() {
            String::new()
        } else {
            format!(" [\"icon\"] = {icon},")
        };
        body.push_str(&format!(
            "        {{ [\"id\"] = {}, [\"name\"] = {name},{icon} [\"slots\"] = {{\n",
            request.id
        ));
        for slot in &request.slots {
            let secondary = slot
                .secondary_appearance_id
                .map(|id| format!(" [\"secondary\"] = {id},"))
                .unwrap_or_default();
            let illusion = slot
                .illusion_id
                .map(|id| format!(" [\"illusion\"] = {id},"))
                .unwrap_or_default();
            body.push_str(&format!(
                "            {{ [\"slot\"] = {}, [\"appearance\"] = {},{secondary}{illusion} }},\n",
                slot.slot, slot.appearance_id
            ));
        }
        body.push_str("        } },\n");
    }
    format!(
        "local _, ns = ...\n\
         \n\
         -- Written by the Chronie desktop app. Everything in here is an outfit somebody asked\n\
         -- it to save into this account's transmog sets, and the addon carries each one out\n\
         -- once and remembers that it did. Editing it by hand lasts until the app next writes\n\
         -- it, which is whenever an outfit is sent or the addon is installed.\n\
         --\n\
         -- A request stays here until the addon has said what became of it, because the app\n\
         -- has no way to know the game ever loaded. See docs/transmog-sets.md.\n\
         ns.customSetRequests = {{\n\
         \x20   [\"issuedAt\"] = {issued_at},\n\
         \x20   [\"requests\"] = {{\n\
         {body}\
         \x20   }},\n\
         }}\n"
    )
}

/// What the addon said it did, read back out of SavedVariables.
///
/// Keyed by the request id the app gave it, which is the whole point of that id: the app can
/// then stop writing the request into the game's folder, and the window can say what happened
/// to an outfit somebody sent a week ago.
///
/// **The id is read out of the record and not off the key it was filed under**, and that is not
/// belt and braces. The addon files these as `done[id] = outcome`, so the table it writes has
/// integer keys — and a Lua table whose integer keys run from one is a *sequence*, which the
/// parser hands back as a JSON array with the keys gone. Trusting the key would therefore have
/// worked for every request except the first one anybody ever sent, which is exactly the one a
/// person would notice. The record carries its own id for this reason.
pub fn outcomes(value: &Value) -> Vec<(i64, String, Option<i64>, Option<i64>)> {
    let done = match value.get("done") {
        // Either shape, because which one arrives is decided by what the ids happen to be.
        Some(Value::Object(table)) => table.values().collect::<Vec<_>>(),
        Some(Value::Array(rows)) => rows.iter().collect::<Vec<_>>(),
        _ => return Vec::new(),
    };
    let mut found: Vec<(i64, String, Option<i64>, Option<i64>)> = done
        .into_iter()
        .filter_map(|entry| {
            let id = number(entry.get("id"))?;
            let outcome = entry.get("outcome").and_then(Value::as_str)?.to_string();
            Some((
                id,
                outcome,
                number(entry.get("at")),
                number(entry.get("setId")),
            ))
        })
        .collect();
    found.sort_by_key(|(id, ..)| *id);
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_a_character_with_one_set() {
        let found = read(&json!({
            "Aster-Vale": {
                "at": 1_700_000_000,
                "sets": [{
                    "id": 4,
                    "name": "Winter",
                    "icon": 133_600,
                    "slots": [{ "slot": 0, "appearance": 55 }],
                }],
            }
        }));

        assert_eq!(
            found,
            vec![CharacterSets {
                character: "Aster-Vale".into(),
                sets: vec![InGameSet {
                    id: 4,
                    name: "Winter".into(),
                    icon: Some(133_600),
                    observed_at: Some(1_700_000_000),
                    slots: vec![Slot {
                        slot: 0,
                        appearance_id: 55,
                        secondary_appearance_id: None,
                        illusion_id: None,
                    }],
                }],
            }]
        );
    }

    /// A set the player named and has not filled is a set. The game lists it for them, and a
    /// wardrobe that quietly dropped it would disagree with the one they can see.
    #[test]
    fn keeps_a_set_with_nothing_in_it() {
        let found = read(&json!({
            "Aster-Vale": { "sets": [{ "id": 1, "name": "Later", "slots": [] }] }
        }));

        assert_eq!(found[0].sets[0].slots, Vec::new());
        assert_eq!(found[0].sets[0].observed_at, None);
    }

    /// The id is the only thing a set cannot be read without: it is what an edit names, and
    /// what the next sync matches against.
    #[test]
    fn refuses_a_set_with_no_id() {
        let found = read(&json!({
            "Aster-Vale": { "sets": [{ "name": "Nameless" }, { "id": 2, "name": "Real" }] }
        }));

        assert_eq!(found[0].sets.len(), 1);
        assert_eq!(found[0].sets[0].id, 2);
    }

    /// `GetCustomSetInfo` is documented as sometimes answering nothing, so an unnamed set is a
    /// thing the game itself produces rather than a corrupt file.
    #[test]
    fn survives_a_set_that_will_not_name_itself() {
        let found = read(&json!({ "Aster-Vale": { "sets": [{ "id": 7 }] } }));

        assert_eq!(found[0].sets[0].name, "");
        assert_eq!(found[0].sets[0].icon, None);
    }

    /// Everything downstream treats the number as a place on the body, so a slot the game has
    /// not got would be drawn nowhere and reported as somewhere the reader does not have.
    #[test]
    fn refuses_a_slot_the_game_does_not_have() {
        let found = read(&json!({
            "Aster-Vale": { "sets": [{ "id": 1, "slots": [
                { "slot": -1, "appearance": 5 },
                { "slot": 13, "appearance": 6 },
                { "slot": 12, "appearance": 7 },
            ] }] }
        }));

        assert_eq!(found[0].sets[0].slots.len(), 1);
        assert_eq!(found[0].sets[0].slots[0].slot, 12);
    }

    #[test]
    fn orders_characters_sets_and_slots() {
        let found = read(&json!({
            "Zia-Vale": { "sets": [] },
            "Aster-Vale": { "sets": [
                { "id": 9, "slots": [{ "slot": 5, "appearance": 1 }, { "slot": 2, "appearance": 2 }] },
                { "id": 3, "slots": [] },
            ] },
        }));

        assert_eq!(found[0].character, "Aster-Vale");
        assert_eq!(found[1].character, "Zia-Vale");
        assert_eq!(
            found[0].sets.iter().map(|set| set.id).collect::<Vec<_>>(),
            vec![3, 9]
        );
        assert_eq!(
            found[0].sets[1]
                .slots
                .iter()
                .map(|held| held.slot)
                .collect::<Vec<_>>(),
            vec![2, 5]
        );
    }

    /// Never looked and looked-and-found-none are different, and only the second should
    /// overwrite what the database already knows about that character.
    #[test]
    fn skips_a_character_that_has_not_reported_a_list_at_all() {
        let found = read(&json!({
            "Aster-Vale": { "at": 1 },
            "Zia-Vale": { "sets": [] },
        }));

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].character, "Zia-Vale");
    }

    #[test]
    fn reads_the_two_things_a_slot_usually_has_not_got() {
        let found = read(&json!({
            "Aster-Vale": { "sets": [{ "id": 1, "slots": [
                { "slot": 11, "appearance": 5, "secondary": 6, "illusion": 7 },
            ] }] }
        }));

        assert_eq!(
            found[0].sets[0].slots[0],
            Slot {
                slot: 11,
                appearance_id: 5,
                secondary_appearance_id: Some(6),
                illusion_id: Some(7),
            }
        );
    }

    #[test]
    fn survives_a_table_that_is_not_a_table_of_characters() {
        assert!(read(&Value::Null).is_empty());
        assert!(read(&json!([1, 2, 3])).is_empty());
    }

    /* ---------- and the one thing this app says back ---------- */

    /// One request, with only what a test is about filled in.
    fn request(name: &str, slots: Vec<Slot>) -> Request {
        Request {
            id: 1,
            name: name.into(),
            icon: Some(133_600),
            created_at: 0,
            outcome: None,
            applied_at: None,
            set_id: None,
            slots,
        }
    }

    fn slot(slot: i64, appearance_id: i64) -> Slot {
        Slot {
            slot,
            appearance_id,
            secondary_appearance_id: None,
            illusion_id: None,
        }
    }

    /// The module is Lua the game executes, so the shape it declares has to be the shape the
    /// shipped `src/CustomSetRequests.lua` declares — a hand-installed addon gets that one and
    /// must still load.
    #[test]
    fn writes_a_module_the_addon_can_load() {
        let lua = requests_module(1_700_000_000, &[request("Winter", vec![slot(0, 55)])]);

        assert!(lua.starts_with("local _, ns = ...\n"));
        assert!(lua.contains("ns.customSetRequests = {"));
        assert!(lua.contains("[\"issuedAt\"] = 1700000000,"));
        assert!(lua.contains("[\"id\"] = 1,"));
        assert!(lua.contains("[\"name\"] = \"Winter\","));
        assert!(lua.contains("[\"icon\"] = 133600,"));
        assert!(lua.contains("[\"slot\"] = 0, [\"appearance\"] = 55,"));
    }

    /// Asking for nothing still has to be a module that loads: it is what gets written the
    /// moment the last request is answered, and a file that failed to parse would take the
    /// whole addon down with it.
    #[test]
    fn writes_a_module_that_asks_for_nothing() {
        let lua = requests_module(0, &[]);

        assert!(lua.contains("[\"requests\"] = {"));
        assert!(!lua.contains("[\"id\"]"));
    }

    /// The game picks its own picture from the first piece when it is not told, so an absent
    /// icon is written as absent rather than as a nil the addon would have to read around.
    #[test]
    fn leaves_out_an_icon_nobody_chose() {
        let mut asked = request("Winter", vec![slot(0, 55)]);
        asked.icon = None;

        assert!(!requests_module(0, &[asked]).contains("icon"));
    }

    #[test]
    fn writes_the_two_things_a_slot_usually_has_not_got() {
        let held = Slot {
            slot: 11,
            appearance_id: 55,
            secondary_appearance_id: Some(66),
            illusion_id: Some(77),
        };

        let lua = requests_module(0, &[request("Winter", vec![held])]);

        assert!(lua.contains("[\"secondary\"] = 66,"));
        assert!(lua.contains("[\"illusion\"] = 77,"));
    }

    /// A set name is a person's own words about their own clothes, so it is escaped rather
    /// than filtered — and it ends up inside a Lua source file the game executes, where a bare
    /// quote would end the literal and the rest of the name would be run as code.
    #[test]
    fn escapes_a_name_that_would_otherwise_end_the_literal() {
        let lua = requests_module(0, &[request("say \"hi\" \\ then", vec![slot(0, 55)])]);

        assert!(lua.contains(r#"["name"] = "say \"hi\" \\ then","#), "{lua}");
    }

    /// Anything below a space travels as a decimal escape rather than as a raw control byte,
    /// including the newline that would otherwise break the line the name sits on.
    #[test]
    fn escapes_what_would_otherwise_break_the_line() {
        let lua = requests_module(0, &[request("two\nlines\u{7}", vec![slot(0, 55)])]);

        assert!(lua.contains(r#"["name"] = "two\nlines\7","#), "{lua}");
        assert!(!lua.contains("two\nlines"));
    }

    #[test]
    fn reads_back_what_the_addon_did() {
        let found = outcomes(&json!({
            "done": {
                "2": { "id": 2, "outcome": "created", "at": 1_700_000_000, "setId": 9 },
                "1": { "id": 1, "outcome": "full", "at": 1_600_000_000 },
            }
        }));

        assert_eq!(
            found,
            vec![
                (1, "full".to_string(), Some(1_600_000_000), None),
                (2, "created".to_string(), Some(1_700_000_000), Some(9)),
            ]
        );
    }

    /// An entry that names no outcome says nothing about what happened, and a key that is not
    /// a number is not a request id. Neither should be allowed to mark a request answered.
    #[test]
    fn refuses_an_answer_that_says_nothing() {
        let found = outcomes(&json!({
            "done": {
                "1": { "id": 1, "at": 1 },
                "3": { "outcome": "created" },
                "2": { "id": 2, "outcome": "created" },
            }
        }));

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, 2);
    }

    /// The shape the parser hands back whenever the ids happen to run from one — which is the
    /// first request anybody ever sends, and so the one case that must not be the broken one.
    #[test]
    fn reads_the_record_back_when_it_arrives_as_a_sequence() {
        let found = outcomes(&json!({
            "done": [
                { "id": 1, "outcome": "created", "at": 20, "setId": 9 },
                { "id": 2, "outcome": "full", "at": 21 },
            ]
        }));

        assert_eq!(
            found,
            vec![
                (1, "created".to_string(), Some(20), Some(9)),
                (2, "full".to_string(), Some(21), None),
            ]
        );
    }

    #[test]
    fn survives_a_record_the_addon_has_never_written() {
        assert!(outcomes(&json!({})).is_empty());
        assert!(outcomes(&Value::Null).is_empty());
    }
}
