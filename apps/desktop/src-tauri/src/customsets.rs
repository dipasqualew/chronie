//! The sets somebody puts together themselves, out of whatever the character is wearing.
//!
//! Everything else the transmog view browses is Blizzard's idea of an outfit, read out of the
//! installed game. A custom set is the reader's: the helm from one set, the robe from another
//! and the staff from the game at large, saved under a name they chose and browsed beside the
//! game's own sets ever after. `0017_custom_sets.sql` is where it is stored, `collector.rs` is
//! the SQL, and the window over it is `customSets.ts`.
//!
//! This module is the rules and the shapes and nothing else: what a name may look like, what a
//! set has to hold before it is worth saving, and what a saved piece is.
//!
//! **A piece is stored as what the reader was looking at rather than as a key to look up.** The
//! reason is in the migration; what it means here is that this module never opens the game's
//! files and a saved set can be read on a machine that has not got the game installed at all.

use serde::{Deserialize, Serialize};

/// A set of the reader's own, as `marks::subject_kind` spells it.
///
/// The third kind of thing a star or a tag can be against, beside a Blizzard set and a look.
pub const KIND: &str = "custom";

/// How long a name may be. A shade longer than the longest set name the game ships — *Vestments
/// of the Virtuous Prophet* is 33 characters — because somebody naming their own is as likely
/// to write "what the alt wears to Karazhan" as to write a title.
pub const NAME_LIMIT: usize = 64;

/// How many pieces one set may hold.
///
/// The character has thirteen places on her and `outfit.ts` allows one thing in each, so
/// thirteen is the real answer and this is the floor under a payload that says otherwise. It is
/// deliberately not thirteen: the places are the window's vocabulary rather than this module's,
/// and a backend that refused a fourteenth would be the wrong end of the app to learn from that
/// a place had been added.
pub const PIECE_LIMIT: usize = 32;

/// How long a place may be — see [`Piece::place`], which is a word the window chose.
const PLACE_LIMIT: usize = 24;

/// One piece of a saved outfit: where it goes, and everything needed to draw it again.
///
/// The same numbers the row it was picked from carried. `display_info_id` is the one the
/// character is actually drawn from, `appearance_id` is the game's own unit of collection and
/// so is what a mark against this piece is keyed by, and the rest is what a list draws.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    /// Where on the body it sits, in the window's own words: `armour-3`, `hand-right`.
    ///
    /// Opaque here on purpose. Which hand holds a one-hander is a question the game's display
    /// types cannot answer and `outfit.ts` settles for the whole view; this stores the answer.
    pub place: String,
    pub appearance_id: i64,
    pub item_id: i64,
    /// What the row was called, which is the name of the item the look was named after.
    pub name: String,
    pub display_type: i64,
    pub inventory_type: i64,
    pub display_info_id: i64,
    pub icon_file_data_id: i64,
    pub has_model: bool,
}

/// One saved set, with everything it is made of.
///
/// Whole rather than summarised, and unlike a Blizzard set — which is a card that costs four
/// table walks to open. A saved set is a dozen rows already written down, so there is nothing
/// to defer and no second command to ask for it with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSet {
    pub id: i64,
    pub name: String,
    /// When it was first saved, and when it was last saved over. Seconds, as everything else
    /// in this database is.
    pub created_at: i64,
    pub updated_at: i64,
    pub pieces: Vec<Piece>,
}

/// Every set the reader has saved, which is the whole of what the window is given.
///
/// All of them at once, for the reason the marks are: this is what one person made with their
/// own hands, so it is tens of rows rather than the game's several thousand sets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomSetsPayload {
    pub sets: Vec<CustomSet>,
}

/// The name as it will be stored: what was typed, with the whitespace made ordinary.
///
/// The same cleaning a tag's key gets, and for the same reasons — see `marks::clean_key`. The
/// case is kept and the uniqueness is case-insensitive, which is what makes saving over "Horde
/// look" with "horde look" a correction of the set that is there rather than a second one
/// beside it.
pub fn clean_name(raw: &str) -> Result<String, String> {
    let name = collapse(raw);
    if name.is_empty() {
        return Err("Give the set a name and it will be saved under it.".into());
    }
    if name.chars().count() > NAME_LIMIT {
        return Err(format!("A set's name has to fit in {NAME_LIMIT} characters."));
    }
    Ok(name)
}

/// The pieces as they will be stored, refusing what could not be drawn again.
///
/// Three things are refused and each is a set that would come back wrong rather than a set
/// somebody meant to save. **Nothing on her at all**, because a set of no clothes is a name and
/// a date; the character standing bare is the state a reader reaches by taking things off, not
/// something to save under a name. **Two pieces in one place**, because the primary key allows
/// one and a silent overwrite would drop whichever the window sent first. And **a piece with no
/// display**, because that is the number the character is drawn from and a row carrying zero is
/// an appearance the game withheld — which `outfit.ts` never puts on her in the first place.
pub fn clean_pieces(pieces: Vec<Piece>) -> Result<Vec<Piece>, String> {
    if pieces.is_empty() {
        return Err("Put something on her first, and then it can be saved as a set.".into());
    }
    if pieces.len() > PIECE_LIMIT {
        return Err(format!("A set holds at most {PIECE_LIMIT} pieces."));
    }
    let mut cleaned: Vec<Piece> = Vec::with_capacity(pieces.len());
    for mut piece in pieces {
        piece.place = collapse(&piece.place);
        if piece.place.is_empty() || piece.place.chars().count() > PLACE_LIMIT {
            return Err("That piece says nothing about where on her it goes.".into());
        }
        if cleaned.iter().any(|held| held.place == piece.place) {
            return Err("Two of those pieces claim the same place on her.".into());
        }
        if piece.display_info_id <= 0 {
            return Err("The game says nothing it could draw for one of those pieces.".into());
        }
        piece.name = collapse(&piece.name);
        cleaned.push(piece);
    }
    Ok(cleaned)
}

/// A set id this database could have issued, which is any positive number.
pub fn set_id(id: i64) -> Result<i64, String> {
    if id > 0 {
        Ok(id)
    } else {
        Err("There is no set of yours with that number.".into())
    }
}

/// Whitespace and control characters made ordinary: one space between words, none at the ends.
///
/// The same rule `marks::collapse` applies, written again rather than shared, because the two
/// modules answer to different halves of the window and a change to what a tag key may hold is
/// not a change to what a set may be called.
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

    fn piece(place: &str) -> Piece {
        Piece {
            place: place.into(),
            appearance_id: 91002,
            item_id: 712245,
            name: "Tideglass Mantle".into(),
            display_type: 1,
            inventory_type: 3,
            display_info_id: 900001,
            icon_file_data_id: 130001,
            has_model: true,
        }
    }

    #[test]
    fn tidies_a_name_without_changing_what_was_typed() {
        assert_eq!(clean_name("  Horde look "), Ok("Horde look".into()));
        assert_eq!(clean_name("what   the alt\twears"), Ok("what the alt wears".into()));
        // The case survives; the migration is what makes two spellings of it one set.
        assert_eq!(clean_name("HORDE LOOK"), Ok("HORDE LOOK".into()));
        assert_eq!(clean_name("nor\u{7}mal"), Ok("normal".into()));
    }

    #[test]
    fn refuses_a_name_that_is_nothing_or_endless() {
        assert!(clean_name("").is_err());
        assert!(clean_name("   ").is_err());
        assert!(clean_name(&"a".repeat(NAME_LIMIT)).is_ok());
        assert!(clean_name(&"a".repeat(NAME_LIMIT + 1)).is_err());
        // A character outside the basic plane is one character, not four.
        assert!(clean_name(&"🐉".repeat(NAME_LIMIT)).is_ok());
    }

    #[test]
    fn keeps_the_pieces_in_the_order_they_were_sent() {
        let cleaned = clean_pieces(vec![piece("armour-0"), piece("hand-right")]).unwrap();
        let places: Vec<&str> = cleaned.iter().map(|one| one.place.as_str()).collect();
        assert_eq!(places, vec!["armour-0", "hand-right"]);
    }

    #[test]
    fn refuses_a_set_of_no_clothes() {
        assert!(clean_pieces(Vec::new()).is_err());
    }

    #[test]
    fn refuses_two_pieces_claiming_one_place() {
        let twice = clean_pieces(vec![piece("armour-0"), piece("armour-0")]);
        assert!(twice.is_err());
    }

    #[test]
    fn refuses_a_piece_the_character_could_not_be_drawn_in() {
        let mut withheld = piece("armour-0");
        withheld.display_info_id = 0;
        assert!(clean_pieces(vec![withheld]).is_err());
    }

    #[test]
    fn refuses_a_piece_that_says_nowhere() {
        assert!(clean_pieces(vec![piece("  ")]).is_err());
        assert!(clean_pieces(vec![piece(&"a".repeat(PLACE_LIMIT + 1))]).is_err());
    }

    #[test]
    fn refuses_more_pieces_than_a_character_has_places() {
        let many: Vec<Piece> = (0..=PIECE_LIMIT).map(|at| piece(&format!("armour-{at}"))).collect();
        assert!(clean_pieces(many).is_err());
    }
}
