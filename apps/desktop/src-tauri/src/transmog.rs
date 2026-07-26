//! The transmog sets the game knows about, and what each one is made of.
//!
//! Three of the client's tables describe the sets: `TransmogSet` is the sets themselves,
//! `TransmogSetGroup` names the collections a set can belong to, and `TransmogSetItem` lists
//! the appearances that make one up. [`sets`] reads those three and flattens them into one
//! list for the window.
//!
//! Opening a set goes four hops further — `TransmogSetItem` → `ItemModifiedAppearance` →
//! `ItemAppearance` → `ItemDisplayInfo` — which is what [`set_items`] walks. That chain is
//! written down in `docs/game-files.md`, verified against a real install.
//!
//! The column numbers below are the layout the game has used since patch 12.0.0, and they
//! are the one thing here that a game patch can invalidate. They come from the community's
//! table definitions rather than from guesswork, and a build that reorders them will show
//! wrong values rather than fail, so [`sets`] checks the row count it ends up with against
//! the count the file declares.

use std::collections::HashMap;

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
const ITEM_DISPLAY_INFO: u32 = 1266429;

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

/// Columns of `ItemDisplayInfo`.
mod display_column {
    /// A fixed-size array of two, not a scalar. Shoulders keep a model in each slot, and a
    /// reader that stops at the first element reports half of them as having no geometry.
    pub const MODEL_RESOURCES_ID: usize = 10;
}

/// How many model slots `ModelResourcesID` holds, and how wide one of them is. The file
/// records only the column's total width, so the caller supplies the element size.
const MODEL_SLOTS: usize = 2;
const MODEL_SLOT_BITS: u32 = 32;

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
    pub appearance_id: u32,
    /// Which slot the appearance fills, as `ItemAppearance` numbers them: 0 head,
    /// 1 shoulder, 2 through 10 the rest of the armour, 11 upward weapons and shields.
    pub display_type: u32,
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
                appearance_id,
                display_type,
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
    Ok(payload(set_id, found))
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
    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// The three fixture tables joined, as the window would receive them.
    fn payload() -> Value {
        sets(&fixture_files()).unwrap()
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
                (&json!(204), &json!(1)),
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
}

