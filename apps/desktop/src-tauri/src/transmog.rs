//! The transmog sets the game knows about, and what each one is made of.
//!
//! Three of the client's tables describe the sets: `TransmogSet` is the sets themselves,
//! `TransmogSetGroup` names the collections a set can belong to, and `TransmogSetItem` lists
//! the appearances that make one up. [`sets`] reads those three and flattens them into one
//! list for the window.
//!
//! Opening a set goes four hops further — `TransmogSetItem` → `ItemModifiedAppearance` →
//! `ItemAppearance` → `ItemDisplayInfo` — which is what [`set_items`] walks, with a fifth
//! table, `ItemSparse`, asked what each item ended up being called. That chain is written
//! down in `docs/game-files.md`, verified against a real install.
//!
//! The column numbers below are the layout the game has used since patch 12.0.0, and they
//! are the one thing here that a game patch can invalidate. They come from the community's
//! table definitions rather than from guesswork, and a build that reorders them will show
//! wrong values rather than fail, so [`sets`] checks the row count it ends up with against
//! the count the file declares.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{json, Value};

use crate::casc::GameFiles;
use crate::db2::Db2;

/// What the game calls each table. These are stable across patches.
const TRANSMOG_SET: u32 = 1376213;
const TRANSMOG_SET_ITEM: u32 = 1376212;
const TRANSMOG_SET_GROUP: u32 = 1576116;
const ITEM_MODIFIED_APPEARANCE: u32 = 982457;
const ITEM_APPEARANCE: u32 = 982462;
/// Shared with `models`, which reaches the same table by a different question: this module
/// asks whether a display has geometry, that one asks what it is.
pub const ITEM_DISPLAY_INFO: u32 = 1266429;
/// Every item in the game and what it is called. 63 MB of it, and the only table here whose
/// records vary in length.
///
/// Public for `examples/dump_items`, which is how the column positions below get checked
/// against a real install after a patch.
pub const ITEM_SPARSE: u32 = 1572924;

/// Columns of `TransmogSet`, in the order the file stores them.
mod set_column {
    pub const NAME: usize = 0;
    pub const CLASS_MASK: usize = 2;
    pub const FLAGS: usize = 4;
    pub const GROUP_ID: usize = 5;
    pub const PARENT_ID: usize = 7;
    pub const EXPANSION_ID: usize = 9;
    pub const PATCH_INTRODUCED: usize = 10;
    pub const UI_ORDER: usize = 11;
}

/// The one column of `TransmogSetGroup` that is not the row id.
const GROUP_NAME: usize = 0;

/// Columns of `TransmogSetItem`. The set id is a relationship the game duplicates into the
/// record, which is why it reads as an ordinary column.
mod set_item_column {
    pub const SET_ID: usize = 0;
    pub const MODIFIED_APPEARANCE_ID: usize = 1;
}

/// Columns of `ItemModifiedAppearance`, which is what ties an appearance to an item.
mod modified_appearance_column {
    pub const ITEM_ID: usize = 1;
    pub const APPEARANCE_ID: usize = 3;
}

/// Columns of `ItemAppearance`.
mod appearance_column {
    /// Which slot the appearance fills; the game's own numbering, tabulated in the docs.
    pub const DISPLAY_TYPE: usize = 0;
    pub const DISPLAY_INFO_ID: usize = 1;
    pub const ICON_FILE_DATA_ID: usize = 2;
}

/// Columns of `ItemSparse`, whose records vary in length.
///
/// A column of such a table is only findable by walking the ones in front of it, and a string
/// column is as long as the text in it — so the reader has to be told which columns those are
/// before it can find any of them. `ItemSparse` opens with five.
///
/// **These positions are the community's and were not read off an install**, unlike the chain
/// above them. A patch that reorders the table shows empty names rather than wrong ones,
/// because the view falls back to the item's id.
pub mod item_column {
    /// What the item is called.
    pub const NAME: usize = 5;
    /// Every column of the table that holds text, in the order it holds them: the item's
    /// description, its three alternate display names, and its name.
    pub const TEXT: [usize; 5] = [1, 2, 3, 4, 5];
    /// Where the item is worn, which is the one thing `ItemAppearance.DisplayType` will not
    /// say about a weapon: a one-hander is 13, a two-hander 17, a shield 14, an off-hand 22.
    ///
    /// **Unlike the rest of this module, this position was read off an install** — 12.0.5.67,
    /// with `examples/dump_inventory_types`, which finds it rather than trusting it: every
    /// armour slot has exactly one `InventoryType` it can be, and column 66 is the one that
    /// agrees with all eleven of them on 99.8% of the 77,356 pieces of armour in the game.
    /// Nothing else in the table comes within 13%.
    pub const INVENTORY_TYPE: usize = 66;
}

/// Columns of `ItemDisplayInfo`.
pub mod display_column {
    /// A fixed-size array of two, not a scalar. Shoulders keep a model in each slot, and a
    /// reader that stops at the first element reports half of them as having no geometry.
    pub const MODEL_RESOURCES_ID: usize = 10;
    /// The same shape, and parallel to it: slot `i`'s model is painted with slot `i`'s
    /// material. This is the texture an item's own model uses, and not the one armour is
    /// drawn on the body with — that comes out of `ItemDisplayInfoMaterialRes`.
    pub const MATERIAL_RESOURCES_ID: usize = 11;
    /// What kind of model each of the two slots holds. Nothing reads it; it is named because
    /// it is what sits between the materials and the geoset groups, and reading it *as* the
    /// geoset groups is the mistake this table invites — see `examples/dump_display_columns`.
    pub const MODEL_TYPE: usize = 12;
    /// Which variant of each geoset group the display switches on: an array of six, read one
    /// element at a time like the two above.
    ///
    /// Verified on 12.0.5.67, like 10 and 11: this column holds six values where 12 holds two,
    /// and a robe puts a 1 in its third while leaving its second at 0. `docs/game-files.md`
    /// has the whole tail of array columns and what told them apart.
    pub const GEOSET_GROUP: usize = 13;
    /// Which rows of `HelmetGeosetData` say what a helm hides: an array of two, one per
    /// gender. Column 14 between them is `AttachmentGeosetGroup[6]`, which nothing reads.
    pub const HELMET_GEOSET_VIS: usize = 15;
}

/// How many model slots `ModelResourcesID` holds, and how wide one of them is. The file
/// records only the column's total width, so the caller supplies the element size.
pub const MODEL_SLOTS: usize = 2;
pub const MODEL_SLOT_BITS: u32 = 32;

/// One transmog set, as the window shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransmogSet {
    pub id: u32,
    pub name: String,
    /// The collection the set belongs to, already resolved to its name.
    pub group: String,
    pub group_id: u32,
    /// A bit per class, in the game's class order. Zero means every class.
    pub class_mask: u32,
    pub expansion_id: u32,
    /// The set this one is a variant of, or zero.
    pub parent_id: u32,
    pub flags: u32,
    /// Where the set sits in the game's own ordering of its group.
    pub ui_order: u32,
    /// The patch the set arrived in, as the game writes it: major, then two digits each of
    /// minor and patch. Zero when the table does not say.
    pub patch_introduced: u32,
    /// How many appearances make the set up.
    pub item_count: u32,
}

/// Everything the transmog view needs, in one payload.
#[tracing::instrument(name = "transmog.sets", skip_all)]
pub fn sets(files: &dyn GameFiles) -> Result<Value, String> {
    let groups = Db2::parse(files.read(TRANSMOG_SET_GROUP)?)?;
    let group_names: HashMap<u32, String> = groups
        .rows()
        .map(|row| (row.id(), row.text(GROUP_NAME)))
        .collect();

    // `TransmogSetItem` keys each appearance to its set through the game's relationship
    // column, which the reader exposes as the row's own id — one row per appearance, so
    // counting rows per set is all the view wants from it.
    let items = Db2::parse(files.read(TRANSMOG_SET_ITEM)?)?;
    let mut item_counts: HashMap<u32, u32> = HashMap::new();
    for row in items.rows() {
        *item_counts.entry(row.number(set_item_column::SET_ID)).or_default() += 1;
    }

    let table = Db2::parse(files.read(TRANSMOG_SET)?)?;
    let mut sets: Vec<TransmogSet> = table
        .rows()
        .map(|row| {
            let group_id = row.number(set_column::GROUP_ID);
            let id = row.id();
            TransmogSet {
                id,
                name: row.text(set_column::NAME),
                group: group_names.get(&group_id).cloned().unwrap_or_default(),
                group_id,
                class_mask: row.number(set_column::CLASS_MASK),
                expansion_id: row.number(set_column::EXPANSION_ID),
                parent_id: row.number(set_column::PARENT_ID),
                flags: row.number(set_column::FLAGS),
                ui_order: row.number(set_column::UI_ORDER),
                patch_introduced: row.number(set_column::PATCH_INTRODUCED),
                item_count: item_counts.get(&id).copied().unwrap_or(0),
            }
        })
        .collect();

    sets.sort_by(|left, right| {
        right
            .expansion_id
            .cmp(&left.expansion_id)
            .then(left.ui_order.cmp(&right.ui_order))
            .then(left.name.cmp(&right.name))
            .then(left.id.cmp(&right.id))
    });

    // Blizzard encrypts the sets belonging to content it has not shipped, so an install is
    // expected to come up a little short. Saying by how much beats silently showing fewer
    // sets than the game has.
    let declared = table.declared_rows();
    Ok(json!({
        "sets": sets,
        "readCount": sets.len(),
        "declaredCount": declared,
        "withheldCount": declared.saturating_sub(sets.len()),
    }))
}

/// One appearance out of a set, followed as far as the game's tables go.
///
/// Every field past the first can be zero. Blizzard encrypts the content it has not shipped,
/// and a hop of the chain that lands in an encrypted section reads as nothing at all — so a
/// row here says as much of "which item, which slot, which icon" as this install can answer,
/// rather than being dropped for being incomplete.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransmogSetAppearance {
    /// The appearance the set itself names, which is where the chain starts.
    pub modified_appearance_id: u32,
    pub item_id: u32,
    /// What the game calls the item, or empty when it does not say — because the item is in a
    /// section this install cannot decrypt, or because the table holds no name for it.
    pub name: String,
    pub appearance_id: u32,
    /// Which slot the appearance fills, as `ItemAppearance` numbers them: 0 head,
    /// 1 shoulder, 2 through 10 the rest of the armour, 11 upward weapons and shields.
    pub display_type: u32,
    /// Where the item is worn, as `ItemSparse` says it — which for a weapon is the only thing
    /// that says which hand, because the four display types above do not. Zero when the game
    /// holds no row for the item, which is the same silence that leaves it unnamed.
    pub inventory_type: u32,
    pub display_info_id: u32,
    /// The icon the game shows for it, as a FileDataID, or zero when it names none.
    pub icon_file_data_id: u32,
    /// Whether the appearance has geometry of its own. Only heads, shoulders, weapons and
    /// shields do; the rest of a set is texture painted onto the character's body.
    pub has_model: bool,
}

/// What one set is made of, walked out of the game's own tables.
///
/// The set is addressed by id rather than by anything the window carries, so this stays
/// answerable from the game files alone. One row comes back per row of `TransmogSetItem` —
/// including a set that names the same appearance twice — so the length of the list always
/// matches the count the grid showed.
#[tracing::instrument(name = "transmog.set_items", skip_all, fields(set = set_id))]
pub fn set_items(files: &dyn GameFiles, set_id: u32) -> Result<Value, String> {
    let items = Db2::parse(files.read(TRANSMOG_SET_ITEM)?)?;
    let wanted: Vec<u32> = items
        .rows()
        .filter(|row| row.number(set_item_column::SET_ID) == set_id)
        .map(|row| row.number(set_item_column::MODIFIED_APPEARANCE_ID))
        .collect();

    // Nothing further needs reading for a set this install cannot see into, and the tables
    // below are the expensive ones.
    if wanted.is_empty() {
        return Ok(payload(set_id, Vec::new()));
    }

    let modified = Db2::parse(files.read(ITEM_MODIFIED_APPEARANCE)?)?;
    let by_modified: HashMap<u32, (u32, u32)> = modified
        .rows()
        .map(|row| {
            (
                row.id(),
                (
                    row.number(modified_appearance_column::ITEM_ID),
                    row.number(modified_appearance_column::APPEARANCE_ID),
                ),
            )
        })
        .collect();

    let appearances = Db2::parse(files.read(ITEM_APPEARANCE)?)?;
    let by_appearance: HashMap<u32, (u32, u32, u32)> = appearances
        .rows()
        .map(|row| {
            (
                row.id(),
                (
                    row.number(appearance_column::DISPLAY_TYPE),
                    row.number(appearance_column::DISPLAY_INFO_ID),
                    row.number(appearance_column::ICON_FILE_DATA_ID),
                ),
            )
        })
        .collect();

    let displays = Db2::parse(files.read(ITEM_DISPLAY_INFO)?)?;
    let has_model: HashMap<u32, bool> = displays
        .rows()
        .map(|row| {
            let modelled = (0..MODEL_SLOTS).any(|slot| {
                row.element(display_column::MODEL_RESOURCES_ID, slot, MODEL_SLOT_BITS) != 0
            });
            (row.id(), modelled)
        })
        .collect();

    let mut found: Vec<TransmogSetAppearance> = wanted
        .into_iter()
        .map(|modified_appearance_id| {
            let (item_id, appearance_id) = by_modified
                .get(&modified_appearance_id)
                .copied()
                .unwrap_or((0, 0));
            let (display_type, display_info_id, icon_file_data_id) = by_appearance
                .get(&appearance_id)
                .copied()
                .unwrap_or((0, 0, 0));
            TransmogSetAppearance {
                modified_appearance_id,
                item_id,
                name: String::new(),
                appearance_id,
                display_type,
                inventory_type: 0,
                display_info_id,
                icon_file_data_id,
                has_model: has_model.get(&display_info_id).copied().unwrap_or(false),
            }
        })
        .collect();

    // By slot, which is the order the set is worn in and the order the detail view groups
    // by. The rows nothing could be resolved for go last rather than leading with a slot
    // they only appear to fill.
    found.sort_by_key(|appearance| {
        (
            appearance.item_id == 0,
            appearance.display_type,
            appearance.item_id,
            appearance.modified_appearance_id,
        )
    });
    describe_items(files, &mut found)?;
    Ok(payload(set_id, found))
}

/// Fills in what the game calls each of a set's items and where it is worn, out of `ItemSparse`.
///
/// That table is every item in the game — 63 MB of it on a shipping build, an order of
/// magnitude more than the rest of the chain put together — so nothing is kept from it beyond
/// the dozen rows a set actually needs. The rows are walked once and only the ones an
/// appearance here belongs to are read; the file itself is dropped on the way out.
///
/// Two things come out of the same walk, and the second is why a weapon can be shown at all.
/// The **name** is what the row is labelled with. The **inventory type** is where the item is
/// worn, and for a weapon it is the only statement in the game's files of which hand it goes
/// in — `ItemAppearance.DisplayType` files a sword, a shield and a wand under four numbers that
/// say none of it. See `worn::held_in`.
///
/// An item the table says nothing about keeps an empty name and a zero rather than costing its
/// row. The game encrypts the items of content it has not shipped, exactly as it does
/// everywhere else along this chain, and neither is worth dropping a row for.
fn describe_items(
    files: &dyn GameFiles,
    appearances: &mut [TransmogSetAppearance],
) -> Result<(), String> {
    let wanted: HashSet<u32> = appearances
        .iter()
        .map(|appearance| appearance.item_id)
        .filter(|item_id| *item_id != 0)
        .collect();
    if wanted.is_empty() {
        return Ok(());
    }

    let items = Db2::parse_with_text_columns(files.read(ITEM_SPARSE)?, &item_column::TEXT)?;
    let described: HashMap<u32, (String, u32)> = items
        .rows()
        .filter(|row| wanted.contains(&row.id()))
        .map(|row| {
            (
                row.id(),
                (
                    row.text(item_column::NAME),
                    row.number(item_column::INVENTORY_TYPE),
                ),
            )
        })
        .collect();
    for appearance in appearances {
        let (name, inventory_type) = described
            .get(&appearance.item_id)
            .cloned()
            .unwrap_or_default();
        appearance.name = name;
        appearance.inventory_type = inventory_type;
    }
    Ok(())
}

/// The set's appearances as the window reads them, with the shortfall counted.
fn payload(set_id: u32, appearances: Vec<TransmogSetAppearance>) -> Value {
    let named = appearances
        .iter()
        .filter(|appearance| appearance.item_id != 0)
        .count();
    json!({
        "setId": set_id,
        "readCount": named,
        "withheldCount": appearances.len() - named,
        "appearances": appearances,
    })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// The three fixture tables joined, as the window would receive them.
    fn payload() -> Value {
        sets(&fixture_files()).unwrap()
    }

    /// One set opened, as the detail view would receive it.
    fn opened(set_id: u32) -> Value {
        set_items(&fixture_files(), set_id).unwrap()
    }

    /// Fixture files that remember what was asked of them.
    ///
    /// Which of the game's tables a read opens is part of the behaviour: the three past
    /// `TransmogSetItem` are the expensive ones, and a set nothing can be said about is not
    /// worth parsing them for.
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
        fn read(&self, fdid: u32) -> Result<Vec<u8>, String> {
            self.asked.borrow_mut().push(fdid);
            self.files.read(fdid)
        }
    }

    /// The sets out of a payload, still as JSON — which is the shape the window reads, so the
    /// key names are part of what these tests hold still.
    fn read_sets(payload: &Value) -> Vec<Value> {
        payload["sets"].as_array().unwrap().clone()
    }

    fn column(payload: &Value, key: &str) -> Vec<Value> {
        read_sets(payload)
            .into_iter()
            .map(|set| set[key].clone())
            .collect()
    }

    // The join is the whole point of the module: a set's group is a name from one table and
    // its appearance count is a row count from another.
    #[test]
    fn joins_a_set_to_its_collection_and_its_appearances() {
        let payload = payload();
        let sets = read_sets(&payload);
        let tideglass = sets
            .iter()
            .find(|set| set["id"] == 201)
            .expect("the fixture holds set 201");

        assert_eq!(
            tideglass,
            &json!({
                "id": 201,
                "name": "Tideglass Regalia",
                "group": "Tideglass Wardrobe",
                "groupId": 1,
                "classMask": 0x0190,
                "expansionId": 3,
                "parentId": 0,
                "flags": 1,
                "uiOrder": 5,
                "patchIntroduced": 100_200,
                // Three rows of `TransmogSetItem` plus the one the table stores as a copy.
                "itemCount": 4,
            })
        );

        let counts: Vec<(&Value, &Value)> = sets
            .iter()
            .map(|set| (&set["id"], &set["itemCount"]))
            .collect();
        assert_eq!(
            counts,
            vec![
                (&json!(205), &json!(2)),
                (&json!(206), &json!(1)),
                (&json!(203), &json!(4)),
                // The weapon rack: a one-hander, a two-hander, a shield, and one held in
                // the other hand.
                (&json!(204), &json!(4)),
                (&json!(201), &json!(4)),
                (&json!(202), &json!(2)),
            ]
        );
    }

    #[test]
    fn names_every_collection_a_set_belongs_to() {
        assert_eq!(
            column(&payload(), "group"),
            vec![
                json!("Duskwoven Attire"),
                json!("Duskwoven Attire"),
                json!("Emberforge Armory"),
                json!("Emberforge Armory"),
                json!("Tideglass Wardrobe"),
                json!("Tideglass Wardrobe"),
            ]
        );
    }

    // Newest expansion first, then the game's own ordering within a collection — which is the
    // order a player is used to seeing them in.
    #[test]
    fn sorts_by_expansion_then_by_the_order_the_game_gives() {
        let payload = payload();
        let ordered: Vec<(&Value, &Value, &Value)> = payload["sets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|set| (&set["expansionId"], &set["uiOrder"], &set["id"]))
            .collect();
        assert_eq!(
            ordered,
            vec![
                (&json!(5), &json!(15), &json!(205)),
                (&json!(5), &json!(20), &json!(206)),
                (&json!(4), &json!(5), &json!(203)),
                (&json!(4), &json!(10), &json!(204)),
                (&json!(3), &json!(5), &json!(201)),
                (&json!(3), &json!(10), &json!(202)),
            ]
        );
    }

    // An install cannot read the sets Blizzard encrypted, and coming up short silently would
    // look like the game having fewer sets than it has.
    #[test]
    fn reports_the_sets_the_game_keeps_encrypted() {
        let payload = payload();
        assert_eq!(payload["readCount"], 6);
        assert_eq!(payload["declaredCount"], 8);
        assert_eq!(payload["withheldCount"], 2);
        assert!(!column(&payload, "id").contains(&json!(900)));
        assert!(!column(&payload, "name").contains(&json!("Unreleased Alpha")));
    }

    #[test]
    fn says_so_when_a_table_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = sets(&DirFiles::new(temp.path())).unwrap_err();
        assert!(error.contains("1576116.db2"), "{error}");
    }

    /* ---------- opening one set ---------- */

    // Four tables and three joins stand between a set and the items it is made of, and set 203
    // is the one whose appearances land in different slots — so the whole payload is written
    // out here, keys included, because it is the shape the detail view reads.
    #[test]
    fn walks_a_set_down_to_the_items_its_appearances_belong_to() {
        let opened = opened(203);
        assert_eq!(opened["setId"], 203);
        assert_eq!(opened["readCount"], 4);
        assert_eq!(opened["withheldCount"], 0);
        assert_eq!(
            opened["appearances"],
            json!([
                {
                    "modifiedAppearanceId": 71006, "itemId": 30006, "name": "Emberforge Helm",
                    "appearanceId": 80006,
                    "displayType": 0, "inventoryType": 1,
                    "displayInfoId": 900001, "iconFileDataId": 130001,
                    "hasModel": true,
                },
                {
                    "modifiedAppearanceId": 71007, "itemId": 30007, "name": "Emberforge Pauldrons",
                    "appearanceId": 80007,
                    "displayType": 1, "inventoryType": 3,
                    "displayInfoId": 900009, "iconFileDataId": 130002,
                    "hasModel": true,
                },
                {
                    "modifiedAppearanceId": 71008, "itemId": 30008,
                    "name": "Emberforge Breastplate", "appearanceId": 80008,
                    "displayType": 3, "inventoryType": 5,
                    "displayInfoId": 900003, "iconFileDataId": 130003,
                    "hasModel": false,
                },
                {
                    "modifiedAppearanceId": 71009, "itemId": 30009, "name": "Emberforge Greaves",
                    "appearanceId": 80009,
                    "displayType": 5, "inventoryType": 7,
                    "displayInfoId": 900006, "iconFileDataId": 130006,
                    "hasModel": false,
                },
            ])
        );
    }

    // The game stores a set's fourteenth appearance as a copy of its first, and a reader that
    // collapsed the two would open a set showing three rows under a card promising four.
    #[test]
    fn lists_an_appearance_twice_when_the_set_names_it_twice() {
        let opened = opened(201);
        let named: Vec<&Value> = opened["appearances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|appearance| &appearance["modifiedAppearanceId"])
            .collect();
        assert_eq!(
            named,
            vec![&json!(71001), &json!(71001), &json!(71002), &json!(71003)]
        );

        let grid = payload();
        let counted = read_sets(&grid)
            .into_iter()
            .find(|set| set["id"] == 201)
            .expect("the fixture holds set 201");
        assert_eq!(opened["readCount"], counted["itemCount"]);
    }

    // Set 205 names two appearances and the game encrypts the `ItemModifiedAppearance` row of
    // one of them, so nothing about it can be named — not its item, not even the slot it
    // fills. It still gets a row, because a list one short of the count on the card reads as a
    // bug rather than as a withheld appearance.
    #[test]
    fn keeps_a_row_for_an_appearance_a_hop_of_the_chain_withholds() {
        let opened = opened(205);
        assert_eq!(opened["readCount"], 1);
        assert_eq!(opened["withheldCount"], 1);
        assert_eq!(
            opened["appearances"],
            json!([
                // The other one gets as far as its slot and then stops: its display info is
                // encrypted too, so "no model" here is the absence of an answer rather than
                // one. `ItemSparse` encrypts the item itself, so it goes unnamed as well.
                {
                    "modifiedAppearanceId": 71011, "itemId": 30011, "name": "",
                    "appearanceId": 80011,
                    "displayType": 3, "inventoryType": 0,
                    "displayInfoId": 900900, "iconFileDataId": 130008,
                    "hasModel": false,
                },
                {
                    "modifiedAppearanceId": 71012, "itemId": 0, "name": "", "appearanceId": 0,
                    "displayType": 0, "inventoryType": 0, "displayInfoId": 0,
                    "iconFileDataId": 0,
                    "hasModel": false,
                },
            ])
        );
    }

    // `ItemDisplayInfo` gives a display two model slots, and shoulders are drawn from either.
    // Display 900009 fills only the second, so reading the column with `Row::number` rather
    // than `Row::element` would report a shoulder with geometry as flat texture.
    #[test]
    fn finds_a_model_kept_only_in_the_second_slot() {
        let shoulder = opened(203)["appearances"][1].clone();
        assert_eq!(shoulder["displayInfoId"], 900009);
        assert_eq!(shoulder["hasModel"], json!(true));
    }

    // An appearance the table gives no icon still belongs to the set, and zero is the answer
    // rather than a reason to leave it out. Its item is the one `ItemSparse` holds a row for
    // and no name in, which is the other way a row can arrive unnamed.
    #[test]
    fn names_an_appearance_the_table_gives_no_icon() {
        assert_eq!(
            opened(206)["appearances"],
            json!([{
                "modifiedAppearanceId": 71013, "itemId": 30013, "name": "",
                "appearanceId": 80013,
                "displayType": 2, "inventoryType": 4,
                "displayInfoId": 900008, "iconFileDataId": 0,
                "hasModel": false,
            }])
        );
    }

    // The fifth table of the chain, and the reason the reader learned to read records that
    // vary in length: what the game actually calls each of a set's items.
    #[test]
    fn names_the_item_behind_every_appearance() {
        let opened = opened(201);
        let named: Vec<(&Value, &Value)> = opened["appearances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|appearance| (&appearance["itemId"], &appearance["name"]))
            .collect();
        assert_eq!(
            named,
            vec![
                // The set names its first appearance twice, and both rows are named.
                (&json!(30001), &json!("Tideglass Crown")),
                (&json!(30001), &json!("Tideglass Crown")),
                (&json!(30002), &json!("Tideglass Mantle")),
                (&json!(30003), &json!("Tideglass Robe")),
            ]
        );
    }

    // The sixth thing the chain now answers, and the reason the largest table in the game is
    // read for two columns rather than one. Set 204 is the weapon rack: four appearances the
    // game files under three display types, none of which says which hand — and the inventory
    // types beside them, which say a one-hander, a two-hander, a shield and a thing held in
    // the other hand.
    #[test]
    fn says_where_each_weapon_of_a_set_is_worn() {
        let opened = opened(204);
        let worn: Vec<(&Value, &Value, &Value)> = opened["appearances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|appearance| {
                (
                    &appearance["name"],
                    &appearance["displayType"],
                    &appearance["inventoryType"],
                )
            })
            .collect();
        assert_eq!(
            worn,
            vec![
                (&json!("Emberforge Blade"), &json!(11), &json!(13)),
                (&json!("Emberforge Greatsword"), &json!(11), &json!(17)),
                (&json!("Emberforge Aegis"), &json!(13), &json!(14)),
                (&json!("Emberforge Censer"), &json!(15), &json!(23)),
            ]
        );
    }

    // `ItemSparse` is the largest file the app reads by an order of magnitude, and a set the
    // install can say nothing about is not worth opening it for.
    #[test]
    fn does_not_read_the_item_table_for_a_set_it_can_name_nothing_in() {
        let files = Noted::new();
        set_items(&files, 900).unwrap();
        assert!(!files.asked.into_inner().contains(&ITEM_SPARSE));
    }

    // Set 900 belongs to content the game has not shipped, so `TransmogSetItem` says nothing
    // about it and the three tables below it hold nothing worth the parse.
    #[test]
    fn opens_a_set_the_install_cannot_see_into_without_reading_further() {
        let files = Noted::new();
        let opened = set_items(&files, 900).unwrap();
        assert_eq!(
            opened,
            json!({ "setId": 900, "readCount": 0, "withheldCount": 0, "appearances": [] })
        );
        assert_eq!(files.asked.into_inner(), vec![TRANSMOG_SET_ITEM]);
    }

    #[test]
    fn says_so_when_the_chain_starts_at_a_table_that_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = set_items(&DirFiles::new(temp.path()), 201).unwrap_err();
        assert!(error.contains("1376212.db2"), "{error}");
    }
}

