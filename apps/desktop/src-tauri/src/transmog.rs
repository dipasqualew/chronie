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

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use serde_json::{json, Value};

use crate::casc::GameFiles;
use crate::db2::Db2;

/// What the game calls each table. These are stable across patches.
const TRANSMOG_SET: u32 = 1376213;
const TRANSMOG_SET_ITEM: u32 = 1376212;
const TRANSMOG_SET_GROUP: u32 = 1576116;
/// Shared with `wardrobe`, which walks the same two hops from the other end: this module
/// asks what a named set is made of, that one asks what fills a place on the body.
pub const ITEM_MODIFIED_APPEARANCE: u32 = 982457;
pub const ITEM_APPEARANCE: u32 = 982462;
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
pub mod modified_appearance_column {
    pub const ITEM_ID: usize = 1;
    pub const APPEARANCE_ID: usize = 3;
}

/// Columns of `ItemAppearance`.
pub mod appearance_column {
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
    /// A bit per class, or [`crate::items::ANY_CLASS`] for anybody — which is what nearly
    /// every item carries.
    ///
    /// Read off the same install as the three below it, by `examples/dump_item_facts`. This
    /// is the column that says an appearance a class set locks away is also sold to everyone
    /// by something else, which happens to 30.8% of the appearances in the game that more
    /// than one item reaches.
    pub const ALLOWABLE_CLASS: usize = 52;
    /// The level a character has to have reached to equip it. Zero for most things.
    pub const REQUIRED_LEVEL: usize = 65;
    /// The colour the game writes the name in: 0 poor, 2 uncommon, 4 epic, 5 legendary.
    pub const QUALITY: usize = 67;
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

/// Why two sets that look identical are two sets at all.
///
/// Read off the sets themselves rather than guessed. Of the 329 clusters a shipping install
/// holds, 78 are the two factions buying one wardrobe under two names, 61 are one look sold to
/// several classes, and 180 are a season's set reissued under a new name a patch later.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SameLook {
    /// Flag bits 2 and 3, which the game sets on one set of a pair and never on both: 435
    /// sets carry one and 438 the other across the whole table.
    Faction,
    /// The same armour drawn for several classes, which the game files as several sets.
    Class,
    /// The same look released again, usually a season later and usually renamed.
    Reissue,
}

/// A set that is another set's look, named so the one shown can say who else wears it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Alternate {
    pub id: u32,
    pub name: String,
    pub group: String,
    pub class_mask: u32,
    pub expansion_id: u32,
    pub patch_introduced: u32,
    /// What makes it a separate set despite being the same clothes.
    pub reason: SameLook,
}

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
    /// The other sets holding exactly this set's appearances, where this is the one shown.
    ///
    /// Empty for all but 329 of the game's sets, and left out of the payload when it is.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub alternates: Vec<Alternate>,
    /// The set this one is shown under, when it is not the one shown. Zero otherwise.
    ///
    /// 436 sets of a shipping install carry one. They are still in the payload — the counts
    /// are about what the game holds, not about what is drawn — and the window leaves them
    /// out of the grid while still searching their names.
    #[serde(skip_serializing_if = "is_zero")]
    pub same_look_as: u32,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
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
    // counting rows per set is all the grid wants from it. What each row *reaches* is the
    // other thing, and it is what says two sets are the same clothes: see [`same_looks`].
    let items = Db2::parse(files.read(TRANSMOG_SET_ITEM)?)?;
    let mut item_counts: HashMap<u32, u32> = HashMap::new();
    let mut named_by_set: HashMap<u32, Vec<u32>> = HashMap::new();
    for row in items.rows() {
        let set_id = row.number(set_item_column::SET_ID);
        *item_counts.entry(set_id).or_default() += 1;
        named_by_set
            .entry(set_id)
            .or_default()
            .push(row.number(set_item_column::MODIFIED_APPEARANCE_ID));
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
                alternates: Vec::new(),
                same_look_as: 0,
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

    same_looks(files, &named_by_set, &mut sets)?;

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

/// The two flag bits that say which faction a set was sold to.
///
/// Read off a shipping install: 435 sets carry bit 2, 438 carry bit 3, and **not one carries
/// both** — which is what makes a pair of sets differing only in these two a faction pair
/// rather than a coincidence.
const FACTION_FLAGS: u32 = 0b1100;

/// Marks the sets that are another set's clothes, and says which set that is.
///
/// **Exactly identical, and nothing looser.** A shipping install holds 4,727 sets with
/// readable contents and 4,291 distinct looks between them, folded into 329 clusters that
/// account for 765 sets. What justifies exact matching is the shape of what is left over: of
/// every pair of sets sharing any appearance at all, 610 are identical and only **four** land
/// between nine tenths and identical, thirty above three quarters, thirteen above a half.
/// There is no fuzzy middle to model, so there is no threshold anybody would have to defend —
/// and a threshold, once introduced, eventually swallows two sets that are genuinely different.
///
/// The look is the set of `ItemAppearance` ids the set names, which is the game's own unit of
/// collection. Reaching them costs one more table than the grid already reads —
/// `ItemModifiedAppearance`, eleven milliseconds against the six hundred that opening the
/// game's storage costs — and grouping on the appearances rather than on the items is what
/// catches the 323 clusters that use different items to sell the same clothes.
///
/// The set shown is the earliest: the lowest patch that says anything, then the game's own
/// ordering, then the id. A season's set is shown as the season it came out in, with its
/// reissues folded under it.
///
/// A set whose appearances this install cannot read at all is left alone. Two of those would
/// share an empty look, and "these encrypted sets are the same encrypted set" is not something
/// anybody can know.
fn same_looks(
    files: &dyn GameFiles,
    named_by_set: &HashMap<u32, Vec<u32>>,
    sets: &mut [TransmogSet],
) -> Result<(), String> {
    let modified = Db2::parse(files.read(ITEM_MODIFIED_APPEARANCE)?)?;
    let appearance_of: HashMap<u32, u32> = modified
        .rows()
        .map(|row| {
            (
                row.id(),
                row.number(modified_appearance_column::APPEARANCE_ID),
            )
        })
        .collect();

    let mut by_look: HashMap<Vec<u32>, Vec<u32>> = HashMap::new();
    for set in sets.iter() {
        let mut look: Vec<u32> = named_by_set
            .get(&set.id)
            .into_iter()
            .flatten()
            .filter_map(|named| appearance_of.get(named).copied())
            .filter(|appearance| *appearance != 0)
            .collect();
        if look.is_empty() {
            continue;
        }
        look.sort_unstable();
        look.dedup();
        by_look.entry(look).or_default().push(set.id);
    }

    // Which set is shown, and which are folded under it, keyed so the walk below is a lookup
    // rather than a second search. The sets are already in the order the grid draws them,
    // which is not the order that decides this, so the choice is made on the facts.
    let facts: HashMap<u32, &TransmogSet> = sets.iter().map(|set| (set.id, set)).collect();
    let mut shown_by_folded: HashMap<u32, u32> = HashMap::new();
    let mut folded_by_shown: HashMap<u32, Vec<u32>> = HashMap::new();
    for ids in by_look.into_values() {
        if ids.len() < 2 {
            continue;
        }
        let Some(shown) = ids.iter().copied().min_by_key(|id| {
            let set = facts[id];
            // A patch of zero is the table declining to say rather than the dawn of time,
            // so it sorts last and lets the ordering and the id decide.
            let patch = if set.patch_introduced == 0 {
                u32::MAX
            } else {
                set.patch_introduced
            };
            (patch, set.ui_order, *id)
        }) else {
            continue;
        };
        for id in ids {
            if id == shown {
                continue;
            }
            shown_by_folded.insert(id, shown);
            folded_by_shown.entry(shown).or_default().push(id);
        }
    }

    let alternates: HashMap<u32, Vec<Alternate>> = folded_by_shown
        .into_iter()
        .map(|(shown, mut folded)| {
            let under = facts[&shown];
            folded.sort_unstable_by_key(|id| {
                let set = facts[id];
                (set.expansion_id, set.ui_order, *id)
            });
            let named = folded
                .into_iter()
                .map(|id| {
                    let set = facts[&id];
                    Alternate {
                        id,
                        name: set.name.clone(),
                        group: set.group.clone(),
                        class_mask: set.class_mask,
                        expansion_id: set.expansion_id,
                        patch_introduced: set.patch_introduced,
                        reason: why(under, set),
                    }
                })
                .collect();
            (shown, named)
        })
        .collect();

    for set in sets.iter_mut() {
        set.same_look_as = shown_by_folded.get(&set.id).copied().unwrap_or(0);
        set.alternates = alternates.get(&set.id).cloned().unwrap_or_default();
    }
    Ok(())
}

/// What makes two sets of identical clothes two sets, read off the sets themselves.
///
/// The order matters: a faction pair is usually also a pair of separate names, and a class
/// variant usually also sits in a different collection, so the most specific answer the two
/// sets can support is the one worth giving.
fn why(shown: &TransmogSet, folded: &TransmogSet) -> SameLook {
    let factions = (shown.flags & FACTION_FLAGS, folded.flags & FACTION_FLAGS);
    if factions.0 != factions.1 && factions.0 != 0 && factions.1 != 0 {
        SameLook::Faction
    } else if shown.class_mask != folded.class_mask {
        SameLook::Class
    } else {
        SameLook::Reissue
    }
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
    /// Who may wear the item, as a bit per class, or [`crate::items::ANY_CLASS`] for anybody.
    ///
    /// This and the two below it are not facts about the appearance — they are facts about
    /// the *item*, and they are here because several items reach one appearance and this is
    /// what tells them apart. A set sells one look through a class-locked piece, an
    /// unrestricted one and a cheaper one, and without these three the rows are the same
    /// sentence written out five times. Zero where the game withholds the item.
    pub allowable_class: u32,
    /// The level a character has to have reached to equip it. Zero is the ordinary answer.
    pub required_level: u32,
    /// The colour the game writes the name in: 0 poor, 2 uncommon, 4 epic, 5 legendary.
    pub quality: u32,
    pub display_info_id: u32,
    /// The icon the game shows for it, as a FileDataID, or zero when it names none.
    pub icon_file_data_id: u32,
    /// Whether the appearance has geometry of its own. Only heads, shoulders, weapons and
    /// shields do; the rest of a set is texture painted onto the character's body.
    pub has_model: bool,
}

/// Which looks every set in the game holds, out of one walk of each of the two tables.
///
/// [`set_items`] answers the same question about *one* set and answers far more about it — the
/// items behind each look, what they are called, who may wear them — at the cost of walking five
/// of the game's tables. Asked about all four thousand sets in turn, that is twenty thousand
/// walks of tables with hundreds of thousands of rows in them, which is the shape of read this
/// app avoids everywhere else and cannot afford here either.
///
/// So this is the narrow question on its own: set id to appearance ids, nothing else. Sorted and
/// deduplicated, because the one caller — `examples/dump_qualities` — is writing a file that has
/// to be the same bytes twice, and because a set naming one look through two difficulties is one
/// look as far as what the set is *like* is concerned.
pub fn set_appearances(files: &dyn GameFiles) -> Result<BTreeMap<u32, Vec<u32>>, String> {
    let modified = Db2::parse(files.read(ITEM_MODIFIED_APPEARANCE)?)?;
    let appearance_of: HashMap<u32, u32> = modified
        .rows()
        .map(|row| {
            (
                row.id(),
                row.number(modified_appearance_column::APPEARANCE_ID),
            )
        })
        .collect();

    let items = Db2::parse(files.read(TRANSMOG_SET_ITEM)?)?;
    let mut held: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for row in items.rows() {
        let modified_appearance_id = row.number(set_item_column::MODIFIED_APPEARANCE_ID);
        // A set whose rows point at modified appearances this install cannot decrypt keeps its
        // place with however many of them it can reach, which may be none.
        let looks = held.entry(row.number(set_item_column::SET_ID)).or_default();
        if let Some(appearance_id) = appearance_of.get(&modified_appearance_id) {
            looks.push(*appearance_id);
        }
    }
    for looks in held.values_mut() {
        looks.sort_unstable();
        looks.dedup();
    }
    Ok(held)
}

/// What several sets are wearing, as the three numbers a body is dressed from.
///
/// The narrow question, for the caller who has to ask it about many sets at once:
/// [`crate::gallery::sets`], which draws a page of the grid as characters. [`set_items`] answers
/// this and much more about *one* set — asked about a page of a dozen, that is sixty walks of
/// tables with hundreds of thousands of rows in them to keep a hundred rows, which is the shape
/// of read this app avoids everywhere else.
///
/// So `TransmogSetItem` is walked once for the whole page and [`appearances_of`] follows every
/// row of it down the same four tables in one go. That the chain is shared rather than written
/// again here is the point: what an appearance *is* has one answer, and this adds only the two
/// rules a picture of a set needs, both of which the window would otherwise have applied itself.
///
/// - **A row with nowhere to go is dropped.** Armour always has a place; a thing the game files
///   under a weapon slot has one only when its item says which hand — see [`crate::worn::held_in`],
///   which is the same reading `modelPreview.wearable` does in the window. An arrow contributes
///   nothing to a picture of a set, and neither does an appearance whose display the game keeps
///   encrypted.
/// - **A piece named twice is worn once.** A set sells one look through several items and the
///   game stores a row per item, so a set of 126 items is a dozen pieces of clothing. Wearing the
///   robe three times is the same body and three times the texture work.
pub fn set_pieces(
    files: &dyn GameFiles,
    set_ids: &[u32],
) -> Result<BTreeMap<u32, Vec<crate::worn::Piece>>, String> {
    let mut found: BTreeMap<u32, Vec<crate::worn::Piece>> =
        set_ids.iter().map(|id| (*id, Vec::new())).collect();
    if found.is_empty() {
        return Ok(found);
    }

    let wanted: HashSet<u32> = set_ids.iter().copied().collect();
    let items = Db2::parse(files.read(TRANSMOG_SET_ITEM)?)?;
    // Which set each row belongs to, in the order the table lists them. What order the pieces
    // are laid in is `worn::each`'s and nothing here needs to know it.
    let named: Vec<(u32, u32)> = items
        .rows()
        .filter(|row| wanted.contains(&row.number(set_item_column::SET_ID)))
        .map(|row| {
            (
                row.number(set_item_column::SET_ID),
                row.number(set_item_column::MODIFIED_APPEARANCE_ID),
            )
        })
        .collect();
    drop(items);

    let ids: Vec<u32> = named.iter().map(|(_, id)| *id).collect();
    // One row out per row in, in order — which is what lets the two lists be zipped back
    // together. A row the install can say nothing about comes back zeroed and is dropped below.
    for ((set_id, _), appearance) in named.iter().zip(appearances_of(files, &ids)?) {
        if appearance.display_info_id == 0 {
            continue;
        }
        // The one reading of "is there anywhere on her for this" there is: armour always has a
        // place, and something carried has one when the item says which hand.
        if crate::worn::held(appearance.display_type)
            && crate::worn::held_in(appearance.inventory_type).is_none()
        {
            continue;
        }
        let piece = crate::worn::Piece {
            display_info_id: appearance.display_info_id,
            display_type: appearance.display_type,
            inventory_type: appearance.inventory_type,
        };
        let Some(wearing) = found.get_mut(set_id) else {
            continue;
        };
        if !wearing.contains(&piece) {
            wearing.push(piece);
        }
    }
    Ok(found)
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

    let mut found = appearances_of(files, &wanted)?;

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

/// What a list of appearances is, walked out of the game's own tables.
///
/// One row out per id in, **in the order they were asked for**, including an id the game says
/// nothing about — which comes back named after nothing and zeroed, the way a withheld row of a
/// Blizzard set does. Keeping the order is what makes this usable by a caller that already knows
/// what order it wants: a Blizzard set sorts by slot afterwards, and a set the player saved in
/// game arrives in slot order already and would be spoiled by being sorted again.
///
/// Split out of [`set_items`] rather than written twice because the two callers differ only in
/// where the list of ids comes from. A Blizzard set names its appearances in `TransmogSetItem`;
/// a set the player saved in game names them through the addon, in `ItemTransmogInfo`. From here
/// down they are the same numbers and deserve the same four table walks.
#[tracing::instrument(name = "transmog.appearances_of", skip_all, fields(wanted = wanted.len()))]
pub fn appearances_of(
    files: &dyn GameFiles,
    wanted: &[u32],
) -> Result<Vec<TransmogSetAppearance>, String> {
    // Nothing further needs reading for a set this install cannot see into, and the tables
    // below are the expensive ones.
    if wanted.is_empty() {
        return Ok(Vec::new());
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
        .iter()
        .copied()
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
                allowable_class: 0,
                required_level: 0,
                quality: 0,
                display_info_id,
                icon_file_data_id,
                has_model: has_model.get(&display_info_id).copied().unwrap_or(false),
            }
        })
        .collect();

    describe_items(files, &mut found)?;
    Ok(found)
}

/// What one row of `ItemSparse` says about an item, out of the five columns this app reads.
#[derive(Debug, Clone, Default)]
struct ItemFacts {
    name: String,
    inventory_type: u32,
    allowable_class: u32,
    required_level: u32,
    quality: u32,
}

/// Fills in what the game says about each of a set's items, out of `ItemSparse`.
///
/// That table is every item in the game — 63 MB of it on a shipping build, an order of
/// magnitude more than the rest of the chain put together — so nothing is kept from it beyond
/// the dozen rows a set actually needs. The rows are walked once and only the ones an
/// appearance here belongs to are read; the file itself is dropped on the way out.
///
/// Five columns come out of the one walk, and each is here because something cannot be drawn
/// without it. The **name** is what the row is labelled with. The **inventory type** is where
/// the item is worn, and for a weapon it is the only statement in the game's files of which
/// hand it goes in — `ItemAppearance.DisplayType` files a sword, a shield and a wand under
/// four numbers that say none of it. See `worn::held_in`.
///
/// The last three — **who may wear it, what it takes, and what it is worth** — are what tells
/// two rows of a set apart once the rows are grouped by appearance. A set names one look
/// several times over, once per item that gives it, and 92.6% of the time the items disagree
/// about nothing except their names. These are the columns that carry the disagreements worth
/// showing, and the one worth showing most is the first: a look a class set locks away is
/// often sold to everybody by something else in the same set.
///
/// An item the table says nothing about keeps an empty name and zeroes rather than costing its
/// row. The game encrypts the items of content it has not shipped, exactly as it does
/// everywhere else along this chain, and none of that is worth dropping a row for.
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
    let described: HashMap<u32, ItemFacts> = items
        .rows()
        .filter(|row| wanted.contains(&row.id()))
        .map(|row| {
            (
                row.id(),
                ItemFacts {
                    name: row.text(item_column::NAME),
                    inventory_type: row.number(item_column::INVENTORY_TYPE),
                    allowable_class: row.number(item_column::ALLOWABLE_CLASS),
                    required_level: row.number(item_column::REQUIRED_LEVEL),
                    quality: row.number(item_column::QUALITY),
                },
            )
        })
        .collect();
    for appearance in appearances {
        let facts = described
            .get(&appearance.item_id)
            .cloned()
            .unwrap_or_default();
        appearance.name = facts.name;
        appearance.inventory_type = facts.inventory_type;
        appearance.allowable_class = facts.allowable_class;
        appearance.required_level = facts.required_level;
        appearance.quality = facts.quality;
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
        fn read(&self, fdid: u32) -> Result<std::sync::Arc<Vec<u8>>, String> {
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
                // Five rows and two looks, which is what the count on a card means and why
                // it is no longer the number of rows the detail view draws.
                (&json!(207), &json!(5)),
                (&json!(208), &json!(2)),
                (&json!(209), &json!(2)),
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
                json!("Emberforge Armory"),
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
                (&json!(4), &json!(15), &json!(207)),
                (&json!(4), &json!(20), &json!(208)),
                (&json!(4), &json!(25), &json!(209)),
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
        assert_eq!(payload["readCount"], 9);
        assert_eq!(payload["declaredCount"], 11);
        assert_eq!(payload["withheldCount"], 2);
        assert!(!column(&payload, "id").contains(&json!(900)));
        assert!(!column(&payload, "name").contains(&json!("Unreleased Alpha")));
    }

    /* ---------- sets that are the same clothes ---------- */

    // Sets 208 and 209 name the same two appearances and differ in one bit of one column, which
    // is how the game files a wardrobe sold to both factions. They are one set as far as a
    // reader is concerned, and 208 is the one shown because it orders first.
    #[test]
    fn folds_a_set_under_the_one_holding_the_same_appearances() {
        let sets = read_sets(&payload());
        let shown = sets.iter().find(|set| set["id"] == 208).expect("set 208");
        let folded = sets.iter().find(|set| set["id"] == 209).expect("set 209");

        assert_eq!(shown["sameLookAs"], Value::Null);
        assert_eq!(
            shown["alternates"],
            json!([{
                "id": 209,
                "name": "Stormbreaker's Battleplate",
                "group": "Emberforge Armory",
                "classMask": 0x0023,
                "expansionId": 4,
                "patchIntroduced": 100_300,
                "reason": "faction",
            }])
        );

        // And the folded one says which set it is shown under, so the window can leave it out
        // of the grid without having to work out why on its own.
        assert_eq!(folded["sameLookAs"], 208);
        assert_eq!(folded["alternates"], Value::Null);
    }

    // The two fields cost nothing on the sets that have neither, which is all but a few hundred
    // of the game's — an empty list and a zero repeated 4,475 times is payload nobody reads.
    #[test]
    fn says_nothing_about_a_set_that_is_nobody_elses_clothes() {
        for set in read_sets(&payload()) {
            if [208, 209].contains(&set["id"].as_u64().unwrap_or(0)) {
                continue;
            }
            assert_eq!(set["alternates"], Value::Null, "{}", set["id"]);
            assert_eq!(set["sameLookAs"], Value::Null, "{}", set["id"]);
        }
    }

    // Sets 201 and 202 hold different appearances and are not each other's clothes, however
    // alike the rest of their columns are — which is what stops the fold being "sets that
    // look related".
    #[test]
    fn leaves_two_sets_of_different_appearances_alone() {
        let sets = read_sets(&payload());
        for id in [201, 202, 203, 204, 205, 206, 207] {
            let set = sets.iter().find(|set| set["id"] == id).expect("the set");
            assert_eq!(set["sameLookAs"], Value::Null, "set {id}");
        }
    }

    // The invariant the window rests its whole grid on, and the one way this feature could lose
    // a look outright: a set carrying `sameLookAs` is dropped from the grid unconditionally, so
    // if it pointed at a set that was absent — or at one that did not name it back — that
    // wardrobe would be gone, unsearchable, with nothing downstream able to notice. The two
    // fields are written from one pass and this is what says they agree.
    #[test]
    fn every_folded_set_points_at_a_shown_set_that_names_it_back() {
        let payload = payload();
        let sets = read_sets(&payload);
        let mut folded = 0;
        for set in &sets {
            let Some(under) = set["sameLookAs"].as_u64() else {
                continue;
            };
            folded += 1;
            let shown = sets
                .iter()
                .find(|other| other["id"].as_u64() == Some(under))
                .unwrap_or_else(|| panic!("set {} is shown under absent set {under}", set["id"]));
            // The set shown is never itself folded, or the grid would drop them both.
            assert_eq!(shown["sameLookAs"], Value::Null, "{under} is folded too");
            let names_back = shown["alternates"]
                .as_array()
                .map(|alternates| alternates.iter().any(|one| one["id"] == set["id"]))
                .unwrap_or(false);
            assert!(names_back, "set {under} does not name {}", set["id"]);
        }
        assert!(folded > 0, "the fixture holds a fold to check");
    }

    // Set 900's appearances are encrypted, so nothing can be said about what it holds. Two such
    // sets would share an empty look, and "these two sets nobody can read are the same set" is
    // not a thing this install knows.
    #[test]
    fn does_not_fold_the_sets_it_can_read_nothing_out_of() {
        let payload = payload();
        assert!(!read_sets(&payload).iter().any(|set| set["id"] == 900));
        let empty = sets(&fixture_files()).unwrap();
        assert_eq!(empty["withheldCount"], 2);
    }

    // The reason is read off the sets rather than guessed, and the most specific one the pair
    // supports is the one worth giving: a faction pair is usually also two names, and a class
    // variant usually also two collections.
    #[test]
    fn says_why_two_sets_of_the_same_clothes_are_two_sets() {
        let base = TransmogSet {
            id: 1,
            name: String::new(),
            group: String::new(),
            group_id: 0,
            class_mask: 0x23,
            expansion_id: 4,
            parent_id: 0,
            flags: 0,
            ui_order: 0,
            patch_introduced: 0,
            item_count: 0,
            alternates: Vec::new(),
            same_look_as: 0,
        };
        let with = |flags: u32, class_mask: u32| TransmogSet {
            flags,
            class_mask,
            ..base.clone()
        };

        // One faction bit each, which the install never sets together.
        assert_eq!(
            why(&with(0b0100, 0x23), &with(0b1000, 0x23)),
            SameLook::Faction
        );
        // A faction bit on one and none on the other is not a pair.
        assert_eq!(why(&with(0b0100, 0x23), &with(0, 0x23)), SameLook::Reissue);
        assert_eq!(why(&with(0b0100, 0x23), &with(0, 0x1044)), SameLook::Class);
        // The same clothes drawn for different classes, which the game files as two sets.
        assert_eq!(why(&with(0, 0x23), &with(0, 0x1044)), SameLook::Class);
        // And everything else: one look released twice, usually renamed a season later.
        assert_eq!(why(&with(0, 0x23), &with(0, 0x23)), SameLook::Reissue);
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
                    "allowableClass": 0xffff, "requiredLevel": 0, "quality": 4,
                    "displayInfoId": 900001, "iconFileDataId": 130001,
                    "hasModel": true,
                },
                {
                    "modifiedAppearanceId": 71007, "itemId": 30007, "name": "Emberforge Pauldrons",
                    "appearanceId": 80007,
                    "displayType": 1, "inventoryType": 3,
                    "allowableClass": 0xffff, "requiredLevel": 0, "quality": 4,
                    "displayInfoId": 900009, "iconFileDataId": 130002,
                    "hasModel": true,
                },
                {
                    "modifiedAppearanceId": 71008, "itemId": 30008,
                    "name": "Emberforge Breastplate", "appearanceId": 80008,
                    "displayType": 3, "inventoryType": 5,
                    "allowableClass": 0xffff, "requiredLevel": 0, "quality": 5,
                    "displayInfoId": 900003, "iconFileDataId": 130003,
                    "hasModel": false,
                },
                {
                    "modifiedAppearanceId": 71009, "itemId": 30009, "name": "Emberforge Greaves",
                    "appearanceId": 80009,
                    "displayType": 5, "inventoryType": 7,
                    "allowableClass": 0xffff, "requiredLevel": 0, "quality": 4,
                    "displayInfoId": 900006, "iconFileDataId": 130006,
                    "hasModel": false,
                },
            ])
        );
    }

    // The three columns the largest table in the game is now read for beyond the name: who may
    // wear an item, what it takes to wear it, and what it is worth. Set 207 sells one look
    // three ways and this is the whole of what separates the three rows — without it the
    // detail view would be collapsing them on the strength of nothing.
    #[test]
    fn says_who_may_wear_each_item_of_a_set_and_what_it_costs() {
        let opened = opened(207);
        let facts: Vec<(&Value, &Value, &Value, &Value)> = opened["appearances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|appearance| {
                (
                    &appearance["name"],
                    &appearance["allowableClass"],
                    &appearance["requiredLevel"],
                    &appearance["quality"],
                )
            })
            .collect();
        assert_eq!(
            facts,
            vec![
                // The head, three times over: the set's own piece is Warrior-only, and two
                // other items give the same look to anybody — the second of them cheaper.
                (
                    &json!("Stormforged Helm"),
                    &json!(0b1),
                    &json!(60),
                    &json!(4)
                ),
                (
                    &json!("Stormforged Greathelm"),
                    &json!(0xffff),
                    &json!(60),
                    &json!(4)
                ),
                (
                    &json!("Helm of the Tempest"),
                    &json!(0xffff),
                    &json!(45),
                    &json!(3)
                ),
                (
                    &json!("Stormforged Breastplate"),
                    &json!(0b1),
                    &json!(60),
                    &json!(4)
                ),
                (
                    &json!("Breastplate of the Tempest"),
                    &json!(0xffff),
                    &json!(60),
                    &json!(4)
                ),
            ]
        );

        // Five rows and two appearances between them, which is the count the detail view
        // groups down to.
        let looks: HashSet<u32> = opened["appearances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|appearance| appearance["appearanceId"].as_u64().unwrap() as u32)
            .collect();
        assert_eq!(looks.len(), 2);
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
                    "allowableClass": 0, "requiredLevel": 0, "quality": 0,
                    "displayInfoId": 900900, "iconFileDataId": 130008,
                    "hasModel": false,
                },
                {
                    "modifiedAppearanceId": 71012, "itemId": 0, "name": "", "appearanceId": 0,
                    "displayType": 0, "inventoryType": 0,
                    "allowableClass": 0, "requiredLevel": 0, "quality": 0,
                    "displayInfoId": 0,
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
                "allowableClass": 0xffff, "requiredLevel": 0, "quality": 1,
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

    /* ---------- every set at once ---------- */

    // The narrow question the whole-game reads ask: which looks each set holds, and nothing else.
    // Every set in the fixtures, in one answer, out of two tables rather than five.
    #[test]
    fn names_the_looks_of_every_set_at_once() {
        let files = Noted::new();
        let held = set_appearances(&files).unwrap();
        assert_eq!(held[&201], vec![80001, 80002, 80003]);
        // Set 900 is content the game has not shipped, and `TransmogSetItem` holds no row for it
        // at all — so it is not in the answer. What is in the answer is what the table names.
        assert_eq!(held.get(&900), None);
        assert_eq!(
            files.asked.into_inner(),
            vec![ITEM_MODIFIED_APPEARANCE, TRANSMOG_SET_ITEM]
        );
    }

    // Sorted and deduplicated, because the one caller writes a file that has to be the same
    // bytes twice — and because a set selling one look at two difficulties is one look.
    #[test]
    fn says_a_look_a_set_names_twice_once() {
        for looks in set_appearances(&fixture_files()).unwrap().values() {
            let mut once = looks.clone();
            once.sort_unstable();
            once.dedup();
            assert_eq!(*looks, once);
        }
    }

    #[test]
    fn says_so_when_the_sets_own_table_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        assert!(set_appearances(&DirFiles::new(temp.path())).is_err());
    }

    /* ---------- a list of appearances that came from somewhere else ---------- */

    // The order is the contract, and it is the whole reason this is a function of its own.
    // `set_items` sorts afterwards and does not care, but a set the player saved in game
    // arrives in slot order — head, shoulder, back — and sorting it again would hand the
    // window an outfit laid out differently from the one the game shows.
    #[test]
    fn answers_a_list_of_appearances_in_the_order_it_was_asked_for() {
        let found = appearances_of(&fixture_files(), &[71009, 71001, 71007]).unwrap();

        let named: Vec<(u32, u32, &str)> = found
            .iter()
            .map(|one| (one.modified_appearance_id, one.item_id, one.name.as_str()))
            .collect();
        assert_eq!(
            named,
            vec![
                (71009, 30009, "Emberforge Greaves"),
                (71001, 30001, "Tideglass Crown"),
                (71007, 30007, "Emberforge Pauldrons"),
            ]
        );
    }

    // An id nothing can be said about keeps its place rather than being dropped. Dropping it
    // would silently shorten the list, and a caller that asked slot by slot would then read
    // every appearance after the gap as belonging to the slot before it.
    #[test]
    fn keeps_the_place_of_an_id_the_install_can_say_nothing_about() {
        let found = appearances_of(&fixture_files(), &[71001, 71012, 71002]).unwrap();

        assert_eq!(found.len(), 3);
        // 71012's `ItemModifiedAppearance` row is one the fixture encrypts, so the chain stops
        // at the id itself — zeroed the way a withheld row of a Blizzard set is, and still a
        // row.
        assert_eq!(found[1].modified_appearance_id, 71012);
        assert_eq!(found[1].item_id, 0);
        assert_eq!(found[1].appearance_id, 0);
        assert_eq!(found[1].name, "");
        assert!(!found[1].has_model);
        assert_eq!(found[0].item_id, 30001);
        assert_eq!(found[2].item_id, 30002);
    }

    // An id the game has never issued reaches the same end as an encrypted one: this is a list
    // the addon read out of a client, so a set saved on a build newer than the installed one
    // can name appearances these tables have no row for.
    #[test]
    fn keeps_the_place_of_an_id_the_tables_have_never_heard_of() {
        let found = appearances_of(&fixture_files(), &[999_999]).unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].modified_appearance_id, 999_999);
        assert_eq!(found[0].item_id, 0);
    }

    // The same appearance twice is two rows, because the caller asked twice — an outfit
    // wearing one look in two slots is ordinary and each slot needs its own row to draw.
    #[test]
    fn answers_twice_for_an_id_asked_for_twice() {
        let found = appearances_of(&fixture_files(), &[71001, 71001]).unwrap();

        assert_eq!(found.len(), 2);
        assert_eq!(found[0], found[1]);
    }

    // Four tables, the largest of them 63 MB on a shipping build, and nothing in them can be
    // said about a list with nothing in it.
    #[test]
    fn opens_no_tables_at_all_for_an_empty_list() {
        let files = Noted::new();

        assert!(appearances_of(&files, &[]).unwrap().is_empty());
        assert!(files.asked.into_inner().is_empty());
    }

    /* ---------- what a page of sets is wearing ---------- */

    /// The pieces of one set, as `(display, slot, where the item is worn)`.
    fn wearing(set_id: u32) -> Vec<(u32, u32, u32)> {
        pieces_of(&fixture_files(), &[set_id])[&set_id].clone()
    }

    fn pieces_of(files: &dyn GameFiles, set_ids: &[u32]) -> BTreeMap<u32, Vec<(u32, u32, u32)>> {
        set_pieces(files, set_ids)
            .unwrap()
            .into_iter()
            .map(|(set_id, pieces)| {
                (
                    set_id,
                    pieces
                        .into_iter()
                        .map(|piece| {
                            (
                                piece.display_info_id,
                                piece.display_type,
                                piece.inventory_type,
                            )
                        })
                        .collect(),
                )
            })
            .collect()
    }

    // The point of it: a set id in, a body's worth of clothes out, with the slot each piece
    // fills — which is what `worn::each` is asked to dress a character in.
    #[test]
    fn says_what_a_set_is_wearing() {
        assert_eq!(
            wearing(203),
            vec![
                (900_001, 0, 1),
                (900_009, 1, 3),
                (900_003, 3, 5),
                (900_006, 5, 7)
            ],
        );
    }

    // Several sets out of one call, each answered separately — which is the whole reason this
    // exists beside `set_items`. Every id asked about comes back, in the map, whatever it holds.
    #[test]
    fn answers_for_every_set_of_a_page() {
        let page = pieces_of(&fixture_files(), &[201, 202, 203]);
        assert_eq!(
            page.keys().copied().collect::<Vec<u32>>(),
            vec![201, 202, 203]
        );
        assert_eq!(page[&202], vec![(900_004, 6, 8), (900_005, 8, 10)]);
    }

    // A set names one look once per item that gives it, and set 201 names its crown twice
    // through the same row copied. Wearing it twice is the same body and twice the texture work.
    #[test]
    fn wears_a_piece_a_set_names_twice_once() {
        assert_eq!(
            wearing(201),
            vec![(900_001, 0, 1), (900_002, 1, 3), (900_012, 3, 5)],
        );
    }

    // Which hand a weapon goes in is `ItemSparse.InventoryType` and nothing else in the chain
    // says it: set 204's four rows are filed under three display types between them.
    #[test]
    fn says_where_a_sets_weapons_are_held() {
        assert_eq!(
            wearing(204),
            vec![
                (900_007, 11, 13),
                (900_014, 11, 17),
                (900_015, 13, 14),
                (900_007, 15, 23)
            ],
        );
    }

    // A hop of the chain that lands in a section the game encrypts takes its row with it, and
    // the set keeps whatever else it holds. Set 205 names two appearances and only one of them
    // can be reached at all.
    #[test]
    fn leaves_out_a_row_the_install_cannot_follow() {
        // And the row it does keep carries a zero where the item would have said which hand:
        // 30011's `ItemSparse` row is encrypted too. It is a chestpiece, so nothing turns on
        // it — the slot has already said where the piece goes.
        assert_eq!(wearing(205), vec![(900_900, 3, 0)]);
    }

    // Every table once for the whole page, which is the entire reason this exists beside
    // `set_items`. `ItemSparse` is 63 MB on a shipping build and `Db2::rows` materialises a
    // table before it yields its first row, so the difference between one walk and one per set
    // is the difference between a page and a stall. `budget.rs` counts the same claim in rows.
    #[test]
    fn opens_each_table_once_for_a_whole_page() {
        let files = Noted::new();
        set_pieces(&files, &[201, 202, 203, 204]).unwrap();
        let asked = files.asked.into_inner();
        for table in [
            TRANSMOG_SET_ITEM,
            ITEM_MODIFIED_APPEARANCE,
            ITEM_APPEARANCE,
            ITEM_SPARSE,
        ] {
            assert_eq!(
                asked.iter().filter(|fdid| **fdid == table).count(),
                1,
                "table {table} was opened more than once for one page",
            );
        }
    }

    // And a page the install can see nothing in never reaches the tables past the first, the
    // same way opening one such set does not.
    #[test]
    fn reads_no_further_for_a_page_of_sets_it_cannot_see_into() {
        let files = Noted::new();
        assert_eq!(pieces_of(&files, &[900]), BTreeMap::from([(900, vec![])]));
        let asked = files.asked.into_inner();
        assert!(!asked.contains(&ITEM_MODIFIED_APPEARANCE));
        assert!(!asked.contains(&ITEM_APPEARANCE));
    }

    // A page of no sets asks the game nothing at all, which is what a filter that empties the
    // grid comes to.
    #[test]
    fn asks_the_game_nothing_for_a_page_of_no_sets() {
        let temp = tempfile::tempdir().unwrap();
        assert!(set_pieces(&DirFiles::new(temp.path()), &[])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn says_so_when_the_set_item_table_is_not_there_for_a_page() {
        let temp = tempfile::tempdir().unwrap();
        assert!(set_pieces(&DirFiles::new(temp.path()), &[201]).is_err());
    }
}
