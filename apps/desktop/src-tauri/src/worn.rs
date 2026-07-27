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

use std::collections::HashMap;

use crate::casc::GameFiles;
use crate::db2::{Db2, Row};
use crate::models::{file_named, MATERIAL_RESOURCES_ID, MODEL_FILE_DATA, MODEL_RESOURCES_ID};
use crate::models::TEXTURE_FILE_DATA;
use crate::transmog::{display_column, ITEM_DISPLAY_INFO, MODEL_SLOT_BITS};

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

/// The body every appearance in this app is worn on, as the game numbers bodies.
///
/// Human Female, matching [`crate::character::HUMAN_FEMALE`]. There is no class: a
/// class-specific texture is a demon hunter's tattoos and a handful of tabards, and a wardrobe
/// is browsed by a reader rather than by a character.
const FEMALE: u32 = 1;
const HUMAN: u32 = 1;

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
    &[11],    // 0  head: the helm
    &[6, 5],  // 1  shoulder: the left pad, then the right
    &[],      // 2  shirt
    &[],      // 3  chest
    &[],      // 4  waist
    &[],      // 5  legs
    &[],      // 6  feet
    &[],      // 7  wrist
    &[],      // 8  hands
    &[],      // 9  back — a cape is the body's own geometry, not a model. See [`cape_of`].
    &[],      // 10 tabard
];

/// The slot a cape is worn in, and the slot a helm is.
const BACK: u32 = 9;
const HEAD: u32 = 0;

/// Which of `HelmetGeosetVis`'s two elements is this app's body.
///
/// The community's definitions read the array as male then female, and this app draws a Human
/// Female. On 12.0.5.67 the two elements name the same hidden groups for hair on every one of
/// the 5,698 helms in the table — 4,576 hide it either way — so the acceptance this was
/// written for does not turn on the choice; the rarer groups do.
const FEMALE_VIS: usize = 1;

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
    /// The geometry it hangs off the body: a helm, or a pad on each shoulder.
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

/// What an appearance puts on the body, out of the game's own tables.
///
/// `display_type` is the slot, as `ItemAppearance` numbers it, and it is what says which
/// geoset groups the display's six values drive. It comes from the row the reader clicked
/// rather than from another table, because the appearance is what knows its own slot.
pub fn of(files: &dyn GameFiles, display_info_id: u32, display_type: u32) -> Result<Worn, String> {
    let materials = sections(files, display_info_id)?;
    let textures = if materials.is_empty() {
        // Neither of the two tables below is worth opening for an appearance that paints
        // nothing: `TextureFileData` is a row per texture the client owns.
        Vec::new()
    } else {
        resolve(files, &materials)?
    };

    let displays = Db2::parse(files.read(ITEM_DISPLAY_INFO)?)?;
    let Some(display) = displays.rows().find(|row| row.id() == display_info_id) else {
        return Ok(Worn {
            textures,
            ..Default::default()
        });
    };

    Ok(Worn {
        textures,
        geosets: geosets_of(&display, display_type),
        models: models_of(files, &display, display_type)?,
        cape: cape_of(files, &display, display_type)?,
        hidden: hidden_of(files, &display, display_type)?,
    })
}

/// The models an appearance hangs off the body, one per model slot the display fills.
///
/// Both slots, not the first: shoulders keep a left pad in one and a right in the other, and
/// showing one of them is the shape of an appearance that has half its geometry. Which
/// attachment each goes to is [`SLOT_ATTACHMENTS`], and it is the position in the array rather
/// than anything in the row that says which is which.
fn models_of(
    files: &dyn GameFiles,
    display: &Row<'_>,
    display_type: u32,
) -> Result<Vec<WornModel>, String> {
    let attachments = SLOT_ATTACHMENTS
        .get(display_type as usize)
        .copied()
        .unwrap_or(&[]);
    // The slot travels with the rest, because it is not only where the row's values are: it is
    // also which shoulder the model is for. See [`model_file`].
    let asked: Vec<(usize, u32, u32, u32)> = attachments
        .iter()
        .enumerate()
        .map(|(slot, attachment)| {
            (
                slot,
                *attachment,
                display.element(display_column::MODEL_RESOURCES_ID, slot, MODEL_SLOT_BITS),
                display.element(display_column::MATERIAL_RESOURCES_ID, slot, MODEL_SLOT_BITS),
            )
        })
        .filter(|(_, _, model, _)| *model != 0)
        .collect();
    if asked.is_empty() {
        // Neither table below is worth opening for an appearance that hangs nothing off the
        // body, which is every slot but two and most of what a reader clicks on.
        return Ok(Vec::new());
    }

    let mut found = Vec::with_capacity(asked.len());
    for (slot, attachment, model, material) in asked {
        let Some(file) = model_file(files, model, slot)? else {
            continue;
        };
        found.push(WornModel {
            attachment,
            file,
            texture: match material {
                0 => None,
                resource => file_named(files, TEXTURE_FILE_DATA, MATERIAL_RESOURCES_ID, resource)?,
            },
        });
    }
    Ok(found)
}

/// The `.m2` a model resource names for the body this app draws, on the side it is worn.
///
/// Two narrowings, and the game uses one or the other rather than both. **Per body**: a helm's
/// resource names 31 files on 12.0.5.67, one per race and gender, and `ComponentModelFileData`
/// is the only place saying which is which — [`for_this_body`], the same function the textures
/// go through. **Per side**: a shoulder's resource names two, a left pad and its mirror, told
/// apart by `PositionIndex` and by nothing else. `slot` is the model slot the resource came out
/// of, and it *is* the side — element 0 of `ModelResourcesID` is the left pad and element 1 the
/// right, which is what the two files' geometry says: position 0 leans towards the character's
/// left and position 1 is the same mesh mirrored.
///
/// Silence means what it means everywhere else here: a model nothing was said about is the
/// fallback rather than a reject, which is what a weapon and a shield are.
pub fn model_file(files: &dyn GameFiles, resource: u32, slot: usize) -> Result<Option<u32>, String> {
    let table = Db2::parse(files.read(MODEL_FILE_DATA)?)?;
    let mut candidates: Vec<u32> = table
        .rows()
        .filter(|row| row.number(MODEL_RESOURCES_ID) == resource)
        .map(|row| row.id())
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }
    // Lowest first, which is the order the fallback leans on: the client numbers a model's
    // coarser levels of detail above the model itself.
    candidates.sort_unstable();

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

    // A file modelled for the other shoulder is not a candidate at all, whatever body it is
    // for. A file with no side — every helm, and everything untagged — is a candidate for any.
    let wanted = u32::try_from(slot).unwrap_or(0);
    candidates.retain(|file| match sides.get(file) {
        Some(side) if *side < SIDES => *side == wanted,
        _ => true,
    });
    Ok(for_this_body(&candidates, &bodies))
}

/// The picture a cape is painted with, which is not a model and not a body texture either.
///
/// The back slot is the one that has geometry without having a model: the body carries the
/// cloak itself as geoset group 15, and what an appearance supplies is only the picture on it —
/// out of `ModelMaterialResourcesID[0]`, and bound as M2 texture **type 2**, which is the type
/// the body's cape parts ask for and nothing else on it does. Read off 12.0.5.67:
/// `humanfemale_hd`'s geosets 1502 to 1510 are the only parts of the body on that type, and a
/// back display keeps both its model slots at zero and names a material anyway.
fn cape_of(
    files: &dyn GameFiles,
    display: &Row<'_>,
    display_type: u32,
) -> Result<Option<u32>, String> {
    if display_type != BACK {
        return Ok(None);
    }
    match display.element(display_column::MATERIAL_RESOURCES_ID, 0, MODEL_SLOT_BITS) {
        0 => Ok(None),
        resource => file_named(files, TEXTURE_FILE_DATA, MATERIAL_RESOURCES_ID, resource),
    }
}

/// The geoset groups a helm hides on this body.
///
/// Not variants: a helm takes hair, ears or a beard away entirely, and what the table names is
/// the group rather than an id inside it. Which rows apply is the display's `HelmetGeosetVis`
/// through the relationship block, then the race — the table lists every race the game ships
/// under one vis id, and a reader that took them all would hide groups meant for a Draenei's
/// horns.
fn hidden_of(
    files: &dyn GameFiles,
    display: &Row<'_>,
    display_type: u32,
) -> Result<Vec<u16>, String> {
    if display_type != HEAD {
        return Ok(Vec::new());
    }
    let vis = display.element(display_column::HELMET_GEOSET_VIS, FEMALE_VIS, MODEL_SLOT_BITS);
    if vis == 0 {
        // 210 of the game's helms say this, and it means an open helm that hides nothing.
        return Ok(Vec::new());
    }
    let table = Db2::parse(files.read(HELMET_GEOSET_DATA)?)?;
    let mut groups: Vec<u16> = table
        .rows()
        .filter(|row| row.foreign_id() == vis && row.number(helmet_column::RACE) == HUMAN)
        .filter_map(|row| u16::try_from(row.number(helmet_column::HIDE_GEOSET_GROUP)).ok())
        .collect();
    groups.sort_unstable();
    groups.dedup();
    Ok(groups)
}

/// The sections an appearance paints, as `(section, material resource)`.
///
/// In section order, so that an atlas is composited the same way twice. The game does not
/// order the rows, and two appearances that paint the same parts should not differ by the
/// order their rows happen to sit in.
fn sections(files: &dyn GameFiles, display_info_id: u32) -> Result<Vec<(u32, u32)>, String> {
    let table = Db2::parse(files.read(ITEM_DISPLAY_INFO_MATERIAL_RES)?)?;
    let mut found: Vec<(u32, u32)> = table
        .rows()
        .filter(|row| row.foreign_id() == display_info_id)
        .map(|row| {
            (
                row.number(material_column::COMPONENT_SECTION),
                row.number(material_column::MATERIAL_RESOURCES_ID),
            )
        })
        .filter(|(_, material)| *material != 0)
        .collect();
    found.sort_by_key(|(section, _)| *section);
    Ok(found)
}

/// The one texture per section that was painted for this body.
fn resolve(files: &dyn GameFiles, materials: &[(u32, u32)]) -> Result<Vec<ComponentTexture>, String> {
    let textures = Db2::parse(files.read(TEXTURE_FILE_DATA)?)?;
    // Every file each material names, lowest first — which is the order the ranking below
    // falls back on when nothing distinguishes two candidates.
    let mut candidates: HashMap<u32, Vec<u32>> = HashMap::new();
    for row in textures.rows() {
        candidates
            .entry(row.number(MATERIAL_RESOURCES_ID))
            .or_default()
            .push(row.id());
    }
    for files in candidates.values_mut() {
        files.sort_unstable();
    }

    let bodies = bodies_in(files, COMPONENT_TEXTURE_FILE_DATA)?;

    Ok(materials
        .iter()
        .filter_map(|(section, material)| {
            let file = for_this_body(candidates.get(material)?, &bodies)?;
            Some(ComponentTexture {
                section: *section,
                file,
            })
        })
        .collect())
}

/// Which body each file in a component table belongs to, keyed by the file's own FileDataID.
///
/// One function for two tables: `ComponentTextureFileData` and `ComponentModelFileData` are
/// the same three columns keyed the same way, and the only difference between them is whether
/// the file behind the id is a picture or a mesh.
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
fn for_this_body(candidates: &[u32], bodies: &HashMap<u32, (u32, u32, u32)>) -> Option<u32> {
    let mut best: Option<(u32, u32)> = None;
    for file in candidates {
        let Some((gender, class, race)) = bodies.get(file).copied() else {
            continue;
        };
        // No class at all, so a file kept for one is somebody else's.
        let gendered = gender == FEMALE || gender == ANY_GENDER || gender == NO_GENDER;
        if !gendered || class != ANY_CLASS {
            continue;
        }
        let rank = u32::from(gender == FEMALE) * 2 + u32::from(race == HUMAN);
        if best.is_none_or(|(chosen, _)| rank > chosen) {
            best = Some((rank, *file));
        }
    }
    best.map(|(_, file)| file)
        .or_else(|| candidates.iter().find(|file| !bodies.contains_key(file)).copied())
}

/// The geosets a display switches on, for the slot it is worn in.
///
/// A group the row says nothing about still gets an answer: value 0 is every group's bare
/// default, so an item that drives five groups and fills two of them puts the other three
/// back where a bare body had them. What drops out entirely is a group whose value cannot be
/// one — see [`LARGEST_VALUE`].
fn geosets_of(display: &Row<'_>, display_type: u32) -> Vec<Geoset> {
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

    /// The fixture displays, by what the generator made each of them.
    const HELM_DISPLAY: u32 = 900001;
    const SHOULDERS: u32 = 900002;
    const CHESTPIECE: u32 = 900003;
    const WEAPON: u32 = 900007;
    const CAPE: u32 = 900013;
    const BOOTS: u32 = 900004;
    const GLOVES: u32 = 900005;
    const SHIRT: u32 = 900008;
    const ROBE: u32 = 900012;
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
    const WEAPON_SLOT: u32 = 11;

    fn worn(display_info_id: u32, display_type: u32) -> Worn {
        of(&fixture_files(), display_info_id, display_type).unwrap()
    }

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
        assert_eq!(switched(&worn(ROBE, CHEST)), vec![802, 1001, 1302, 2201, 2801]);
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
        assert_eq!(helm.geosets.iter().map(|geoset| geoset.group).collect::<Vec<u16>>(), vec![27]);
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
                WornModel { attachment: 6, file: 140_002, texture: Some(150_002) },
                WornModel { attachment: 5, file: 140_006, texture: Some(150_007) },
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
        assert_eq!(for_this_body(&[140_002], &bodies), Some(140_002));
    }

    // A slot with no attachment of its own hangs nothing, however much geometry the display
    // names — and most of a wardrobe is that, which is why the tables behind this are not
    // opened for it at all.
    #[test]
    fn hangs_nothing_off_a_slot_that_has_no_attachment() {
        assert_eq!(worn(CHESTPIECE, CHEST).models, vec![]);
        assert_eq!(worn(WEAPON, WEAPON_SLOT).models, vec![]);
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
        assert_eq!(of(&fixture_files(), HELM_DISPLAY, CHEST).unwrap().hidden, Vec::<u16>::new());
    }

    #[test]
    fn says_so_when_the_chain_starts_at_a_table_that_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = of(&DirFiles::new(temp.path()), CHESTPIECE, CHEST).unwrap_err();
        assert!(error.contains("1280614.db2"), "{error}");
    }
}
