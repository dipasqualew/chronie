//! A page of the wardrobe: armour shown worn, and what is carried shown as itself.
//!
//! The game's own wardrobe does not draw a chestpiece; it draws a character wearing one, and that
//! is not a presentational choice. **Most of the game's armour has no geometry at all.** A
//! chestpiece is a set of textures painted into a body's atlas and a handful of geoset switches,
//! as `docs/character-rendering.md` sets out — there is no chestpiece mesh to put on a turntable,
//! and the only thing that can be shown is a body with the chestpiece on it.
//!
//! **A weapon is the other case, and it is not a rare one.** A sword, a shield, a bow and an
//! off-hand each have a mesh of their own, and the body under one of them contributes nothing:
//! she is a hundred pixels of woman holding the thing the reader actually asked to look at.
//! Seventeen of the wardrobe's thirty kinds are held in a hand, so this is a third of the browser
//! rather than a corner of it. Those rows are drawn by [`crate::models`], which is the same code
//! `dump_model` writes an `.m2` out with, and they are drawn *without a body at all* — see
//! [`held`], which is where the page stops paying for one.
//!
//! So: one body between every row that needs one, and every row that does not, alone.
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
//! # And a page of the set grid, which is the same errand one word wider
//!
//! [`sets`] draws the other half of the transmog browser: a card per set, and the picture on it is
//! the whole set worn. It is the same arrangement and not a second one — [`crate::worn::each`] has
//! always taken a list of *outfits* and [`of`] hands it lists of one, so a page of a dozen sets is
//! still one body, one walk of each table and one `.glb` per row. What it adds in front is
//! [`crate::transmog::set_pieces`], because a card in the grid is a name and a count until
//! somebody opens it and the window has no clothes to send.
//!
//! What is deliberately *not* here is a cache. The page is what the window asked for, and holding
//! the bodies it produced would be tens of megabytes per page of a wardrobe several thousand rows
//! long. [`crate::casc::Remembered`] already keeps the files underneath all of this, which is the
//! part that repeats.
//!
//! `budget.rs` is where the claims above are held to: it renders a page from the fixtures and
//! asserts what it read, what it walked, and how the cost of twenty compares to the cost of one.

use serde_json::Value;

use crate::body;
use crate::casc::GameFiles;
use crate::character::{Mannequin, Who};
use crate::icons::data_url;
use crate::worn::{self, held, Piece};

/// What kind of picture a row came back as, so the window knows what it is framing.
///
/// The two differ in more than provenance. A body is a two-metre character with the appearance
/// somewhere on her, and the window points a camera at the part of her the slot is on; a held
/// model is the object and nothing else, and the whole of it is the picture. Sending the word
/// rather than letting the window re-derive it from the display type keeps one answer to
/// "was this drawn on a body" instead of two that can disagree.
const WORN: &str = "worn";
const HELD: &str = "held";

/// Every appearance of a page, drawn the way that appearance can be drawn, in the order asked.
///
/// `null` for a row is the ordinary answer and means what it means everywhere else in this app:
/// the game encrypts the displays of content it has not shipped, an appearance whose only texture
/// was painted for another body resolves to nothing, and an install can be missing the `.m2` a
/// weapon names. The window keeps that row's icon.
///
/// The order is the caller's, and every row asked for gets an answer, including the ones that
/// resolve to nothing — a page one row short is a row the window would have to hunt for.
#[tracing::instrument(name = "gallery.of", skip_all, fields(pieces = pieces.len()))]
pub fn of(files: &dyn GameFiles, pieces: &[Piece], who: &Who) -> Result<Value, String> {
    if pieces.is_empty() {
        return Ok(serde_json::json!({ "models": [] }));
    }

    // The page split by what each row can be a picture of, keeping where each sat. Both halves
    // are then answered in one go, which is the whole shape of this module: the cost of either
    // kind is the tables behind it, and a table costs the same walk however many rows come out.
    let dressed: Vec<usize> = (0..pieces.len())
        .filter(|row| !held(pieces[*row].display_type))
        .collect();
    let carried: Vec<usize> = (0..pieces.len())
        .filter(|row| held(pieces[*row].display_type))
        .collect();

    let mut drawn: Vec<Option<String>> = vec![None; pieces.len()];

    // Whose body the page is of, read once for both halves. An item's textures and the `.m2` a
    // helm is modelled as are both chosen by the body's own race and sex, so even the half that
    // hangs no character off anything is answered for somebody. It is three of the smallest
    // tables in the game against the two hundred-thousand-row ones below.
    let body = body::of(files, who.body)?;

    // A page with nothing on it that goes on a body never reaches this branch, and that is the
    // point of the split: the character and the six tables behind her are the whole cost of a
    // gallery, and a reader browsing the seventeen kinds of weapon should not pay for a body
    // none of their rows would have shown.
    if !dressed.is_empty() {
        // One outfit per piece: nothing on this page is ever worn beside anything else on it, so
        // there is nothing for the priority table or the draw order to settle. What the pieces
        // share is the tables, and that is the whole reason this is one call rather than a loop.
        let alone: Vec<&[Piece]> = dressed
            .iter()
            .map(|row| std::slice::from_ref(&pieces[*row]))
            .collect();
        let worn = worn::each(files, &body, &alone)?;

        let mannequin = Mannequin::standing(files, &body, &who.picked)?;
        for (row, worn) in dressed.iter().zip(worn.iter()) {
            if worn.is_empty() {
                continue;
            }
            drawn[*row] = Some(data_url("model/gltf-binary", &mannequin.wearing(Some(worn))?));
        }
    }

    // And the same for the geometry, out of one walk of each of the three tables an item's own
    // model comes out of. Nothing is an ordinary answer here too, and a *different* ordinary
    // answer than an empty `Worn`: this install may simply not hold the file the display names.
    if !carried.is_empty() {
        let displays: Vec<u32> = carried
            .iter()
            .map(|row| pieces[*row].display_info_id)
            .collect();
        for (row, alone) in carried.iter().zip(crate::models::each(files, &body, &displays)?) {
            drawn[*row] = alone.map(|bytes| data_url("model/gltf-binary", &bytes));
        }
    }

    let models: Vec<Value> = pieces
        .iter()
        .zip(drawn)
        .map(|(piece, model)| {
            serde_json::json!({
                "displayInfoId": piece.display_info_id,
                "kind": if held(piece.display_type) { HELD } else { WORN },
                "model": model.map_or(Value::Null, Value::String),
            })
        })
        .collect();

    Ok(serde_json::json!({ "models": models }))
}

/// A page of the set grid, each set worn whole on a body of its own.
///
/// The other half of the same errand [`of`] runs, and the difference is one word: a row here is
/// an *outfit* rather than an appearance. That word costs nothing extra — [`crate::worn::each`]
/// was always a list of outfits and [`of`] passes it lists of one — so a page of sets is the same
/// one body, the same one walk of each table, and the same one `.glb` per row.
///
/// **What a set is wearing is read here rather than sent from the window.** The window holds the
/// grid, not the clothes: a card is a name and a count until somebody opens it, and asking it to
/// open a dozen sets to draw a page would be a dozen trips through the five tables
/// [`crate::transmog::set_items`] walks. So this takes the ids off the cards and asks
/// [`crate::transmog::set_pieces`], which answers for the whole page out of one walk of each of
/// the four tables the chain is read through.
///
/// `null` for a row means the same as it does everywhere else along here: this install can say
/// nothing to put on her for that set. A set the game encrypts outright reads as no pieces at
/// all, and one whose every display is withheld reads as an empty outfit; both leave the card
/// showing what it showed before anybody asked for a picture.
#[tracing::instrument(name = "gallery.sets", skip_all, fields(sets = set_ids.len()))]
pub fn sets(files: &dyn GameFiles, set_ids: &[u32], who: &Who) -> Result<Value, String> {
    if set_ids.is_empty() {
        return Ok(serde_json::json!({ "models": [] }));
    }

    let wearing = crate::transmog::set_pieces(files, set_ids)?;
    let outfits: Vec<&[Piece]> = set_ids
        .iter()
        .map(|set_id| wearing.get(set_id).map_or(&[][..], Vec::as_slice))
        .collect();

    // A page whose every set is empty is a page with nothing on it, and reading the character to
    // answer it would be several hundred milliseconds spent on nothing — the same saving [`of`]
    // makes for a page of nothing but weapons.
    if outfits.iter().all(|pieces| pieces.is_empty()) {
        return Ok(serde_json::json!({
            "models": set_ids
                .iter()
                .map(|set_id| serde_json::json!({ "setId": set_id, "model": Value::Null }))
                .collect::<Vec<Value>>(),
        }));
    }

    let body = body::of(files, who.body)?;
    let worn = worn::each(files, &body, &outfits)?;
    let mannequin = Mannequin::standing(files, &body, &who.picked)?;

    let models: Vec<Value> = set_ids
        .iter()
        .zip(worn.iter())
        .map(|(set_id, worn)| {
            let model = if worn.is_empty() {
                Value::Null
            } else {
                Value::String(data_url("model/gltf-binary", &mannequin.wearing(Some(worn))?))
            };
            Ok(serde_json::json!({ "setId": set_id, "model": model }))
        })
        .collect::<Result<Vec<Value>, String>>()?;

    Ok(serde_json::json!({ "models": models }))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// Fixture files that remember which of the game's own files were opened.
    ///
    /// The same recorder `wardrobe`'s tests use, and here for the one thing counting cannot say:
    /// whether the *character* was among them. A page that skipped the body reads fewer files
    /// than one that did not, but so does a page whose weapons this install cannot see — and
    /// those are opposite outcomes.
    struct Noted {
        files: DirFiles,
        asked: RefCell<Vec<u32>>,
    }

    impl Noted {
        fn new() -> Self {
            Self {
                files: fixture_files(),
                asked: RefCell::new(Vec::new()),
            }
        }
    }

    impl GameFiles for Noted {
        fn read(&self, fdid: u32) -> Result<std::sync::Arc<Vec<u8>>, String> {
            self.asked.borrow_mut().push(fdid);
            self.files.read(fdid)
        }
    }

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

    /// The rows of a page, as `(display id, whether it came back with a model)`.
    fn page(pieces: &[Piece]) -> Vec<(u64, bool)> {
        rows(&of(&fixture_files(), pieces, &Who::default()).unwrap())
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

    /// What each row of a page says it is, which is what the window frames by.
    fn kinds(pieces: &[Piece]) -> Vec<&'static str> {
        of(&fixture_files(), pieces, &Who::default()).unwrap()["models"]
            .as_array()
            .expect("a page answers with an array")
            .iter()
            .map(|row| match row["kind"].as_str().expect("a row says what it is") {
                "worn" => WORN,
                "held" => HELD,
                other => panic!("a row came back as {other}"),
            })
            .collect()
    }

    // The point of the module: four rows in, four pictures out.
    #[test]
    fn shows_every_appearance_of_a_page() {
        assert_eq!(
            page(&[HELM, SHOULDERS, CHESTPIECE, WEAPON]),
            vec![(900_001, true), (900_002, true), (900_003, true), (900_007, true)],
        );
    }

    // And what each of those pictures is. The three armour rows are a character wearing the
    // thing, because there is no chestpiece to draw; the weapon is the weapon.
    #[test]
    fn draws_armour_on_a_body_and_a_weapon_as_itself() {
        assert_eq!(
            kinds(&[HELM, SHOULDERS, CHESTPIECE, WEAPON]),
            vec![WORN, WORN, WORN, HELD],
        );
    }

    // A helm has a mesh of its own and is still drawn worn, which is the distinction the module
    // turns on: what decides is where the appearance goes, not whether it has geometry. A helm
    // off a head is a bowl, and the game's own wardrobe shows it on one.
    #[test]
    fn draws_a_helm_on_a_body_though_it_has_a_model_of_its_own() {
        assert_eq!(kinds(&[HELM]), vec![WORN]);
    }

    // The weapon row is the item's own model and nothing else — which is the same `.glb` the
    // model path writes for `dump_model`, down to the bytes. Anything else here would mean the
    // gallery had grown a second implementation of what an item's geometry is.
    #[test]
    fn draws_a_weapon_as_the_model_the_display_names() {
        let files = fixture_files();
        let hers = body::of(&files, body::DEFAULT).unwrap();
        let alone = crate::models::glb_of(&files, &hers, WEAPON.display_info_id)
            .unwrap()
            .expect("the fixture weapon has a model");
        assert_eq!(
            of(&files, &[WEAPON], &Who::default()).unwrap()["models"][0]["model"],
            Value::String(data_url("model/gltf-binary", &alone)),
        );
    }

    /// The mesh the body this app opens on is drawn from, which is the file those two tests are
    /// about. Read rather than named, because which mesh a body is is `body.rs`'s answer now.
    fn her_mesh() -> u32 {
        body::of(&fixture_files(), body::DEFAULT).unwrap().model
    }

    // And the saving that pays for it: a page with nothing on it that goes on a body never reads
    // her mesh. She is the single most expensive thing a gallery touches — the mesh, the skin
    // resized onto a 2048x1024 atlas, the face composited over it and a 16MB skeleton — and a
    // reader browsing the seventeen kinds of weapon would otherwise pay for her on every page.
    //
    // What *is* read either way is the three small tables saying what a body is: which of a
    // weapon's models is the one for this body is decided by its own race and sex, the same way
    // an item's textures are.
    #[test]
    fn reads_no_body_for_a_page_of_nothing_but_weapons() {
        let files = Noted::new();
        of(&files, &[WEAPON, WEAPON], &Who::default()).expect("a page of weapons draws");
        assert!(
            !files.asked.borrow().contains(&her_mesh()),
            "a page of weapons read the character anyway",
        );
    }

    // The other side of it, so that the test above is measuring the branch rather than a fixture
    // that happens never to name her: one chestpiece on the page and the body is read.
    #[test]
    fn reads_the_body_for_a_page_holding_one_piece_of_armour() {
        let files = Noted::new();
        of(&files, &[WEAPON, CHESTPIECE], &Who::default()).expect("a mixed page draws");
        assert!(files.asked.borrow().contains(&her_mesh()));
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
        assert_eq!(of(&DirFiles::new(temp.path()), &[], &Who::default()).unwrap()["models"], serde_json::json!([]));
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
        let apart = of(&files, &[robe, legs], &Who::default()).unwrap();

        // What each looks like when it is the only thing asked for, which is what a page row has
        // to be — down to the bytes, because a body is deterministic given what is on it.
        for (which, piece) in [robe, legs].into_iter().enumerate() {
            let alone = of(&files, &[piece], &Who::default()).unwrap();
            assert_eq!(apart["models"][which]["model"], alone["models"][0]["model"]);
        }
    }

    // The failure that is worth reporting rather than drawing an empty page over: the body itself
    // is the one file every row of the page needs, and an install without it has nothing to show.
    #[test]
    fn says_so_when_the_body_cannot_be_read() {
        let temp = tempfile::tempdir().unwrap();
        assert!(of(&DirFiles::new(temp.path()), &[HELM], &Who::default()).is_err());
    }

    /* ---------- a page of sets, each worn whole ---------- */

    /// The rows of a page of sets, as `(set id, whether it came back with a picture)`.
    fn set_page(set_ids: &[u32]) -> Vec<(u64, bool)> {
        sets(&fixture_files(), set_ids, &Who::default()).unwrap()["models"]
            .as_array()
            .expect("a page answers with an array")
            .iter()
            .map(|row| {
                (
                    row["setId"].as_u64().expect("a row names its set"),
                    row["model"].as_str().is_some_and(|url| {
                        url.starts_with("data:model/gltf-binary;base64,")
                    }),
                )
            })
            .collect()
    }

    // The point of the module's other half: set ids in, one picture per set out, in the order
    // asked. The window lays a grid out from its own list and has to line the answers back up.
    #[test]
    fn shows_every_set_of_a_page() {
        assert_eq!(set_page(&[203, 201]), vec![(203, true), (201, true)]);
        assert_eq!(set_page(&[201, 203]), vec![(201, true), (203, true)]);
    }

    // And what one of those pictures is: the whole set on one body, rather than a body per
    // piece. Down to the bytes, because dressing a character is deterministic given what is on
    // her — so this is the same claim as "the card shows what wearing the set would show".
    #[test]
    fn dresses_one_body_in_the_whole_set() {
        let files = fixture_files();
        let wearing = crate::transmog::set_pieces(&files, &[203]).unwrap();
        let whole = crate::character::worn_set_of(&files, &wearing[&203], &Who::default()).unwrap();
        assert_eq!(
            sets(&files, &[203], &Who::default()).unwrap()["models"][0]["model"],
            whole["model"],
        );
    }

    // A set this install can put nothing on her for keeps its place and comes back empty. Set
    // 205's one readable row names a display the game encrypts, so there is nothing to paint.
    #[test]
    fn keeps_the_place_of_a_set_it_can_draw_nothing_for() {
        assert_eq!(set_page(&[201, 205, 203]), vec![(201, true), (205, false), (203, true)]);
    }

    // And a page where that is true of every set never reads the character at all — she is the
    // most expensive thing a gallery touches, and there would be nothing to hang off her.
    #[test]
    fn reads_no_body_for_a_page_of_sets_with_nothing_to_wear() {
        let files = Noted::new();
        assert_eq!(
            sets(&files, &[900], &Who::default()).unwrap()["models"],
            serde_json::json!([{ "setId": 900, "model": Value::Null }]),
        );
        assert!(!files.asked.borrow().contains(&her_mesh()));
    }

    // A page of no sets is an empty page rather than a body, the same way a page of no
    // appearances is: the window asks for one whenever a filter empties the grid.
    #[test]
    fn asks_the_game_nothing_for_a_page_of_no_sets() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            sets(&DirFiles::new(temp.path()), &[], &Who::default()).unwrap()["models"],
            serde_json::json!([]),
        );
    }

    // The failure worth reporting rather than drawing an empty grid over, which is the one
    // every row of the page shares.
    #[test]
    fn says_so_when_a_page_of_sets_cannot_be_read() {
        let temp = tempfile::tempdir().unwrap();
        assert!(sets(&DirFiles::new(temp.path()), &[203], &Who::default()).is_err());
    }
}
