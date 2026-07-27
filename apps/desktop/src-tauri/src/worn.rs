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
//! ```
//!
//! The first chain has two traps beyond the relationship block. **A material can name more
//! than one file**, one per body the game painted it for, and which is which is written down
//! only in `ComponentTextureFileData` — so taking the first, or the lowest-numbered, dresses a
//! Human Female in a Human Male's chest often enough to notice. And **a texture with no row in
//! that table at all is not excluded**: silence is what most of the game's armour has, and
//! reading it as "not for this body" would leave the character bare.
//!
//! The second is the one to distrust. `GeosetGroup`'s column position is the community's and
//! has not been read off an install, unlike the two beside it — `docs/game-files.md` says so
//! and `docs/character-rendering.md` says what a wrong guess would look like. Which is why
//! nothing here hides a group it cannot then show something for: see
//! [`crate::character::dressed`].

use std::collections::HashMap;

use crate::casc::GameFiles;
use crate::db2::{Db2, Row};
use crate::models::{MATERIAL_RESOURCES_ID, TEXTURE_FILE_DATA};
use crate::transmog::{display_column, ITEM_DISPLAY_INFO};

/// `ItemDisplayInfoMaterialRes` — which texture an appearance paints each part of a body with.
const ITEM_DISPLAY_INFO_MATERIAL_RES: u32 = 1280614;
/// `ComponentTextureFileData` — which body a given texture file was painted for.
const COMPONENT_TEXTURE_FILE_DATA: u32 = 1278239;

/// Columns of `ItemDisplayInfoMaterialRes`. Its own id is of no use to anybody: what ties a
/// row to an appearance is the relationship block, which [`Row::foreign_id`] reads.
mod material_column {
    /// Which part of the body, 0 to 8. The layout says where each of those lands.
    pub const COMPONENT_SECTION: usize = 0;
    pub const MATERIAL_RESOURCES_ID: usize = 1;
}

/// Columns of `ComponentTextureFileData`, whose row id is the texture's own FileDataID.
mod component_column {
    pub const GENDER: usize = 0;
    pub const CLASS: usize = 1;
    pub const RACE: usize = 2;
}

/// The body every appearance in this app is worn on, as the game numbers bodies.
///
/// Human Female, matching [`crate::character::HUMAN_FEMALE`]. There is no class: a
/// class-specific texture is a demon hunter's tattoos and a handful of tabards, and a wardrobe
/// is browsed by a reader rather than by a character.
const FEMALE: u32 = 1;
const HUMAN: u32 = 1;

/// The gender the game marks a texture with when it fits any body, and the class it marks one
/// with when it fits any class. Both are "no opinion" rather than a body of their own.
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
/// From `docs/character-rendering.md`, which has the group numbers and the slots side by side.
/// One item drives several at once — a chestpiece drives five — and since they all come from
/// the same item, none of them can conflict with another. That is the whole reason a single
/// appearance is so much less work than an assembled outfit.
///
/// Wrist and shirt drive nothing: a bracer is texture alone, and the shirt row is not in the
/// community's table at all, so it is left as texture rather than guessed at.
const SLOT_GROUPS: [&[u16]; 11] = [
    &[27, 21],            // head: helm, skull
    &[26],                // shoulder
    &[8, 10, 13, 22, 28], // chest: sleeves, chest, robe, torso, arm upper
    &[18],                // waist: belt
    &[11, 9, 13],         // legs: pants, kneepads, robe
    &[5, 20],             // feet: boot, feet
    &[],                  // wrist
    &[4, 23],             // hands: gloves, hand attach
    &[15],                // back: cape
    &[12],                // tabard
    &[],                  // shirt
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

/// Everything one appearance does to a bare body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Worn {
    pub textures: Vec<ComponentTexture>,
    pub geosets: Vec<Geoset>,
}

impl Worn {
    /// Whether this install can say anything at all about how the appearance is worn.
    ///
    /// Empty is an ordinary answer rather than a failure: the game encrypts the displays of
    /// content it has not shipped, and a slot whose only texture was painted for another body
    /// resolves to nothing. Either way there is nothing to put on the character, and the
    /// window is better off showing the appearance's icon.
    pub fn is_empty(&self) -> bool {
        self.textures.is_empty() && self.geosets.is_empty()
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
    let geosets = displays
        .rows()
        .find(|row| row.id() == display_info_id)
        .map(|display| geosets_of(&display, display_type))
        .unwrap_or_default();

    Ok(Worn { textures, geosets })
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

    let components = Db2::parse(files.read(COMPONENT_TEXTURE_FILE_DATA)?)?;
    let bodies: HashMap<u32, (u32, u32, u32)> = components
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
        .collect();

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

/// Which of a material's textures was painted for the body this app draws.
///
/// Following wow.export's `DBComponentTextureFileData`: a candidate is in the running when its
/// gender is this one or "any" and its class is this one or "any", and among those the more
/// specific wins — a female texture over a generic one, then a class match, then a race match.
///
/// A candidate the table says nothing about is the fallback rather than a reject, and it is
/// what most of the game's armour is: one texture, no row, worn by everybody.
fn for_this_body(candidates: &[u32], bodies: &HashMap<u32, (u32, u32, u32)>) -> Option<u32> {
    let mut best: Option<(u32, u32)> = None;
    for file in candidates {
        let Some((gender, class, race)) = bodies.get(file).copied() else {
            continue;
        };
        // No class at all, so a texture kept for one is somebody else's.
        if (gender != FEMALE && gender != ANY_GENDER) || class != ANY_CLASS {
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
    const CHESTPIECE: u32 = 900003;
    const BOOTS: u32 = 900004;
    const GLOVES: u32 = 900005;
    const SHIRT: u32 = 900008;
    const ROBE: u32 = 900012;
    /// A display in a section the game encrypts, so nothing can be read about it.
    const WITHHELD: u32 = 900900;

    /// The slots those displays are worn in, as `ItemAppearance` numbers them.
    const HEAD: u32 = 0;
    const CHEST: u32 = 2;
    const FEET_SLOT: u32 = 5;
    const HANDS: u32 = 7;
    const SHIRT_SLOT: u32 = 10;

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

    #[test]
    fn says_so_when_the_chain_starts_at_a_table_that_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = of(&DirFiles::new(temp.path()), CHESTPIECE, CHEST).unwrap_err();
        assert!(error.contains("1280614.db2"), "{error}");
    }
}
