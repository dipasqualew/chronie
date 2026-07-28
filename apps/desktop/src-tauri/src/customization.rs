//! The character herself: what a body is before anything is worn on it.
//!
//! [`crate::worn`] reads what an *appearance* puts on a body. This reads what the body already
//! is — her skin, her face, her hair, her ears, and the jewellery she is not wearing. Both end
//! at the same two places, a geoset switched on and a picture composited, and the difference is
//! where they start: an item names its textures and its geosets directly, and a character's come
//! out of the customization the player chose in the character creation screen.
//!
//! **This is not decoration, and the head is why.** Every armour group on a body has a "nothing
//! here" value — bare arms, bare legs, no helm — so an unread group still draws something
//! recognisable. The groups a customization owns do not. Group 32 is the head: `3201` is a scrap
//! at the top of the neck and the head itself is whichever value the character's *face shape*
//! names, so a body that never reads this chain has no face at all. Group 7, the ears, has no
//! value 1 to fall back on either, and group 36's chosen value is often *nothing* — which is why
//! not reading it hangs a necklace on a character who never picked one.
//!
//! ```text
//! ChrCustomizationOption          the things this body can be asked about
//!   col4 = ChrModelID              ← 2, Human Female. Another body's options resolve too.
//!      │
//!      ▼
//! ChrCustomizationChoice          the swatches of one of them; ids kept inline
//!   col2 = ChrCustomizationOptionID
//!   col5 = OrderIndex              ← the first is the one the screen opens on
//!      │
//!      ▼
//! ChrCustomizationElement         what picking that swatch actually does
//!   col0 = ChrCustomizationChoiceID
//!   col1 = RelatedChrCustomizationChoiceID   ← 0, or a swatch that must be chosen too
//!   col2 = ChrCustomizationGeosetID          ── 0 where the element paints instead
//!   col4 = ChrCustomizationMaterialID        ── 0 where the element switches geometry
//!      │                                        │
//!      ▼                                        ▼
//! ChrCustomizationGeoset          ChrCustomizationMaterial
//!   col0 = GeosetType               col0 = ChrModelTextureTargetID   ← which layer it paints
//!   col1 = GeosetID                 col1 = MaterialResourcesID
//!   geoset = type × 100 + id           │
//!                                      ▼
//!                                 TextureFileData.col2 = MaterialResourcesID
//!                                   row.id() = FileDataID ──▶ BLP2
//! ```
//!
//! Four things about that chain are traps rather than steps, and each of them fails as a
//! picture or as geometry rather than as an error.
//!
//! **The option belongs to a body.** `ChrCustomizationOption` describes every playable model at
//! once, and a Dracthyr's face shape is a row of exactly the same shape as a Human's. Filtering
//! on `ChrModelID` is what keeps group 32 from having two owners.
//!
//! **The swatch is the first by `OrderIndex`, not the first row.** The rows sit in id order and
//! the ids are historical; the order index is what the character creation screen reads.
//!
//! **An element can be conditional.** A face is authored per *skin*, so choosing one face names
//! a material for every swatch of the skin option and only the one whose
//! `RelatedChrCustomizationChoiceID` is also chosen applies. Take them all and the last one
//! wins, which is a face of the wrong colour on a body of the right one.
//!
//! **A choice names more than one material, and which is which is `ChrModelTextureLayer`.**
//! Nothing in `ChrCustomizationMaterial` says whether a picture is the body or something painted
//! over it:
//!
//! ```text
//! ChrModelTextureLayer, for CharComponentTextureLayoutID 104
//!   foreign_id() = the layout            ← the relationship block, and nowhere else
//!   col0 = TextureType                   1 is the body atlas; 6, 19 and 20 are atlases of
//!                                        their own, and the M2 texture types the body's own
//!                                        parts ask for them under
//!   col1 = Layer                         bottom first
//!   col3 = BlendMode                     1 is a straight copy; everything else blends
//!   col4 = TextureSectionTypeBitMask     which rectangles of the atlas it lands in
//!   col7 = ChrModelTextureTargetID[2]  ──▶ ChrCustomizationMaterial.col0
//! ```
//!
//! The base skin is **the one layer of the body atlas that is copied rather than blended**, and
//! it covers the whole buffer. Everything painted above it is blended into the rectangles its
//! mask names — her underwear at 256 × 128 a piece, and her face into the right half that the
//! body's own UVs never reach. So none of them is picked by number: a build that moves any of
//! these columns leaves the body unpainted instead of painting it with somebody's makeup.
//!
//! **The other atlases are one picture each.** Hair, eyes and jewellery have buffers of their
//! own rather than rectangles of the body's, and on layout 104 every layer of the three is a
//! straight copy but one — a blend on the eye atlas that nothing this app chooses paints. So
//! each of them comes back as the last copied layer that resolved, bound whole, and there is no
//! compositor for them at all. That one picture is the whole of the difference between a
//! hairstyle and a white cap.
//!
//! One fixed body, because the app draws one Human Female and never asks the reader who she is —
//! but every option of that body, at the swatch the game itself opens on.

use std::collections::{HashMap, HashSet};

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::models::{MATERIAL_RESOURCES_ID, TEXTURE_FILE_DATA};
use crate::worn::{ComponentTexture, Geoset};

/// `ChrCustomizationOption` — the things a body can be asked about, and whose body it is.
const CHR_CUSTOMIZATION_OPTION: u32 = 3384247;
/// `ChrCustomizationChoice` — the swatches of one option.
const CHR_CUSTOMIZATION_CHOICE: u32 = 3450554;
/// `ChrCustomizationElement` — what one customization choice does to a character.
const CHR_CUSTOMIZATION_ELEMENT: u32 = 3512765;
/// `ChrCustomizationMaterial` — which target a customization paints, and with what.
const CHR_CUSTOMIZATION_MATERIAL: u32 = 3459652;
/// `ChrCustomizationGeoset` — the group and value a customization switches on.
const CHR_CUSTOMIZATION_GEOSET: u32 = 3456171;
/// `ChrModelTextureLayer` — how one texture layout is composited, a layer at a time.
const CHR_MODEL_TEXTURE_LAYER: u32 = 3548976;

/// Columns of `ChrCustomizationOption`, which keeps its id **inside** the row.
mod option_column {
    /// `ChrModelID`: whose body this option belongs to.
    pub const MODEL: usize = 4;
}

/// Columns of `ChrCustomizationChoice`, which keeps its id inside the row as well.
mod choice_column {
    pub const OPTION: usize = 2;
    /// Which swatch this is, in the order the character creation screen lists them.
    pub const ORDER: usize = 5;
}

/// Columns of `ChrCustomizationElement`, whose id is kept beside the rows rather than in them.
///
/// The eight columns past the material are the rest of what a choice can do — a skinned model,
/// a bone set, a voice — and none of them is a picture or a geoset.
mod element_column {
    /// The choice this row belongs to. Not a relationship block: an ordinary column.
    pub const CHOICE: usize = 0;
    /// A second choice that must be chosen too, or zero where the element is unconditional.
    pub const RELATED: usize = 1;
    pub const GEOSET: usize = 2;
    pub const MATERIAL: usize = 4;
}

/// Columns of `ChrCustomizationMaterial`, whose id is also kept beside the rows.
mod material_column {
    pub const TEXTURE_TARGET: usize = 0;
    pub const MATERIAL_RESOURCES_ID: usize = 1;
}

/// Columns of `ChrCustomizationGeoset`, whose id is kept beside the rows.
mod geoset_column {
    pub const TYPE: usize = 0;
    pub const VALUE: usize = 1;
}

/// Columns of `ChrModelTextureLayer`.
///
/// Its id is beside the rows and the layout it belongs to is in the relationship block, so
/// neither is a column — which is what puts `TextureType` at 0 rather than at 1 or 2.
mod layer_column {
    pub const TEXTURE_TYPE: usize = 0;
    pub const LAYER: usize = 1;
    pub const BLEND_MODE: usize = 3;
    /// Which of the layout's rectangles the layer paints, as one bit per `SectionType`.
    pub const SECTION_MASK: usize = 4;
    /// `ChrModelTextureTargetID[2]`, an array; the second element is unused on this layout.
    pub const TEXTURE_TARGET: usize = 7;
}

/// How wide one element of that array is. The file records only the column's total.
const TARGET_BITS: u32 = 32;

/// The body this app draws, as `ChrModel` numbers them, and the texture layout it composites.
///
/// Human Female and 104, verified on 12.0.5.67 and tabulated in `docs/character-rendering.md`.
/// The pair travels together because the options are keyed by the one and the layers by the
/// other, and a body composited under another body's layout is the failure that still draws.
const HUMAN_FEMALE_MODEL: u32 = 2;
const LAYOUT: u32 = 104;

/// The M2 texture type the composited body atlas is bound as, as against 6 hair, 19 eyes and
/// 20 jewelry — which have buffers of their own and no armour on them.
const BODY_TEXTURE: u32 = 1;

/// The blend mode the game gives a layer that is copied rather than composited.
///
/// wow.export's `CharMaterialRenderer` names it "blit", and it is the only mode in that
/// switch which disables blending outright. On the body atlas exactly one layer has it, and that
/// layer is the skin: everything above the skin is painted *over* it and has to blend, and the
/// skin has nothing under it to blend against.
const BLIT: u32 = 1;

/// Everything the character's own customization decides, before anything is worn on her.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Customization {
    /// The picture the whole 2048 × 1024 body atlas is covered with, as a straight copy, or
    /// zero where this install cannot say — in which case the atlas keeps its flat tone and
    /// everything else here still applies. Losing the skin and losing the head are different
    /// failures, and only one of them leaves a body worth looking at.
    pub base: u32,
    /// What the same choices paint over it, bottom layer first: her underwear, and her face.
    pub over: Vec<ComponentTexture>,
    /// Her other atlases, as `(M2 texture type, FileDataID)` — the hair and the eyes. Each is
    /// bound whole rather than composited, and the type is what the body's own parts ask for.
    pub atlases: Vec<(u32, u32)>,
    /// The geosets she is made of: her head, her ears, her hairstyle, and the groups whose
    /// chosen value is nothing at all.
    pub geosets: Vec<Geoset>,
}

/// What the character is, or nothing where this install cannot say.
///
/// `None` is an ordinary answer rather than a failure: the game encrypts what it has not
/// shipped, and a build that renumbers the tables above resolves to nothing. The body is then
/// drawn from its groups' bare defaults on the flat tone
/// [`crate::character::Atlas::unpainted`] holds — which is what every body looked like before
/// this chain was read, so the worst case is the old picture rather than a broken one.
#[tracing::instrument(name = "customization.of", skip_all)]
pub fn of(files: &dyn GameFiles) -> Result<Option<Customization>, String> {
    let chosen = chosen_by(files)?;
    if chosen.is_empty() {
        return Ok(None);
    }
    let elements = elements_of(files, &chosen)?;

    let mut found = Customization {
        geosets: geosets_of(files, &elements)?,
        ..Default::default()
    };
    paint(files, &elements, &mut found)?;
    if found == Customization::default() {
        return Ok(None);
    }
    Ok(Some(found))
}

/// The swatch of every one of this body's options that the game itself opens on.
///
/// The first by `OrderIndex`, which is the order the character creation screen lists them in
/// and not the order the rows sit in. Ties fall to the lower id so that two runs agree.
fn chosen_by(files: &dyn GameFiles) -> Result<Vec<u32>, String> {
    let options = Db2::parse(files.read(CHR_CUSTOMIZATION_OPTION)?)?;
    // A set rather than a list, because what follows asks "is this one of mine" once per row of
    // a table with hundreds of thousands of them.
    let mine: HashSet<u32> = options
        .rows()
        .filter(|row| row.number(option_column::MODEL) == HUMAN_FEMALE_MODEL)
        .map(|row| row.id())
        .collect();
    if mine.is_empty() {
        return Ok(Vec::new());
    }

    let choices = Db2::parse(files.read(CHR_CUSTOMIZATION_CHOICE)?)?;
    let mut first: HashMap<u32, (u32, u32)> = HashMap::new();
    for row in choices.rows() {
        let option = row.number(choice_column::OPTION);
        if !mine.contains(&option) {
            continue;
        }
        // Held per option, so the count here is the body's options and not the table's rows.
        let swatch = (row.number(choice_column::ORDER), row.id());
        let held = first.entry(option).or_insert(swatch);
        if swatch < *held {
            *held = swatch;
        }
    }
    let mut chosen: Vec<u32> = first.into_values().map(|(_, choice)| choice).collect();
    chosen.sort_unstable();
    Ok(chosen)
}

/// The geoset and the material of every element those choices bring with them, in table order.
///
/// An element that names a choice in `RelatedChrCustomizationChoiceID` applies only when that
/// choice is one of the chosen too — which is how a face is authored once per skin, and how a
/// hairstyle is authored once per hair colour. Dropping the condition takes every one of them
/// and leaves whichever sits last.
fn elements_of(files: &dyn GameFiles, chosen: &[u32]) -> Result<Vec<(u32, u32)>, String> {
    let chosen: HashSet<u32> = chosen.iter().copied().collect();
    let elements = Db2::parse(files.read(CHR_CUSTOMIZATION_ELEMENT)?)?;
    Ok(elements
        .rows()
        .filter(|row| chosen.contains(&row.number(element_column::CHOICE)))
        .filter(|row| match row.number(element_column::RELATED) {
            0 => true,
            related => chosen.contains(&related),
        })
        .map(|row| {
            (
                row.number(element_column::GEOSET),
                row.number(element_column::MATERIAL),
            )
        })
        .collect())
}

/// The geosets those elements switch on, as a group and the value it takes.
///
/// `geoset = GeosetType × 100 + GeosetID`, the same arithmetic an item's groups get — and a
/// value of **0** is the game saying the group is off. That is not a row to drop: a group
/// switched off has to take its bare default with it, or a character wears the jewellery she
/// declined.
fn geosets_of(files: &dyn GameFiles, elements: &[(u32, u32)]) -> Result<Vec<Geoset>, String> {
    let wanted: HashSet<u32> = elements
        .iter()
        .map(|(geoset, _)| *geoset)
        .filter(|geoset| *geoset != 0)
        .collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }

    let table = Db2::parse(files.read(CHR_CUSTOMIZATION_GEOSET)?)?;
    Ok(table
        .rows()
        .filter(|row| wanted.contains(&row.id()))
        .map(|row| {
            let group = row.number(geoset_column::TYPE) as u16;
            Geoset { group, geoset: group * 100 + row.number(geoset_column::VALUE) as u16 }
        })
        .collect())
}

/// The pictures those elements paint, laid out by the layer table into the atlases they go in.
///
/// The body's is composited — a copy at the bottom and blends into rectangles above it — and
/// every other atlas is one picture bound whole. Which is which is the layer's texture type,
/// and taking the blend mode alone would lay a hairline across the body and call it a skin.
fn paint(
    files: &dyn GameFiles,
    elements: &[(u32, u32)],
    into: &mut Customization,
) -> Result<(), String> {
    let painted = painted_by(files, elements)?;
    if painted.is_empty() {
        return Ok(());
    }

    // A material resource can name more than one file. Unlike the body textures armour is
    // painted with, a character's need no help telling them apart — the choice they came from
    // belongs to one body already — so the lowest wins and two runs of this agree.
    //
    // One pass for every resource that will be asked about, rather than a walk per layer:
    // `TextureFileData` is 3MB and `Db2::rows` materialises every row of it before yielding the
    // first, and a layout has a dozen layers. Only the resources the chosen elements actually
    // paint with are kept, which is a handful of the table's rows.
    let wanted: HashSet<u32> = painted.values().copied().collect();
    let textures = Db2::parse(files.read(TEXTURE_FILE_DATA)?)?;
    let mut file_of: HashMap<u32, u32> = HashMap::new();
    for row in textures.rows() {
        let resource = row.number(MATERIAL_RESOURCES_ID);
        if !wanted.contains(&resource) {
            continue;
        }
        let file = file_of.entry(resource).or_insert_with(|| row.id());
        *file = (*file).min(row.id());
    }

    for layer in layers_of(files)? {
        let Some(file) = painted
            .get(&layer.target)
            .and_then(|resource| file_of.get(resource))
            .copied()
        else {
            continue;
        };
        match (layer.texture_type == BODY_TEXTURE, layer.copied) {
            // The bottom of the body's stack, and the only layer that covers the whole buffer.
            (true, true) => into.base = file,
            (true, false) => into
                .over
                .extend(sections(layer.section_mask).map(|section| ComponentTexture { section, file })),
            // An atlas of its own: one picture, bound whole, and a later copy replaces an
            // earlier one exactly as it would in a compositor.
            (false, true) => {
                into.atlases.retain(|(kind, _)| *kind != layer.texture_type);
                into.atlases.push((layer.texture_type, file));
            }
            // And a blend on one of those, which nothing this app chooses paints — there is
            // one on layout 104, on the eyes. Compositing a buffer to hold it would be code
            // with no picture behind it.
            (false, false) => {}
        }
    }
    Ok(())
}

/// One layer of an atlas that a customization choice paints.
struct Layer {
    /// The M2 texture type the finished atlas is bound as: 1 the body, 6 hair, 19 eyes.
    texture_type: u32,
    target: u32,
    section_mask: u32,
    copied: bool,
}

/// Every layer of this layout, bottom first, whichever atlas it belongs to.
fn layers_of(files: &dyn GameFiles) -> Result<Vec<Layer>, String> {
    let table = Db2::parse(files.read(CHR_MODEL_TEXTURE_LAYER)?)?;
    let mut found: Vec<(u32, Layer)> = table
        .rows()
        .filter(|row| row.foreign_id() == LAYOUT)
        .map(|row| {
            (
                row.number(layer_column::LAYER),
                Layer {
                    texture_type: row.number(layer_column::TEXTURE_TYPE),
                    target: row.element(layer_column::TEXTURE_TARGET, 0, TARGET_BITS),
                    section_mask: row.number(layer_column::SECTION_MASK),
                    copied: row.number(layer_column::BLEND_MODE) == BLIT,
                },
            )
        })
        .collect();
    found.sort_by_key(|(layer, _)| *layer);
    Ok(found.into_iter().map(|(_, layer)| layer).collect())
}

/// Which material resource the chosen elements paint each texture target with.
///
/// Most of what picking a customization does drives a geoset or a model and paints nothing at
/// all — hence the zero check, because material 0 is not a material and looking it up finds
/// whatever row sits first.
fn painted_by(files: &dyn GameFiles, elements: &[(u32, u32)]) -> Result<HashMap<u32, u32>, String> {
    let wanted: HashSet<u32> = elements
        .iter()
        .map(|(_, material)| *material)
        .filter(|material| *material != 0)
        .collect();
    if wanted.is_empty() {
        return Ok(HashMap::new());
    }

    let materials = Db2::parse(files.read(CHR_CUSTOMIZATION_MATERIAL)?)?;
    let found = materials
        .rows()
        .filter(|row| wanted.contains(&row.id()))
        .map(|row| {
            (
                row.number(material_column::TEXTURE_TARGET),
                row.number(material_column::MATERIAL_RESOURCES_ID),
            )
        })
        .collect();
    Ok(found)
}

/// The sections a layer's bit mask names, lowest first.
///
/// One bit per `SectionType`, so 8 is the upper torso and 32 the upper legs — which is where
/// the two halves of the underwear go. The all-ones mask the base layer carries is not read
/// through here: a layer that covers everything covers the parts of the buffer no section has
/// a rectangle for as well, which is what makes it a copy rather than a set of blits.
fn sections(mask: u32) -> impl Iterator<Item = u32> {
    (0..u32::BITS).filter(move |section| mask & (1 << section) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// What the fixture's chosen swatches paint: her skin, her face, both halves of her
    /// underwear, and the two atlases that are not the body's.
    const BASE_SKIN: u32 = 160_001;
    const UNDER_LEGS: u32 = 160_002;
    const UNDER_TORSO: u32 = 160_003;
    const FACE: u32 = 160_005;
    const HAIR: u32 = 160_007;
    const EYES: u32 = 160_008;
    /// The pictures beside them, every one of which resolves and none of which is hers: the
    /// skin of the second swatch, and the face authored for that skin.
    const ANOTHER_SKIN: u32 = 160_004;
    const ANOTHER_FACE: u32 = 160_006;

    /// The sections those layers land in, as the layout numbers them. Nine and ten share one
    /// rectangle — the right half of the atlas, where the head is.
    const UPPER_TORSO: u32 = 3;
    const UPPER_LEGS: u32 = 5;
    const SCALP_LOWER: u32 = 10;

    /// The M2 texture types the body's other two atlases are bound as.
    const HAIR_TEXTURE: u32 = 6;
    const EYE_TEXTURE: u32 = 19;

    fn herself() -> Customization {
        of(&fixture_files()).unwrap().expect("the fixture install can say who this body is")
    }

    /// The choices the app makes on this body's behalf, which is what everything else follows
    /// from — one per option, and the one the character creation screen opens on.
    fn chosen() -> Vec<u32> {
        chosen_by(&fixture_files()).unwrap()
    }

    // The chain the module exists for, end to end: a body nobody has chosen anything for
    // becomes a particular woman — the picture she is covered with, the pictures painted over
    // it, the atlases that are not the body's, and the geosets she is made of.
    #[test]
    fn finds_what_the_character_is() {
        assert_eq!(
            herself(),
            Customization {
                base: BASE_SKIN,
                over: vec![
                    ComponentTexture { section: SCALP_LOWER, file: FACE },
                    ComponentTexture { section: UPPER_LEGS, file: UNDER_LEGS },
                    ComponentTexture { section: UPPER_TORSO, file: UNDER_TORSO },
                ],
                atlases: vec![(HAIR_TEXTURE, HAIR), (EYE_TEXTURE, EYES)],
                geosets: vec![
                    Geoset { group: 0, geoset: 2 },     // her hairstyle, and not the first
                    Geoset { group: 36, geoset: 3600 }, // no necklace: a value the body lacks
                    Geoset { group: 21, geoset: 2101 }, // the skull her skin choice drives
                    Geoset { group: 32, geoset: 3202 }, // her head
                    Geoset { group: 7, geoset: 702 },   // and her ears
                ],
            }
        );
    }

    // The head, on its own, because it is the one this is all for: group 32 has no value the
    // body could fall back on, so the arithmetic that turns a `ChrCustomizationGeoset` row into
    // a geoset id is the whole of whether a character has a face.
    #[test]
    fn reads_a_geoset_as_a_group_and_a_value_within_it() {
        let hers = herself().geosets;
        let head = hers.iter().find(|geoset| geoset.group == 32).expect("she has a head");
        assert_eq!(head.geoset, 3202, "type 32 and value 2, and not 32 or 3200 or 322");
        // And a value of zero is the game switching a group off rather than a row to drop —
        // which is what keeps her from wearing the necklace she declined.
        let necklace = hers.iter().find(|geoset| geoset.group == 36).expect("group 36 is decided");
        assert_eq!(necklace.geoset, 3600);
    }

    // Which swatch is the first one is the order index and not the row order. The fixture lists
    // the face, the hairstyle and the face shape second-swatch-first for exactly this reason,
    // and every one of those rows resolves.
    #[test]
    fn opens_on_the_first_swatch_of_each_option_by_order_rather_than_by_row() {
        assert_eq!(chosen(), vec![85, 102, 132, 156, 4150, 4908, 5059, 56653]);
    }

    // And the options are this body's. `ChrCustomizationOption` describes every playable model
    // at once and another race's face shape is a row of the same shape, so dropping the
    // `ChrModelID` filter gives group 32 two owners and a head that depends on row order.
    #[test]
    fn takes_only_the_options_that_belong_to_the_body_this_app_draws() {
        assert!(!chosen().contains(&9001), "another body's swatch was chosen");
        let hers = herself().geosets;
        assert!(hers.iter().all(|geoset| geoset.geoset != 3203), "{hers:?}");
    }

    // An element can be conditional, and a face is the reason: it is authored once per skin, so
    // choosing one face names a material for every skin swatch there is. Take them all and the
    // last one wins, which is a face of the wrong colour on a body of the right one.
    #[test]
    fn takes_the_element_whose_related_choice_was_chosen_too() {
        let painted = herself();
        assert!(
            painted.over.iter().any(|texture| texture.file == FACE),
            "{:?}",
            painted.over
        );
        assert!(
            !painted.over.iter().any(|texture| texture.file == ANOTHER_FACE),
            "the face authored for the other skin swatch was painted over hers"
        );
        // Both are pictures, and both resolve: the condition is the only thing between them.
        assert_ne!(ANOTHER_FACE, FACE);
    }

    // The trap the compositing half is arranged around. The chosen swatches name several
    // pictures of the body's own atlas and any of them will decode, so a reader that took the
    // first would produce a body that looks like it has a skin and has not. What tells them
    // apart is the layer table: the skin is the layer that is copied, and it is the only one
    // that covers the whole buffer.
    #[test]
    fn covers_the_body_with_the_layer_that_is_copied_rather_than_one_blended_over_it() {
        let herself = herself();
        assert_eq!(herself.base, BASE_SKIN);
        assert_ne!(ANOTHER_SKIN, BASE_SKIN);
        for painted in &herself.over {
            assert_ne!(painted.file, BASE_SKIN, "the skin is not one of the layers above it");
        }
    }

    // And the other half of that: a layer above the base lands only in the rectangles its mask
    // names. Painted over the whole buffer instead, a pair of underwear becomes the body.
    #[test]
    fn paints_a_layer_above_the_base_into_the_sections_its_mask_names() {
        assert_eq!(sections(0).count(), 0);
        assert_eq!(sections(1 << UPPER_TORSO).collect::<Vec<u32>>(), vec![UPPER_TORSO]);
        // One layer, several sections: nothing on this body does it, and the mask is a mask.
        assert_eq!(sections(0b101_000).collect::<Vec<u32>>(), vec![3, 5]);
    }

    // The layers arrive in the order the game composites them, bottom first, because two that
    // shared a section would otherwise land in whichever order the rows sit in — and two of
    // them do share one, since sections 9 and 10 are the same rectangle.
    #[test]
    fn keeps_the_layers_in_the_order_the_game_paints_them() {
        let layers = layers_of(&fixture_files()).unwrap();
        let numbered: Vec<u32> = layers.iter().map(|layer| layer.target).collect();
        assert_eq!(numbered, vec![1, 10, 4, 5, 13, 14, 25, 27], "bottom layer first");
    }

    // The layer table describes every layout the client has, and another body's rows are the
    // ones nearest to hand: same shape, same blend mode, a target this app must never paint.
    #[test]
    fn reads_only_the_layers_of_the_layout_this_app_composites() {
        let table = Db2::parse(fixture_files().read(CHR_MODEL_TEXTURE_LAYER).unwrap()).unwrap();
        let elsewhere: Vec<u32> = table
            .rows()
            .filter(|row| row.foreign_id() != LAYOUT)
            .map(|row| row.element(layer_column::TEXTURE_TARGET, 0, TARGET_BITS))
            .collect();
        assert!(elsewhere.contains(&40), "the fixture holds another layout's base layer");
        assert!(!layers_of(&fixture_files()).unwrap().iter().any(|layer| layer.target == 40));
    }

    // Hair is copied too, and belongs to an atlas of its own. It is not the body's base — a
    // reader that took the blend mode and skipped the texture type would lay a hairline across
    // the character and call it a skin — and it is not nothing either, which is what it used to
    // be and what a white cap on a head looks like from the outside.
    #[test]
    fn keeps_the_other_atlases_whole_rather_than_compositing_them_into_the_body() {
        let herself = herself();
        assert_eq!(herself.atlases, vec![(HAIR_TEXTURE, HAIR), (EYE_TEXTURE, EYES)]);
        assert_ne!(herself.base, HAIR);
        assert!(!herself.over.iter().any(|texture| texture.file == HAIR));
    }

    // An element can drive a geoset and paint nothing, which is most of what picking a
    // customization does. Its material is zero, and looking zero up finds whatever sits first.
    #[test]
    fn ignores_an_element_that_paints_nothing() {
        let elements = elements_of(&fixture_files(), &chosen()).unwrap();
        assert!(elements.iter().any(|(geoset, material)| *geoset != 0 && *material == 0));
        let painted = painted_by(&fixture_files(), &elements).unwrap();
        assert!(!painted.values().any(|resource| *resource == 0));
    }

    // A layer whose texture this install does not hold is dropped rather than carried as a file
    // that is not there: the fixture's jewelry target has no picture behind it.
    #[test]
    fn drops_a_layer_whose_texture_no_install_holds() {
        let elements = elements_of(&fixture_files(), &chosen()).unwrap();
        assert_eq!(painted_by(&fixture_files(), &elements).unwrap().get(&20), Some(&53_009));
        let herself = herself();
        assert!(!herself.over.iter().any(|texture| texture.file == 0));
        assert!(!herself.atlases.iter().any(|(_, file)| *file == 0));
    }

    // A body this install can say nothing about is an ordinary answer, and the character keeps
    // the bare defaults and the flat tone she had before any of this: the game encrypts what it
    // has not shipped, and a build can renumber a ChrModel out from under a hard-coded id.
    #[test]
    fn answers_with_nothing_for_a_body_it_cannot_read() {
        let files = fixture_files();
        assert!(elements_of(&files, &[900]).unwrap().is_empty(), "the withheld choice");
        assert!(elements_of(&files, &[40_404]).unwrap().is_empty(), "a choice in no section");
    }

    #[test]
    fn says_so_when_the_chain_starts_at_a_table_that_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = of(&DirFiles::new(temp.path())).unwrap_err();
        assert!(error.contains("3384247.db2"), "{error}");
    }
}
