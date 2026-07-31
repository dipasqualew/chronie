//! What somebody decided about a suggestion, kept where no regeneration can reach it.
//!
//! The two measures behind "show possible alternatives" are recomputed from the game every time
//! it patches — see `20260731T1030_transmog_lookalikes.sql`, which is where the reason is written
//! down. What a person said about one of their answers is not a measurement and does not go in
//! either file, so it goes here, keyed on the two appearance ids and nothing else.
//!
//! All of them, rather than the ones a panel is about to draw. These are the rows one person
//! wrote by hand — a handful — and the transmog view already reads its marks whole for the same
//! reason: asking per look would be a trip across the bridge per click to save nothing.

use super::database::open_database;
use crate::alternatives;
use rusqlite::{params, Connection};
use std::path::Path;

use crate::failure::Failure;

/// Every verdict anybody has passed on a suggestion.
///
/// Ordered by the look and then by what was offered for it, so that two reads of an unchanged
/// database are the same bytes and a list does not reshuffle itself under somebody ruling on
/// something unrelated.
pub fn transmog_lookalikes(database_path: &Path) -> Result<Vec<alternatives::Said>, Failure> {
    read_verdicts(&open_database(database_path)?)
}

/// Writes down that somebody agreed with a suggestion, or that they did not.
///
/// Ruling the other way on something already ruled on replaces the row rather than adding a
/// second, which is what changing one's mind means. Passing no verdict at all deletes it — the
/// third state is "nobody has looked at this", and somebody undoing a click means to be back in
/// it rather than to be recorded as undecided.
pub fn set_transmog_lookalike(
    database_path: &Path,
    appearance_id: i64,
    alternative_id: i64,
    verdict: Option<&str>,
    now: i64,
) -> Result<Vec<alternatives::Said>, Failure> {
    let (appearance_id, alternative_id) = (look(appearance_id)?, look(alternative_id)?);
    if appearance_id == alternative_id {
        return Err(Failure::from(
            "A look cannot be an alternative to itself.".to_string(),
        ));
    }
    let connection = open_database(database_path)?;
    match verdict {
        Some(word) => {
            let word = alternatives::verdict(word).map_err(Failure::from)?;
            connection.execute(
                "INSERT INTO transmog_lookalikes
                     (appearance_id, alternative_id, verdict, created_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(appearance_id, alternative_id)
                     DO UPDATE SET verdict = excluded.verdict, created_at = excluded.created_at",
                params![appearance_id, alternative_id, word, now],
            )?;
        }
        None => {
            connection.execute(
                "DELETE FROM transmog_lookalikes
                     WHERE appearance_id = ?1 AND alternative_id = ?2",
                params![appearance_id, alternative_id],
            )?;
        }
    }
    read_verdicts(&connection)
}

/// One `ItemAppearance.id`, or a complaint about what was passed instead.
fn look(id: i64) -> Result<i64, Failure> {
    if id <= 0 {
        return Err(Failure::from(format!(
            "A look is numbered by the game and {id} is not one of its numbers."
        )));
    }
    Ok(id)
}

fn read_verdicts(connection: &Connection) -> Result<Vec<alternatives::Said>, Failure> {
    let mut statement = connection.prepare(
        "SELECT appearance_id, alternative_id, verdict FROM transmog_lookalikes
             ORDER BY appearance_id, alternative_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(alternatives::Said {
            appearance_id: row.get::<_, i64>(0)? as u32,
            alternative_id: row.get::<_, i64>(1)? as u32,
            verdict: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::testing::*;

    const SAID_AT: i64 = 1_770_000_000;

    /// Ulduar's Priest tier head, and the world drop that looks exactly like it — the case this
    /// whole feature was argued from, and a pair whose answer a person can only settle by eye.
    const TIER_HEAD: i64 = 11678;
    const WORLD_DROP: i64 = 11366;

    #[test]
    fn holds_nothing_until_somebody_rules_on_something() {
        let install = Install::initialized();
        assert_eq!(transmog_lookalikes(&install.database).unwrap(), Vec::new());
    }

    // What the table is for: a measurement offered a look and a person agreed, and that survives
    // every regeneration of the store the suggestion came out of.
    #[test]
    fn keeps_what_somebody_said_about_a_suggestion() {
        let install = Install::initialized();
        let said = set_transmog_lookalike(
            &install.database,
            TIER_HEAD,
            WORLD_DROP,
            Some(alternatives::CONFIRMED),
            SAID_AT,
        )
        .unwrap();
        assert_eq!(
            said,
            vec![alternatives::Said {
                appearance_id: TIER_HEAD as u32,
                alternative_id: WORLD_DROP as u32,
                verdict: alternatives::CONFIRMED.to_string(),
            }]
        );
    }

    // And the other half, which is the one a store of confirmations alone would lose: a person
    // who has looked at a suggestion and rejected it has said something, and without it the same
    // wrong row climbs back to the top of the list every time the panel is opened.
    #[test]
    fn keeps_a_rejection_as_something_said_rather_than_as_nothing() {
        let install = Install::initialized();
        set_transmog_lookalike(
            &install.database,
            TIER_HEAD,
            WORLD_DROP,
            Some(alternatives::REJECTED),
            SAID_AT,
        )
        .unwrap();
        let said = transmog_lookalikes(&install.database).unwrap();
        assert_eq!(said.len(), 1);
        assert_eq!(said[0].verdict, alternatives::REJECTED);
    }

    // Ruling the other way replaces the row, which is what changing one's mind means.
    #[test]
    fn lets_somebody_change_their_mind() {
        let install = Install::initialized();
        let yes = Some(alternatives::CONFIRMED);
        set_transmog_lookalike(&install.database, TIER_HEAD, WORLD_DROP, yes, SAID_AT).unwrap();
        let no = Some(alternatives::REJECTED);
        let said =
            set_transmog_lookalike(&install.database, TIER_HEAD, WORLD_DROP, no, SAID_AT + 1)
                .unwrap();
        assert_eq!(said.len(), 1);
        assert_eq!(said[0].verdict, alternatives::REJECTED);
    }

    // And undoing a click puts it back to the state it was in before there was a row, which is
    // "nobody has looked at this" rather than "somebody looked and was undecided".
    #[test]
    fn takes_a_verdict_off_again() {
        let install = Install::initialized();
        let yes = Some(alternatives::CONFIRMED);
        set_transmog_lookalike(&install.database, TIER_HEAD, WORLD_DROP, yes, SAID_AT).unwrap();
        let said =
            set_transmog_lookalike(&install.database, TIER_HEAD, WORLD_DROP, None, SAID_AT + 1)
                .unwrap();
        assert_eq!(said, Vec::new());
        // A pair nobody ever ruled on is not an error to un-rule on: the state asked for is the
        // state that results, which is what a second click on a button means.
        assert!(set_transmog_lookalike(&install.database, 1, 2, None, SAID_AT).is_ok());
    }

    // The order two reads come back in, because the window draws a list off this and a list that
    // reshuffles itself under an unrelated click is one nobody can use.
    #[test]
    fn reads_the_verdicts_in_a_stated_order() {
        let install = Install::initialized();
        let yes = Some(alternatives::CONFIRMED);
        for (look, alternative) in [(9, 4), (2, 8), (9, 1), (2, 3)] {
            set_transmog_lookalike(&install.database, look, alternative, yes, SAID_AT).unwrap();
        }
        let pairs: Vec<(u32, u32)> = transmog_lookalikes(&install.database)
            .unwrap()
            .iter()
            .map(|said| (said.appearance_id, said.alternative_id))
            .collect();
        assert_eq!(pairs, vec![(2, 3), (2, 8), (9, 1), (9, 4)]);
    }

    #[test]
    fn refuses_a_verdict_that_is_neither_of_the_two() {
        let install = Install::initialized();
        let error = set_transmog_lookalike(
            &install.database,
            TIER_HEAD,
            WORLD_DROP,
            Some("maybe"),
            SAID_AT,
        )
        .unwrap_err();
        assert!(format!("{error}").contains("maybe"), "{error}");
    }

    // A look is not an alternative to itself, and a number the game never issued is not a look.
    #[test]
    fn refuses_a_pair_that_is_not_two_looks() {
        let install = Install::initialized();
        let yes = Some(alternatives::CONFIRMED);
        assert!(set_transmog_lookalike(&install.database, 11, 11, yes, SAID_AT).is_err());
        assert!(set_transmog_lookalike(&install.database, 0, 11, yes, SAID_AT).is_err());
        assert!(set_transmog_lookalike(&install.database, 11, -3, yes, SAID_AT).is_err());
    }
}
