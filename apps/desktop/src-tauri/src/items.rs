//! What the game says about an item the addon only recorded the number of.
//!
//! A segment arrives carrying item ids — the transmog sources a character learned, the pieces
//! an equipment set was changed to hold — and, where the client happened to have the item
//! loaded at the moment, a name. Everything a player recognises an item by is in two of the
//! client's own tables: `Item` is what kind of thing it is, where it is worn and the picture
//! beside it, and `ItemSparse` is what it is called, what it is worth and who may wear it.
//! [`read`] joins the two for the handful of ids a window is showing.
//!
//! Nothing here decides wording. Which subclass of armour is "Leather" and which slot is
//! "Head" is the window's business, and doing it there keeps the language beside the markup
//! it goes in; this answers with the numbers the game stores and no more.
//!
//! The column positions are [`crate::tables`]'s, out of `docs/game-tables.json`, and were read
//! off build 12.0.5.67 with `examples/dump_item_facts` — which finds them rather than trusting
//! them and is what to run again after a patch. A patch that reorders one shows wrong values
//! rather than failing, so every position the registry holds for these two tables is one that
//! tool checks against something a wrong column could not produce.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::tables::item as column;
use crate::tables::item_sparse as item_column;
use crate::tables::{ITEM, ITEM_SPARSE};

/// What the game files armour and weapons under, which is all this module names by hand.
pub const ARMOR: u32 = 4;
pub const WEAPON: u32 = 2;

/// The class mask on an item anybody may wear, which is nearly all of them.
///
/// Stored as a signed 16-bit `-1` and read back out of a bit field, so it arrives as this
/// rather than as something with every bit set.
pub const ANY_CLASS: u32 = 0xFFFF;

/// One item, in the facts the game keeps about it.
///
/// Everything here is a number the game stores except the name, and the window turns them
/// into words. An item this install cannot describe has no `Item` at all rather than an
/// `Item` full of zeroes — see [`read`].
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: u32,
    /// What the game calls it. Empty for an item `ItemSparse` holds no readable row for — or
    /// holds one that names it nothing, which comes to the same thing — and that is a real
    /// answer: what `Item` said is still worth drawing, and the window falls back to the name
    /// the addon caught. Nothing else from an unnamed row is carried; see [`read`].
    pub name: String,
    /// [`ARMOR`], [`WEAPON`], or one of the kinds nothing is worn from.
    pub class_id: u32,
    pub subclass_id: u32,
    /// Where it is worn: 1 head, 5 chest, 13 a one-hander, 17 a two-hander. Zero for a thing
    /// that is not worn at all.
    pub inventory_type: u32,
    /// The colour the game writes it in: 0 poor, 1 common, 2 uncommon, 3 rare, 4 epic,
    /// 5 legendary, 6 artifact, 7 heirloom.
    pub quality: u32,
    /// The level needed to equip it. Zero is the ordinary answer.
    pub required_level: u32,
    /// A bit per class, in the game's class order, or [`ANY_CLASS`] for anybody.
    pub allowable_class: u32,
    /// The picture beside it, as a FileDataID to be decoded through `icons`. Zero where the
    /// row names none.
    pub icon_file_data_id: u32,
}

/// Looks up the items a window is showing, and nothing else.
///
/// Two tables, opened in the order that costs least: `Item` is two megabytes and answers for
/// every item the install holds, and `ItemSparse` is sixty-three and is opened only once
/// something has been found to name. A batch nothing at all was found for never opens it.
///
/// `None` against an id is an answer rather than a failure, the way it is for an achievement:
/// the game encrypts content it has not shipped, so an item from a build newer than this
/// install — or one a patch removed — is a row that is simply not there, and the rest of a
/// segment's list still has to draw.
pub fn read(files: &dyn GameFiles, wanted: &[u32]) -> Result<Vec<(u32, Option<Item>)>, String> {
    if wanted.is_empty() {
        return Ok(Vec::new());
    }

    let table = Db2::parse(files.read(ITEM)?)?;
    let mut found: HashMap<u32, Item> = table
        .rows()
        .filter(|row| wanted.contains(&row.id()))
        .map(|row| {
            let id = row.id();
            (
                id,
                Item {
                    id,
                    name: String::new(),
                    class_id: row.number(column::CLASS),
                    subclass_id: row.number(column::SUBCLASS),
                    inventory_type: row.number(column::INVENTORY_TYPE),
                    quality: 0,
                    required_level: 0,
                    allowable_class: ANY_CLASS,
                    icon_file_data_id: row.number(column::ICON_FILE_ID),
                },
            )
        })
        .collect();

    if !found.is_empty() {
        let sparse = Db2::parse_with_text_columns(files.read(ITEM_SPARSE)?, &item_column::TEXT)?;
        for row in sparse.rows() {
            let Some(item) = found.get_mut(&row.id()) else {
                continue;
            };
            // A row that cannot say what the item is called says nothing else either. The name
            // and the numbers are the same record read at different offsets, so whatever leaves
            // the text empty — a patch that moved the strings, a locale that holds none — leaves
            // the numbers pointing somewhere they should not, and a quality read as a required
            // level is worse than no level at all: it draws as a fact. The window makes the same
            // judgement about the same row when it declines to colour an item it cannot name.
            let name = row.text(item_column::NAME);
            if name.is_empty() {
                continue;
            }
            item.name = name;
            item.quality = row.number(item_column::QUALITY);
            item.required_level = row.number(item_column::REQUIRED_LEVEL);
            item.allowable_class = row.number(item_column::ALLOWABLE_CLASS);
        }
    }

    Ok(wanted
        .iter()
        .map(|id| (*id, found.get(id).cloned()))
        .collect())
}

/// The items looked up so far, kept for as long as the app runs.
///
/// Same bargain as the achievement book, and a better one: what the game says about an item
/// cannot change under a running app, a reader walking their history meets the same items
/// over and over, and the read behind this one opens sixty-three megabytes of `ItemSparse`.
/// An id the tables answered nothing for is remembered as such, because that too is a fact
/// about the install rather than about the moment.
#[derive(Default)]
pub struct ItemBook {
    known: Mutex<HashMap<u32, Option<Item>>>,
}

impl ItemBook {
    /// Which of the ids asked for have not been looked up yet, without repeats.
    pub fn missing(&self, wanted: &[u32]) -> Vec<u32> {
        let known = self.known.lock().expect("the item book is not poisoned");
        let mut missing: Vec<u32> = Vec::new();
        for id in wanted {
            if *id != 0 && !known.contains_key(id) && !missing.contains(id) {
                missing.push(*id);
            }
        }
        missing
    }

    pub fn store(&self, found: Vec<(u32, Option<Item>)>) {
        let mut known = self.known.lock().expect("the item book is not poisoned");
        known.extend(found);
    }

    /// The answer to a request: the items among those asked for that this install can
    /// describe, keyed by the id the segment named them by.
    ///
    /// The ones it cannot are left out rather than sent as null, so a row draws exactly as it
    /// would have before the lookup came back — the addon's own name, and no more.
    pub fn answer(&self, wanted: &[u32]) -> Value {
        let known = self.known.lock().expect("the item book is not poisoned");
        let mut items = serde_json::Map::new();
        for id in wanted {
            if let Some(Some(found)) = known.get(id) {
                items.insert(id.to_string(), json!(found));
            }
        }
        json!({ "items": Value::Object(items) })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::casc::{item_fixture_files, DirFiles};

    /// The invented items, by the id a segment would name them under.
    /// A pair of leather shoulders, which is the ordinary case.
    const WANDERERS_MANTLE: u32 = 201;
    /// Plate, and the only item restricted to some classes.
    const BULWARK_HELM: u32 = 202;
    /// A one-handed sword, so a weapon's slot has to come from the item rather than the
    /// appearance.
    const TIDEGLASS_EDGE: u32 = 203;
    /// A cloak: cloth by class, worn on the back.
    const NIGHT_CLOAK: u32 = 204;
    /// Held in `Item` and not in `ItemSparse`, which is half a row rather than none.
    const NAMELESS_TRINKET: u32 = 205;
    /// Held in both, and named by neither: an `ItemSparse` row whose text is empty and whose
    /// numbers are not.
    const UNNAMED_CHEST: u32 = 207;
    /// Not worn at all, so nothing about it is a slot.
    const HEARTH_TOKEN: u32 = 206;
    /// A mail chestpiece the game keeps encrypted.
    const WITHHELD: u32 = 900;
    /// An id no row of either table carries.
    const ABSENT: u32 = 4242;

    /// Game files that remember what was asked of them. Which table a read opens is part of
    /// the behaviour: the big one is only opened when there is something to name.
    struct Noted {
        files: DirFiles,
        asked: RefCell<Vec<u32>>,
    }

    impl Noted {
        fn new() -> Self {
            Self {
                files: item_fixture_files(),
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

    fn read_all(wanted: &[u32]) -> Vec<(u32, Option<Item>)> {
        read(&item_fixture_files(), wanted).unwrap()
    }

    fn one(id: u32) -> Item {
        read_all(&[id])
            .into_iter()
            .next()
            .and_then(|(_, found)| found)
            .unwrap_or_else(|| panic!("the fixture holds item {id}"))
    }

    // Everything the window shows about an item comes out of one row of each table, so the
    // whole of it is written out here rather than a field at a time.
    #[test]
    fn reads_an_item_down_to_what_the_game_calls_it() {
        assert_eq!(
            one(WANDERERS_MANTLE),
            Item {
                id: 201,
                name: "Wanderer's Mantle".into(),
                class_id: ARMOR,
                subclass_id: 2,
                inventory_type: 3,
                quality: 3,
                required_level: 25,
                allowable_class: ANY_CLASS,
                icon_file_data_id: 260001,
            }
        );
    }

    // The two tables are joined on the item id, and a reader that took either half positionally
    // would put one item's name on another's row.
    #[test]
    fn keeps_each_items_name_on_its_own_row() {
        let named: Vec<(u32, String)> = read_all(&[TIDEGLASS_EDGE, NIGHT_CLOAK, BULWARK_HELM])
            .into_iter()
            .filter_map(|(id, found)| found.map(|found| (id, found.name)))
            .collect();
        assert_eq!(
            named,
            vec![
                (TIDEGLASS_EDGE, "Tideglass Edge".to_string()),
                (NIGHT_CLOAK, "Cloak of the Long Night".to_string()),
                (BULWARK_HELM, "Bulwark Helm".to_string()),
            ]
        );
    }

    // Which armour class a piece is, and which hand a weapon goes in, is the pair of facts the
    // whole lookup exists for: the addon records neither.
    #[test]
    fn says_what_kind_of_thing_an_item_is_and_where_it_is_worn() {
        let kinds: Vec<(u32, u32, u32, u32)> =
            read_all(&[WANDERERS_MANTLE, BULWARK_HELM, TIDEGLASS_EDGE, HEARTH_TOKEN])
                .into_iter()
                .filter_map(|(id, found)| {
                    found.map(|found| (id, found.class_id, found.subclass_id, found.inventory_type))
                })
                .collect();
        assert_eq!(
            kinds,
            vec![
                (WANDERERS_MANTLE, ARMOR, 2, 3), // leather shoulders
                (BULWARK_HELM, ARMOR, 4, 1),     // plate head
                (TIDEGLASS_EDGE, WEAPON, 7, 13), // a one-handed sword
                (HEARTH_TOKEN, 15, 0, 0),        // worn nowhere at all
            ]
        );
    }

    // Nearly every item is for every class, so the game keeps the exception sparsely: a reader
    // that missed it would report the whole game as being restricted to whichever class is
    // numbered first.
    #[test]
    fn says_which_classes_may_wear_an_item_when_it_is_not_all_of_them() {
        // Warrior, paladin and death knight — the three that wear plate — as a bit each.
        assert_eq!(one(BULWARK_HELM).allowable_class, 0b10_0011);
        assert_eq!(one(WANDERERS_MANTLE).allowable_class, ANY_CLASS);
        assert_eq!(one(TIDEGLASS_EDGE).allowable_class, ANY_CLASS);
    }

    // The colour an item's name is written in and the level it takes to wear it both come out
    // of the big table, and both are worth nothing more than the number the game stores.
    #[test]
    fn reads_what_an_item_is_worth_and_what_it_takes_to_wear_it() {
        let worth: Vec<(u32, u32, u32)> =
            read_all(&[WANDERERS_MANTLE, BULWARK_HELM, TIDEGLASS_EDGE, HEARTH_TOKEN])
                .into_iter()
                .filter_map(|(id, found)| {
                    found.map(|found| (id, found.quality, found.required_level))
                })
                .collect();
        assert_eq!(
            worth,
            vec![
                (WANDERERS_MANTLE, 3, 25),
                (BULWARK_HELM, 4, 60),
                (TIDEGLASS_EDGE, 5, 60),
                // A token nobody wears: common, and needing no level at all.
                (HEARTH_TOKEN, 1, 0),
            ]
        );
    }

    // A row in the small table and none in the big one is half an answer, and half an answer
    // is worth drawing: the slot and the picture are there, and the window falls back to the
    // name the addon caught.
    #[test]
    fn answers_with_what_it_has_for_an_item_the_big_table_cannot_name() {
        let found = one(NAMELESS_TRINKET);
        assert_eq!(found.name, "");
        assert_eq!(found.inventory_type, 12);
        assert_eq!(found.icon_file_data_id, 260004);
        assert_eq!(found.quality, 0);
    }

    // A row that cannot say what the item is called is not a row to read numbers off either.
    //
    // The window showed "Item 39270 · Sword · One-hand · Level 4" about an epic Wrath sword that
    // takes level 30: the name had come back empty and the level was the quality, read a few
    // columns off. Whatever moves the strings moves the numbers beside them, and a level that is
    // really a quality is worse than no level — it reads as a fact. So an unnamed row contributes
    // nothing but its silence, and what the row *before* it said still stands: the slot, the
    // kind and the picture come out of `Item` and are unaffected.
    //
    // `itemLine` in the window already refuses to colour an item it cannot name, for the same
    // reason and about the same row.
    #[test]
    fn takes_no_numbers_from_a_row_that_cannot_name_the_item() {
        let found = one(UNNAMED_CHEST);
        assert_eq!(found.name, "");
        // What `Item` says, which is not in doubt.
        assert_eq!(
            (found.class_id, found.subclass_id, found.inventory_type),
            (ARMOR, 1, 5)
        );
        assert_eq!(found.icon_file_data_id, 260003);
        // And what the nameless row said, which is not believed: the defaults an item nothing is
        // known about carries.
        assert_eq!(found.quality, 0);
        assert_eq!(found.required_level, 0);
        assert_eq!(found.allowable_class, ANY_CLASS);
    }

    // Two ways an id can go unanswered, and neither is a reason to fail the batch.
    #[test]
    fn answers_with_nothing_for_an_item_this_install_cannot_describe() {
        let named: Vec<(u32, bool)> = read_all(&[WANDERERS_MANTLE, WITHHELD, ABSENT])
            .iter()
            .map(|(id, found)| (*id, found.is_some()))
            .collect();
        assert_eq!(
            named,
            vec![(WANDERERS_MANTLE, true), (WITHHELD, false), (ABSENT, false)]
        );
    }

    // Both tables are parsed once however many items a batch asks about, and the answer keeps
    // the order it was asked in.
    #[test]
    fn opens_each_table_once_for_a_whole_batch() {
        let files = Noted::new();
        let found = read(&files, &[NIGHT_CLOAK, WANDERERS_MANTLE, TIDEGLASS_EDGE]).unwrap();
        assert_eq!(
            found.iter().map(|(id, _)| *id).collect::<Vec<u32>>(),
            vec![NIGHT_CLOAK, WANDERERS_MANTLE, TIDEGLASS_EDGE]
        );
        assert_eq!(files.asked.into_inner(), vec![ITEM, ITEM_SPARSE]);
    }

    // The big table is sixty-three megabytes on a real install, and a batch with nothing to
    // name has nothing to look up in it.
    #[test]
    fn does_not_open_the_big_table_for_a_batch_it_can_describe_nothing_of() {
        let files = Noted::new();
        assert_eq!(read(&files, &[WITHHELD, ABSENT]).unwrap().len(), 2);
        assert_eq!(files.asked.into_inner(), vec![ITEM]);
    }

    #[test]
    fn reads_nothing_at_all_when_nothing_was_asked_for() {
        let files = Noted::new();
        assert_eq!(read(&files, &[]).unwrap(), Vec::new());
        assert_eq!(files.asked.into_inner(), Vec::<u32>::new());
    }

    #[test]
    fn says_so_when_a_table_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = read(&DirFiles::new(temp.path()), &[WANDERERS_MANTLE]).unwrap_err();
        assert!(error.contains("841626.db2"), "{error}");
    }

    /* ---------- the book ---------- */

    // A history mentions the same item once per segment it turned up in, and the read behind
    // this opens sixty-three megabytes — so an id is looked up once and not again.
    #[test]
    fn looks_an_item_up_the_first_time_it_is_named_and_not_again() {
        let files = Noted::new();
        let book = ItemBook::default();

        let first = book.missing(&[WANDERERS_MANTLE, BULWARK_HELM]);
        assert_eq!(first, vec![WANDERERS_MANTLE, BULWARK_HELM]);
        book.store(read(&files, &first).unwrap());

        let second = book.missing(&[WANDERERS_MANTLE, TIDEGLASS_EDGE]);
        assert_eq!(second, vec![TIDEGLASS_EDGE]);
        book.store(read(&files, &second).unwrap());

        assert_eq!(
            files.asked.into_inner(),
            vec![ITEM, ITEM_SPARSE, ITEM, ITEM_SPARSE]
        );
        let answer = book.answer(&[WANDERERS_MANTLE, BULWARK_HELM, TIDEGLASS_EDGE]);
        assert_eq!(answer["items"].as_object().unwrap().len(), 3);
    }

    // Whether an install can describe an item is a fact about the install, so asking again
    // would cost the same two reads to arrive back at the same nothing.
    #[test]
    fn does_not_go_looking_again_for_an_item_it_already_failed_to_find() {
        let book = ItemBook::default();
        book.store(read(&item_fixture_files(), &book.missing(&[WITHHELD, ABSENT])).unwrap());

        assert_eq!(book.missing(&[WITHHELD, ABSENT]), Vec::<u32>::new());
        assert_eq!(book.answer(&[WITHHELD, ABSENT])["items"], json!({}));
    }

    // A window asks with the list its segments carry, which repeats an item collected on two
    // characters and can hold the zero an event with no id at all comes across as.
    #[test]
    fn asks_after_one_item_however_many_segments_name_it() {
        let book = ItemBook::default();
        assert_eq!(
            book.missing(&[BULWARK_HELM, BULWARK_HELM, 0, NIGHT_CLOAK, BULWARK_HELM]),
            vec![BULWARK_HELM, NIGHT_CLOAK]
        );
    }

    // The window keys what it draws by the id the segment carries, so the answer is keyed the
    // same way rather than positionally — half of a request can be missing.
    #[test]
    fn keys_what_it_answers_with_by_the_id_the_segment_named() {
        let book = ItemBook::default();
        book.store(read(&item_fixture_files(), &[WANDERERS_MANTLE, WITHHELD]).unwrap());
        let answer = book.answer(&[WANDERERS_MANTLE, WITHHELD]);
        assert_eq!(answer["items"]["201"]["name"], json!("Wanderer's Mantle"));
        assert_eq!(answer["items"]["201"]["subclassId"], json!(2));
        assert_eq!(answer["items"]["201"]["inventoryType"], json!(3));
        assert_eq!(answer["items"]["201"]["iconFileDataId"], json!(260001));
        assert_eq!(answer["items"][WITHHELD.to_string()], Value::Null);
    }
}
