//! The outfits the game itself holds, and the ones this app asks it to save.
//!
//! Both directions of the same conversation. What the addon read out of the game's own
//! wardrobe is filed per character and replaced wholesale on every sync; what this app wants
//! saved is written as a request the addon picks up at the next login, and the answer it
//! writes back is filed against the request that asked.

use super::database::open_database;
use super::roster::upsert_character_key;
use crate::customsets;
use crate::ingamesets;
use rusqlite::{params, Connection, Transaction};
use std::path::Path;

use crate::failure::Failure;

/// What each character was last seen to have saved in game, replacing whatever it last said.
///
/// Wholesale per character, the way [`super::holdings::sync_holdings`] is and for the same reason: this is a
/// snapshot of one wardrobe, and half of an old one beside half of a new one is a wardrobe
/// nobody ever had. That is also the whole of the cleaning up the file needs — a set deleted in
/// game stops being written by the addon, and stops existing here on the next sync, without
/// anything having to notice it went.
///
/// Only characters the file actually reported are touched. A roster of ten alts is one file, and
/// the character that logged out last is the only one whose wardrobe was read; wiping the other
/// nine because they said nothing this time would empty the app every time somebody played.
pub(super) fn sync_in_game_sets(
    transaction: &Transaction<'_>,
    account_id: i64,
    characters: &[ingamesets::CharacterSets],
    now: i64,
) -> Result<(), Failure> {
    for reported in characters {
        let character_id = upsert_character_key(
            transaction,
            account_id,
            &reported.character,
            None,
            None,
            now,
        )?;
        // The slots go with the sets by way of the cascade the migration declares, so deleting
        // the sets is the whole of the clearing out.
        transaction.execute(
            "DELETE FROM character_transmog_sets WHERE character_id = ?1",
            [character_id],
        )?;
        for set in &reported.sets {
            transaction.execute(
                "INSERT INTO character_transmog_sets
                         (character_id, set_id, name, icon, observed_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                params![character_id, set.id, set.name, set.icon, set.observed_at],
            )?;
            for slot in &set.slots {
                transaction.execute(
                    "INSERT INTO character_transmog_set_slots
                             (character_id, set_id, slot, appearance_id,
                              secondary_appearance_id, illusion_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        character_id,
                        set.id,
                        slot.slot,
                        slot.appearance_id,
                        slot.secondary_appearance_id,
                        slot.illusion_id
                    ],
                )?;
            }
        }
    }
    Ok(())
}

/// Marks the outfits the addon has now carried out, so the app stops asking for them.
///
/// The first write is the last one: `applied_at IS NULL` is the guard, so an addon that keeps
/// reporting the same outcome — which it does, because its own record outlives the request —
/// leaves the first answer standing rather than moving the moment forward on every login.
///
/// Nothing is checked about *which* account answered. A custom set belongs to the account and a
/// request names no character, so the first account to carry one out has carried it out; an
/// install with two accounts would otherwise have the same outfit saved twice, once per roster.
pub(super) fn sync_set_request_outcomes(
    transaction: &Transaction<'_>,
    outcomes: &[(i64, String, Option<i64>, Option<i64>)],
    now: i64,
) -> Result<(), Failure> {
    for (id, outcome, at, set_id) in outcomes {
        transaction.execute(
            "UPDATE transmog_set_requests
                 SET outcome = ?2, applied_at = COALESCE(?3, ?4), set_id = ?5
                 WHERE id = ?1 AND applied_at IS NULL",
            // The addon's own moment where it gave one, and this sync's where it did not:
            // a request that has been answered has to carry a moment, or the guard above
            // would let the next sync answer it again.
            params![id, outcome, at, now, set_id],
        )?;
    }
    Ok(())
}

/// Every character's in-game sets, for the window to browse.
///
/// All of them at once rather than a character at a time, for the reason the reader's own sets
/// come back all at once: this is what one person saved with their own hands across one roster,
/// so it is tens of rows rather than the game's several thousand sets.
pub fn in_game_sets(database_path: &Path) -> Result<ingamesets::InGameSetsPayload, Failure> {
    let connection = open_database(database_path)?;
    let mut statement = connection.prepare(
        // `source_key` rather than `name`, which is what every other reader in this file
        // selects and what the payload's own doc promises: `name` is the half before the
        // hyphen, so two Asters on two realms would fold into one wardrobe and the window
        // — which looks a character up by `Name-Realm` — would find neither.
        "SELECT c.source_key, s.set_id, s.name, s.icon, s.observed_at
             FROM character_transmog_sets s
             JOIN characters c ON c.id = s.character_id
             ORDER BY c.source_key, s.name COLLATE NOCASE, s.set_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, Option<i64>>(4)?,
        ))
    })?;

    let mut characters: Vec<ingamesets::CharacterSets> = Vec::new();
    for row in rows {
        let (character, id, name, icon, observed_at) = row?;
        let set = ingamesets::InGameSet {
            id,
            name,
            icon,
            observed_at,
            slots: Vec::new(),
        };
        // The query is ordered by character, so a run of rows belongs to whichever one is
        // already being built and a new name is always a new entry.
        match characters.last_mut() {
            Some(last) if last.character == character => last.sets.push(set),
            _ => characters.push(ingamesets::CharacterSets {
                character,
                sets: vec![set],
            }),
        }
    }

    let mut slots = connection.prepare(
        "SELECT c.source_key, s.set_id, s.slot, s.appearance_id,
                    s.secondary_appearance_id, s.illusion_id
             FROM character_transmog_set_slots s
             JOIN characters c ON c.id = s.character_id
             ORDER BY c.source_key, s.set_id, s.slot",
    )?;
    let held = slots.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            ingamesets::Slot {
                slot: row.get(2)?,
                appearance_id: row.get(3)?,
                secondary_appearance_id: row.get(4)?,
                illusion_id: row.get(5)?,
            },
        ))
    })?;
    for row in held {
        let (character, set_id, slot) = row?;
        if let Some(found) = characters
            .iter_mut()
            .find(|entry| entry.character == character)
            .and_then(|entry| entry.sets.iter_mut().find(|set| set.id == set_id))
        {
            found.slots.push(slot);
        }
    }

    Ok(ingamesets::InGameSetsPayload { characters })
}

/// Records an outfit for the game to hold on to, and answers with everything asked for so far.
///
/// The name is cleaned to exactly the rules a set saved in this app is held to — see
/// `customsets::clean_name` — because both end up as a name somebody reads in a list, and one of
/// them ends up inside a Lua source file the game executes.
///
/// A send is *recorded* and not performed. Nothing here touches the game: the caller writes the
/// waiting requests into the addon's folder afterwards, and the addon carries them out the next
/// time the player logs in. That is the whole shape of this direction and the reason the row
/// outlives the file — see `0019_set_requests.sql`.
pub fn request_set_in_game(
    database_path: &Path,
    name: &str,
    icon: Option<i64>,
    slots: &[ingamesets::Slot],
    now: i64,
) -> Result<Vec<ingamesets::Request>, Failure> {
    let name = customsets::clean_name(name)?;
    if slots.is_empty() {
        return Err("Put something on her first, and then it can be sent to the game.".into());
    }
    let mut connection = open_database(database_path)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction.execute(
        "INSERT INTO transmog_set_requests (name, icon, created_at) VALUES (?1, ?2, ?3)",
        params![name, icon, now],
    )?;
    let request_id = transaction.last_insert_rowid();
    for slot in slots {
        transaction.execute(
            "INSERT OR REPLACE INTO transmog_set_request_slots
                     (request_id, slot, appearance_id, secondary_appearance_id, illusion_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                request_id,
                slot.slot,
                slot.appearance_id,
                slot.secondary_appearance_id,
                slot.illusion_id
            ],
        )?;
    }
    transaction.commit()?;
    read_set_requests(&connection, false)
}

/// Every outfit this app has asked the game for, newest first.
pub fn set_requests(database_path: &Path) -> Result<Vec<ingamesets::Request>, Failure> {
    let connection = open_database(database_path)?;
    read_set_requests(&connection, false)
}

/// The ones still waiting to be seen, which is what gets written into the addon's folder.
pub fn waiting_set_requests(database_path: &Path) -> Result<Vec<ingamesets::Request>, Failure> {
    let connection = open_database(database_path)?;
    read_set_requests(&connection, true)
}

/// Reads requests, optionally only the unanswered ones, with their slots attached.
fn read_set_requests(
    connection: &Connection,
    waiting_only: bool,
) -> Result<Vec<ingamesets::Request>, Failure> {
    let sql = if waiting_only {
        "SELECT id, name, icon, created_at, outcome, applied_at, set_id
         FROM transmog_set_requests WHERE applied_at IS NULL ORDER BY id"
    } else {
        "SELECT id, name, icon, created_at, outcome, applied_at, set_id
         FROM transmog_set_requests ORDER BY id DESC"
    };
    let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| {
        Ok(ingamesets::Request {
            id: row.get(0)?,
            name: row.get(1)?,
            icon: row.get(2)?,
            created_at: row.get(3)?,
            outcome: row.get(4)?,
            applied_at: row.get(5)?,
            set_id: row.get(6)?,
            slots: Vec::new(),
        })
    })?;
    let mut requests: Vec<ingamesets::Request> =
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;

    let mut slots = connection.prepare(
        "SELECT request_id, slot, appearance_id, secondary_appearance_id, illusion_id
             FROM transmog_set_request_slots ORDER BY request_id, slot",
    )?;
    let held = slots.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            ingamesets::Slot {
                slot: row.get(1)?,
                appearance_id: row.get(2)?,
                secondary_appearance_id: row.get(3)?,
                illusion_id: row.get(4)?,
            },
        ))
    })?;
    for row in held {
        let (request_id, slot) = row?;
        if let Some(found) = requests.iter_mut().find(|request| request.id == request_id) {
            found.slots.push(slot);
        }
    }
    Ok(requests)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::collector::testing::*;

    /// One character's sets out of the payload, by the key it comes back under.
    ///
    /// `Name-Realm` — the account key, which is what every reader in this file answers with and
    /// what the window looks a character up by. The bare name would fold two Asters on two
    /// realms into one wardrobe, so the whole key is asked for here and nowhere is it split.
    fn sets_of<'a>(
        payload: &'a ingamesets::InGameSetsPayload,
        character: &str,
    ) -> &'a [ingamesets::InGameSet] {
        payload
            .characters
            .iter()
            .find(|entry| entry.character == character)
            .map(|entry| entry.sets.as_slice())
            .unwrap_or_else(|| panic!("no sets for {character}"))
    }

    /// Two characters of one account, which is what one SavedVariables file holds. Aster has a
    /// filled set and an empty one; Brin has a weapon, which is the only kind of slot that
    /// carries both of the things a slot usually has not got.
    const TWO_WARDROBES: &str = r#"
        ["Aster-Vale"] = {
            ["at"] = 2000000000,
            ["sets"] = {
                { ["id"] = 4, ["name"] = "Winter", ["icon"] = 133600, ["slots"] = {
                    { ["slot"] = 0, ["appearance"] = 55 },
                    { ["slot"] = 9, ["appearance"] = 66 },
                } },
                { ["id"] = 7, ["name"] = "Later", ["slots"] = { } },
            },
        },
        ["Brin-Ravencrest"] = {
            ["at"] = 1999000000,
            ["sets"] = {
                { ["id"] = 1, ["name"] = "Sunfire", ["icon"] = 133601, ["slots"] = {
                    { ["slot"] = 11, ["appearance"] = 88, ["secondary"] = 99,
                      ["illusion"] = 5000 },
                } },
            },
        },
    "#;

    #[test]
    fn a_roster_nobody_has_saved_a_set_on_holds_none() {
        let install = Install::of(&SavedVariables::new().in_game_sets(""));

        install.collect(2_000_000_100);

        assert!(in_game_sets(&install.database)
            .unwrap()
            .characters
            .is_empty());
    }

    /// The whole of the round trip: the addon's table becomes rows, and the rows come back as
    /// sets with their slots on the set they belong to rather than pooled across the character.
    #[test]
    fn files_a_characters_sets_and_what_is_in_them() {
        let install = Install::of(&SavedVariables::new().in_game_sets(TWO_WARDROBES));

        install.collect(2_000_000_100);

        let payload = in_game_sets(&install.database).unwrap();
        let aster = sets_of(&payload, "Aster-Vale");
        // By name, which is the order the window lists them in, so the empty one leads.
        assert_eq!(
            aster.iter().map(|set| set.id).collect::<Vec<_>>(),
            vec![7, 4]
        );

        let winter = &aster[1];
        assert_eq!(winter.name, "Winter");
        assert_eq!(winter.icon, Some(133_600));
        assert_eq!(
            winter.slots,
            vec![
                ingamesets::Slot {
                    slot: 0,
                    appearance_id: 55,
                    secondary_appearance_id: None,
                    illusion_id: None,
                },
                ingamesets::Slot {
                    slot: 9,
                    appearance_id: 66,
                    secondary_appearance_id: None,
                    illusion_id: None,
                },
            ]
        );

        // Brin's one slot stayed on Brin's one set: the join is by character and set, and a
        // reader that matched on the set id alone would hang this weapon on Aster too, since
        // both rosters number their sets from one.
        let brin = sets_of(&payload, "Brin-Ravencrest");
        assert_eq!(brin.len(), 1);
        assert_eq!(
            brin[0].slots,
            vec![ingamesets::Slot {
                slot: 11,
                appearance_id: 88,
                secondary_appearance_id: Some(99),
                illusion_id: Some(5000),
            }]
        );
    }

    /// A set the player named and has not filled is a set — the game lists it for them, and a
    /// wardrobe that quietly dropped it here would disagree with the one they can see.
    #[test]
    fn keeps_a_set_with_nothing_in_it() {
        let install = Install::of(&SavedVariables::new().in_game_sets(TWO_WARDROBES));

        install.collect(2_000_000_100);

        let payload = in_game_sets(&install.database).unwrap();
        let later = &sets_of(&payload, "Aster-Vale")[0];
        assert_eq!(later.id, 7);
        assert_eq!(later.name, "Later");
        assert_eq!(later.icon, None);
        assert!(later.slots.is_empty());
    }

    /// When the addon last saw the wardrobe *differ*, not when the collector ran. The two are
    /// hours apart for anybody who saved a set and then played for an evening, and the reading
    /// is only worth showing if it is the addon's.
    #[test]
    fn carries_through_when_the_wardrobe_was_last_seen_to_differ() {
        let install = Install::of(&SavedVariables::new().in_game_sets(TWO_WARDROBES));

        install.collect(2_000_000_100);

        let payload = in_game_sets(&install.database).unwrap();
        for set in sets_of(&payload, "Aster-Vale") {
            assert_eq!(set.observed_at, Some(2_000_000_000));
        }
        assert_eq!(
            sets_of(&payload, "Brin-Ravencrest")[0].observed_at,
            Some(1_999_000_000)
        );
    }

    /// The file is a snapshot of one wardrobe, so a sync is a replacement and not a merge. A
    /// set deleted at the transmogrifier simply stops being written, and this is what makes it
    /// stop existing here — with its slots, by the cascade the migration declares.
    #[test]
    fn a_later_sync_replaces_a_characters_sets_wholesale() {
        let install = Install::of(&SavedVariables::new().in_game_sets(TWO_WARDROBES));
        install.collect(2_000_000_100);

        // Winter was deleted in game, Later was renamed and filled, and both are reported in
        // the one list because that list is the whole wardrobe.
        install.rewrite(&SavedVariables::new().in_game_sets(
            r#"
            ["Aster-Vale"] = {
                ["at"] = 2000000500,
                ["sets"] = {
                    { ["id"] = 7, ["name"] = "Spring", ["icon"] = 133602, ["slots"] = {
                        { ["slot"] = 3, ["appearance"] = 44 },
                    } },
                },
            },
            "#,
        ));
        install.collect(2_000_000_600);

        let payload = in_game_sets(&install.database).unwrap();
        let aster = sets_of(&payload, "Aster-Vale");
        assert_eq!(aster.len(), 1);
        assert_eq!(aster[0].id, 7);
        assert_eq!(aster[0].name, "Spring");
        assert_eq!(aster[0].observed_at, Some(2_000_000_500));
        assert_eq!(aster[0].slots.len(), 1);
        assert_eq!(aster[0].slots[0].appearance_id, 44);

        // The deleted set's two slots went with it rather than being left behind to be hung on
        // whatever set claims id 4 next — Brin's one slot is all that is left beside Spring's.
        assert_eq!(count_of(&install.database, "character_transmog_sets"), 2);
        assert_eq!(
            count_of(&install.database, "character_transmog_set_slots"),
            2
        );
    }

    /// A roster of ten alts is one file, and the character that logged out last is the only one
    /// whose wardrobe was read. Wiping the other nine because they said nothing this time would
    /// empty the app every time somebody played.
    #[test]
    fn leaves_a_character_the_file_did_not_mention_this_time_standing() {
        let install = Install::of(&SavedVariables::new().in_game_sets(TWO_WARDROBES));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().in_game_sets(
            r#"
            ["Brin-Ravencrest"] = {
                ["at"] = 2000000500,
                ["sets"] = { { ["id"] = 1, ["name"] = "Sunfire", ["slots"] = { } } },
            },
            "#,
        ));
        install.collect(2_000_000_600);

        let payload = in_game_sets(&install.database).unwrap();
        // Aster's wardrobe is exactly as it was, stamp included: nothing about her was read.
        let aster = sets_of(&payload, "Aster-Vale");
        assert_eq!(
            aster.iter().map(|set| set.id).collect::<Vec<_>>(),
            vec![7, 4]
        );
        assert_eq!(aster[1].slots.len(), 2);
        assert_eq!(aster[1].observed_at, Some(2_000_000_000));
        // And Brin's was replaced, weapon and all, by the one list that did arrive.
        let brin = sets_of(&payload, "Brin-Ravencrest");
        assert_eq!(brin.len(), 1);
        assert!(brin[0].slots.is_empty());
    }

    fn one_slot(slot: i64, appearance_id: i64) -> ingamesets::Slot {
        ingamesets::Slot {
            slot,
            appearance_id,
            secondary_appearance_id: None,
            illusion_id: None,
        }
    }

    #[test]
    fn records_an_outfit_for_the_game_to_save() {
        let install = Install::of(&SavedVariables::new().in_game_sets(""));
        open_database(&install.database).unwrap();

        let requests = request_set_in_game(
            &install.database,
            "  Winter   Look ",
            Some(133_600),
            &[one_slot(0, 55)],
            10,
        )
        .unwrap();

        assert_eq!(requests.len(), 1);
        // Cleaned the way a set saved in this app is, because both end up as a name somebody
        // reads in a list — and one of them ends up inside a Lua file the game executes.
        assert_eq!(requests[0].name, "Winter Look");
        assert_eq!(requests[0].icon, Some(133_600));
        assert_eq!(requests[0].created_at, 10);
        assert_eq!(requests[0].slots, vec![one_slot(0, 55)]);
        // Unanswered, which is what a request is until the player has actually logged in.
        assert_eq!(requests[0].outcome, None);
        assert_eq!(requests[0].applied_at, None);
    }

    /// A send with nothing on her is refused rather than stored, because a set of no clothes is
    /// not a thing the player could have meant and the game would only be asked to hold nothing.
    #[test]
    fn refuses_an_outfit_with_nothing_in_it() {
        let install = Install::of(&SavedVariables::new().in_game_sets(""));
        open_database(&install.database).unwrap();

        let error = request_set_in_game(&install.database, "Winter", None, &[], 10).unwrap_err();

        assert!(error.report().contains("Put something on her"), "{error}");
        assert!(set_requests(&install.database).unwrap().is_empty());
    }

    /// Only the unanswered ones are written into the addon's folder. A request the game has
    /// already carried out would otherwise be carried out again on the next install, saving
    /// over a set the player may have edited since.
    #[test]
    fn writes_only_the_requests_still_waiting() {
        let install = Install::of(&SavedVariables::new().in_game_sets(""));
        open_database(&install.database).unwrap();
        request_set_in_game(&install.database, "Winter", None, &[one_slot(0, 55)], 10).unwrap();
        request_set_in_game(&install.database, "Summer", None, &[one_slot(0, 66)], 11).unwrap();

        install.rewrite(&SavedVariables::new().answered_set_requests(
            r#"[1] = { ["id"] = 1, ["outcome"] = "created", ["at"] = 20, ["setId"] = 9 },"#,
        ));
        install.collect(30);

        let waiting = waiting_set_requests(&install.database).unwrap();
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].name, "Summer");

        // And the answered one carries what the addon said, under the id the app gave it.
        let all = set_requests(&install.database).unwrap();
        let winter = all.iter().find(|one| one.name == "Winter").unwrap();
        assert_eq!(winter.outcome.as_deref(), Some("created"));
        assert_eq!(winter.applied_at, Some(20));
        assert_eq!(winter.set_id, Some(9));
    }

    /// The addon's record outlives the request, so it keeps reporting the same outcome at every
    /// logout. The first answer is the one that stands — otherwise the moment it was carried
    /// out would creep forward every time the player logged in for the rest of the year.
    #[test]
    fn keeps_the_first_answer_a_request_was_given() {
        let install = Install::of(&SavedVariables::new().in_game_sets(""));
        open_database(&install.database).unwrap();
        request_set_in_game(&install.database, "Winter", None, &[one_slot(0, 55)], 10).unwrap();

        let answered = SavedVariables::new().answered_set_requests(
            r#"[1] = { ["id"] = 1, ["outcome"] = "created", ["at"] = 20, ["setId"] = 9 },"#,
        );
        install.write(&answered);
        install.collect(30);
        install.rewrite(&answered);
        install.collect(40);

        let all = set_requests(&install.database).unwrap();
        assert_eq!(all[0].applied_at, Some(20));
    }

    /// Newest first, because the one somebody just sent is the one they are looking for — and
    /// the id is what the addon keys "already done" on, so it has to be theirs alone.
    #[test]
    fn hands_back_every_request_newest_first() {
        let install = Install::of(&SavedVariables::new().in_game_sets(""));
        open_database(&install.database).unwrap();
        request_set_in_game(&install.database, "Winter", None, &[one_slot(0, 55)], 10).unwrap();
        request_set_in_game(&install.database, "Summer", None, &[one_slot(1, 66)], 11).unwrap();

        let all = set_requests(&install.database).unwrap();

        assert_eq!(
            all.iter().map(|one| one.name.as_str()).collect::<Vec<_>>(),
            vec!["Summer", "Winter"]
        );
        assert_eq!(all[0].slots, vec![one_slot(1, 66)]);
        assert_ne!(all[0].id, all[1].id);
    }
}
