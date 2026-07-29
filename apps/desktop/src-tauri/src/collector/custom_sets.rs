//! The sets somebody put together in this app.
//!
//! Theirs rather than the game's: nothing in a saved set exists in the client's wardrobe, and
//! nothing outside this app writes one. A set is a name and the pieces under it, replaced when
//! the same name is saved again, and marked the same way a set the game ships is — see
//! [`super::marks`].

use super::database::open_database;
use crate::customsets;
use rusqlite::{params, Connection};
use std::{collections::HashMap, path::Path};

/// Every set the reader has saved, whole.
///
/// Whole rather than as cards to open later, because there is nothing to open: a Blizzard set is
/// a row in the game's tables that costs four more table walks to turn into a list of looks, and
/// a saved set *is* the list of looks. Tens of sets of a dozen pieces is a payload smaller than
/// one set's icons, and the window re-reads it after every write — the same "repaint from
/// storage" rule the marks follow.
pub fn custom_sets(database_path: &Path) -> Result<customsets::CustomSetsPayload, String> {
    let connection = open_database(database_path)?;
    read_custom_sets(&connection)
}

/// Saves whatever the character has on under a name, or saves over the set already called that.
///
/// One command for both, and that is the feature rather than a shortcut: names are unique
/// without regard to case, so a reader who dressed her, saved "Horde look", then swapped the
/// helm and saved again means the set they already have and not a second one beside it. Which
/// spelling is kept is the one just typed, for the same reason a tag's key is — it is the
/// correction.
///
/// The pieces are replaced rather than merged. A saved set is a picture of the character at a
/// moment, and merging would make saving a shorter outfit over a longer one leave the difference
/// on her — a set nobody ever wore.
pub fn save_custom_set(
    database_path: &Path,
    name: &str,
    pieces: Vec<customsets::Piece>,
    now: i64,
) -> Result<customsets::CustomSetsPayload, String> {
    let name = customsets::clean_name(name)?;
    let pieces = customsets::clean_pieces(pieces)?;
    let mut connection = open_database(database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO transmog_custom_sets (name, created_at, updated_at)
             VALUES (?1, ?2, ?2)
             ON CONFLICT(name)
             DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
            params![name, now],
        )
        .map_err(|error| error.to_string())?;
    let set_id: i64 = transaction
        .query_row(
            "SELECT id FROM transmog_custom_sets WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM transmog_custom_set_pieces WHERE set_id = ?1",
            params![set_id],
        )
        .map_err(|error| error.to_string())?;
    for piece in &pieces {
        transaction
            .execute(
                "INSERT INTO transmog_custom_set_pieces (
                     set_id, place, appearance_id, item_id, name, display_type, inventory_type,
                     display_info_id, icon_file_data_id, has_model
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    set_id,
                    piece.place,
                    piece.appearance_id,
                    piece.item_id,
                    piece.name,
                    piece.display_type,
                    piece.inventory_type,
                    piece.display_info_id,
                    piece.icon_file_data_id,
                    i64::from(piece.has_model),
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    read_custom_sets(&connection)
}

/// Throws a saved set away, and everything anybody said about it with it.
///
/// The marks go by hand rather than by a foreign key, because a mark has none — its subject is
/// usually something in the game's files. Leaving them would be worse than untidy: the ids are
/// this database's own, so a star left behind by a deleted set is a star the *next* set saved
/// would be wearing. `AUTOINCREMENT` in the migration is the other half of that guard.
///
/// A set that is not there is not an error, the way an already-removed tag is not: the state
/// asked for is the state that results.
pub fn delete_custom_set(
    database_path: &Path,
    id: i64,
) -> Result<customsets::CustomSetsPayload, String> {
    let id = customsets::set_id(id)?;
    let mut connection = open_database(database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    // The pieces go with it, by the cascade the migration declares and `PRAGMA foreign_keys`
    // turns on in `open_database`.
    transaction
        .execute(
            "DELETE FROM transmog_custom_sets WHERE id = ?1",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM transmog_favourites WHERE subject_kind = ?1 AND subject_id = ?2",
            params![customsets::KIND, id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM transmog_tags WHERE subject_kind = ?1 AND subject_id = ?2",
            params![customsets::KIND, id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    read_custom_sets(&connection)
}

/// The saved sets and their pieces, folded into one list.
///
/// Two queries rather than a join, the way the marks are read: a set is worth answering with
/// whether or not it has pieces, and a join would have to invent a row to say so. By name
/// without regard to case, so the browser lists them the way a reader would file them and not
/// in the order they happened to be saved. The pieces come back in a fixed order rather than a
/// meaningful one — which place is worn above which is `outfit.ts`'s question, and it is asked
/// of a set of the reader's own exactly as it is asked of the character herself.
fn read_custom_sets(connection: &Connection) -> Result<customsets::CustomSetsPayload, String> {
    let mut sets: Vec<customsets::CustomSet> = Vec::new();
    let mut at: HashMap<i64, usize> = HashMap::new();

    let mut saved = connection
        .prepare(
            "SELECT id, name, created_at, updated_at FROM transmog_custom_sets
             ORDER BY name COLLATE NOCASE, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = saved
        .query_map([], |row| {
            Ok(customsets::CustomSet {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                pieces: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let set = row.map_err(|error| error.to_string())?;
        at.insert(set.id, sets.len());
        sets.push(set);
    }

    let mut worn = connection
        .prepare(
            "SELECT set_id, place, appearance_id, item_id, name, display_type, inventory_type,
                    display_info_id, icon_file_data_id, has_model
             FROM transmog_custom_set_pieces ORDER BY set_id, place",
        )
        .map_err(|error| error.to_string())?;
    let rows = worn
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                customsets::Piece {
                    place: row.get(1)?,
                    appearance_id: row.get(2)?,
                    item_id: row.get(3)?,
                    name: row.get(4)?,
                    display_type: row.get(5)?,
                    inventory_type: row.get(6)?,
                    display_info_id: row.get(7)?,
                    icon_file_data_id: row.get(8)?,
                    has_model: row.get::<_, i64>(9)? != 0,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (set_id, piece) = row.map_err(|error| error.to_string())?;
        if let Some(index) = at.get(&set_id) {
            sets[*index].pieces.push(piece);
        }
    }

    Ok(customsets::CustomSetsPayload { sets })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::database::MIGRATIONS;
    use crate::collector::marks::{set_transmog_favourite, set_transmog_tag, transmog_marks};
    use crate::collector::testing::*;
    use crate::marks;

    use std::fs;

    const SAVED_AT: i64 = 2_100_000_000;

    /// One piece of an outfit, as the window sends it: a place, and what to draw there.
    fn worn(place: &str, display_info_id: i64) -> customsets::Piece {
        customsets::Piece {
            place: place.into(),
            appearance_id: display_info_id - 800_000,
            item_id: 712_245,
            name: "Tideglass Mantle".into(),
            display_type: 1,
            inventory_type: 3,
            display_info_id,
            icon_file_data_id: 130_001,
            has_model: true,
        }
    }

    fn saved<'a>(
        payload: &'a customsets::CustomSetsPayload,
        name: &str,
    ) -> Option<&'a customsets::CustomSet> {
        payload.sets.iter().find(|set| set.name == name)
    }

    #[test]
    fn a_database_nobody_has_saved_a_set_in_holds_none() {
        let install = Install::initialized();

        assert!(custom_sets(&install.database).unwrap().sets.is_empty());
    }

    #[test]
    fn saves_what_the_character_has_on_under_a_name() {
        let install = Install::initialized();

        let payload = save_custom_set(
            &install.database,
            "  Horde  look ",
            vec![worn("armour-0", 900_001), worn("hand-right", 900_007)],
            SAVED_AT,
        )
        .unwrap();

        // The name is what was typed with its whitespace made ordinary, not what was typed.
        let set = saved(&payload, "Horde look").unwrap();
        assert_eq!(set.created_at, SAVED_AT);
        assert_eq!(set.updated_at, SAVED_AT);
        // Every number a row needs to be drawn again survives the round trip, which is the
        // whole reason a piece is stored as what was on screen rather than as a key to it.
        let places: Vec<&str> = set.pieces.iter().map(|one| one.place.as_str()).collect();
        assert_eq!(places, vec!["armour-0", "hand-right"]);
        assert_eq!(set.pieces[1].display_info_id, 900_007);
        assert_eq!(set.pieces[1].appearance_id, 100_007);
        assert_eq!(set.pieces[0].name, "Tideglass Mantle");
        assert!(set.pieces[0].has_model);

        // And it is still there on the next read, which is the point of saving one.
        assert_eq!(custom_sets(&install.database).unwrap().sets.len(), 1);
    }

    /// Saving over a set is what somebody who swapped the helm means by saving again, and the
    /// name is how they say which set they meant. A second set of the same name is not it.
    #[test]
    fn saving_under_a_name_already_used_replaces_that_set() {
        let install = Install::initialized();

        let first = save_custom_set(
            &install.database,
            "Horde look",
            vec![worn("armour-0", 900_001), worn("hand-right", 900_007)],
            SAVED_AT,
        )
        .unwrap();
        let id = saved(&first, "Horde look").unwrap().id;

        // A different spelling of the same name, and a shorter outfit than the one saved.
        let payload = save_custom_set(
            &install.database,
            "horde LOOK",
            vec![worn("armour-3", 900_002)],
            SAVED_AT + 3600,
        )
        .unwrap();

        assert_eq!(payload.sets.len(), 1);
        let set = &payload.sets[0];
        assert_eq!(set.id, id);
        // The spelling just typed, the way a re-typed tag key is the correction.
        assert_eq!(set.name, "horde LOOK");
        assert_eq!(set.created_at, SAVED_AT);
        assert_eq!(set.updated_at, SAVED_AT + 3600);
        // Replaced rather than merged: the helm and the weapon are not still on her.
        let places: Vec<&str> = set.pieces.iter().map(|one| one.place.as_str()).collect();
        assert_eq!(places, vec!["armour-3"]);
    }

    #[test]
    fn refuses_a_set_nobody_could_have_meant_to_save() {
        let install = Install::initialized();

        assert!(save_custom_set(
            &install.database,
            "  ",
            vec![worn("armour-0", 900_001)],
            SAVED_AT
        )
        .is_err());
        assert!(save_custom_set(&install.database, "Bare", Vec::new(), SAVED_AT).is_err());
        assert!(save_custom_set(
            &install.database,
            "Twice",
            vec![worn("armour-0", 900_001), worn("armour-0", 900_002)],
            SAVED_AT,
        )
        .is_err());
        assert!(custom_sets(&install.database).unwrap().sets.is_empty());
    }

    /// The whole of what "custom sets can have any metadata a Blizzard set can" comes to: the
    /// same two tables, a third kind of subject, and no second feature anywhere.
    #[test]
    fn a_saved_set_is_starred_and_tagged_like_a_set_the_game_ships() {
        let install = Install::initialized();
        let payload = save_custom_set(
            &install.database,
            "Horde look",
            vec![worn("armour-0", 900_001)],
            SAVED_AT,
        )
        .unwrap();
        let id = payload.sets[0].id;

        set_transmog_favourite(&install.database, customsets::KIND, id, true, MARKED_AT).unwrap();
        let marked = set_transmog_tag(
            &install.database,
            customsets::KIND,
            id,
            "faction",
            Some("horde"),
            MARKED_AT,
        )
        .unwrap();

        let mark = mark_of(&marked, customsets::KIND, id).unwrap();
        assert!(mark.favourite);
        assert_eq!(mark.tags[0].value.as_deref(), Some("horde"));
        // And it is a subject of its own: set 1 of the game is not this set of the reader's.
        assert!(mark_of(&marked, marks::SET, id).is_none());
    }

    /// The ids here are this database's own, so a mark left behind by a deleted set is a mark
    /// the *next* set saved could find itself wearing. Both halves of that guard are checked:
    /// the marks go with the set, and the id is never handed out again.
    #[test]
    fn deleting_a_saved_set_takes_its_pieces_and_everything_said_about_it() {
        let install = Install::initialized();
        let payload = save_custom_set(
            &install.database,
            "Horde look",
            vec![worn("armour-0", 900_001)],
            SAVED_AT,
        )
        .unwrap();
        let id = payload.sets[0].id;
        set_transmog_favourite(&install.database, customsets::KIND, id, true, MARKED_AT).unwrap();

        let left = delete_custom_set(&install.database, id).unwrap();

        assert!(left.sets.is_empty());
        assert!(mark_of(
            &transmog_marks(&install.database).unwrap(),
            customsets::KIND,
            id
        )
        .is_none());
        // The pieces went with it, by the cascade the migration declares.
        let connection = open_database(&install.database).unwrap();
        let pieces: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM transmog_custom_set_pieces",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pieces, 0);

        let next = save_custom_set(
            &install.database,
            "Alliance look",
            vec![worn("armour-0", 900_002)],
            SAVED_AT,
        )
        .unwrap();
        assert_ne!(next.sets[0].id, id);
    }

    /// A set that is not there is a set nobody has to be told about — the same rule a tag
    /// removed twice follows.
    #[test]
    fn deleting_a_set_that_is_not_there_is_not_an_error() {
        let install = Install::initialized();

        assert!(delete_custom_set(&install.database, 404)
            .unwrap()
            .sets
            .is_empty());
        assert!(delete_custom_set(&install.database, 0).is_err());
    }

    /// The migration rebuilds both mark tables to widen one `CHECK`, and a rebuild that lost a
    /// row would lose what somebody said about the game's wardrobe months ago.
    #[test]
    fn migrates_a_database_marked_before_anybody_could_save_a_set_of_their_own() {
        let install = Install::empty();
        {
            fs::create_dir_all(install.database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&install.database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..16] {
                transaction.execute_batch(migration.sql).unwrap();
            }
            transaction
                .execute(
                    "INSERT INTO transmog_favourites (subject_kind, subject_id, created_at)
                     VALUES ('set', 1834, ?1)",
                    params![MARKED_AT],
                )
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO transmog_tags (subject_kind, subject_id, key, value, created_at)
                     VALUES ('appearance', 91002, 'faction', 'horde', ?1)",
                    params![MARKED_AT],
                )
                .unwrap();
            transaction
                .pragma_update(None, "user_version", 16_i64)
                .unwrap();
            transaction.commit().unwrap();
        }

        let payload = save_custom_set(
            &install.database,
            "Horde look",
            vec![worn("armour-0", 900_001)],
            SAVED_AT,
        )
        .unwrap();

        assert_eq!(payload.sets.len(), 1);
        let marks = transmog_marks(&install.database).unwrap();
        assert!(mark_of(&marks, marks::SET, 1834).unwrap().favourite);
        assert_eq!(
            mark_of(&marks, marks::APPEARANCE, 91002).unwrap().tags[0]
                .value
                .as_deref(),
            Some("horde")
        );
    }
}
