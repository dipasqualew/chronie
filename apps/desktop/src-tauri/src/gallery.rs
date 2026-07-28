//! A page of the wardrobe, every appearance on it shown worn.
//!
//! The game's own wardrobe does not draw an item; it draws a character wearing the item, and that
//! is not a presentational choice. **Most of the game's armour has no geometry at all.** A
//! chestpiece is a set of textures painted into a body's atlas and a handful of geoset switches,
//! as `docs/character-rendering.md` sets out — there is no chestpiece mesh to put on a turntable,
//! and the only thing that can be shown is a body with the chestpiece on it. A helm and a sword do
//! have meshes, and [`crate::models`] still writes one out on its own for `dump_model`, but a
//! wardrobe that showed geometry where there was some and an icon where there was not would be
//! showing a body for a tenth of its rows.
//!
//! So: one body, and every row of the page wearing one thing.
//!
//! # What makes twenty of them affordable
//!
//! Naively a page is twenty renders, and a render used to mean reading the body's `.m2` and its
//! skin profile, resizing her skin onto a 2048 × 1024 buffer, compositing her face onto that,
//! decoding her hair and eyes, reading a 16MB skeleton, and walking six of the game's tables end
//! to end. On a real install that is roughly 400ms each and none of it depends on the item.
//!
//! Two things are hoisted out of the loop, and between them they are nearly all of it:
//!
//! - **[`crate::character::Mannequin`]** is the body with all of the above already done. Twenty
//!   renders share one, and what is left per appearance is the geosets it switches, what it paints
//!   into a *clone* of the base atlas, the geometry it hangs, and writing the `.glb`.
//! - **[`crate::worn::each`]** answers for every appearance on the page out of one walk of each
//!   table, rather than one walk per appearance. `ItemDisplayInfoMaterialRes` is 604,000 rows on a
//!   shipping install and [`crate::db2::Db2::rows`] materialises all of them before it yields the
//!   first, so this is the difference between walking it once and walking it twenty times.
//!
//! What is deliberately *not* here is a cache. The page is what the window asked for, and holding
//! the bodies it produced would be tens of megabytes per page of a wardrobe several thousand rows
//! long. [`crate::casc::Remembered`] already keeps the files underneath all of this, which is the
//! part that repeats.
//!
//! `budget.rs` is where the claims above are held to: it renders a page from the fixtures and
//! asserts what it read, what it walked, and how the cost of twenty compares to the cost of one.

use serde_json::Value;

use crate::casc::GameFiles;
use crate::character::Mannequin;
use crate::customization::Picked;
use crate::icons::data_url;
use crate::worn::{self, Piece};

/// Every appearance of a page, each worn on the same body, in the order they were asked for.
///
/// `null` for a row is the ordinary answer and means what it means everywhere else in this app:
/// the game encrypts the displays of content it has not shipped, and an appearance whose only
/// texture was painted for another body resolves to nothing. The window keeps that row's icon.
///
/// The order is the caller's, and every row asked for gets an answer, including the ones that
/// resolve to nothing — a page one row short is a row the window would have to hunt for.
#[tracing::instrument(name = "gallery.of", skip_all, fields(pieces = pieces.len()))]
pub fn of(files: &dyn GameFiles, pieces: &[Piece], picked: &[Picked]) -> Result<Value, String> {
    if pieces.is_empty() {
        return Ok(serde_json::json!({ "models": [] }));
    }

    // One outfit per piece: nothing on this page is ever worn beside anything else on it, so
    // there is nothing for the priority table or the draw order to settle. What the pieces share
    // is the tables, and that is the whole reason this is one call rather than a loop.
    let alone: Vec<&[Piece]> = pieces.iter().map(std::slice::from_ref).collect();
    let worn = worn::each(files, &alone)?;

    let mannequin = Mannequin::standing(files, picked)?;
    let models: Vec<Value> = pieces
        .iter()
        .zip(worn.iter())
        .map(|(piece, worn)| {
            let model = if worn.is_empty() {
                Value::Null
            } else {
                Value::String(data_url("model/gltf-binary", &mannequin.wearing(Some(worn))?))
            };
            Ok(serde_json::json!({
                "displayInfoId": piece.display_info_id,
                "model": model,
            }))
        })
        .collect::<Result<_, String>>()?;

    Ok(serde_json::json!({ "models": models }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// A helm, a pair of shoulders, a chestpiece and a weapon: the two rows that hang geometry
    /// off the body and the two that only paint it, which is both halves of what a page holds.
    const HELM: Piece = armour(900_001, 0);
    const SHOULDERS: Piece = armour(900_002, 1);
    const CHESTPIECE: Piece = armour(900_003, 3);
    const WEAPON: Piece = Piece {
        display_info_id: 900_007,
        display_type: 11,
        inventory_type: 13,
    };
    /// A display in a section the game encrypts, so nothing can be read about it.
    const WITHHELD: Piece = armour(900_900, 3);

    const fn armour(display_info_id: u32, display_type: u32) -> Piece {
        Piece {
            display_info_id,
            display_type,
            inventory_type: 0,
        }
    }

    /// The rows of a page, as `(display id, whether it came back with a body)`.
    fn page(pieces: &[Piece]) -> Vec<(u64, bool)> {
        rows(&of(&fixture_files(), pieces, &[]).unwrap())
    }

    fn rows(answer: &Value) -> Vec<(u64, bool)> {
        answer["models"]
            .as_array()
            .expect("a page answers with an array")
            .iter()
            .map(|row| {
                (
                    row["displayInfoId"].as_u64().expect("a row names its display"),
                    row["model"].as_str().is_some_and(|url| {
                        url.starts_with("data:model/gltf-binary;base64,")
                    }),
                )
            })
            .collect()
    }

    // The point of the module: four rows in, four bodies out.
    #[test]
    fn shows_every_appearance_of_a_page_worn() {
        assert_eq!(
            page(&[HELM, SHOULDERS, CHESTPIECE, WEAPON]),
            vec![(900_001, true), (900_002, true), (900_003, true), (900_007, true)],
        );
    }

    // The order is the caller's and not the draw order the pieces would have gone on a body in.
    // Nothing here is worn beside anything else, so there is no draw order to be in — and a
    // window that laid a page out by sorting its own request would have no way to line the
    // answers back up.
    #[test]
    fn answers_in_the_order_it_was_asked() {
        // Reversed, and reversed again: the head layers over the chest and the chest over the
        // legs, so a list sorted by layer would come back in a different order than either.
        assert_eq!(page(&[CHESTPIECE, HELM]), vec![(900_003, true), (900_001, true)]);
        assert_eq!(page(&[HELM, CHESTPIECE]), vec![(900_001, true), (900_003, true)]);
    }

    // A row this install can say nothing about keeps its place and comes back empty, because the
    // window draws the row either way and needs to know which one it was.
    #[test]
    fn keeps_the_place_of_a_row_it_can_say_nothing_about() {
        assert_eq!(
            page(&[HELM, WITHHELD, CHESTPIECE]),
            vec![(900_001, true), (900_900, false), (900_003, true)],
        );
    }

    // A page of nothing is an empty page rather than a body: the window asks for one whenever a
    // filter empties the list, and reading the character out of the game to answer it would be
    // several hundred milliseconds spent on nothing.
    #[test]
    fn asks_the_game_nothing_for_an_empty_page() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(of(&DirFiles::new(temp.path()), &[], &[]).unwrap()["models"], serde_json::json!([]));
    }

    // Each row is the appearance on its own, and the way to see that is to put two on a page that
    // would fight if they were worn together: a robe and a pair of legs both claim geoset group
    // 13, and on one body the priority table gives it to the robe. On a page they each get their
    // own body and neither takes anything from the other.
    #[test]
    fn shows_each_appearance_alone_rather_than_as_an_outfit() {
        let files = fixture_files();
        let robe = armour(900_012, 3);
        let legs = armour(900_004, 5);
        let apart = of(&files, &[robe, legs], &[]).unwrap();

        // What each looks like when it is the only thing asked for, which is what a page row has
        // to be — down to the bytes, because a body is deterministic given what is on it.
        for (which, piece) in [robe, legs].into_iter().enumerate() {
            let alone = of(&files, &[piece], &[]).unwrap();
            assert_eq!(apart["models"][which]["model"], alone["models"][0]["model"]);
        }
    }

    // The failure that is worth reporting rather than drawing an empty page over: the body itself
    // is the one file every row of the page needs, and an install without it has nothing to show.
    #[test]
    fn says_so_when_the_body_cannot_be_read() {
        let temp = tempfile::tempdir().unwrap();
        assert!(of(&DirFiles::new(temp.path()), &[HELM], &[]).is_err());
    }
}
