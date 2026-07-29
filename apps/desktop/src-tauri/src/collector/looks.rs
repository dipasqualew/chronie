//! Who each character is, and what they are made of.
//!
//! The race, the sex and the customisation choices the client reported for each character,
//! replaced wholesale per character for the same reason a holding is. It is what lets the
//! transmog view draw one of the reader's own characters rather than a body assembled from
//! selects.

use super::database::open_database;
use super::roster::upsert_character_key;
use crate::customization;
use crate::look;
use rusqlite::{params, Transaction};
use std::path::Path;

/// Who each character was last seen to be, replacing whatever they last said.
///
/// Wholesale per character, for the reason the sets above are: this is one statement about one
/// person, and half an old look beside half a new one is nobody. A character who has since
/// answered fewer questions — which is what a race change comes to, since the new race's
/// questions are not the old one's — has to lose the answers that are no longer theirs, and
/// deleting the row first is what does it.
///
/// Only the characters the file mentions are touched. A look is written per character and only
/// the one being played can be read, so a sync says nothing at all about the rest of the roster.
pub(super) fn sync_character_looks(
    transaction: &Transaction<'_>,
    account_id: i64,
    looks: &[look::Look],
    now: i64,
) -> Result<(), String> {
    for look in looks {
        let character_id =
            upsert_character_key(transaction, account_id, &look.character, None, None, now)?;
        // The choices go with the look by way of the cascade the migration declares.
        transaction
            .execute(
                "DELETE FROM character_looks WHERE character_id = ?1",
                [character_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO character_looks (character_id, race, sex, observed_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![character_id, look.race, look.sex, look.observed_at],
            )
            .map_err(|error| error.to_string())?;
        for answer in &look.picked {
            transaction
                .execute(
                    "INSERT INTO character_look_choices (character_id, option_id, choice_id)
                     VALUES (?1, ?2, ?3)",
                    params![character_id, answer.question, answer.swatch],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Who every character the addon has looked at is, for the transmog view to offer as a shortcut.
///
/// All of them at once, and unresolved: nothing here opens the installed game, so this answers on
/// a machine that has not got one — and what a race comes to is [`look::resolve`]'s question,
/// asked by whichever command already has the game's files open.
///
/// A roster is tens of characters with at most a few dozen answers each, which is why the choices
/// come back in a second query rather than a join: a character with no answers is the ordinary
/// case here, and a join would have to invent a row to say so.
pub fn character_looks(database_path: &Path) -> Result<Vec<look::Look>, String> {
    let connection = open_database(database_path)?;
    let mut statement = connection
        .prepare(
            // `source_key` rather than `name`, for the reason the sets below select it: `name`
            // is the half before the hyphen, and two Asters on two realms are two people.
            "SELECT c.source_key, l.race, l.sex, l.observed_at
             FROM character_looks l
             JOIN characters c ON c.id = l.character_id
             ORDER BY c.source_key",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(look::Look {
                character: row.get(0)?,
                race: row.get(1)?,
                sex: row.get(2)?,
                observed_at: row.get(3)?,
                picked: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?;
    let mut looks: Vec<look::Look> = Vec::new();
    for row in rows {
        looks.push(row.map_err(|error| error.to_string())?);
    }

    let mut chosen = connection
        .prepare(
            "SELECT c.source_key, h.option_id, h.choice_id
             FROM character_look_choices h
             JOIN characters c ON c.id = h.character_id
             ORDER BY c.source_key, h.option_id",
        )
        .map_err(|error| error.to_string())?;
    let answers = chosen
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                customization::Picked {
                    question: row.get(1)?,
                    swatch: row.get(2)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in answers {
        let (character, answer) = row.map_err(|error| error.to_string())?;
        if let Some(found) = looks.iter_mut().find(|look| look.character == character) {
            found.picked.push(answer);
        }
    }
    Ok(looks)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::collector::testing::*;

    fn look_of<'a>(looks: &'a [look::Look], character: &str) -> &'a look::Look {
        looks
            .iter()
            .find(|look| look.character == character)
            .unwrap_or_else(|| panic!("no look for {character}"))
    }

    /// Two characters of one account: Aster has been to a barber and Brin has not, which is the
    /// difference the whole table is shaped around.
    const TWO_LOOKS: &str = r#"
        ["Aster-Vale"] = {
            ["at"] = 2000000000,
            ["race"] = 1,
            ["sex"] = 3,
            ["choices"] = {
                { ["option"] = 14, ["choice"] = 133 },
                { ["option"] = 16, ["choice"] = 21 },
            },
        },
        ["Brin-Ravencrest"] = {
            ["at"] = 1999000000,
            ["race"] = 4,
            ["sex"] = 2,
        },
    "#;

    #[test]
    fn a_roster_the_addon_has_never_looked_at_holds_nobody() {
        let install = Install::of(&SavedVariables::new().character_look(""));

        install.collect(2_000_000_100);

        assert!(character_looks(&install.database).unwrap().is_empty());
    }

    /// The whole of the round trip: the addon's table becomes rows, and the rows come back with
    /// each character's answers on the character they belong to.
    #[test]
    fn files_who_each_character_is_and_what_they_are_made_of() {
        let install = Install::of(&SavedVariables::new().character_look(TWO_LOOKS));

        install.collect(2_000_000_100);

        let looks = character_looks(&install.database).unwrap();
        let aster = look_of(&looks, "Aster-Vale");
        assert_eq!((aster.race, aster.sex), (1, 3));
        assert_eq!(aster.observed_at, Some(2_000_000_000));
        assert_eq!(
            aster.picked,
            vec![
                customization::Picked {
                    question: 14,
                    swatch: 133
                },
                customization::Picked {
                    question: 16,
                    swatch: 21
                },
            ]
        );

        // And the ordinary case: somebody the addon has only ever seen walking around, who is a
        // race and a sex and is drawn on the swatches the game itself opens on.
        let brin = look_of(&looks, "Brin-Ravencrest");
        assert_eq!((brin.race, brin.sex), (4, 2));
        assert!(brin.picked.is_empty());
    }

    /// A look is one statement about one person, so a sync replaces rather than merges. A race
    /// change is the case that proves it: the new race's questions are not the old one's, and an
    /// answer left behind would be somebody else's hairstyle on this character's head.
    #[test]
    fn a_later_sync_replaces_a_characters_look_wholesale() {
        let install = Install::of(&SavedVariables::new().character_look(TWO_LOOKS));
        install.collect(2_000_000_100);

        install.rewrite(&SavedVariables::new().character_look(
            r#"
            ["Aster-Vale"] = {
                ["at"] = 2000000500,
                ["race"] = 2,
                ["sex"] = 3,
                ["choices"] = { { ["option"] = 91, ["choice"] = 400 } },
            },
            "#,
        ));
        install.collect(2_000_000_600);

        let looks = character_looks(&install.database).unwrap();
        let aster = look_of(&looks, "Aster-Vale");
        assert_eq!(aster.race, 2);
        assert_eq!(aster.observed_at, Some(2_000_000_500));
        assert_eq!(
            aster.picked,
            vec![customization::Picked {
                question: 91,
                swatch: 400
            }]
        );

        // The old race's answers went with it by the cascade the migration declares, rather than
        // being left to be read as this character's.
        assert_eq!(count_of(&install.database, "character_look_choices"), 1);
        // And Brin, whose file said nothing this time, is exactly as they were: the addon can
        // only ever read the character in front of it.
        assert_eq!(look_of(&looks, "Brin-Ravencrest").race, 4);
    }
}
