//! What a person says about the game's wardrobe: a star, and tags of their own invention.
//!
//! The transmog view reads the installed game, so everything on it is true of every install
//! with that build. A mark is the one thing on that screen that is the reader's — "I want this
//! one", "this is the horde half of the pair", "this is what the alt wears" — and it is stored
//! in Chronie's own database because the game has nowhere to put it and no reason to.
//!
//! This module is the rules and nothing else: what a subject may be, what a key and a value
//! are allowed to look like, and what a stored mark is as a shape. The SQL is `collector.rs`,
//! beside every other statement in the app, and the window over it is `marks.ts`.
//!
//! **A label and a property are one thing here.** A key with a value is a property and a key
//! without one is a label, which is exactly the difference between `Some` and `None` — so
//! there is one editor, one table and one filter rather than two of each. What that costs is
//! one rule, [`clean_value`]: a value that cleans away to nothing becomes a label rather than
//! an empty string, because a tag whose value is `""` would filter like a property and read
//! like a label and be neither.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A set the game ships, numbered by `TransmogSet.id`.
pub const SET: &str = "set";
/// A look, numbered by `ItemAppearance.id` — the game's own unit of collection.
pub const APPEARANCE: &str = "appearance";
/// A set the reader saved off the character themselves, numbered by this database.
///
/// The one subject of the three that Chronie issues the id for, and the reason marking one had
/// to be the same feature rather than a second one beside it: a set of somebody's own is a set,
/// and "star it, tag it, filter the browser by what you said" is what they already know how to
/// do to the ones Blizzard shipped. See `customsets::KIND`, which is this string from the other
/// end, and `0017_custom_sets.sql`, which widened the two tables to hold it.
pub const CUSTOM: &str = "custom";

/// How long a key may be. Long enough for "expansion" or "who wears it", short enough that a
/// chip stays a chip; a reader wanting a sentence about a look wants the value, not the key.
pub const KEY_LIMIT: usize = 48;

/// And how long a value may be. Four times the key, because "the one from the Timewalking
/// vendor in Tanaris" is a thing somebody will reasonably want to write.
pub const VALUE_LIMIT: usize = 160;

/// One thing somebody said about a look or a set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Tag {
    pub key: String,
    /// The value, or `None` where the key is the whole of what was said — which is a label.
    pub value: Option<String>,
}

/// Everything somebody has said about one subject, as the window reads it.
///
/// A mark exists only where there is something to say: a subject nobody has starred and nobody
/// has tagged has no row anywhere and no entry in a payload, which is what keeps this list the
/// length of what a person did rather than the length of the game's wardrobe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    /// [`SET`], [`APPEARANCE`] or [`CUSTOM`].
    pub kind: String,
    /// The id of the thing: the game's for the first two, and this database's own for a set the
    /// reader saved. Which is why nothing here has a foreign key — two of the three subjects
    /// live in the game's files rather than in any table.
    pub id: i64,
    pub favourite: bool,
    pub tags: Vec<Tag>,
}

/// Every mark in the database, which is the whole of what the window is given.
///
/// All of them at once, and deliberately: this is what one person has said with their own
/// hands, so it is hundreds of rows rather than the fifty-five thousand looks they were said
/// about. Asking per set or per page would be four hundred round trips to save a payload that
/// is smaller than one set's icons.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MarksPayload {
    pub marks: Vec<Mark>,
}

/// Which of the three kinds of subject this is, refusing anything that is none of them.
///
/// The check is here as well as in the table's own `CHECK` because the window sends this
/// across the bridge as a string, and "the database rejected it" is not a sentence anybody
/// should have to read to find out they meant `appearance`.
pub fn subject_kind(raw: &str) -> Result<&'static str, String> {
    match raw {
        SET => Ok(SET),
        APPEARANCE => Ok(APPEARANCE),
        CUSTOM => Ok(CUSTOM),
        other => Err(format!(
            "A mark belongs to a set, an appearance or a set of your own, not to a '{other}'."
        )),
    }
}

/// A subject id anything could have issued, which is any positive number.
///
/// Zero is what every hop of the transmog chain reads as when the game encrypts it — an
/// appearance belonging to content Blizzard has not shipped arrives as an id of nothing at
/// all — and a star against "whatever the game would not tell us about" is a star nobody can
/// ever find again.
pub fn subject_id(id: i64) -> Result<i64, String> {
    if id > 0 {
        Ok(id)
    } else {
        Err("The game says nothing about that one, so there is nothing to mark.".into())
    }
}

/// The key as it will be stored: what was typed, with the whitespace made ordinary.
///
/// Trimmed and with runs of space collapsed, because a key is compared against other keys and
/// "off  hand" and "off hand" being two tags is a distinction nobody typed on purpose. Control
/// characters go for the reason they go everywhere else in this app — a stored string that can
/// move a cursor is a string that draws wrong in every reader downstream.
///
/// The case is *kept*, and the uniqueness is case-insensitive: that is `COLLATE NOCASE` in the
/// migration. Somebody who types "Faction" gets "Faction" back, and typing "faction" later
/// edits the tag they already have rather than making a second one.
pub fn clean_key(raw: &str) -> Result<String, String> {
    let key = collapse(raw);
    if key.is_empty() {
        return Err("A tag needs a name.".into());
    }
    if key.chars().count() > KEY_LIMIT {
        return Err(format!(
            "A tag's name has to fit in {KEY_LIMIT} characters."
        ));
    }
    Ok(key)
}

/// The value as it will be stored, or `None` where what was typed says nothing.
///
/// Cleaned the same way the key is, and then the one rule that makes a label: a value that is
/// empty, or that was only ever spaces, is stored as no value rather than as `''`. That is
/// what makes "label" and "property" the same feature — see the module's own note — and it is
/// also what clearing a value means, which is the same act as never having typed one.
pub fn clean_value(raw: Option<&str>) -> Result<Option<String>, String> {
    let value = collapse(raw.unwrap_or_default());
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > VALUE_LIMIT {
        return Err(format!("A tag's value has to fit in {VALUE_LIMIT} characters."));
    }
    Ok(Some(value))
}

/// Whitespace and control characters made ordinary: one space between words, none at the ends.
fn collapse(raw: &str) -> String {
    raw.split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|character| !character.is_control())
                .collect::<String>()
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_three_kinds_of_subject_and_nothing_else() {
        assert_eq!(subject_kind("set"), Ok(SET));
        assert_eq!(subject_kind("appearance"), Ok(APPEARANCE));
        assert_eq!(subject_kind("custom"), Ok(CUSTOM));
        assert!(subject_kind("item").is_err());
        assert!(subject_kind("").is_err());
        // Case is not a spelling of the same word here: this crosses the bridge as one of two
        // literals the window writes, not as something anybody types.
        assert!(subject_kind("Set").is_err());
    }

    #[test]
    fn refuses_an_id_the_game_never_issued() {
        assert_eq!(subject_id(1), Ok(1));
        assert_eq!(subject_id(712245), Ok(712245));
        // Which is what an appearance the game encrypts arrives as.
        assert!(subject_id(0).is_err());
        assert!(subject_id(-3).is_err());
    }

    #[test]
    fn tidies_a_key_without_changing_what_was_typed() {
        assert_eq!(clean_key("  faction  "), Ok("faction".into()));
        assert_eq!(clean_key("off   hand"), Ok("off hand".into()));
        // The case survives; the migration is what makes two spellings of it one tag.
        assert_eq!(clean_key("Faction"), Ok("Faction".into()));
        assert_eq!(clean_key("who\twears\nit"), Ok("who wears it".into()));
        assert_eq!(clean_key("nor\u{7}mal"), Ok("normal".into()));
    }

    #[test]
    fn refuses_a_key_that_is_nothing_or_endless() {
        assert!(clean_key("").is_err());
        assert!(clean_key("   ").is_err());
        assert!(clean_key("\u{7}").is_err());
        assert!(clean_key(&"a".repeat(KEY_LIMIT)).is_ok());
        assert!(clean_key(&"a".repeat(KEY_LIMIT + 1)).is_err());
    }

    #[test]
    fn a_value_that_says_nothing_is_a_label() {
        assert_eq!(clean_value(None), Ok(None));
        assert_eq!(clean_value(Some("")), Ok(None));
        assert_eq!(clean_value(Some("   ")), Ok(None));
        assert_eq!(clean_value(Some("  horde ")), Ok(Some("horde".into())));
        assert_eq!(
            clean_value(Some("the one  from Tanaris")),
            Ok(Some("the one from Tanaris".into()))
        );
    }

    #[test]
    fn refuses_a_value_longer_than_a_chip_can_hold() {
        assert!(clean_value(Some(&"a".repeat(VALUE_LIMIT))).is_ok());
        assert!(clean_value(Some(&"a".repeat(VALUE_LIMIT + 1))).is_err());
    }

    /// A character outside the basic plane is one character, not four — the limits are about
    /// what a reader typed rather than about how many bytes it took to say it.
    #[test]
    fn counts_characters_rather_than_bytes() {
        assert!(clean_key(&"é".repeat(KEY_LIMIT)).is_ok());
        assert!(clean_value(Some(&"🐉".repeat(VALUE_LIMIT))).is_ok());
    }
}
