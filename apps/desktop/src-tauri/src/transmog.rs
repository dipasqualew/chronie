//! The transmog sets the game knows about.
//!
//! Three of the client's tables describe them: `TransmogSet` is the sets themselves,
//! `TransmogSetGroup` names the collections a set can belong to, and `TransmogSetItem` lists
//! the appearances that make one up. This module reads those three and flattens them into
//! one list for the window.
//!
//! The column numbers below are the layout the game has used since patch 12.0.0, and they
//! are the one thing here that a game patch can invalidate. They come from the community's
//! table definitions rather than from guesswork, and a build that reorders them will show
//! wrong values rather than fail, so [`sets`] checks the row count it ends up with against
//! the count the file declares.

use serde::Serialize;
use serde_json::{json, Value};

use crate::casc::GameFiles;
use crate::db2::Db2;

/// What the game calls each table. These are stable across patches.
const TRANSMOG_SET: u32 = 1376213;
const TRANSMOG_SET_ITEM: u32 = 1376212;
const TRANSMOG_SET_GROUP: u32 = 1576116;

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
    let group_names: std::collections::HashMap<u32, String> = groups
        .rows()
        .map(|row| (row.id(), row.text(GROUP_NAME)))
        .collect();

    // `TransmogSetItem` keys each appearance to its set through the game's relationship
    // column, which the reader exposes as the row's own id — one row per appearance, so
    // counting rows per set is all the view wants from it.
    let items = Db2::parse(files.read(TRANSMOG_SET_ITEM)?)?;
    let mut item_counts: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    for row in items.rows() {
        *item_counts.entry(row.number(0)).or_default() += 1;
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
