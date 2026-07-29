//! What one appearance puts on a character: the pictures it paints, and the geometry it swaps.
//!
//! Most of a transmog set has no model of its own. A chestpiece is a set of textures blitted
//! into the character's body atlas plus a handful of geoset switches, and this module is the
//! half of that which comes out of the game's tables — [`crate::character`] is the half that
//! puts it on a mesh.
//!
//! Two chains, from the same `ItemDisplayInfo` id:
//!
//! ```text
//! ItemDisplayInfoMaterialRes      which texture goes on which part of the body
//!   foreign_id() = ItemDisplayInfoID   ← the relationship block, and nowhere else
//!   col0 = ComponentSection
//!   col1 = MaterialResourcesID ──▶ TextureFileData ──▶ several BLPs
//!                                     └──▶ ComponentTextureFileData: which body each is for
//!
//! ItemDisplayInfo.GeosetGroup[6]  which variant of which group the item switches on
//! ItemDisplayInfo.ModelResourcesID[2] ──▶ ModelFileData ──▶ several .m2s
//!                                            └──▶ ComponentModelFileData: which body each is
//! ItemDisplayInfo.HelmetGeosetVis[2] ──▶ HelmetGeosetData: what a helm hides
//! ```
//!
//! The first chain has two traps beyond the relationship block. **A material can name more
//! than one file**, one per body the game painted it for, and which is which is written down
//! only in `ComponentTextureFileData` — so taking the first, or the lowest-numbered, dresses a
//! Human Female in a Human Male's chest often enough to notice. And **a texture with no row in
//! that table at all is not excluded**: silence is what most of the game's armour has, and
//! reading it as "not for this body" would leave the character bare.
//!
//! The second chain is two positions rather than one, and both were read off an install:
//! `GeosetGroup` is column 13 of `ItemDisplayInfo`, and which slot a display type names is
//! item by item in [`SLOT_GROUPS`]. Neither is the community's, because the community is wrong
//! about both — `docs/game-files.md` has the run that settled them. Getting either wrong is
//! quiet rather than loud, which is why nothing here hides a group it cannot then show
//! something for: see [`crate::character::dressed`].
//!
//! The third chain is the same trap as the first, one table over. **A model resource names an
//! `.m2` per body too** — a helm is modelled for every race and gender the game ships — and
//! `ComponentModelFileData` is `ComponentTextureFileData` with models behind it, down to the
//! column positions. [`for_this_body`] is therefore one function asked twice, which is the
//! whole reason it takes the table's rows rather than reading them itself.
//!
//! The fourth is the smallest and the only one that takes geometry *away*: a helm hides hair,
//! ears and facial hair, and `HelmetGeosetData` says which groups, per race.
//!
//! And then the one thing none of the four says. A helm hangs where a helm hangs because the
//! slot decides it, and a **weapon's slot decides nothing**: `ItemAppearance.DisplayType` files
//! a sword, a bow, a shield and a tome under four numbers that distinguish none of them. Which
//! hand comes from the item rather than from the display — `ItemSparse.InventoryType`, which
//! [`crate::transmog`] already reads for the name — and is [`held_in`].
//!
//! # A set of them, which is where the arguments start
//!
//! Everything above is one appearance answering for itself, and none of it can be wrong about
//! another item because there is no other item. [`of_set`] is the whole outfit, and it adds the
//! two subsystems that exist only to settle arguments between pieces:
//!
//! - **[`GEOSET_PRIORITY`]**, which says who owns a group two pieces both drive. A robe and a
//!   pair of legs both claim group 13, and the game's answer is a fixed order of slots per
//!   contested group rather than anything in either row.
//! - **[`SLOT_LAYER`]**, which says what order the textures go down in. With one item over a
//!   bare body there is one layer; with twelve there is a stack, and it is not the order the
//!   tables happen to hand the pieces over in.
//!
//! Both are wow.export's, re-keyed, and both are stated where they are defined.
//!
//! The other thing a set changes is arithmetic rather than correctness. Twelve appearances read
//! one at a time is twelve parses of `ItemDisplayInfoMaterialRes`, `TextureFileData`,
//! `ComponentTextureFileData` and `ItemDisplayInfo`, and on a real install those are the
//! expensive part by a wide margin. So the tables are read **once for everything asked about**
//! and the parse handed down — [`TextureFiles`] and [`ModelFiles`] are what it hands down —
//! rather than anything being cached between renders.
//!
//! [`each`] is where "everything asked about" stops meaning one outfit. A gallery is twenty
//! appearances each shown alone, with nothing to arbitrate between them and every one of those
//! tables in common, so it goes through the same walk — and [`of_set`] is a gallery of one.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::body::Body;
use crate::casc::GameFiles;
use crate::db2::{Db2, Row};
use crate::models::TEXTURE_FILE_DATA;
use crate::models::{MATERIAL_RESOURCES_ID, MODEL_FILE_DATA, MODEL_RESOURCES_ID};
use crate::transmog::{display_column, ITEM_DISPLAY_INFO, MODEL_SLOTS, MODEL_SLOT_BITS};

/// `ItemDisplayInfoMaterialRes` — which texture an appearance paints each part of a body with.
const ITEM_DISPLAY_INFO_MATERIAL_RES: u32 = 1280614;
/// `ComponentTextureFileData` — which body a given texture file was painted for.
const COMPONENT_TEXTURE_FILE_DATA: u32 = 1278239;
/// `ComponentModelFileData` — the same for a model file, and the same three columns.
const COMPONENT_MODEL_FILE_DATA: u32 = 1349053;
/// `HelmetGeosetData` — which of a body's geoset groups a helm hides, race by race.
const HELMET_GEOSET_DATA: u32 = 2821752;

/// Columns of `ItemDisplayInfoMaterialRes`. Its own id is of no use to anybody: what ties a
/// row to an appearance is the relationship block, which [`Row::foreign_id`] reads.
mod material_column {
    /// Which part of the body, 0 to 8. The layout says where each of those lands.
    pub const COMPONENT_SECTION: usize = 0;
    pub const MATERIAL_RESOURCES_ID: usize = 1;
}

/// Columns of `ComponentTextureFileData`, whose row id is the texture's own FileDataID — and
/// of `ComponentModelFileData`, which is the same three columns with models behind them.
///
/// The models table carries a fourth, and it is not decoration: **`PositionIndex` is which
/// shoulder.** Read off 12.0.5.67, the two tags are orthogonal and each slot uses exactly one
/// of them — a helm is `gender 0 or 1, position -1`, and every one of the 10,449 shoulder
/// resources is `gender 2, positions 0 and 1`. Which is to say a helm is modelled per body and
/// a pauldron is modelled per side, and neither is modelled per both.
mod component_column {
    pub const GENDER: usize = 0;
    pub const CLASS: usize = 1;
    pub const RACE: usize = 2;
    pub const POSITION: usize = 3;
}

/// How many sides a model resource can be modelled for, which is two: a left pad and a right.
///
/// Anything a row states outside that is the game saying the model has no side — `-1` on every
/// helm, and read unsigned it arrives as a number far past this. Treating it as a bound rather
/// than as a sentinel is what keeps that true however the column is packed.
const SIDES: u32 = 2;

/// Columns of `HelmetGeosetData`. Which helm a row belongs to is the relationship block, as it
/// is in `ItemDisplayInfoMaterialRes`, so [`Row::foreign_id`] is what reads it.
///
/// Two more columns follow these, read off 12.0.5.67 and left alone: one is zero on all but
/// five of the table's 19,150 rows, and `RaceBitSelection` is `32` or `-1` throughout. Neither
/// has a reading this app could act on, and ignoring them errs towards hiding — which is what
/// a helm does.
mod helmet_column {
    pub const RACE: usize = 0;
    pub const HIDE_GEOSET_GROUP: usize = 1;
}

// There is no class anywhere in this module, and that is a decision rather than an omission: a
// class-specific texture is a demon hunter's tattoos and a handful of tabards, and a wardrobe is
// browsed by a reader rather than by a character.
//
// The *body* is `crate::body::Body`, passed in — its race and its sex are what an item's
// textures and a helm's hidden groups are chosen by, and both used to be a Human Female here.

/// The genders the game marks a file with when it does not belong to one body, and the class
/// it marks one with when it fits any class. All three are "no opinion" rather than a body.
///
/// 2 is the game's "none" and 3 its "any", and the difference between them is not one this app
/// can act on — but excluding either is: **every shoulder model in the game is a 2**, because a
/// pauldron is modelled per side rather than per body, and a reader that kept only 1 and 3
/// would find no pauldron anywhere.
const NO_GENDER: u32 = 2;
const ANY_GENDER: u32 = 3;
const ANY_CLASS: u32 = 0;

/// How many geoset groups `ItemDisplayInfo` gives a display, and how wide one of them is.
///
/// A fixed-size array inside a single column, like the two model slots beside it, so the
/// caller supplies the element width — the file records only the column's total.
const GEOSET_GROUPS: usize = 6;
const GEOSET_GROUP_BITS: u32 = 32;

/// The largest number that can be a geoset value.
///
/// A geoset id is `group × 100 + value`, so a value of 99 or more belongs to the next group.
/// The rows that carry `-1` — the game's way of writing "this drives no geoset" — arrive here
/// as `u32::MAX` and are caught by the same test, which is the point of stating it as a bound
/// rather than as a sentinel.
const LARGEST_VALUE: u32 = 98;

/// Which geoset groups each slot's `GeosetGroup` elements drive, indexed by `DisplayType`.
///
/// The group numbers are `docs/character-rendering.md`'s, which has them and the slots side by
/// side. The slot each one is filed under was read off an install with
/// `examples/dump_display_columns`, item by item — a shirt is 2 and a chestpiece is 3, which
/// is not where the community's list puts either.
///
/// One item drives several groups at once — a chestpiece drives five — and since they all come
/// from the same item, none of them can conflict with another. That is the whole reason a
/// single appearance is so much less work than an assembled outfit.
///
/// Shirt and wrist drive nothing: a bracer is texture alone, and the shirt row is not in the
/// community's table at all, so it is left as texture rather than guessed at.
const SLOT_GROUPS: [&[u16]; 11] = [
    &[27, 21],            // 0  head: helm, skull
    &[26],                // 1  shoulder
    &[],                  // 2  shirt
    &[8, 10, 13, 22, 28], // 3  chest: sleeves, chest, robe, torso, arm upper
    &[18],                // 4  waist: belt
    &[11, 9, 13],         // 5  legs: pants, kneepads, robe
    &[5, 20],             // 6  feet: boot, feet
    &[],                  // 7  wrist
    &[4, 23],             // 8  hands: gloves, hand attach
    &[15],                // 9  back: cape
    &[12],                // 10 tabard
];

/// Which slot owns each contested geoset group, best claim first.
///
/// **This is the table one item cannot reach.** Sleeves are claimed by gloves, the chest and the
/// shirt; the robe group by the chest and the legs; the feet group by boots. The game settles it
/// with a fixed order per group — the first slot in the list that drives the group at all wins
/// outright, and nothing in either row is consulted.
///
/// The shape and the contents are wow.export's `GEOSET_PRIORITY`, in
/// `src/js/db/caches/DBItemGeosets.js` (MIT), read on 2026-07-27. What is changed is the key:
/// that table is keyed by the game's **equipment slots**, where a helm is 1 and a cloak 15, and
/// this app carries `DisplayType`, where a helm is 0 and a cloak 9. So each list is written here
/// in the numbering the rest of this module already uses — [`SLOT_GROUPS`]'s — rather than
/// keeping a second table to translate between the two. `docs/character-rendering.md` has both
/// numberings side by side.
///
/// Several of these rows can never fire against [`SLOT_GROUPS`], and they are kept anyway.
/// Sleeves name gloves first, and no gloves in this app's table drive sleeves; the chest group
/// names the shirt, and this app's shirt drives nothing at all. They are wow.export's rows and
/// they are inert rather than wrong — the one contest that does fire is group 13, where a robe
/// worn on the chest beats a pair of legs, which is the sentence the whole table is here for.
const GEOSET_PRIORITY: [(u16, &[u32]); 17] = [
    (8, &[8, 3, 2]), // sleeves: gloves, then chest, then shirt
    (10, &[3, 2]),   // chest: chest, then shirt
    (13, &[3, 5]),   // robe: the chest beats the legs
    (12, &[10]),     // tabard
    (15, &[9]),      // cape
    (18, &[4]),      // belt
    (20, &[6]),      // feet
    (22, &[3]),      // torso
    (23, &[8]),      // hand attach
    (27, &[0]),      // helm
    (28, &[3]),      // arm upper
    (21, &[0]),      // skull
    (26, &[1]),      // shoulders
    (5, &[6]),       // boot
    (4, &[8]),       // gloves
    (11, &[5]),      // pants
    (9, &[5]),       // kneepads
];

/// What order a slot's textures go into the atlas, lowest first.
///
/// Bracers land over sleeves and gauntlets over bracers, and none of that is decidable from the
/// section rectangles: two pieces can paint the same rectangle, and which one the reader ends up
/// seeing is this and nothing else. Getting it wrong looks like the wrong sleeve rather than
/// like an error.
///
/// wow.export's `SLOT_LAYER`, in `src/js/wow/EquipmentSlots.js` (MIT), read on 2026-07-27 and
/// re-keyed to `DisplayType` the same way [`GEOSET_PRIORITY`] is. The ties are the source's:
/// the shirt and the legs share a layer, as do the head and the feet, and the shoulders and the
/// chest — so pieces on the same layer keep the order they arrived in, which is the order the
/// set itself names them.
const SLOT_LAYER: [u32; 11] = [
    11, // 0  head
    13, // 1  shoulder
    10, // 2  shirt
    13, // 3  chest
    18, // 4  waist
    10, // 5  legs
    11, // 6  feet
    19, // 7  wrist
    20, // 8  hands
    23, // 9  back
    17, // 10 tabard
];

/// Where a slot the layer table says nothing about goes, which is the bottom.
///
/// wow.export's own default, and what every weapon lands on. It costs nothing either way: a
/// weapon paints no part of the body, so where it would sit in the stack never comes up.
const BOTTOM_LAYER: u32 = 10;

/// Where a slot's textures sit in the stack.
fn layer_of(display_type: u32) -> u32 {
    SLOT_LAYER
        .get(display_type as usize)
        .copied()
        .unwrap_or(BOTTOM_LAYER)
}

/// The two groups whose zero does not mean "nothing here".
///
/// Every other group reads value 0 as its bare default. These two invert it: a boot with a
/// zero is still a boot and a helm with a zero is still a helm, because the row only exists
/// when an item is there at all. Getting this wrong puts bare feet inside a pair of boots.
const FEET: u16 = 20;
const HELM: u16 = 27;
const BOOTED: u16 = 2002;
const HELMETED: u16 = 2702;

/// Where each slot's model slots hang off the body, as the community numbers attachments.
///
/// Indexed by `DisplayType` like [`SLOT_GROUPS`], and parallel to `ModelResourcesID`: element
/// `i` of that array goes to attachment `SLOT_ATTACHMENTS[slot][i]`. Everything not named here
/// has no model of its own, and the weapons above 10 hang off hands, which is another issue.
///
/// The ids are the community's, at <https://wowdev.wiki/M2#Attachments>, and the positions
/// `humanfemale_hd`'s skeleton states for them on 12.0.5.67 are what says they are right: 11
/// sits at the top of the head, 5 and 6 are a mirrored pair at shoulder height, and 12 is
/// behind the chest.
const SLOT_ATTACHMENTS: [&[u32]; 11] = [
    &[11],   // 0  head: the helm
    &[6, 5], // 1  shoulder: the left pad, then the right
    &[],     // 2  shirt
    &[],     // 3  chest
    &[],     // 4  waist
    &[],     // 5  legs
    &[],     // 6  feet
    &[],     // 7  wrist
    &[],     // 8  hands
    &[],     // 9  back — a cape is the body's own geometry, not a model. See [`cape_of`].
    &[],     // 10 tabard
];

/// The three attachments a weapon can hang off, as the community numbers them.
///
/// The right hand and the left are the two a weapon is held in. The shield is neither: it hangs
/// off attachment 0, which on `humanfemale_hd` is a bone on the *left forearm* rather than in
/// the hand — read off 12.0.5.67, and the reason a shield is not simply an off-hand weapon.
const HAND_RIGHT: u32 = 1;
const HAND_LEFT: u32 = 2;
const SHIELD: u32 = 0;

/// Which hand the game puts each kind of weapon in, as `ItemSparse.InventoryType` numbers them.
///
/// **This is the table `DisplayType` cannot give.** An appearance files every weapon and shield
/// in the game under four numbers — 11, 12, 13 and 15 — and none of them says which hand, which
/// is why the detail view used to call all four "Weapon or shield". `InventoryType` is the
/// game's own answer to "where does this go" and it is already being read for the item's name:
/// a one-hander is 13, a two-hander 17, a shield 14, and an off-hand 22. Counted on 12.0.5.67
/// with `examples/dump_inventory_types`, which is what to run again after a patch.
///
/// Two of these are named rather than counted, and are marked as such:
///
/// - **A bow is 15 and a gun or a wand is 26, "ranged right".** That the game keeps two numbers
///   for the ranged weapons at all, and calls one of them the right, is the only thing said
///   about which hand either goes in — so a bow goes in the left, where a player holds one, and
///   everything else ranged goes in the right.
/// - **A profession tool is 29 and its accessory 30**, which are a blacksmith's hammer and the
///   thing held in the other hand. They follow the main-hand and off-hand pair beside them.
///
/// `docs/game-files.md` has the whole cross-tab. What is deliberately not here is 24, ammo:
/// arrows are not held, and a quiver full of them is not something this app can place.
const HELD_IN: [(u32, u32); 11] = [
    (13, HAND_RIGHT), // one-hand
    (17, HAND_RIGHT), // two-hand — one model on one attachment, and not two
    (21, HAND_RIGHT), // main hand
    (25, HAND_RIGHT), // thrown
    (26, HAND_RIGHT), // ranged right: a gun, a crossbow, a wand
    (29, HAND_RIGHT), // profession tool
    (22, HAND_LEFT),  // off hand
    (23, HAND_LEFT),  // held in off hand
    (15, HAND_LEFT),  // ranged: a bow
    (30, HAND_LEFT),  // profession accessory
    (14, SHIELD),     // a shield, which is on the forearm rather than in a hand
];

/// Where a weapon of this kind hangs, or nothing when the game says nothing this app can place.
///
/// Nothing is an ordinary answer twice over: the game withholds the items of content it has not
/// shipped, and an item nothing can be read about has no `InventoryType` at all — which arrives
/// here as zero. The window shows those on their own rather than in a hand, which is where
/// every weapon in this app was before this.
pub fn held_in(inventory_type: u32) -> Option<u32> {
    HELD_IN
        .iter()
        .find(|(kind, _)| *kind == inventory_type)
        .map(|(_, attachment)| *attachment)
}

/// Whether a slot is something carried rather than something put on.
///
/// The eleven armour slots are head through tabard and are exactly the ones [`SLOT_LAYER`]
/// tabulates, because a slot that paints the body is a slot that has somewhere in the stack to
/// paint it; everything the game numbers above them is a weapon, a shield, an off-hand or a
/// thing held in one. So the length of that table *is* the boundary, and keeping the question
/// here rather than writing `> 10` somewhere else is what stops the two drifting apart.
///
/// What turns on it is what a picture of the appearance ought to be. Armour has no geometry to
/// show — a chestpiece is paint on a body — so the only honest picture is a character wearing
/// it. A sword is a mesh, and a reader who asked to see a sword wants the sword.
pub fn held(display_type: u32) -> bool {
    display_type as usize >= SLOT_LAYER.len()
}

/// The slot a cape is worn in, and the slot a helm is.
const BACK: u32 = 9;
const HEAD: u32 = 0;

// `HelmetGeosetVis` is two elements, male then female — which is the community's reading and is
// exactly `crate::body::Body::sex`, so the sex indexes the array directly.
//
// On 12.0.5.67 the two elements name the same hidden groups for hair on every one of the 5,698
// helms in the table — 4,576 hide it either way — so nothing about a *hairstyle* turns on the
// choice; the rarer groups do.

/// One piece of an outfit: which appearance, which slot it fills, and where its item is worn.
///
/// The three numbers the window already has for every row of a set. `display_type` is
/// `ItemAppearance`'s and is what says which geoset groups the six values drive and where the
/// piece sits in the stack; `inventory_type` is `ItemSparse`'s and is what the slot cannot say,
/// which is the hand a weapon is held in. Zero for every piece of armour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    pub display_info_id: u32,
    pub display_type: u32,
    pub inventory_type: u32,
}

/// One texture, and which part of the body it is painted on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComponentTexture {
    /// The game's `ComponentSection`, 0 to 8. Where it lands is the texture layout's business.
    pub section: u32,
    /// The FileDataID of the BLP, already narrowed to the one for this body.
    pub file: u32,
}

/// One geoset an appearance switches on, and the group it belongs to.
///
/// The group travels with it because applying a geoset means hiding that group's other
/// hundred: `802` on its own says nothing about the bare arms it replaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geoset {
    pub group: u16,
    pub geoset: u16,
}

/// One model an appearance hangs off the body, already narrowed to this body's copy of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WornModel {
    /// Where it hangs, as the community numbers a body's attachments.
    pub attachment: u32,
    /// The `.m2` itself.
    pub file: u32,
    /// The one picture the model paints itself with, where the item names one.
    pub texture: Option<u32>,
}

/// Everything one appearance does to a bare body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Worn {
    pub textures: Vec<ComponentTexture>,
    pub geosets: Vec<Geoset>,
    /// The geometry it hangs off the body: a helm, a pad on each shoulder, or the one weapon
    /// or shield a hand holds.
    pub models: Vec<WornModel>,
    /// The picture the body's own cape geometry is painted with, for the one slot whose
    /// "model" is a geoset the body already holds. Bound as M2 texture type 2.
    pub cape: Option<u32>,
    /// The geoset groups a helm hides outright — hair, ears, facial hair — rather than
    /// swapping a variant of. The whole group goes, which is why it is a group and not an id.
    pub hidden: Vec<u16>,
}

impl Worn {
    /// Whether this install can say anything at all about how the appearance is worn.
    ///
    /// Empty is an ordinary answer rather than a failure: the game encrypts the displays of
    /// content it has not shipped, and a slot whose only texture was painted for another body
    /// resolves to nothing. Either way there is nothing to put on the character, and the
    /// window is better off showing the appearance's icon.
    ///
    /// Note what is *not* here: `hidden` on its own is a helm this install holds no model for,
    /// which is a bald character rather than a helmed one and is not worth showing.
    pub fn is_empty(&self) -> bool {
        self.textures.is_empty()
            && self.geosets.is_empty()
            && self.models.is_empty()
            && self.cape.is_none()
    }
}

/// What one appearance puts on the body, out of the game's own tables.
///
/// `display_type` is the slot, as `ItemAppearance` numbers it, and it is what says which
/// geoset groups the display's six values drive. It comes from the row the reader clicked
/// rather than from another table, because the appearance is what knows its own slot.
///
/// `inventory_type` is the item's, out of `ItemSparse`, and it is what the slot cannot say: a
/// weapon's hand. Zero for every piece of armour and for an item the game withholds — see
/// [`held_in`].
///
/// A set of one, and it goes through [`of_set`] like any other: neither the priority table nor
/// the draw order has anything to settle when there is one piece, which is the whole reason a
/// single appearance was worth shipping first.
pub fn of(
    files: &dyn GameFiles,
    body: &Body,
    display_info_id: u32,
    display_type: u32,
    inventory_type: u32,
) -> Result<Worn, String> {
    of_set(
        files,
        body,
        &[Piece {
            display_info_id,
            display_type,
            inventory_type,
        }],
    )
}

/// What a whole outfit puts on the body, with the arguments between its pieces settled.
///
/// Three things happen here that [`of`] on its own never needed:
///
/// - **The pieces are laid in draw order first**, by [`SLOT_LAYER`], so the textures come out of
///   this in the order they are meant to go down and [`crate::character::Atlas::wear`] can stay
///   a loop over a list.
/// - **Each contested geoset group is resolved once**, by [`GEOSET_PRIORITY`], so what comes
///   back is at most one [`Geoset`] per group and nothing downstream has to arbitrate.
/// - **Each of the game's tables is parsed once for the whole outfit, and walked once**, rather
///   than either happening per piece — which is where twelve appearances stop being twelve
///   times the work. The walk is the half that costs: `Db2::rows` materialises every row of a
///   table before it yields the first, so a walk is the whole table however few rows the
///   caller keeps.
///
/// A set may name the same appearance twice and may name pieces whose slots conflict outright —
/// a robe and a pair of legs. Neither is deduplicated on the way in: the priority table is the
/// game's own answer to the second, and a reader that collapsed by slot first would quietly
/// drop one of them.
#[tracing::instrument(name = "worn.of_set", skip_all, fields(pieces = pieces.len()))]
pub fn of_set(files: &dyn GameFiles, body: &Body, pieces: &[Piece]) -> Result<Worn, String> {
    Ok(each(files, body, &[pieces])?
        .pop()
        .expect("one outfit in, one outfit out"))
}

/// The same, for several outfits at once, sharing every table between them.
///
/// **A gallery is not one outfit.** Twenty items each shown alone on the body is twenty separate
/// answers to "what does this put on her" — nothing is arbitrated between them, because no two of
/// them are ever on her at the same time. What they do share is every table the answer is read
/// out of, and that is the entire cost: `ItemDisplayInfoMaterialRes` is 604,000 rows and
/// `TextureFileData` several hundred thousand, and [`Db2::rows`] materialises all of them before
/// it yields the first. Asked once per outfit, a page of twenty walks those tables twenty times
/// to keep a few dozen rows out of each.
///
/// So the shape is the one [`of_set`] already had for the pieces of a set, one level further out:
/// lay every outfit's pieces flat, walk each table once over the lot, then answer each outfit from
/// what came back. [`of_set`] is a gallery of one and goes through here too, so there is a single
/// implementation of what an appearance does to a body rather than a fast one and a correct one.
///
/// The conditional reads stay conditional, and now for the whole batch: a gallery of nothing but
/// helms never opens `ComponentTextureFileData`, and a gallery of nothing but chestpieces never
/// opens the two model tables.
#[tracing::instrument(name = "worn.each", skip_all, fields(outfits = outfits.len()))]
pub fn each(files: &dyn GameFiles, body: &Body, outfits: &[&[Piece]]) -> Result<Vec<Worn>, String> {
    // Draw order before anything else, because everything below walks these lists in order and
    // the textures come out of them stacked. A stable sort, so pieces sharing a layer — the
    // shirt and the legs, the head and the feet — keep the order the set named them in.
    let layered: Vec<Vec<Piece>> = outfits
        .iter()
        .map(|pieces| {
            let mut pieces = pieces.to_vec();
            pieces.sort_by_key(|piece| layer_of(piece.display_type));
            pieces
        })
        .collect();
    let flat: Vec<Piece> = layered.iter().flatten().copied().collect();

    let materials = Db2::parse(files.read(ITEM_DISPLAY_INFO_MATERIAL_RES)?)?;
    let painted = sections(&materials, &flat);
    drop(materials);

    let displays = Db2::parse(files.read(ITEM_DISPLAY_INFO)?)?;
    let wanted: HashSet<u32> = flat.iter().map(|piece| piece.display_info_id).collect();
    let rows: HashMap<u32, Row<'_>> = displays
        .rows()
        .filter(|row| wanted.contains(&row.id()))
        .map(|row| (row.id(), row))
        .collect();

    // What each outfit asks for, resolved as far as the two tables above can take it. The files
    // behind the resources are looked up afterwards, because those tables are read for the whole
    // batch or not at all.
    let mut wanting: Vec<Wanted<'_>> = Vec::with_capacity(layered.len());
    let mut at = 0;
    for pieces in &layered {
        let paints = &painted[at..at + pieces.len()];
        at += pieces.len();
        // In draw order, and only the pieces this install can say anything about. A display in a
        // section the game encrypts drops out here and takes its geometry with it; whatever it
        // paints was already resolved above, because the two tables fail independently.
        let drawn: Vec<(Piece, &Row<'_>)> = pieces
            .iter()
            .filter_map(|piece| Some((*piece, rows.get(&piece.display_info_id)?)))
            .collect();
        wanting.push(Wanted {
            hangs: hangs_in(&drawn),
            cape: cape_in(&drawn),
            vis: helmet_vis(&drawn, body.helmet_slot()),
            paints,
            drawn,
        });
    }

    // Everything an item's *own* pictures are named by, which is one question asked of
    // `TextureFileData` for three different things: the body textures, the picture on a model,
    // and the picture on a cape. A wardrobe of chestpieces needs it once and a set needs it
    // once, rather than once per row of either — and a gallery once, rather than once per item.
    let any_painted = wanting.iter().any(Wanted::paints_anything);
    let textures = if wanting.iter().all(|outfit| {
        !outfit.paints_anything()
            && outfit.hangs.iter().all(|hung| hung.material == 0)
            && outfit.cape.is_none()
    }) {
        // Not worth opening for a batch that names no picture of its own anywhere:
        // `TextureFileData` is a row per texture the client owns.
        None
    } else {
        Some(TextureFiles::read(files)?)
    };
    let bodies = if any_painted {
        Some(bodies_in(files, COMPONENT_TEXTURE_FILE_DATA)?)
    } else {
        None
    };
    let models = if wanting.iter().any(|outfit| !outfit.hangs.is_empty()) {
        Some(ModelFiles::read(files)?)
    } else {
        None
    };
    let helmets = Helmets::read(
        files,
        body.race,
        wanting.iter().flat_map(|outfit| outfit.vis.iter()),
    )?;

    wanting
        .iter()
        .map(|outfit| {
            let painted = if outfit.paints_anything() {
                let named = textures
                    .as_ref()
                    .expect("a painted outfit opened the texture table");
                let bodies = bodies
                    .as_ref()
                    .expect("a painted outfit opened the body table");
                outfit
                    .paints
                    .iter()
                    .flatten()
                    .filter_map(|(section, material)| {
                        Some(ComponentTexture {
                            section: *section,
                            file: named.for_this_body(body, *material, bodies)?,
                        })
                    })
                    .collect()
            } else {
                Vec::new()
            };
            Ok(Worn {
                textures: painted,
                geosets: geosets_of(&outfit.drawn),
                models: models_of(body, models.as_ref(), &outfit.hangs, textures.as_ref()),
                cape: outfit.cape.and_then(|resource| {
                    textures
                        .as_ref()
                        .expect("a caped outfit opened the texture table")
                        .named(resource)
                }),
                hidden: helmets.hiding(&outfit.vis),
            })
        })
        .collect()
}

/// One outfit of a batch, as far as the two tables every outfit needs can take it.
struct Wanted<'a> {
    /// The pieces this install can say anything about, in draw order, with their display rows.
    drawn: Vec<(Piece, &'a Row<'a>)>,
    /// What each piece paints, in the order the pieces were handed over — including the empty
    /// lists of the pieces that paint nothing, because the caller's order is the draw order.
    paints: &'a [Vec<(u32, u32)>],
    hangs: Vec<Hung>,
    cape: Option<u32>,
    /// The `HelmetGeosetVis` entries of whatever heads it names.
    vis: HashSet<u32>,
}

impl Wanted<'_> {
    /// Whether anything in it paints any part of the body.
    fn paints_anything(&self) -> bool {
        !self.paints.iter().all(Vec::is_empty)
    }
}

/// One thing an outfit hangs off the body, before the files behind it have been looked up.
///
/// The model slot travels with the rest, because it is not only where the row's values are: it
/// is also which shoulder the model is for. See [`ModelFiles::file`].
struct Hung {
    slot: usize,
    attachment: u32,
    model: u32,
    material: u32,
}

/// Everything an outfit hangs off the body, in draw order and across every piece of it.
///
/// Both of a display's model slots, not the first: shoulders keep a left pad in one and a right
/// in the other, and showing one of them is the shape of an appearance that has half its
/// geometry. Which attachment each goes to is [`hangs_from`], and for armour it is the position
/// in the array rather than anything in the row that says which is which.
fn hangs_in(drawn: &[(Piece, &Row<'_>)]) -> Vec<Hung> {
    drawn
        .iter()
        .flat_map(|(piece, display)| {
            hangs_from(display, piece.display_type, piece.inventory_type)
                .into_iter()
                .map(move |(slot, attachment)| Hung {
                    slot,
                    attachment,
                    model: display.element(
                        display_column::MODEL_RESOURCES_ID,
                        slot,
                        MODEL_SLOT_BITS,
                    ),
                    material: display.element(
                        display_column::MATERIAL_RESOURCES_ID,
                        slot,
                        MODEL_SLOT_BITS,
                    ),
                })
        })
        .filter(|hung| hung.model != 0)
        .collect()
}

/// The `.m2`s behind those, narrowed to the copy this body and this side want.
///
/// The two model tables are read once for the whole batch or not at all: most of a wardrobe
/// hangs nothing off the body, and on a real install `ModelFileData` is a row per model the
/// client owns. So they arrive here already read, and `None` is a batch where nothing hangs.
fn models_of(
    body: &Body,
    models: Option<&ModelFiles>,
    hangs: &[Hung],
    textures: Option<&TextureFiles>,
) -> Vec<WornModel> {
    let Some(models) = models else {
        return Vec::new();
    };

    let mut found: Vec<WornModel> = Vec::with_capacity(hangs.len());
    for hung in hangs {
        let Some(file) = models.file(body, hung.model, hung.slot) else {
            continue;
        };
        let model = WornModel {
            attachment: hung.attachment,
            file,
            texture: match hung.material {
                0 => None,
                resource => textures
                    .expect("an outfit naming a model material opened the texture table")
                    .named(resource),
            },
        };
        // The same mesh, the same picture and the same place on the body, twice. The game
        // stores a set's repeated appearance as a copy of an earlier one — `TransmogSetItem`
        // does it rather than write the row again — so an outfit can genuinely name one helm
        // twice, and drawing it twice is two identical surfaces at one depth. That is the
        // z-fighting an assembled outfit is supposed to be free of.
        //
        // Note what this is *not*: deduplicating by slot. Two pieces of one slot with anything
        // different about them are both kept, and which of them owns a contested geoset group
        // is the priority table's business rather than this list's.
        if !found.contains(&model) {
            found.push(model);
        }
    }
    found
}

/// Which of the display's model slots hangs where, as `(model slot, attachment)`.
///
/// Armour and weaponry answer this differently, and the difference is the whole of what a
/// weapon adds. **A piece of armour is a slot with a fixed place**: a helm is model slot 0 on
/// attachment 11, a pair of shoulders is slot 0 on one shoulder and slot 1 on the other, and
/// which is which is [`SLOT_ATTACHMENTS`], indexed by the slot the appearance fills.
///
/// **A weapon is one model wherever the item is worn.** Its `DisplayType` says only that it is
/// a weapon, so the hand comes from the item's `InventoryType` — and a two-hander is one model
/// on one attachment rather than two, which is what taking a single slot here says. That slot
/// is the first one the display fills rather than element 0: a display keeps two, and reading
/// only the first would call a weapon that uses the second one flat.
fn hangs_from(display: &Row<'_>, display_type: u32, inventory_type: u32) -> Vec<(usize, u32)> {
    if let Some(attachments) = SLOT_ATTACHMENTS.get(display_type as usize) {
        return attachments
            .iter()
            .enumerate()
            .map(|(slot, attachment)| (slot, *attachment))
            .collect();
    }
    let Some(hand) = held_in(inventory_type) else {
        return Vec::new();
    };
    let filled = (0..MODEL_SLOTS)
        .find(|slot| {
            display.element(display_column::MODEL_RESOURCES_ID, *slot, MODEL_SLOT_BITS) != 0
        })
        .unwrap_or(0);
    vec![(filled, hand)]
}

/// `ModelFileData` and `ComponentModelFileData`, parsed: every `.m2` a resource names, and what
/// the game says about each of those files.
///
/// One read for a whole outfit. A set with a helm and a pair of shoulders asks this three
/// questions, and on a real install each of the two tables behind it is a row per model the
/// client owns.
pub(crate) struct ModelFiles {
    /// Every file each resource names, lowest first — which is the order the fallback leans on:
    /// the client numbers a model's coarser levels of detail above the model itself.
    candidates: HashMap<u32, Vec<u32>>,
    bodies: HashMap<u32, (u32, u32, u32)>,
    sides: HashMap<u32, u32>,
}

impl ModelFiles {
    #[tracing::instrument(name = "worn.model_files", skip_all)]
    pub(crate) fn read(files: &dyn GameFiles) -> Result<Self, String> {
        let table = Db2::parse(files.read(MODEL_FILE_DATA)?)?;
        let mut candidates: HashMap<u32, Vec<u32>> = HashMap::new();
        for row in table.rows() {
            candidates
                .entry(row.number(MODEL_RESOURCES_ID))
                .or_default()
                .push(row.id());
        }
        for named in candidates.values_mut() {
            named.sort_unstable();
        }

        let table = Db2::parse(files.read(COMPONENT_MODEL_FILE_DATA)?)?;
        let mut bodies: HashMap<u32, (u32, u32, u32)> = HashMap::new();
        let mut sides: HashMap<u32, u32> = HashMap::new();
        for row in table.rows() {
            bodies.insert(
                row.id(),
                (
                    row.number(component_column::GENDER),
                    row.number(component_column::CLASS),
                    row.number(component_column::RACE),
                ),
            );
            sides.insert(row.id(), row.number(component_column::POSITION));
        }
        Ok(Self {
            candidates,
            bodies,
            sides,
        })
    }

    /// The `.m2` a model resource names for the body this app draws, on the side it is worn.
    ///
    /// Two narrowings, and the game uses one or the other rather than both. **Per body**: a
    /// helm's resource names 31 files on 12.0.5.67, one per race and gender, and
    /// `ComponentModelFileData` is the only place saying which is which — [`for_this_body`], the
    /// same function the textures go through. **Per side**: a shoulder's resource names two, a
    /// left pad and its mirror, told apart by `PositionIndex` and by nothing else. `slot` is the
    /// model slot the resource came out of, and it *is* the side — element 0 of
    /// `ModelResourcesID` is the left pad and element 1 the right, which is what the two files'
    /// geometry says: position 0 leans towards the character's left and position 1 is the same
    /// mesh mirrored.
    ///
    /// Silence means what it means everywhere else here: a model nothing was said about is the
    /// fallback rather than a reject, which is what a weapon and a shield are.
    pub(crate) fn file(&self, body: &Body, resource: u32, slot: usize) -> Option<u32> {
        let mut candidates = self.candidates.get(&resource)?.clone();
        // A file modelled for the other shoulder is not a candidate at all, whatever body it is
        // for. A file with no side — every helm, and everything untagged — is one for any.
        let wanted = u32::try_from(slot).unwrap_or(0);
        candidates.retain(|file| match self.sides.get(file) {
            Some(side) if *side < SIDES => *side == wanted,
            _ => true,
        });
        for_this_body(body, &candidates, &self.bodies)
    }
}

/// The `.m2` a model resource names for this body, read on its own.
///
/// [`crate::models`] shows one appearance's geometry without a body under it, and asks this
/// exactly once — so it pays for the two tables rather than being handed them. Everything on a
/// character goes through [`ModelFiles`] instead.
pub fn model_file(
    files: &dyn GameFiles,
    body: &Body,
    resource: u32,
    slot: usize,
) -> Result<Option<u32>, String> {
    Ok(ModelFiles::read(files)?.file(body, resource, slot))
}

/// `TextureFileData`, parsed: every `.blp` each material resource names, lowest first.
///
/// One read for a whole outfit, and it answers the three different questions an outfit asks of
/// this one table — the pictures painted onto the body, the picture on a model that hangs off
/// it, and the picture on a cape.
pub(crate) struct TextureFiles(HashMap<u32, Vec<u32>>);

impl TextureFiles {
    #[tracing::instrument(name = "worn.texture_files", skip_all)]
    pub(crate) fn read(files: &dyn GameFiles) -> Result<Self, String> {
        let table = Db2::parse(files.read(TEXTURE_FILE_DATA)?)?;
        let mut named: HashMap<u32, Vec<u32>> = HashMap::new();
        for row in table.rows() {
            named
                .entry(row.number(MATERIAL_RESOURCES_ID))
                .or_default()
                .push(row.id());
        }
        for files in named.values_mut() {
            files.sort_unstable();
        }
        Ok(Self(named))
    }

    /// The one file a resource names, for the resources that name one thing.
    ///
    /// A resource can name more than one file — a texture and its second usage sit under the
    /// same id — and the client numbers a file's variants above the file itself, so the lowest
    /// is the one to draw. That is enough for an item's *own* picture, which is what a model and
    /// a cape want; a body texture is the next function, because the table saying which body a
    /// file was painted for is a different one.
    pub(crate) fn named(&self, resource: u32) -> Option<u32> {
        self.0.get(&resource)?.first().copied()
    }

    /// The one file a resource names that was painted for the body this app draws.
    fn for_this_body(
        &self,
        body: &Body,
        resource: u32,
        bodies: &HashMap<u32, (u32, u32, u32)>,
    ) -> Option<u32> {
        for_this_body(body, self.0.get(&resource)?, bodies)
    }
}

/// The picture a cape is painted with, which is not a model and not a body texture either.
///
/// The back slot is the one that has geometry without having a model: the body carries the
/// cloak itself as geoset group 15, and what an appearance supplies is only the picture on it —
/// out of `ModelMaterialResourcesID[0]`, and bound as M2 texture **type 2**, which is the type
/// the body's cape parts ask for and nothing else on it does. Read off 12.0.5.67:
/// `humanfemale_hd`'s geosets 1502 to 1510 are the only parts of the body on that type, and a
/// back display keeps both its model slots at zero and names a material anyway.
///
/// One cape per outfit, because one back: the first the set names, in draw order.
fn cape_in(drawn: &[(Piece, &Row<'_>)]) -> Option<u32> {
    drawn
        .iter()
        .filter(|(piece, _)| piece.display_type == BACK)
        .map(|(_, display)| {
            display.element(display_column::MATERIAL_RESOURCES_ID, 0, MODEL_SLOT_BITS)
        })
        .find(|resource| *resource != 0)
}

/// The geoset groups an outfit's helm hides on this body.
///
/// Not variants: a helm takes hair, ears or a beard away entirely, and what the table names is
/// the group rather than an id inside it. Which rows apply is the display's `HelmetGeosetVis`
/// through the relationship block, then the race — the table lists every race the game ships
/// under one vis id, and a reader that took them all would hide groups meant for a Draenei's
/// horns.
///
/// Every head the set names rather than one, and their groups together. A set holds one helm and
/// this costs nothing to say properly; hiding is the one thing here where two pieces cannot
/// disagree, because a group hidden by either is hidden.
fn helmet_vis(drawn: &[(Piece, &Row<'_>)], sex: usize) -> HashSet<u32> {
    drawn
        .iter()
        .filter(|(piece, _)| piece.display_type == HEAD)
        .map(|(_, display)| {
            display.element(display_column::HELMET_GEOSET_VIS, sex, MODEL_SLOT_BITS)
        })
        // 210 of the game's helms say zero here, and it means an open helm that hides nothing.
        .filter(|entry| *entry != 0)
        .collect()
}

/// `HelmetGeosetData`, parsed: which groups each `HelmetGeosetVis` takes off this body.
///
/// One read for the whole batch, and none at all when nothing in it is a helm — which is most of
/// a wardrobe. The race narrowing happens here rather than at the far end: the table lists every
/// race the game ships under one vis id, and a reader that took them all would hide groups meant
/// for a Draenei's horns.
struct Helmets(HashMap<u32, Vec<u16>>);

impl Helmets {
    #[tracing::instrument(name = "worn.helmets", skip_all)]
    fn read<'a>(
        files: &dyn GameFiles,
        race: u32,
        wanted: impl Iterator<Item = &'a u32>,
    ) -> Result<Self, String> {
        let wanted: HashSet<u32> = wanted.copied().collect();
        if wanted.is_empty() {
            return Ok(Self(HashMap::new()));
        }
        let table = Db2::parse(files.read(HELMET_GEOSET_DATA)?)?;
        let mut hiding: HashMap<u32, Vec<u16>> = HashMap::new();
        for row in table.rows().filter(|row| {
            wanted.contains(&row.foreign_id()) && row.number(helmet_column::RACE) == race
        }) {
            let Ok(group) = u16::try_from(row.number(helmet_column::HIDE_GEOSET_GROUP)) else {
                continue;
            };
            hiding.entry(row.foreign_id()).or_default().push(group);
        }
        Ok(Self(hiding))
    }

    /// The groups those vis entries hide between them, sorted and without repeats.
    fn hiding(&self, vis: &HashSet<u32>) -> Vec<u16> {
        let mut groups: Vec<u16> = vis
            .iter()
            .filter_map(|entry| self.0.get(entry))
            .flatten()
            .copied()
            .collect();
        groups.sort_unstable();
        groups.dedup();
        groups
    }
}

/// The sections each piece of an outfit paints, as `(section, material resource)`.
///
/// In section order within a piece, so that an atlas is composited the same way twice. The
/// game does not order the rows, and two appearances that paint the same parts should not
/// differ by the order their rows happen to sit in. Between pieces the order is the one they
/// arrive in, which is the draw order — [`SLOT_LAYER`], and not this.
///
/// **The whole outfit at once, and once.** `Db2::rows` builds a `Vec` of every row and a map of
/// every row id before it yields the first one, so a walk costs the whole table however few
/// rows the caller keeps — and this table has 604,000 of them. Asked a piece at a time, an
/// eight-piece set walked 4.8 million rows to keep about twenty; asked once, it walks 604,000.
/// The same set may name one appearance twice, which is why what comes back is per piece rather
/// than per display id.
#[tracing::instrument(name = "worn.sections", skip_all, fields(pieces = pieces.len()))]
fn sections(table: &Db2, pieces: &[Piece]) -> Vec<Vec<(u32, u32)>> {
    let wanted: HashSet<u32> = pieces.iter().map(|piece| piece.display_info_id).collect();
    let mut found: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
    for row in table
        .rows()
        .filter(|row| wanted.contains(&row.foreign_id()))
    {
        let material = row.number(material_column::MATERIAL_RESOURCES_ID);
        if material == 0 {
            continue;
        }
        found
            .entry(row.foreign_id())
            .or_default()
            .push((row.number(material_column::COMPONENT_SECTION), material));
    }
    for sections in found.values_mut() {
        sections.sort_by_key(|(section, _)| *section);
    }
    pieces
        .iter()
        .map(|piece| {
            found
                .get(&piece.display_info_id)
                .cloned()
                .unwrap_or_default()
        })
        .collect()
}

/// Which body each file in a component table belongs to, keyed by the file's own FileDataID.
///
/// One function for two tables: `ComponentTextureFileData` and `ComponentModelFileData` are
/// the same three columns keyed the same way, and the only difference between them is whether
/// the file behind the id is a picture or a mesh.
#[tracing::instrument(name = "worn.bodies_in", skip_all, fields(table = table))]
fn bodies_in(files: &dyn GameFiles, table: u32) -> Result<HashMap<u32, (u32, u32, u32)>, String> {
    let table = Db2::parse(files.read(table)?)?;
    Ok(table
        .rows()
        .map(|row| {
            (
                row.id(),
                (
                    row.number(component_column::GENDER),
                    row.number(component_column::CLASS),
                    row.number(component_column::RACE),
                ),
            )
        })
        .collect())
}

/// Which of a resource's files was made for the body this app draws.
///
/// Following wow.export's `DBComponentTextureFileData`: a candidate is in the running when its
/// gender is this one or "any" and its class is this one or "any", and among those the more
/// specific wins — a female texture over a generic one, then a class match, then a race match.
///
/// A candidate the table says nothing about is the fallback rather than a reject, and it is
/// what most of the game's armour is: one texture, no row, worn by everybody. On the model
/// side it is what a weapon and a shield are — geometry nobody modelled twice.
///
/// `candidates` is in ascending order, which is what the fallback leans on: the client numbers
/// a file's variants above the file itself.
fn for_this_body(
    body: &Body,
    candidates: &[u32],
    bodies: &HashMap<u32, (u32, u32, u32)>,
) -> Option<u32> {
    let mut best: Option<(u32, u32)> = None;
    for file in candidates {
        let Some((gender, class, race)) = bodies.get(file).copied() else {
            continue;
        };
        // No class at all, so a file kept for one is somebody else's.
        let gendered = gender == body.sex || gender == ANY_GENDER || gender == NO_GENDER;
        if !gendered || class != ANY_CLASS {
            continue;
        }
        let rank = u32::from(gender == body.sex) * 2 + u32::from(race == body.race);
        if best.is_none_or(|(chosen, _)| rank > chosen) {
            best = Some((rank, *file));
        }
    }
    best.map(|(_, file)| file).or_else(|| {
        candidates
            .iter()
            .find(|file| !bodies.contains_key(file))
            .copied()
    })
}

/// The one geoset per group an outfit ends up switching on, with the contests settled.
///
/// Every piece states what it wants of every group its slot drives, and then each group is
/// awarded once. A group only one piece drives is that piece's, which is every group of a set
/// with one item in it and most groups of a set with twelve. A group two pieces drive goes
/// through [`GEOSET_PRIORITY`], and the loser's value is dropped rather than kept beside the
/// winner's — a group with two values in it is two pairs of legs in the same trousers.
///
/// The order is the order the groups were first claimed, walking the pieces in draw order. What
/// that buys is only that the answer is the same twice; nothing downstream reads it as an order.
fn geosets_of(drawn: &[(Piece, &Row<'_>)]) -> Vec<Geoset> {
    let claims: Vec<(u32, Geoset)> = drawn
        .iter()
        .flat_map(|(piece, display)| {
            drives(display, piece.display_type)
                .into_iter()
                .map(move |geoset| (piece.display_type, geoset))
        })
        .collect();

    let mut awarded: Vec<Geoset> = Vec::new();
    for (_, claimed) in &claims {
        if awarded.iter().any(|geoset| geoset.group == claimed.group) {
            continue;
        }
        awarded.push(owner_of(claimed.group, &claims));
    }
    awarded
}

/// Which piece's value a group takes, out of everything claiming it.
///
/// The first slot in the group's priority list that claims it at all, exactly as the game
/// resolves it. A group with no list, or a list none of the claimants is in, falls back to the
/// first claim — because the alternative is a group driven by an item and awarded to nobody,
/// and the whole floor under this pipeline is that priority decides *which* item owns a group
/// and never that a group goes unowned.
fn owner_of(group: u16, claims: &[(u32, Geoset)]) -> Geoset {
    let claiming = |slot: u32| {
        claims
            .iter()
            .find(|(claimed, geoset)| geoset.group == group && *claimed == slot)
    };
    GEOSET_PRIORITY
        .iter()
        .find(|(contested, _)| *contested == group)
        .and_then(|(_, order)| order.iter().find_map(|slot| claiming(*slot)))
        .or_else(|| claims.iter().find(|(_, geoset)| geoset.group == group))
        .map(|(_, geoset)| *geoset)
        .expect("the group was claimed by something")
}

/// The geosets one display asks for, for the slot it is worn in.
///
/// A group the row says nothing about still gets an answer: value 0 is every group's bare
/// default, so an item that drives five groups and fills two of them puts the other three
/// back where a bare body had them. What drops out entirely is a group whose value cannot be
/// one — see [`LARGEST_VALUE`].
fn drives(display: &Row<'_>, display_type: u32) -> Vec<Geoset> {
    let groups = SLOT_GROUPS
        .get(display_type as usize)
        .copied()
        .unwrap_or(&[]);
    groups
        .iter()
        .take(GEOSET_GROUPS)
        .enumerate()
        .filter_map(|(index, group)| {
            let value = display.element(display_column::GEOSET_GROUP, index, GEOSET_GROUP_BITS);
            Some(Geoset {
                group: *group,
                geoset: geoset_of(*group, value)?,
            })
        })
        .collect()
}

/// The geoset id a group and a value name, or nothing when the value is not one.
///
/// `group × 100 + (1 + value)` everywhere but the two groups that count from the item's own
/// presence rather than from the body's — see [`FEET`] and [`HELM`].
fn geoset_of(group: u16, value: u32) -> Option<u16> {
    if value > LARGEST_VALUE {
        return None;
    }
    let value = value as u16;
    Some(match (group, value) {
        (FEET, 0) => BOOTED,
        (HELM, 0) => HELMETED,
        (FEET | HELM, value) => group * 100 + value,
        _ => group * 100 + 1 + value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// The body an appearance is being read for, which is what says which of a resource's
    /// files it wears and which groups a helm takes off it.
    fn hers() -> Body {
        crate::body::of(&fixture_files(), crate::body::DEFAULT).unwrap()
    }

    /// The fixture displays, by what the generator made each of them.
    const HELM_DISPLAY: u32 = 900001;
    const SHOULDERS: u32 = 900002;
    const CHESTPIECE: u32 = 900003;
    /// The weapon rack: a one-hander, a second model for the two-hander, and a shield whose
    /// only model sits in the display's second slot.
    const WEAPON: u32 = 900007;
    const SECOND_WEAPON: u32 = 900014;
    const SECOND_SLOT_WEAPON: u32 = 900015;
    const CAPE: u32 = 900013;
    const BOOTS: u32 = 900004;
    const GLOVES: u32 = 900005;
    const SHIRT: u32 = 900008;
    const ROBE: u32 = 900012;
    const LEGS: u32 = 900006;
    /// A display in a section the game encrypts, so nothing can be read about it.
    const WITHHELD: u32 = 900900;

    /// The slots those displays are worn in, as an install numbers them — which is not how
    /// the community's list does: a shirt is 2 and a chestpiece 3.
    const CHEST: u32 = 3;
    const FEET_SLOT: u32 = 6;
    const HANDS: u32 = 8;
    const SHIRT_SLOT: u32 = 2;
    const SHOULDER: u32 = 1;
    const BACK_SLOT: u32 = 9;
    const LEGS_SLOT: u32 = 5;
    /// The three slots the game files a weapon or a shield under, and the whole of what they
    /// say: 11 is a sword and a two-hander alike, 13 a shield, 15 a thing held in an off hand.
    const WEAPON_SLOT: u32 = 11;
    const SHIELD_SLOT: u32 = 13;
    const OFF_HAND_SLOT: u32 = 15;

    /// Where the game says each of those is worn, which is the half `DisplayType` leaves out.
    const ONE_HAND: u32 = 13;
    const TWO_HAND: u32 = 17;
    const A_SHIELD: u32 = 14;
    const HELD_IN_OFF_HAND: u32 = 23;
    /// Arrows, which are the one thing the game files under a weapon slot and nothing holds.
    const AMMO: u32 = 24;

    fn worn(display_info_id: u32, display_type: u32) -> Worn {
        of(
            &fixture_files(),
            &hers(),
            display_info_id,
            display_type,
            NOT_A_WEAPON,
        )
        .unwrap()
    }

    /// The same for a weapon, which needs the one thing its slot does not say.
    fn held(display_info_id: u32, display_type: u32, inventory_type: u32) -> Worn {
        of(
            &fixture_files(),
            &hers(),
            display_info_id,
            display_type,
            inventory_type,
        )
        .unwrap()
    }

    /// What an item that is not held in a hand says about where it is worn, which is nothing.
    const NOT_A_WEAPON: u32 = 0;

    fn painted(worn: &Worn) -> Vec<(u32, u32)> {
        worn.textures
            .iter()
            .map(|texture| (texture.section, texture.file))
            .collect()
    }

    fn switched(worn: &Worn) -> Vec<u16> {
        worn.geosets.iter().map(|geoset| geoset.geoset).collect()
    }

    // The chain the module exists for: a display id becomes a picture per part of the body,
    // and the geosets that make room for it.
    #[test]
    fn reads_what_an_appearance_paints_and_what_it_switches_on() {
        let chestpiece = worn(CHESTPIECE, CHEST);
        assert_eq!(
            painted(&chestpiece),
            vec![
                (0, 151_003), // upper arms
                (1, 151_004), // lower arms
                (3, 151_002), // upper torso
                (4, 151_005), // lower torso
            ]
        );
        // Sleeves over the bare arms, and a chest over the bare torso. The three groups a
        // chestpiece drives and this one does not fill stay at their defaults.
        assert_eq!(switched(&chestpiece), vec![802, 1002, 1301, 2201, 2801]);
    }

    // The trap in `TextureFileData`: a material names a texture per body, and the one this app
    // wants is not the first, not the last and not the lowest — it is the one another table
    // says is female. 151001 is the same material's other picture.
    #[test]
    fn paints_the_body_it_draws_rather_than_the_first_texture_the_material_names() {
        let torso = worn(CHESTPIECE, CHEST)
            .textures
            .into_iter()
            .find(|texture| texture.section == 3)
            .expect("the chestpiece paints the upper torso");
        assert_eq!(torso.file, 151_002);
    }

    // Most of the game's armour has no row in `ComponentTextureFileData` at all. Silence is
    // not exclusion: read as such it would leave a character in nothing but the two or three
    // textures the game happened to annotate.
    #[test]
    fn uses_a_texture_no_table_says_a_body_for() {
        // The chestpiece's lower arms have no row in that table, and the robe's upper legs
        // have one in a section this install cannot decrypt — which arrives the same way.
        assert!(painted(&worn(CHESTPIECE, CHEST)).contains(&(1, 151_004)));
        assert!(painted(&worn(ROBE, CHEST)).contains(&(5, 151_007)));
    }

    // A texture marked as fitting any body is as good as one marked female, and better than
    // nothing: it is how the game annotates a picture it painted once for everybody.
    #[test]
    fn takes_a_texture_the_game_marks_as_fitting_any_body() {
        assert!(painted(&worn(ROBE, CHEST)).contains(&(3, 151_006)));
    }

    // The other side of the same table: a material whose only texture was painted for a body
    // this is not leaves that section unpainted, rather than dressing a Human Female in it.
    #[test]
    fn paints_nothing_where_the_only_texture_belongs_to_another_body() {
        let gloves = worn(GLOVES, HANDS);
        assert_eq!(painted(&gloves), vec![]);
        // The groups it drives are still read and still answered for: whether this particular
        // body holds geometry for them is the compositor's business, not this module's.
        assert_eq!(switched(&gloves), vec![402, 2301]);
    }

    // The robe is the one that says the groups are worth getting right: same slot as the
    // chestpiece, and it leaves the chest bare to hang a skirt over the legs instead.
    #[test]
    fn switches_a_robe_on_where_a_chestpiece_switches_a_chest_on() {
        assert_eq!(
            switched(&worn(ROBE, CHEST)),
            vec![802, 1001, 1302, 2201, 2801]
        );
        assert_eq!(
            painted(&worn(ROBE, CHEST)),
            vec![(3, 151_006), (5, 151_007), (6, 151_008)]
        );
    }

    // Boots are the exception the game writes into the feet group: a zero there means booted,
    // not bare, and the ordinary formula would put bare feet inside a pair of boots. They are
    // also what says every group of a slot is applied rather than only the first.
    #[test]
    fn reads_a_zero_in_the_feet_group_as_booted_rather_than_bare() {
        assert_eq!(switched(&worn(BOOTS, FEET_SLOT)), vec![502, 2002]);
    }

    // The same exception on the helm group, and the other thing a helm row carries: -1, which
    // the game writes where a display drives no geoset at all. Read as a value it would ask
    // the body for a skull it has no number for.
    #[test]
    fn reads_a_helm_the_same_way_and_drops_the_group_it_says_nothing_for() {
        let helm = worn(HELM_DISPLAY, HEAD);
        assert_eq!(switched(&helm), vec![2702]);
        assert_eq!(
            helm.geosets
                .iter()
                .map(|geoset| geoset.group)
                .collect::<Vec<u16>>(),
            vec![27]
        );
    }

    // The formula itself, at the edges. A value that cannot be one is the difference between
    // leaving a group alone and asking the body for geometry that was never in it.
    #[test]
    fn turns_a_group_and_a_value_into_the_id_the_game_numbers_it_by() {
        assert_eq!(geoset_of(8, 0), Some(801));
        assert_eq!(geoset_of(8, 1), Some(802));
        assert_eq!(geoset_of(13, 1), Some(1302));
        assert_eq!(geoset_of(20, 0), Some(2002));
        assert_eq!(geoset_of(20, 5), Some(2005));
        assert_eq!(geoset_of(27, 0), Some(2702));
        assert_eq!(geoset_of(27, 3), Some(2703));
        // -1, as a column read unsigned hands it over, and the first value too large to be one.
        assert_eq!(geoset_of(27, u32::MAX), None);
        assert_eq!(geoset_of(8, 99), None);
    }

    // A wrist has no geoset group in the community's table and a shirt is not in it at all,
    // so both are texture and nothing else. Inventing a group for either would swap geometry
    // out of a body on a guess.
    #[test]
    fn switches_nothing_on_for_a_slot_that_drives_no_group() {
        assert_eq!(switched(&worn(SHIRT, SHIRT_SLOT)), Vec::<u16>::new());
        // The shirt still paints: its texture is a file this install does not hold, which is
        // a fact about the install rather than about the tables, and the section stands.
        assert_eq!(painted(&worn(SHIRT, SHIRT_SLOT)), vec![(3, 151_013)]);
    }

    // Section 8 has no rectangle in the layout this app draws, and the rows exist anyway. They
    // are resolved here like any other; where they land is the compositor's problem.
    #[test]
    fn keeps_a_section_the_layout_has_nowhere_to_put() {
        assert!(painted(&worn(BOOTS, FEET_SLOT)).contains(&(8, 151_011)));
    }

    // The game encrypts the displays of content it has not shipped, and an appearance can name
    // a display this build's tables do not hold at all. Neither is a failure: there is nothing
    // to wear, and the row still has its icon.
    #[test]
    fn answers_with_nothing_for_a_display_it_cannot_read() {
        assert!(worn(WITHHELD, CHEST).is_empty());
        assert!(worn(404_040, CHEST).is_empty());
    }

    /* ---------- the geometry an appearance hangs off the body ---------- */

    // A helm is one model on one attachment, and the file behind it is the one modelled for
    // this body: 139001 is the same helm for a Human Male and is numbered *below* it, so the
    // lowest-id rule that is right for a level of detail puts a man's helm on her.
    #[test]
    fn hangs_a_helm_off_the_head_and_takes_the_one_modelled_for_this_body() {
        assert_eq!(
            worn(HELM_DISPLAY, HEAD).models,
            vec![WornModel {
                attachment: 11,
                file: 140_001,
                texture: Some(150_004),
            }]
        );
    }

    // Both pads, on the two attachments, out of the two model slots — and the file for each is
    // the one modelled for *that side*. A resource holds a pad and its mirror, and the game
    // tells them apart by `PositionIndex` and by nothing else, so a reader that took the lowest
    // id would put two left pauldrons on her and a reader that stopped at the first slot would
    // give her one.
    #[test]
    fn hangs_a_pad_off_each_shoulder_and_takes_the_one_for_that_side() {
        assert_eq!(
            worn(SHOULDERS, SHOULDER).models,
            vec![
                WornModel {
                    attachment: 6,
                    file: 140_002,
                    texture: Some(150_002)
                },
                WornModel {
                    attachment: 5,
                    file: 140_006,
                    texture: Some(150_007)
                },
            ]
        );
    }

    // The other half of the same table, and the one the game actually uses for a pauldron: a
    // shoulder model is marked gender 2, "none", because it belongs to a side rather than to a
    // body. Read as "not this body" — which is what "not female and not any" comes to — there
    // is not a pauldron in the game.
    #[test]
    fn keeps_a_model_the_game_marks_as_belonging_to_no_gender() {
        let bodies = bodies_in(&fixture_files(), COMPONENT_MODEL_FILE_DATA).unwrap();
        assert_eq!(bodies.get(&140_002), Some(&(NO_GENDER, 0, 0)));
        assert_eq!(for_this_body(&hers(), &[140_002], &bodies), Some(140_002));
    }

    // A slot with no attachment of its own hangs nothing, however much geometry the display
    // names — and most of a wardrobe is that, which is why the tables behind this are not
    // opened for it at all.
    #[test]
    fn hangs_nothing_off_a_slot_that_has_no_attachment() {
        assert_eq!(worn(CHESTPIECE, CHEST).models, vec![]);
        // A weapon whose item the game says nothing about is the same answer arrived at the
        // other way: the slot has an attachment and nothing says which one.
        assert_eq!(worn(WEAPON, WEAPON_SLOT).models, vec![]);
    }

    /* ---------- the hand a weapon is held in ---------- */

    // The whole of what this adds, in one sentence: the *same* display, filed under the same
    // kind of slot, goes in a different hand depending on where the game says the item is
    // worn. Nothing in `ItemDisplayInfo` differs between these two reads.
    #[test]
    fn puts_a_one_hander_in_her_right_hand_and_an_off_hand_in_her_left() {
        assert_eq!(
            held(WEAPON, WEAPON_SLOT, ONE_HAND).models,
            vec![WornModel {
                attachment: 1,
                file: 140_004,
                texture: Some(150_005)
            }]
        );
        assert_eq!(
            held(WEAPON, OFF_HAND_SLOT, HELD_IN_OFF_HAND).models,
            vec![WornModel {
                attachment: 2,
                file: 140_004,
                texture: Some(150_005)
            }]
        );
    }

    // A two-hander is one model on one attachment and not two, which is the trap in holding
    // something with both hands: it is still the main hand that carries it.
    #[test]
    fn holds_a_two_hander_in_one_hand_rather_than_two() {
        assert_eq!(
            held(SECOND_WEAPON, WEAPON_SLOT, TWO_HAND).models,
            vec![WornModel {
                attachment: 1,
                file: 140_005,
                texture: Some(150_003)
            }]
        );
    }

    // And a shield is not an off-hand weapon: it hangs off attachment 0, which on the real
    // body is a bone on the forearm rather than in the hand. This display is also the one
    // whose only model sits in the *second* slot — a weapon has one model and either slot can
    // hold it, so a reader that took element 0 would call this shield flat.
    #[test]
    fn hangs_a_shield_off_the_arm_rather_than_out_of_a_hand() {
        assert_eq!(
            held(SECOND_SLOT_WEAPON, SHIELD_SLOT, A_SHIELD).models,
            vec![WornModel {
                attachment: 0,
                file: 140_004,
                texture: Some(150_005)
            }]
        );
    }

    // The table itself, and the three things it has to keep apart. Everything a hand holds is
    // one of two hands; a shield is neither; and arrows are the game's own reminder that a
    // weapon slot is not the same as something being held.
    #[test]
    fn says_which_hand_each_kind_of_weapon_is_worn_in() {
        for right in [ONE_HAND, TWO_HAND, 21, 25, 26, 29] {
            assert_eq!(held_in(right), Some(1), "{right} is worn in the right hand");
        }
        for left in [22, HELD_IN_OFF_HAND, 15, 30] {
            assert_eq!(held_in(left), Some(2), "{left} is worn in the left hand");
        }
        assert_eq!(held_in(A_SHIELD), Some(0));
        // And the two silences: ammo, and the zero an item the game withholds arrives as.
        assert_eq!(held_in(AMMO), None);
        assert_eq!(held_in(0), None);
    }

    // A weapon switches no geometry on the body and paints none of it, which is what says the
    // hand is the whole of what it does. `ItemDisplayInfoMaterialRes` holds nothing for one.
    #[test]
    fn a_weapon_is_geometry_and_nothing_else() {
        let sword = held(WEAPON, WEAPON_SLOT, ONE_HAND);
        assert_eq!(painted(&sword), vec![]);
        assert_eq!(switched(&sword), Vec::<u16>::new());
        assert_eq!(sword.hidden, Vec::<u16>::new());
        assert_eq!(sword.cape, None);
        assert!(!sword.is_empty(), "there is still a sword to show");
    }

    // The back is the slot with geometry and no model at all: the cloak is the body's own, and
    // what the appearance supplies is the picture that goes on it. Both model slots are zero
    // and the material is read anyway.
    #[test]
    fn gives_a_cape_a_picture_rather_than_a_model() {
        let cape = worn(CAPE, BACK_SLOT);
        assert_eq!(cape.models, vec![]);
        assert_eq!(cape.cape, Some(150_006));
        // And the geoset that is the cloak itself, which is what the picture goes on.
        assert_eq!(switched(&cape), vec![1502]);
        // Nothing else in the game asks for one, so nothing else answers with one.
        assert_eq!(worn(HELM_DISPLAY, HEAD).cape, None);
        assert_eq!(worn(CHESTPIECE, CHEST).cape, None);
    }

    /* ---------- what a helm takes away ---------- */

    // The groups a helm covers up, which is the one thing here that removes geometry. Group 0
    // is the hair, and it is the only group this helm's own gender-entry names.
    #[test]
    fn reads_the_groups_a_helm_hides_on_this_body() {
        assert_eq!(worn(HELM_DISPLAY, HEAD).hidden, vec![0]);
    }

    // Two ways of reading the same table wrong, and the fixture is built so that either one
    // hides the robe group instead — a skirt that vanishes rather than an error.
    //
    // `HelmetGeosetVis` is two entries, one per gender, and this app draws one of them. And the
    // rows under an entry cover every race the game ships, so the race has to be matched as
    // well: the fixture's entry for this helm names group 0 for a Human and group 13 for
    // somebody else.
    #[test]
    fn takes_the_entry_for_this_body_and_the_rows_for_this_race() {
        assert!(!worn(HELM_DISPLAY, HEAD).hidden.contains(&13));
    }

    // Nothing but a helm hides anything, whatever the column happens to hold for it — and a
    // helm whose entry is zero is an open one, which 210 of the game's helms are.
    #[test]
    fn hides_nothing_for_an_appearance_that_is_not_a_helm() {
        assert_eq!(worn(SHOULDERS, SHOULDER).hidden, Vec::<u16>::new());
        assert_eq!(worn(CHESTPIECE, CHEST).hidden, Vec::<u16>::new());
        // The helm read as though it were worn somewhere else, which is the same question
        // asked of the same row and has to come back empty.
        assert_eq!(
            of(&fixture_files(), &hers(), HELM_DISPLAY, CHEST, NOT_A_WEAPON)
                .unwrap()
                .hidden,
            Vec::<u16>::new()
        );
    }

    #[test]
    fn says_so_when_the_chain_starts_at_a_table_that_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = of(
            &DirFiles::new(temp.path()),
            &hers(),
            CHESTPIECE,
            CHEST,
            NOT_A_WEAPON,
        )
        .unwrap_err();
        assert!(error.contains("1280614.db2"), "{error}");
    }

    /* ---------- a whole outfit, and the arguments between its pieces ---------- */

    /// An outfit, out of the fixture's own tables. Each piece is a display and the slot it
    /// fills; nothing here is a weapon, so nothing needs the third number.
    fn outfit(pieces: &[(u32, u32)]) -> Worn {
        let pieces: Vec<Piece> = pieces
            .iter()
            .map(|(display_info_id, display_type)| Piece {
                display_info_id: *display_info_id,
                display_type: *display_type,
                inventory_type: NOT_A_WEAPON,
            })
            .collect();
        of_set(&fixture_files(), &hers(), &pieces).unwrap()
    }

    // The acceptance, and the one contest this app's slot table can actually stage: a robe and
    // a pair of legs both drive group 13, and the game's answer is that the chest owns it.
    //
    // The two values are what makes this a test rather than a coincidence. The robe asks for
    // 1302, the skirt that hangs over the legs; the legs ask for 1301, which is the nothing
    // that is there the rest of the time. And the legs are laid down *first*, because their
    // slot composites below the chest's — so a reader that took the first claim, or the last,
    // would answer 1301 and the skirt would simply not be there.
    #[test]
    fn gives_a_contested_group_to_the_slot_the_game_puts_first() {
        for order in [
            [(ROBE, CHEST), (LEGS, LEGS_SLOT)],
            [(LEGS, LEGS_SLOT), (ROBE, CHEST)],
        ] {
            let dressed = outfit(&order);
            assert_eq!(
                dressed
                    .geosets
                    .iter()
                    .filter(|geoset| geoset.group == 13)
                    .count(),
                1,
                "a group with two values in it is two skirts on one pair of legs"
            );
            assert!(
                dressed.geosets.contains(&Geoset {
                    group: 13,
                    geoset: 1302
                }),
                "the robe lost group 13 to the legs, given {order:?}: {:?}",
                dressed.geosets
            );
        }
    }

    // And the other half of the same sentence: winning group 13 wins that group and nothing
    // else. The legs keep every group the chest does not drive at all — a robe does not take
    // the trousers away, it hangs over them.
    #[test]
    fn leaves_every_group_only_one_piece_drives_with_that_piece() {
        let dressed = outfit(&[(ROBE, CHEST), (LEGS, LEGS_SLOT)]);
        let switched: Vec<(u16, u16)> = dressed
            .geosets
            .iter()
            .map(|geoset| (geoset.group, geoset.geoset))
            .collect();
        assert_eq!(
            switched,
            vec![
                (11, 1104), // the legs' trousers, which nothing else claims
                (9, 901),   // and their kneepads
                (13, 1302), // the group the two of them fought over
                (8, 802),   // the robe's sleeves
                (10, 1001), // the chest it leaves bare
                (22, 2201),
                (28, 2801),
            ]
        );
    }

    // The whole table, stated as a pair of lists rather than as one contest. Every group this
    // app's slots drive is in it, and the order inside a row is what decides an argument — so
    // this is what a patch to either list has to be read against.
    #[test]
    fn says_which_slot_owns_each_group_two_slots_can_both_drive() {
        // The three rows that can fire at all, given what the slots drive.
        assert_eq!(
            owner(8, &[(3, 802), (2, 801)]),
            802,
            "the chest beats the shirt"
        );
        assert_eq!(owner(8, &[(2, 801), (8, 803)]), 803, "and gloves beat both");
        assert_eq!(owner(10, &[(2, 1001), (3, 1002)]), 1002);
        assert_eq!(owner(13, &[(5, 1301), (3, 1302)]), 1302);
        // A group only one slot drives is that slot's, whichever way round it is asked.
        assert_eq!(owner(27, &[(0, 2702)]), 2702);
        assert_eq!(owner(20, &[(6, 2002)]), 2002);
        // And a group claimed by a slot the table does not list under it falls back to the
        // claim rather than to nothing. Nothing in this app reaches it, and what it rules out
        // is a group an item drives and nobody owns — which is a limb that goes missing.
        assert_eq!(owner(13, &[(9, 1303)]), 1303);
    }

    /// [`owner_of`] as the test above reads it: the claims as `(slot, geoset)`.
    fn owner(group: u16, claims: &[(u32, u16)]) -> u16 {
        let claims: Vec<(u32, Geoset)> = claims
            .iter()
            .map(|(slot, geoset)| {
                (
                    *slot,
                    Geoset {
                        group,
                        geoset: *geoset,
                    },
                )
            })
            .collect();
        owner_of(group, &claims).geoset
    }

    // The draw order, on the one pair of fixture appearances that paint the same rectangle: a
    // robe's lower legs and a pair of boots' both land in section 6, and boots composite below
    // the chest. So the boots' picture goes down first and the robe's over it — whichever order
    // the set happened to name the two in, which is what the second half of this reads.
    #[test]
    fn lays_the_pieces_down_in_the_order_their_slots_composite_in() {
        for order in [
            [(ROBE, CHEST), (BOOTS, FEET_SLOT)],
            [(BOOTS, FEET_SLOT), (ROBE, CHEST)],
        ] {
            let painted = painted(&outfit(&order));
            let boots = painted
                .iter()
                .position(|(section, _)| *section == 7)
                .expect("the feet");
            let robe = painted
                .iter()
                .position(|(section, _)| *section == 5)
                .expect("the legs");
            assert!(boots < robe, "given {order:?}: {painted:?}");

            // And the two that overlap, in that order: 151010 is the boots' lower legs and
            // 151008 the robe's, so the robe's is the one a reader ends up seeing.
            let contested: Vec<u32> = painted
                .iter()
                .filter(|(section, _)| *section == 6)
                .map(|(_, file)| *file)
                .collect();
            assert_eq!(contested, vec![151_010, 151_008], "given {order:?}");
        }
    }

    // The layer table itself, at the places it is not the obvious order. A cape goes over
    // everything and trousers go under everything, and neither is the order the slots are
    // numbered in — which is what the app would fall back to if the table were dropped.
    #[test]
    fn stacks_the_slots_the_way_the_game_composites_them() {
        let mut slots: Vec<u32> = (0..11).collect();
        slots.sort_by_key(|slot| layer_of(*slot));
        assert_eq!(slots, vec![2, 5, 0, 6, 1, 3, 10, 4, 7, 8, 9]);
        // A weapon has no layer of its own and lands at the bottom, which costs nothing: it
        // paints no part of the body, so it never shares a rectangle with anything.
        assert_eq!(layer_of(WEAPON_SLOT), layer_of(SHIRT_SLOT));
    }

    // Everything with geometry keeps it, across the whole outfit: a helm on her head and a pad
    // on each shoulder is three models from two pieces.
    #[test]
    fn hangs_the_geometry_of_every_piece_that_has_any() {
        let dressed = outfit(&[
            (HELM_DISPLAY, HEAD),
            (SHOULDERS, SHOULDER),
            (CHESTPIECE, CHEST),
        ]);
        assert_eq!(
            dressed.models,
            vec![
                WornModel {
                    attachment: 11,
                    file: 140_001,
                    texture: Some(150_004)
                },
                WornModel {
                    attachment: 6,
                    file: 140_002,
                    texture: Some(150_002)
                },
                WornModel {
                    attachment: 5,
                    file: 140_006,
                    texture: Some(150_007)
                },
            ]
        );
        // And what a helm takes away is taken away from the outfit, not from the helm.
        assert_eq!(dressed.hidden, vec![0]);
    }

    // The game stores a set's repeated appearance as a copy of an earlier row rather than
    // writing it again, so an outfit can genuinely name one helm twice. Hanging it twice is two
    // identical surfaces at one depth, which is the z-fighting an assembled outfit is meant to
    // be free of — and this is *not* a deduplication by slot, which would drop a second piece
    // that had anything different about it.
    #[test]
    fn hangs_an_appearance_a_set_names_twice_once() {
        let once = outfit(&[(HELM_DISPLAY, HEAD)]);
        let twice = outfit(&[(HELM_DISPLAY, HEAD), (HELM_DISPLAY, HEAD)]);
        assert_eq!(twice.models, once.models);
        assert_eq!(twice.geosets, once.geosets);
    }

    // The arithmetic the whole restructure is for. Twelve appearances read one at a time is
    // twelve parses of the four largest tables on this chain, and on a real install that is
    // where showing a set stops being fast enough. Every table here is opened once or not at
    // all, however many pieces the outfit holds.
    #[test]
    fn reads_each_of_the_games_tables_once_however_many_pieces_are_worn() {
        let files = Noted::new();
        of_set(
            &files,
            &hers(),
            &[
                Piece {
                    display_info_id: HELM_DISPLAY,
                    display_type: HEAD,
                    inventory_type: 0,
                },
                Piece {
                    display_info_id: SHOULDERS,
                    display_type: SHOULDER,
                    inventory_type: 0,
                },
                Piece {
                    display_info_id: ROBE,
                    display_type: CHEST,
                    inventory_type: 0,
                },
                Piece {
                    display_info_id: LEGS,
                    display_type: LEGS_SLOT,
                    inventory_type: 0,
                },
                Piece {
                    display_info_id: BOOTS,
                    display_type: FEET_SLOT,
                    inventory_type: 0,
                },
                Piece {
                    display_info_id: GLOVES,
                    display_type: HANDS,
                    inventory_type: 0,
                },
                Piece {
                    display_info_id: CAPE,
                    display_type: BACK_SLOT,
                    inventory_type: 0,
                },
            ],
        )
        .unwrap();

        let mut opened = files.asked.into_inner();
        opened.sort_unstable();
        let mut once = opened.clone();
        once.dedup();
        assert_eq!(
            opened, once,
            "a table was parsed more than once for one outfit"
        );

        let mut wanted = vec![
            ITEM_DISPLAY_INFO_MATERIAL_RES,
            ITEM_DISPLAY_INFO,
            TEXTURE_FILE_DATA,
            COMPONENT_TEXTURE_FILE_DATA,
            MODEL_FILE_DATA,
            COMPONENT_MODEL_FILE_DATA,
            HELMET_GEOSET_DATA,
        ];
        wanted.sort_unstable();
        assert_eq!(once, wanted);
    }

    // And the other side of that: a table nothing in the outfit has a question for is not
    // opened at all, which is what keeps a wardrobe of chestpieces off the model tables.
    #[test]
    fn opens_no_table_the_outfit_has_no_question_for() {
        let files = Noted::new();
        of_set(
            &files,
            &hers(),
            &[Piece {
                display_info_id: CHESTPIECE,
                display_type: CHEST,
                inventory_type: 0,
            }],
        )
        .unwrap();
        let opened = files.asked.into_inner();
        assert!(!opened.contains(&MODEL_FILE_DATA), "{opened:?}");
        assert!(!opened.contains(&HELMET_GEOSET_DATA), "{opened:?}");
    }

    /// Fixture files that remember which of the game's tables were parsed.
    struct Noted {
        files: DirFiles,
        asked: std::cell::RefCell<Vec<u32>>,
    }

    impl Noted {
        fn new() -> Self {
            Self {
                files: fixture_files(),
                asked: std::cell::RefCell::new(Vec::new()),
            }
        }
    }

    impl GameFiles for Noted {
        fn read(&self, fdid: u32) -> Result<std::sync::Arc<Vec<u8>>, String> {
            self.asked.borrow_mut().push(fdid);
            self.files.read(fdid)
        }
    }
}
