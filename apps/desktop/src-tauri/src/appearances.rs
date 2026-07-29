//! From an item the addon wrote down a number for, to something that can be drawn.
//!
//! A segment arrives holding the transmog a character collected, and what it holds is item ids —
//! that is all the addon can catch at the moment the game says a source was learned. Everything
//! else in this app that draws an appearance starts from the other end: the wardrobe and the sets
//! walk out of `ItemAppearance` and already hold the three numbers a render needs. A segment has
//! none of them, and this is the hop that gets them.
//!
//! Two tables and a walk each. `ItemModifiedAppearance` is what ties an item to the look it
//! carries, and `ItemAppearance` is what says which slot that look fills and which display it is
//! drawn from. `Item` supplies the one thing neither can: the inventory type, which is what says
//! *which hand* a weapon is held in — the same reason [`crate::worn::Piece`] carries it.
//!
//! **Nothing calls this until a reader asks.** A segment can name a few dozen transmog sources
//! and the tables here are hundreds of thousands of rows; a window that resolved every row of
//! every segment it drew would pay for a gallery nobody looked at. So the window asks for one
//! item, when somebody clicks it, and that is why this answers a batch that is usually of one.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::items::{column, ITEM};
use crate::transmog::{
    appearance_column, modified_appearance_column, ITEM_APPEARANCE, ITEM_MODIFIED_APPEARANCE,
};

/// The look each item carries, keyed by the id it was asked for by.
///
/// An id that resolves to nothing is left out rather than answered with zeroes, which is what
/// every other lookup in this app does and means the same thing here: the game encrypts the
/// content it has not shipped, an item may carry no appearance at all, and a patch may have
/// taken one away. The window keeps that row's icon.
///
/// The appearance id comes back beside the display because it is the game's own unit of
/// collection — the same number the wardrobe and the sets key their marks on — so a window that
/// has one of these can say whether the look is already starred without asking anything further.
#[tracing::instrument(name = "appearances.of_items", skip_all, fields(items = wanted.len()))]
pub fn of_items(files: &dyn GameFiles, wanted: &[u32]) -> Result<Value, String> {
    if wanted.is_empty() {
        return Ok(json!({ "appearances": {} }));
    }
    let asked: HashSet<u32> = wanted.iter().copied().collect();

    // Item to look. An item can carry more than one row here — the same item at a different
    // modifier — and they name the same appearance, so the lowest is as good as any and the
    // choice does not have to be defended.
    let modified = Db2::parse(files.read(ITEM_MODIFIED_APPEARANCE)?)?;
    let mut looks: HashMap<u32, u32> = HashMap::new();
    for row in modified.rows() {
        let item = row.number(modified_appearance_column::ITEM_ID);
        if !asked.contains(&item) {
            continue;
        }
        let appearance = row.number(modified_appearance_column::APPEARANCE_ID);
        if appearance == 0 {
            continue;
        }
        looks.entry(item).or_insert(appearance);
    }
    if looks.is_empty() {
        return Ok(json!({ "appearances": {} }));
    }

    // Look to slot and display. Only the appearances actually reached, because the table is
    // fifty-five thousand rows on a shipping install and a segment names a few dozen items.
    let reached: HashSet<u32> = looks.values().copied().collect();
    let appearances = Db2::parse(files.read(ITEM_APPEARANCE)?)?;
    let drawn: HashMap<u32, (u32, u32)> = appearances
        .rows()
        .filter(|row| reached.contains(&row.id()))
        .map(|row| {
            (
                row.id(),
                (
                    row.number(appearance_column::DISPLAY_TYPE),
                    row.number(appearance_column::DISPLAY_INFO_ID),
                ),
            )
        })
        .collect();

    // And the hand, out of the small table. `Item` is two megabytes against `ItemSparse`'s
    // sixty-three and holds the same `InventoryType`, which is why [`items::read`] opens this
    // one first — and why nothing here opens the big one at all, since no name is wanted.
    let table = Db2::parse(files.read(ITEM)?)?;
    let worn_in: HashMap<u32, u32> = table
        .rows()
        .filter(|row| asked.contains(&row.id()))
        .map(|row| (row.id(), row.number(column::INVENTORY_TYPE)))
        .collect();

    let mut found = serde_json::Map::new();
    for item in wanted {
        let Some(appearance) = looks.get(item) else {
            continue;
        };
        let Some((display_type, display_info_id)) = drawn.get(appearance) else {
            continue;
        };
        found.insert(
            item.to_string(),
            json!({
                "appearanceId": appearance,
                "displayType": display_type,
                "displayInfoId": display_info_id,
                "inventoryType": worn_in.get(item).copied().unwrap_or(0),
            }),
        );
    }

    Ok(json!({ "appearances": Value::Object(found) }))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// The fixture items, by what the generator made each of them. Every one of these is an
    /// item the wardrobe reaches the same look through from the other direction.
    ///
    /// `Emberforge Helm`, which fills the head slot, and `Emberforge Blade`, which is a
    /// one-hander — filed under display type 11 like every other weapon in the game, with the
    /// hand it goes in readable off the item and nowhere else.
    const HELM_ITEM: u32 = 30006;
    const WEAPON_ITEM: u32 = 30014;
    /// An item nothing in the fixture tables says anything about.
    const UNKNOWN: u32 = 999_999;

    fn of(wanted: &[u32]) -> Value {
        of_items(&fixture_files(), wanted).unwrap()
    }

    /// The three numbers a render needs, as the window would read them off the answer.
    fn piece(answer: &Value, item: u32) -> Option<(u64, u64, u64)> {
        let found = answer["appearances"].get(item.to_string())?;
        Some((
            found["displayInfoId"].as_u64()?,
            found["displayType"].as_u64()?,
            found["inventoryType"].as_u64()?,
        ))
    }

    // The point of the module: an item id in, and the three numbers `worn::Piece` is made of.
    #[test]
    fn answers_an_item_with_the_piece_it_would_be_drawn_as() {
        let answer = of(&[HELM_ITEM]);
        let (display_info_id, display_type, _) =
            piece(&answer, HELM_ITEM).expect("the fixture helm resolves");
        assert_eq!(display_type, 0, "a helm fills the head slot");
        assert_ne!(display_info_id, 0, "and names a display to be drawn from");
    }

    // The appearance id too, because it is the game's own unit of collection and is what a mark
    // is keyed on everywhere else in this app.
    #[test]
    fn names_the_appearance_the_rest_of_the_app_keys_marks_on() {
        assert_ne!(
            of(&[HELM_ITEM])["appearances"][HELM_ITEM.to_string()]["appearanceId"],
            0
        );
    }

    // The hand, which is the one thing the slot cannot say and the reason `Item` is opened at
    // all: `DisplayType` files every one-hander, staff and dagger under the same number.
    #[test]
    fn says_which_hand_a_weapon_is_held_in() {
        let (_, display_type, inventory_type) =
            piece(&of(&[WEAPON_ITEM]), WEAPON_ITEM).expect("the fixture weapon resolves");
        assert!(
            display_type > 10,
            "a weapon is filed above every armour slot"
        );
        assert_ne!(inventory_type, 0, "and the item says where it is held");
    }

    // An item the tables say nothing about is left out rather than answered with zeroes, which
    // a window would otherwise draw as a helm with no model.
    #[test]
    fn leaves_out_an_item_it_can_say_nothing_about() {
        let answer = of(&[HELM_ITEM, UNKNOWN]);
        assert!(answer["appearances"].get(UNKNOWN.to_string()).is_none());
        assert!(answer["appearances"].get(HELM_ITEM.to_string()).is_some());
    }

    // Nothing is opened for a batch of nothing. The window asks only when a reader clicks, so
    // this is the ordinary state of the command rather than an edge of it.
    #[test]
    fn asks_the_game_nothing_for_an_empty_batch() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            of_items(&DirFiles::new(temp.path()), &[]).unwrap(),
            json!({ "appearances": {} }),
        );
    }

    /// Fixture files that remember which of the game's tables were opened.
    struct Noted {
        files: DirFiles,
        asked: RefCell<Vec<u32>>,
    }

    impl GameFiles for Noted {
        fn read(&self, fdid: u32) -> Result<std::sync::Arc<Vec<u8>>, String> {
            self.asked.borrow_mut().push(fdid);
            self.files.read(fdid)
        }
    }

    // `ItemSparse` is sixty-three megabytes and holds the names, and nothing here wants a name:
    // the window already has one out of the segment or out of the item book beside it. Opening
    // it to answer a click would be the most expensive read in the app spent on nothing.
    #[test]
    fn never_opens_the_table_that_holds_the_names() {
        let files = Noted {
            files: fixture_files(),
            asked: RefCell::new(Vec::new()),
        };
        of_items(&files, &[HELM_ITEM]).expect("the fixture helm resolves");
        assert!(!files.asked.borrow().contains(&crate::transmog::ITEM_SPARSE));
    }

    // Each table once for the batch, however many items are in it — the same claim the gallery
    // makes, and true here for the same reason: a walk costs the whole table.
    #[test]
    fn opens_each_table_once_however_many_items_are_asked_about() {
        let files = Noted {
            files: fixture_files(),
            asked: RefCell::new(Vec::new()),
        };
        of_items(&files, &[HELM_ITEM, WEAPON_ITEM, UNKNOWN]).expect("a batch resolves");
        let asked = files.asked.borrow();
        for table in [ITEM_MODIFIED_APPEARANCE, ITEM_APPEARANCE, ITEM] {
            assert_eq!(
                asked.iter().filter(|read| **read == table).count(),
                1,
                "table {table} was opened more than once",
            );
        }
    }
}
