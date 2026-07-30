//! What somebody has said about a wardrobe.
//!
//! A star or a tag, against a subject named by a kind and a number — an appearance, a set the
//! game ships, a set they saved themselves. Deliberately not a column on the thing marked:
//! most subjects here are the game's own and have no row of ours to carry one, and a mark has
//! to outlive every rebuild of everything it points at.

use super::database::open_database;
use crate::marks;
use rusqlite::{params, Connection};
use std::{collections::HashMap, path::Path};

use crate::failure::Failure;

/// Every mark anybody has made, as one payload.
///
/// All of them, rather than the ones a browser is about to draw. These are the rows one person
/// wrote by hand — a few hundred at the outside — where the wardrobe they were written about
/// is fifty-five thousand looks, so asking per kind or per page would be four hundred trips
/// across the bridge to save less than a single set's worth of icons. The window keeps this and
/// re-reads it after every write, which is what makes what is on screen what was stored.
///
/// A subject with nothing said about it is simply absent. Ordered by subject and then by key,
/// so two reads of an unchanged database are the same bytes and a list of chips does not
/// reshuffle itself under somebody adding an unrelated tag.
pub fn transmog_marks(database_path: &Path) -> Result<marks::MarksPayload, Failure> {
    let connection = open_database(database_path)?;
    read_marks(&connection)
}

/// Stars a set or a look, or takes the star off again.
///
/// Un-starring deletes the row rather than writing a `0`, which is what `0016_transmog_marks`
/// stores this as and why: there is one way of saying "nobody starred this", and a subject
/// somebody starred and then thought better of is that.
pub fn set_transmog_favourite(
    database_path: &Path,
    kind: &str,
    id: i64,
    favourite: bool,
    now: i64,
) -> Result<marks::MarksPayload, Failure> {
    let kind = marks::subject_kind(kind)?;
    let id = marks::subject_id(id)?;
    let connection = open_database(database_path)?;
    if favourite {
        connection.execute(
            "INSERT INTO transmog_favourites (subject_kind, subject_id, created_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(subject_kind, subject_id) DO NOTHING",
            params![kind, id, now],
        )?;
    } else {
        connection.execute(
            "DELETE FROM transmog_favourites WHERE subject_kind = ?1 AND subject_id = ?2",
            params![kind, id],
        )?;
    }
    read_marks(&connection)
}

/// Writes a tag against a set or a look, whether it carries a value or is a bare label.
///
/// Applying a key a subject already has replaces its value rather than adding a second tag,
/// which is what somebody correcting "faction: hoard" means by typing it again — and, because
/// the key collates case-insensitively, typing "Faction" edits the "faction" already there
/// instead of sitting beside it. The key stored is whichever spelling was typed last, for the
/// same reason: it is the correction.
pub fn set_transmog_tag(
    database_path: &Path,
    kind: &str,
    id: i64,
    key: &str,
    value: Option<&str>,
    now: i64,
) -> Result<marks::MarksPayload, Failure> {
    let kind = marks::subject_kind(kind)?;
    let id = marks::subject_id(id)?;
    let key = marks::clean_key(key)?;
    let value = marks::clean_value(value)?;
    let connection = open_database(database_path)?;
    connection.execute(
        "INSERT INTO transmog_tags (subject_kind, subject_id, key, value, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(subject_kind, subject_id, key)
             DO UPDATE SET key = excluded.key, value = excluded.value",
        params![kind, id, key, value, now],
    )?;
    read_marks(&connection)
}

/// Takes a tag off a set or a look. A key that was never there is not an error: the state
/// asked for is the state that results, which is what a second click on a remove button means.
pub fn delete_transmog_tag(
    database_path: &Path,
    kind: &str,
    id: i64,
    key: &str,
) -> Result<marks::MarksPayload, Failure> {
    let kind = marks::subject_kind(kind)?;
    let id = marks::subject_id(id)?;
    let key = marks::clean_key(key)?;
    let connection = open_database(database_path)?;
    connection.execute(
        "DELETE FROM transmog_tags
             WHERE subject_kind = ?1 AND subject_id = ?2 AND key = ?3",
        params![kind, id, key],
    )?;
    read_marks(&connection)
}

/// Folds the two tables into one mark per subject, which is how the window indexes them.
///
/// Two queries rather than a join, because the two facts are independent: a subject can be
/// starred and untagged, tagged and unstarred, or both, and a join would have to invent a row
/// on one side to say so. The order of the marks is the order the favourites and then the tags
/// arrive in — both sorted by subject — so a subject reached from either half lands in the
/// same place.
fn read_marks(connection: &Connection) -> Result<marks::MarksPayload, Failure> {
    let mut marks: Vec<marks::Mark> = Vec::new();
    let mut at: HashMap<(String, i64), usize> = HashMap::new();

    let mut starred = connection.prepare(
        "SELECT subject_kind, subject_id FROM transmog_favourites
             ORDER BY subject_kind, subject_id",
    )?;
    let rows = starred.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (kind, id) = row?;
        let index = *at.entry((kind.clone(), id)).or_insert_with(|| {
            marks.push(marks::Mark {
                kind,
                id,
                favourite: false,
                tags: Vec::new(),
            });
            marks.len() - 1
        });
        marks[index].favourite = true;
    }

    let mut tagged = connection.prepare(
        "SELECT subject_kind, subject_id, key, value FROM transmog_tags
             ORDER BY subject_kind, subject_id, key",
    )?;
    let rows = tagged.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            marks::Tag {
                key: row.get(2)?,
                value: row.get(3)?,
            },
        ))
    })?;
    for row in rows {
        let (kind, id, tag) = row?;
        let index = *at.entry((kind.clone(), id)).or_insert_with(|| {
            marks.push(marks::Mark {
                kind,
                id,
                favourite: false,
                tags: Vec::new(),
            });
            marks.len() - 1
        });
        marks[index].tags.push(tag);
    }

    Ok(marks::MarksPayload { marks })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::database::MIGRATIONS;
    use crate::collector::testing::*;

    use std::fs;

    #[test]
    fn a_database_nobody_has_marked_anything_in_holds_no_marks() {
        let install = Install::initialized();

        assert!(transmog_marks(&install.database).unwrap().marks.is_empty());
    }

    #[test]
    fn stars_a_set_and_a_look_and_takes_the_star_off_again() {
        let install = Install::initialized();

        set_transmog_favourite(&install.database, marks::SET, 1834, true, MARKED_AT).unwrap();
        let payload =
            set_transmog_favourite(&install.database, marks::APPEARANCE, 91002, true, MARKED_AT)
                .unwrap();

        assert!(mark_of(&payload, marks::SET, 1834).unwrap().favourite);
        assert!(
            mark_of(&payload, marks::APPEARANCE, 91002)
                .unwrap()
                .favourite
        );

        let payload =
            set_transmog_favourite(&install.database, marks::SET, 1834, false, MARKED_AT).unwrap();

        // Gone entirely rather than left behind saying `false`: there is one way to say that
        // nobody starred a thing, and this is it.
        assert!(mark_of(&payload, marks::SET, 1834).is_none());
        assert!(
            mark_of(&payload, marks::APPEARANCE, 91002)
                .unwrap()
                .favourite
        );
    }

    /// Starring twice is what a double click is, and it must not be an error or a second row.
    #[test]
    fn starring_something_already_starred_changes_nothing() {
        let install = Install::initialized();

        set_transmog_favourite(&install.database, marks::SET, 1834, true, MARKED_AT).unwrap();
        let payload =
            set_transmog_favourite(&install.database, marks::SET, 1834, true, MARKED_AT + 60)
                .unwrap();

        assert_eq!(payload.marks.len(), 1);
        assert!(payload.marks[0].favourite);
    }

    #[test]
    fn a_tag_carries_a_value_or_is_a_label_on_its_own() {
        let install = Install::initialized();

        set_transmog_tag(
            &install.database,
            marks::SET,
            1834,
            "faction",
            Some("horde"),
            MARKED_AT,
        )
        .unwrap();
        let payload = set_transmog_tag(
            &install.database,
            marks::SET,
            1834,
            "wishlist",
            None,
            MARKED_AT,
        )
        .unwrap();

        let tags = &mark_of(&payload, marks::SET, 1834).unwrap().tags;
        assert_eq!(
            tags,
            &[
                marks::Tag {
                    key: "faction".into(),
                    value: Some("horde".into())
                },
                marks::Tag {
                    key: "wishlist".into(),
                    value: None
                },
            ]
        );
    }

    /// A value that is only whitespace is somebody clearing it, and a cleared value is a
    /// label — the same state as never having typed one. See `marks::clean_value`.
    #[test]
    fn clearing_a_value_leaves_the_tag_as_a_label() {
        let install = Install::initialized();

        set_transmog_tag(
            &install.database,
            marks::APPEARANCE,
            91002,
            "note",
            Some("the good one"),
            MARKED_AT,
        )
        .unwrap();
        let payload = set_transmog_tag(
            &install.database,
            marks::APPEARANCE,
            91002,
            "note",
            Some("   "),
            MARKED_AT + 60,
        )
        .unwrap();

        let tags = &mark_of(&payload, marks::APPEARANCE, 91002).unwrap().tags;
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].value, None);
    }

    /// Typing a key a subject already carries is a correction, not a second tag — and the
    /// spelling that lands is the one just typed, because that is the half being corrected.
    #[test]
    fn applying_a_key_again_replaces_its_value_whatever_its_case() {
        let install = Install::initialized();

        set_transmog_tag(
            &install.database,
            marks::SET,
            1834,
            "faction",
            Some("hoard"),
            MARKED_AT,
        )
        .unwrap();
        let payload = set_transmog_tag(
            &install.database,
            marks::SET,
            1834,
            "Faction",
            Some("horde"),
            MARKED_AT + 60,
        )
        .unwrap();

        let tags = &mark_of(&payload, marks::SET, 1834).unwrap().tags;
        assert_eq!(
            tags.len(),
            1,
            "one tag, corrected — not two spellings of one"
        );
        assert_eq!(tags[0].key, "Faction");
        assert_eq!(tags[0].value.as_deref(), Some("horde"));
    }

    #[test]
    fn takes_a_tag_off_and_says_nothing_about_one_that_was_never_there() {
        let install = Install::initialized();

        set_transmog_tag(
            &install.database,
            marks::SET,
            1834,
            "wishlist",
            None,
            MARKED_AT,
        )
        .unwrap();
        set_transmog_tag(
            &install.database,
            marks::SET,
            1834,
            "faction",
            Some("horde"),
            MARKED_AT,
        )
        .unwrap();

        // By a different spelling, because the key collates without case everywhere.
        let payload = delete_transmog_tag(&install.database, marks::SET, 1834, "WISHLIST").unwrap();
        let tags = &mark_of(&payload, marks::SET, 1834).unwrap().tags;
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].key, "faction");

        // A second click on a remove button asks for a state that already holds.
        let payload = delete_transmog_tag(&install.database, marks::SET, 1834, "wishlist").unwrap();
        assert_eq!(mark_of(&payload, marks::SET, 1834).unwrap().tags.len(), 1);
    }

    /// A set and an appearance can share a number — they are two of the game's own countings —
    /// and a star on set 91002 must not put one on the look of the same id.
    #[test]
    fn a_set_and_an_appearance_of_the_same_number_are_different_subjects() {
        let install = Install::initialized();

        set_transmog_favourite(&install.database, marks::SET, 91002, true, MARKED_AT).unwrap();
        let payload = set_transmog_tag(
            &install.database,
            marks::APPEARANCE,
            91002,
            "wishlist",
            None,
            MARKED_AT,
        )
        .unwrap();

        let set = mark_of(&payload, marks::SET, 91002).unwrap();
        let appearance = mark_of(&payload, marks::APPEARANCE, 91002).unwrap();
        assert!(set.favourite && set.tags.is_empty());
        assert!(!appearance.favourite && appearance.tags.len() == 1);
    }

    /// The one subject that is both starred and tagged is one mark, not two — the reader's
    /// index is keyed by the subject and a second entry would hide half of what they said.
    #[test]
    fn one_subject_starred_and_tagged_reads_as_a_single_mark() {
        let install = Install::initialized();

        set_transmog_favourite(&install.database, marks::APPEARANCE, 91002, true, MARKED_AT)
            .unwrap();
        let payload = set_transmog_tag(
            &install.database,
            marks::APPEARANCE,
            91002,
            "wishlist",
            None,
            MARKED_AT,
        )
        .unwrap();

        assert_eq!(payload.marks.len(), 1);
        assert!(payload.marks[0].favourite);
        assert_eq!(payload.marks[0].tags.len(), 1);
    }

    #[test]
    fn refuses_a_subject_the_browser_could_never_have_meant() {
        let install = Install::initialized();

        assert!(set_transmog_favourite(&install.database, "item", 1834, true, MARKED_AT).is_err());
        // Zero is what a hop the game encrypts reads as, and there is nothing there to mark.
        assert!(
            set_transmog_favourite(&install.database, marks::APPEARANCE, 0, true, MARKED_AT)
                .is_err()
        );
        assert!(
            set_transmog_tag(&install.database, marks::SET, 1834, "  ", None, MARKED_AT).is_err()
        );
        assert!(transmog_marks(&install.database).unwrap().marks.is_empty());
    }

    /// A history collected before anybody could say anything about a look has no tables to
    /// put a mark in. The migration adds them under the rows already there.
    #[test]
    fn migrates_a_database_written_before_the_wardrobe_could_be_marked() {
        let install = Install::empty();
        {
            fs::create_dir_all(install.database.parent().unwrap()).unwrap();
            let mut connection = Connection::open(&install.database).unwrap();
            let transaction = connection.transaction().unwrap();
            for migration in &MIGRATIONS[..15] {
                transaction.execute_batch(migration.sql).unwrap();
            }
            transaction
                .pragma_update(None, "user_version", 15_i64)
                .unwrap();
            transaction.commit().unwrap();
        }

        let payload =
            set_transmog_favourite(&install.database, marks::SET, 1834, true, MARKED_AT).unwrap();

        assert!(payload.marks[0].favourite);
    }
}
