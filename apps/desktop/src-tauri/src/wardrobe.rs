//! Every appearance the game holds for a place on the body, whether or not a set names it.
//!
//! `transmog` reads the game's *sets* — a few thousand wardrobes somebody at Blizzard put
//! together — and a set is the wrong unit for half of what a player wants. Most of the looks
//! in the game belong to no set at all: a world drop, a quest reward, a vendor's tabard. So
//! this reads the other way round, from `ItemAppearance` outward, and answers with every look
//! that fills one kind of place — every head, or everything held in a hand.
//!
//! The chain is the same one `transmog::set_items` walks, entered from the other end:
//! `ItemAppearance` → `ItemModifiedAppearance` → the items, with `ItemSparse` asked what each
//! is called and `ItemDisplayInfo` whether it has geometry. One table more than that chain —
//! `Item`, two megabytes of what-kind-of-thing-it-is — because a *kind* below the armour slots
//! is a question nothing else in the game answers: `DisplayType` files a dagger, a staff and a
//! one-handed axe under 11 alike, and `InventoryType` separates one hand from two and stops.
//!
//! **A row here is a look, not an item**, exactly as a row of an opened set is. The game sells
//! one look through as many items as it likes — 55,198 readable appearances of a 12.0.5.67
//! install are reached by 156,683 items — and the row is named after one of them and says how
//! many there were. Which one is [`named`]'s business.
//!
//! What is *not* here is the whole wardrobe at once. Every appearance the install can read
//! comes to 14 MB of payload, and nothing browses fifty-five thousand rows; the window asks
//! for the display types it is showing and pays about a second for each, which is the same
//! second `transmog::sets` costs and mostly the price of opening the game's storage.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{json, Value};

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::items::{self, ANY_CLASS};
use crate::transmog::{
    appearance_column, display_column, item_column, modified_appearance_column,
    ITEM_APPEARANCE, ITEM_DISPLAY_INFO, ITEM_MODIFIED_APPEARANCE, ITEM_SPARSE, MODEL_SLOTS,
    MODEL_SLOT_BITS,
};

/// One look, as the wardrobe list draws it.
///
/// Everything past the appearance itself is what the item behind it says, and any of it can be
/// missing: the game encrypts the items of content it has not shipped, and such an item is a
/// row with an id and nothing else. That is worth keeping — the appearance is real, the slot
/// it fills is readable, and the window falls back to the id — but it is not worth pretending
/// about, so a zero here means the game said nothing rather than that it said zero.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WardrobeAppearance {
    pub appearance_id: u32,
    /// The item the row is named after, out of however many give the look.
    pub item_id: u32,
    pub name: String,
    /// Which slot the appearance fills, as `ItemAppearance` numbers them.
    pub display_type: u32,
    /// Where the item is worn, which for a weapon is what says which hand holds it.
    pub inventory_type: u32,
    /// What kind of thing the item is: [`items::ARMOR`], [`items::WEAPON`], or another.
    pub class_id: u32,
    /// Which kind of that kind — the axe, the staff, the dagger. What the kinds are called is
    /// the window's business, here as everywhere else.
    pub subclass_id: u32,
    pub allowable_class: u32,
    pub required_level: u32,
    pub quality: u32,
    pub display_info_id: u32,
    pub icon_file_data_id: u32,
    pub has_model: bool,
    /// How many items of the game give this look, the one it is named after included.
    pub item_count: u32,
    /// True when a class-locked item and an unrestricted one both give it, which means a
    /// reader locked out by their class is not locked out of the look.
    pub lifts_restriction: bool,
}

/// What one row of the two item tables says, gathered before a row is named.
#[derive(Debug, Clone, Default)]
struct ItemFacts {
    name: String,
    inventory_type: u32,
    allowable_class: u32,
    required_level: u32,
    quality: u32,
    class_id: u32,
    subclass_id: u32,
}

/// Every appearance filling one of `display_types`, named by an item and sorted for reading.
///
/// The display types are the window's choice rather than this module's, and they come in as a
/// list because the kinds a reader picks between do not divide the way the table does: every
/// armour slot is one display type, and everything held in a hand is five of them — a sword
/// and a two-hander are both 11, a shield is 13, a bow is 12 and a tome 15. Asking for the
/// five at once is what lets the window offer "Staff" and "Shield" as neighbours and filter
/// one payload rather than fetching per weapon.
///
/// The order is by name, because the list is browsed and searched by name and nothing else the
/// game says about an appearance orders a wardrobe usefully. The rows the game will not name
/// go last, where an unreadable id is not in anybody's way.
#[tracing::instrument(name = "wardrobe.appearances", skip_all, fields(kinds = display_types.len()))]
pub fn appearances(files: &dyn GameFiles, display_types: &[u32]) -> Result<Value, String> {
    let wanted: HashSet<u32> = display_types.iter().copied().collect();
    if wanted.is_empty() {
        return Ok(payload(display_types, Vec::new(), 0));
    }

    // Which looks fill those places. The whole table is parsed — it is eight milliseconds —
    // and only the appearances of the kinds asked for are kept.
    let table = Db2::parse(files.read(ITEM_APPEARANCE)?)?;
    let looks: HashMap<u32, (u32, u32, u32)> = table
        .rows()
        .filter(|row| wanted.contains(&row.number(appearance_column::DISPLAY_TYPE)))
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
    if looks.is_empty() {
        return Ok(payload(display_types, Vec::new(), 0));
    }

    // And which items reach each of them, which is the hop that makes a row a look rather
    // than an item: half the appearances in the game are sold by more than one item.
    let modified = Db2::parse(files.read(ITEM_MODIFIED_APPEARANCE)?)?;
    let mut items_of: HashMap<u32, Vec<u32>> = HashMap::new();
    for row in modified.rows() {
        let appearance_id = row.number(modified_appearance_column::APPEARANCE_ID);
        let item_id = row.number(modified_appearance_column::ITEM_ID);
        if item_id == 0 || !looks.contains_key(&appearance_id) {
            continue;
        }
        let reached = items_of.entry(appearance_id).or_default();
        // The game stores one item's row twice where it sold the same look at two
        // difficulties, and a look counted twice for one item is a count nobody can act on.
        if !reached.contains(&item_id) {
            reached.push(item_id);
        }
    }

    let facts = describe(files, &items_of)?;

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

    let mut found: Vec<WardrobeAppearance> = Vec::new();
    let mut withheld = 0usize;
    for (appearance_id, (display_type, display_info_id, icon_file_data_id)) in looks {
        // An appearance no item of this install reaches is one the game says nothing about at
        // all — no name, no kind, no place. A set keeps such a row because its own count
        // promised it; a catalogue promised nothing, so this is counted and left out.
        let Some(reached) = items_of.get(&appearance_id) else {
            withheld += 1;
            continue;
        };
        let item_id = named(reached, &facts);
        let about = facts.get(&item_id).cloned().unwrap_or_default();
        found.push(WardrobeAppearance {
            appearance_id,
            item_id,
            name: about.name,
            display_type,
            inventory_type: about.inventory_type,
            class_id: about.class_id,
            subclass_id: about.subclass_id,
            allowable_class: about.allowable_class,
            required_level: about.required_level,
            quality: about.quality,
            display_info_id,
            icon_file_data_id,
            has_model: has_model.get(&display_info_id).copied().unwrap_or(false),
            item_count: reached.len() as u32,
            lifts_restriction: lifts_restriction(reached, &facts),
        });
    }

    found.sort_by(|left, right| {
        left.name
            .is_empty()
            .cmp(&right.name.is_empty())
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then(left.item_id.cmp(&right.item_id))
            .then(left.appearance_id.cmp(&right.appearance_id))
    });
    Ok(payload(display_types, found, withheld))
}

/// Which of the items that give a look the row is named after.
///
/// **Whatever anybody can wear, as cheaply as possible.** The reader looking at a wardrobe
/// list is asking whether they can have the look at all, so an item no class is locked out of
/// beats one that is, and the lowest level it can be worn at beats the raid version of the
/// same thing. The id breaks the last tie, and is the oldest item — the one the look was sold
/// as first rather than whatever was hung off it later.
///
/// This is the same order [`crate::transmog`]'s detail rows sort their sources by, and
/// deliberately: a look a reader met inside a set and meets again in the list of every head in
/// the game should be the same words both times. What it is *not* is the set view's rule for
/// picking a name, which weighs the item's name against the set's — there being no set here.
fn named(reached: &[u32], facts: &HashMap<u32, ItemFacts>) -> u32 {
    let key = |item_id: &&u32| {
        let item_id = **item_id;
        let about = facts.get(&item_id);
        (
            // An item the game withholds says nothing about who may wear it, and reads as
            // locked to nobody; it sorts behind anything this install can actually describe.
            about.is_none_or(|facts| facts.name.is_empty()),
            about.is_none_or(|facts| facts.allowable_class != ANY_CLASS),
            about.map_or(u32::MAX, |facts| facts.required_level),
            item_id,
        )
    };
    reached.iter().min_by_key(key).copied().unwrap_or(0)
}

/// Whether a class-locked item and an unrestricted one both give this look.
fn lifts_restriction(reached: &[u32], facts: &HashMap<u32, ItemFacts>) -> bool {
    let open = |item_id: &u32| {
        facts
            .get(item_id)
            .is_some_and(|about| about.allowable_class == ANY_CLASS)
    };
    let locked = |item_id: &u32| {
        facts.get(item_id).is_some_and(|about| {
            about.allowable_class != ANY_CLASS && about.allowable_class != 0
        })
    };
    reached.iter().any(open) && reached.iter().any(locked)
}

/// What the game says about every item that reaches one of these appearances.
///
/// Two tables, in the order that costs least. `Item` is two megabytes and is read for the one
/// thing only it holds — what kind of thing an item is — and `ItemSparse` is sixty-three and
/// holds everything else a row draws. Both are walked once, and only the rows an appearance
/// here is reached by are kept: an install's `ItemSparse` describes two hundred thousand
/// items and one kind of place is filled by a few thousand of them.
fn describe(
    files: &dyn GameFiles,
    items_of: &HashMap<u32, Vec<u32>>,
) -> Result<HashMap<u32, ItemFacts>, String> {
    let wanted: HashSet<u32> = items_of.values().flatten().copied().collect();
    if wanted.is_empty() {
        return Ok(HashMap::new());
    }

    let kinds = Db2::parse(files.read(items::ITEM)?)?;
    let mut facts: HashMap<u32, ItemFacts> = kinds
        .rows()
        .filter(|row| wanted.contains(&row.id()))
        .map(|row| {
            (
                row.id(),
                ItemFacts {
                    class_id: row.number(items::column::CLASS),
                    subclass_id: row.number(items::column::SUBCLASS),
                    ..ItemFacts::default()
                },
            )
        })
        .collect();

    let sparse = Db2::parse_with_text_columns(files.read(ITEM_SPARSE)?, &item_column::TEXT)?;
    for row in sparse.rows() {
        if !wanted.contains(&row.id()) {
            continue;
        }
        // An item `Item` withholds and `ItemSparse` names is still worth its row — the name is
        // the half a reader recognises — so the entry is made here where it is missing.
        let about = facts.entry(row.id()).or_default();
        about.name = row.text(item_column::NAME);
        about.inventory_type = row.number(item_column::INVENTORY_TYPE);
        about.allowable_class = row.number(item_column::ALLOWABLE_CLASS);
        about.required_level = row.number(item_column::REQUIRED_LEVEL);
        about.quality = row.number(item_column::QUALITY);
    }
    Ok(facts)
}

/// The rows as the window reads them, with what could not be read counted beside them.
fn payload(display_types: &[u32], found: Vec<WardrobeAppearance>, withheld: usize) -> Value {
    json!({
        "displayTypes": display_types,
        "readCount": found.len(),
        "withheldCount": withheld,
        "appearances": found,
    })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// Every head the fixture install holds, as the window would receive it.
    fn read(display_types: &[u32]) -> Value {
        appearances(&fixture_files(), display_types).unwrap()
    }

    fn rows(payload: &Value) -> Vec<Value> {
        payload["appearances"].as_array().unwrap().clone()
    }

    fn names(payload: &Value) -> Vec<String> {
        rows(payload)
            .iter()
            .map(|row| row["name"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    /// Fixture files that remember which of the game's tables were opened.
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

    // The whole point of the module: every head in the game, whether or not a set names it,
    // named by an item and sorted the way a list is read. The fixture's heads come out of
    // four different sets and one of them is sold three times over.
    #[test]
    fn answers_with_every_appearance_filling_one_place() {
        let payload = read(&[0]);
        assert_eq!(payload["displayTypes"], json!([0]));
        assert_eq!(
            names(&payload),
            vec![
                "Emberforge Helm",
                // The look three items sell, named after the one anybody can wear at the
                // lowest level of the three rather than after the set's own Warrior piece.
                "Helm of the Tempest",
                "Stormbreaker's Helm",
                "Tideglass Crown",
            ]
        );
    }

    // A row is a look and says how many items give it, which is what a card of a set cannot:
    // set 207 sells one head three ways, and the three are one row here.
    #[test]
    fn counts_the_items_behind_one_look() {
        let counted: Vec<Value> = rows(&read(&[0]))
            .iter()
            .map(|row| json!([row["name"], row["itemCount"], row["liftsRestriction"]]))
            .collect();
        assert_eq!(
            counted,
            vec![
                json!(["Emberforge Helm", 1, false]),
                // Three items, one of them Warrior-only and two open to anybody — which is
                // the one fact about a look that no amount of scrolling would show.
                json!(["Helm of the Tempest", 3, true]),
                json!(["Stormbreaker's Helm", 1, false]),
                json!(["Tideglass Crown", 1, false]),
            ]
        );
    }

    // The whole row, keys included, because this is the shape the window reads. The head of
    // set 203 is the ordinary case: one item, one look, a model of its own.
    #[test]
    fn says_everything_the_window_draws_a_row_from() {
        let helm = rows(&read(&[0]))
            .into_iter()
            .find(|row| row["name"] == "Emberforge Helm")
            .expect("the fixture holds it");
        assert_eq!(
            helm,
            json!({
                "appearanceId": 80006,
                "itemId": 30006,
                "name": "Emberforge Helm",
                "displayType": 0,
                "inventoryType": 1,
                "classId": 4,
                "subclassId": 4,
                "allowableClass": 0xffff,
                "requiredLevel": 0,
                "quality": 4,
                "displayInfoId": 900001,
                "iconFileDataId": 130001,
                "hasModel": true,
                "itemCount": 1,
                "liftsRestriction": false,
            })
        );
    }

    // The reason `Item` is read at all. Every weapon and shield arrives in one answer,
    // because that is how a reader picks between them, and the subclass is the only thing in
    // the game's files that says a one-handed sword from a two-handed one — the display type
    // files both under 11 and the inventory type says only how many hands it takes.
    #[test]
    fn says_which_kind_of_weapon_each_look_is() {
        let payload = read(&[11, 12, 13, 14, 15]);
        let kinds: Vec<Value> = rows(&payload)
            .iter()
            .map(|row| {
                json!([
                    row["name"],
                    row["classId"],
                    row["subclassId"],
                    row["inventoryType"]
                ])
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                // A shield and a thing held in the other hand are not weapons at all in the
                // game's own filing: both are armour, and only the subclass separates them.
                json!(["Emberforge Aegis", 4, 6, 14]),
                json!(["Emberforge Blade", 2, 7, 13]),
                json!(["Emberforge Censer", 4, 0, 23]),
                json!(["Emberforge Greatsword", 2, 8, 17]),
            ]
        );
    }

    // Sorted by name, so that a list of several thousand can be scrolled at all — and the
    // rows the game will not name go last rather than sitting at the top under an id.
    #[test]
    fn sorts_by_name_and_leaves_the_unnamed_until_last() {
        let payload = read(&[0, 2, 3]);
        let named = names(&payload);
        let unnamed = named.iter().filter(|name| name.is_empty()).count();
        // One item the table holds a row for and no name in, and one whose row is encrypted.
        assert_eq!(unnamed, 2, "the fixture holds two looks it cannot name");
        assert_eq!(named.last(), Some(&String::new()));
        let mut sorted: Vec<String> = named
            .iter()
            .filter(|name| !name.is_empty())
            .map(|name| name.to_lowercase())
            .collect();
        let was = sorted.clone();
        sorted.sort();
        assert_eq!(was, sorted);
    }

    // An appearance nothing this install can read reaches is one nothing can be said about —
    // not its item, not its kind. A set keeps such a row because the count on its card
    // promised it; a catalogue promised nothing, so it is counted and left out.
    #[test]
    fn counts_the_appearances_it_can_reach_no_item_of() {
        // Appearance 80021 is a head whose only `ItemModifiedAppearance` row the game
        // encrypts, which is the one hop of the chain that can lose a look outright.
        let payload = read(&[0]);
        assert_eq!(payload["withheldCount"], 1);
        assert_eq!(payload["readCount"], rows(&payload).len());
        let ids: Vec<u64> = rows(&payload)
            .iter()
            .map(|row| row["appearanceId"].as_u64().unwrap())
            .collect();
        assert!(!ids.contains(&80021), "{ids:?}");
    }

    // The other way a row arrives with nothing on it, and the one that keeps its place: the
    // appearance is readable, an item reaches it, and that item is in a section this install
    // holds no key to. The look is real and fills a chest, so the row stays and says the id.
    #[test]
    fn keeps_a_look_whose_item_this_install_cannot_read() {
        let withheld = rows(&read(&[3]))
            .into_iter()
            .find(|row| row["appearanceId"] == 80011)
            .expect("the fixture holds it");
        assert_eq!(withheld["itemId"], 30011);
        assert_eq!(withheld["name"], "");
        // No kind, no place, and no pretending otherwise.
        assert_eq!(withheld["classId"], 0);
        assert_eq!(withheld["inventoryType"], 0);
    }

    // An item the big table holds a row for and no name in still gets its row: the
    // appearance is real, the place it fills is readable, and the window falls back to the id.
    #[test]
    fn keeps_a_look_whose_item_the_game_never_named() {
        let shirt = rows(&read(&[2]));
        assert_eq!(shirt.len(), 1);
        assert_eq!(shirt[0]["name"], "");
        assert_eq!(shirt[0]["itemId"], 30013);
        assert_eq!(shirt[0]["iconFileDataId"], 0);
    }

    // Nothing is read for a kind that does not exist, and the tables behind this are the
    // expensive ones — `ItemSparse` alone is sixty-three megabytes on a shipping install.
    #[test]
    fn opens_nothing_beyond_the_first_table_for_a_kind_the_game_has_none_of() {
        let files = Noted::new();
        let payload = appearances(&files, &[30]).unwrap();
        assert_eq!(payload["readCount"], 0);
        assert_eq!(payload["appearances"], json!([]));
        assert_eq!(files.asked.into_inner(), vec![ITEM_APPEARANCE]);
    }

    #[test]
    fn reads_nothing_at_all_when_asked_for_no_kinds() {
        let files = Noted::new();
        let payload = appearances(&files, &[]).unwrap();
        assert_eq!(payload["readCount"], 0);
        assert!(files.asked.into_inner().is_empty());
    }

    #[test]
    fn says_so_when_a_table_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = appearances(&DirFiles::new(temp.path()), &[0]).unwrap_err();
        assert!(error.contains("982462.db2"), "{error}");
    }
}
