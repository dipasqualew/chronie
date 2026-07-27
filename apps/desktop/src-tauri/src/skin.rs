//! The character's own skin: which picture goes under everything else on the body.
//!
//! [`crate::worn`] reads what an *appearance* puts on a body. This reads what the body already
//! is. Both end at the same place — a FileDataID that [`crate::character`] decodes and
//! composites — and the difference is where they start: an item names its textures directly,
//! and a character's skin comes out of the player's own customization.
//!
//! ```text
//! ChrCustomizationChoice          the skin the reader picked; here a fixed one
//!      │
//!      ▼
//! ChrCustomizationElement         what that choice actually does
//!   col0 = ChrCustomizationChoiceID
//!   col4 = ChrCustomizationMaterialID   ← a choice has several; only one is the skin
//!      │
//!      ▼
//! ChrCustomizationMaterial
//!   col0 = ChrModelTextureTargetID      ← which layer of the atlas it is painted into
//!   col1 = MaterialResourcesID
//!      │
//!      ▼
//! TextureFileData.col2 = MaterialResourcesID
//!   row.id() = FileDataID ──▶ BLP2
//! ```
//!
//! **A choice names more than one material, and which is which is the whole trap.** The default
//! Human Female skin names three: the body, and the two halves of her underwear. Nothing in
//! `ChrCustomizationMaterial` says which is which — what says it is `ChrModelTextureLayer`,
//! which lays this atlas out a layer at a time:
//!
//! ```text
//! ChrModelTextureLayer, for CharComponentTextureLayoutID 104
//!   foreign_id() = the layout            ← the relationship block, and nowhere else
//!   col0 = TextureType                   1 is the body atlas; 6, 19 and 20 are elsewhere
//!   col1 = Layer                         bottom first
//!   col3 = BlendMode                     1 is a straight copy; everything else blends
//!   col4 = TextureSectionTypeBitMask     which rectangles of the atlas it lands in
//!   col7 = ChrModelTextureTargetID[2]  ──▶ ChrCustomizationMaterial.col0
//! ```
//!
//! The base skin is **the one layer of the layout that is copied rather than blended**, and it
//! covers the whole buffer. Everything the same choice paints above it is blended into the
//! rectangles its mask names — which is what the underwear is, at 256 × 128 a piece rather than
//! part of the skin picture. So none of the three is picked by number: a build that moves any
//! of these columns leaves the body unpainted instead of painting it with somebody's makeup.
//!
//! One fixed choice, because the app draws one Human Female and never asks the reader who she
//! is. Face, hair, tattoos and choosing the body at all are a wardrobe's problem rather than
//! this one's; [`DEFAULT_SKIN`] is the only customization this app has an opinion about.

use std::collections::HashMap;

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::models::{MATERIAL_RESOURCES_ID, TEXTURE_FILE_DATA};
use crate::worn::ComponentTexture;

/// `ChrCustomizationElement` — what one customization choice does to a character.
const CHR_CUSTOMIZATION_ELEMENT: u32 = 3512765;
/// `ChrCustomizationMaterial` — which target a customization paints, and with what.
const CHR_CUSTOMIZATION_MATERIAL: u32 = 3459652;
/// `ChrModelTextureLayer` — how one texture layout is composited, a layer at a time.
const CHR_MODEL_TEXTURE_LAYER: u32 = 3548976;

/// Columns of `ChrCustomizationElement`, whose id is kept beside the rows rather than in them.
///
/// The nine columns past the material are the rest of what a choice can do — a geoset, a
/// skinned model, a bone set, a voice — and none of them is a skin.
mod element_column {
    /// The choice this row belongs to. Not a relationship block: an ordinary column.
    pub const CHOICE: usize = 0;
    pub const MATERIAL: usize = 4;
}

/// Columns of `ChrCustomizationMaterial`, whose id is also kept beside the rows.
mod material_column {
    pub const TEXTURE_TARGET: usize = 0;
    pub const MATERIAL_RESOURCES_ID: usize = 1;
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

/// The texture layout this app composites, and the M2 texture type the result is bound as.
///
/// 104 is Human Female's, verified on 12.0.5.67 and tabulated in
/// `docs/character-rendering.md`; type 1 is the body atlas, as against 6 hair, 19 eyes and 20
/// jewelry, which have atlases of their own and no armour on them.
const LAYOUT: u32 = 104;
const BODY_TEXTURE: u32 = 1;

/// The blend mode the game gives a layer that is copied rather than composited.
///
/// wow.export's `CharMaterialRenderer` names it "blit", and it is the only mode in that
/// switch which disables blending outright. On this layout exactly one layer has it, and that
/// layer is the skin: everything above the skin is painted *over* it and has to blend, and the
/// skin has nothing under it to blend against.
const BLIT: u32 = 1;

/// The customization choice this app draws, as `ChrCustomizationChoice` numbers them.
///
/// Human Female's "Skin Color" option, its first swatch — the body the character creation
/// screen opens on. Hard-coded the same way [`crate::character::HUMAN_FEMALE`] is, and for the
/// same reason: this app shows a wardrobe rather than a character, and one body it draws
/// consistently is worth more than a choice nobody asked to make.
const DEFAULT_SKIN: u32 = 85;

/// One layer of the atlas that a customization choice paints.
///
/// The base covers the whole buffer; every other layer lands in the rectangles its section mask
/// names, which is why the two are not the same kind of thing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skin {
    /// The picture the whole 2048 × 1024 is covered with, as a straight copy.
    pub base: u32,
    /// What the same choice paints over it, bottom layer first. Her underwear, on this body.
    pub over: Vec<ComponentTexture>,
}

/// What the character's body is painted with, or nothing where this install cannot say.
///
/// `None` is an ordinary answer rather than a failure: the game encrypts what it has not
/// shipped, and a build that renumbers the choice above resolves to nothing. The body is then
/// drawn on the flat tone [`crate::character::Atlas::unpainted`] holds — which is what every
/// body looked like before this chain was read, so the worst case is the old picture rather
/// than a broken one.
pub fn of(files: &dyn GameFiles) -> Result<Option<Skin>, String> {
    let layers = layers_of(files)?;
    if layers.is_empty() {
        return Ok(None);
    }
    let painted = painted_by(files, DEFAULT_SKIN)?;
    if painted.is_empty() {
        return Ok(None);
    }

    let textures = Db2::parse(files.read(TEXTURE_FILE_DATA)?)?;
    // A material resource can name more than one file. Unlike the body textures armour is
    // painted with, a skin needs no help telling them apart — the choice it came from belongs
    // to one body already — so the lowest wins and two runs of this agree.
    let file_of = |resource: u32| {
        textures
            .rows()
            .filter(|row| row.number(MATERIAL_RESOURCES_ID) == resource)
            .map(|row| row.id())
            .min()
    };

    let mut base = None;
    let mut over = Vec::new();
    for layer in layers {
        let Some(resource) = painted.get(&layer.target).copied() else {
            continue;
        };
        let Some(file) = file_of(resource) else {
            continue;
        };
        if layer.copied {
            // The bottom of the stack, and the only layer that covers the whole buffer.
            base.get_or_insert(file);
        } else {
            over.extend(sections(layer.section_mask).map(|section| ComponentTexture { section, file }));
        }
    }
    Ok(base.map(|base| Skin { base, over }))
}

/// One layer of the layout this app composites onto the body atlas.
struct Layer {
    target: u32,
    section_mask: u32,
    copied: bool,
}

/// Every layer of this layout that paints the body atlas, bottom first.
///
/// The other atlases are dropped here rather than later, and they are not a formality: hair is
/// a copied layer too, so a reader that took the blend mode alone would lay a hairline over the
/// body and call it a skin.
fn layers_of(files: &dyn GameFiles) -> Result<Vec<Layer>, String> {
    let table = Db2::parse(files.read(CHR_MODEL_TEXTURE_LAYER)?)?;
    let mut found: Vec<(u32, Layer)> = table
        .rows()
        .filter(|row| row.foreign_id() == LAYOUT)
        .filter(|row| row.number(layer_column::TEXTURE_TYPE) == BODY_TEXTURE)
        .map(|row| {
            (
                row.number(layer_column::LAYER),
                Layer {
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

/// Which material resource a choice paints each texture target with.
///
/// A choice has an element per thing picking it does, and most of those drive a geoset or a
/// model and paint nothing at all — hence the zero check, because material 0 is not a material.
fn painted_by(files: &dyn GameFiles, choice: u32) -> Result<HashMap<u32, u32>, String> {
    let elements = Db2::parse(files.read(CHR_CUSTOMIZATION_ELEMENT)?)?;
    let wanted: Vec<u32> = elements
        .rows()
        .filter(|row| row.number(element_column::CHOICE) == choice)
        .map(|row| row.number(element_column::MATERIAL))
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

    /// What the fixture's default choice paints: her skin, and the two halves of her underwear.
    const BASE_SKIN: u32 = 160_001;
    const UNDER_LEGS: u32 = 160_002;
    const UNDER_TORSO: u32 = 160_003;
    /// The swatch beside it, whose skin is a real picture this app must never reach.
    const ANOTHER_SWATCH: u32 = 86;
    const ANOTHER_SKIN: u32 = 160_004;

    /// The sections of the atlas those two halves land in, as the layout numbers them.
    const UPPER_TORSO: u32 = 3;
    const UPPER_LEGS: u32 = 5;

    fn skin() -> Skin {
        of(&fixture_files()).unwrap().expect("the fixture install can say what this body is")
    }

    // The chain the module exists for, end to end: a fixed choice becomes the picture the body
    // is covered with, and the pictures painted over it.
    #[test]
    fn finds_what_the_body_is_painted_with() {
        assert_eq!(
            skin(),
            Skin {
                base: BASE_SKIN,
                over: vec![
                    ComponentTexture { section: UPPER_LEGS, file: UNDER_LEGS },
                    ComponentTexture { section: UPPER_TORSO, file: UNDER_TORSO },
                ],
            }
        );
    }

    // The trap the whole module is arranged around. The default choice names three pictures and
    // any of them will decode, so a reader that took the first would produce a body that looks
    // like it has a skin and has not. What tells them apart is the layer table: the skin is the
    // layer that is copied, and it is the only one that covers the whole buffer.
    #[test]
    fn covers_the_body_with_the_layer_that_is_copied_rather_than_one_blended_over_it() {
        let skin = skin();
        assert_eq!(skin.base, BASE_SKIN);
        for painted in &skin.over {
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
    // shared a section would otherwise land in whichever order the rows sit in.
    #[test]
    fn keeps_the_layers_in_the_order_the_game_paints_them() {
        let files = fixture_files();
        let layers = layers_of(&files).unwrap();
        let numbered: Vec<u32> = layers.iter().map(|layer| layer.target).collect();
        assert_eq!(numbered, vec![1, 4, 5, 13, 14], "bottom layer first");
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

    // Hair is copied too, and belongs to an atlas of its own. A reader that took the blend mode
    // and skipped the texture type would lay a hairline across the body and call it a skin.
    #[test]
    fn leaves_the_layers_of_the_other_atlases_alone() {
        let table = Db2::parse(fixture_files().read(CHR_MODEL_TEXTURE_LAYER).unwrap()).unwrap();
        let hair = table
            .rows()
            .filter(|row| row.foreign_id() == LAYOUT)
            .find(|row| row.number(layer_column::TEXTURE_TYPE) != BODY_TEXTURE)
            .expect("the fixture layout has a layer on another atlas");
        assert_eq!(hair.number(layer_column::BLEND_MODE), BLIT, "and it is copied, like the skin");
        assert!(!layers_of(&fixture_files()).unwrap().iter().any(|layer| layer.target == 10));
    }

    // Two swatches of the same option paint the same target, and the choice is the only thing
    // between them. Reading that column wrong lands on a real skin of the wrong colour, which
    // is the failure that looks least like one.
    #[test]
    fn takes_the_swatch_it_was_asked_for_rather_than_the_one_beside_it() {
        let files = fixture_files();
        assert_eq!(painted_by(&files, DEFAULT_SKIN).unwrap().get(&1), Some(&53_001));
        assert_eq!(painted_by(&files, ANOTHER_SWATCH).unwrap().get(&1), Some(&53_004));
        // And the other swatch's picture is a picture: this resolves all the way down.
        assert_ne!(ANOTHER_SKIN, BASE_SKIN);
        assert_eq!(skin().base, BASE_SKIN);
    }

    // A choice element can drive a geoset and paint nothing, which is most of what picking a
    // customization does. Its material is zero, and looking zero up finds whatever sits first.
    #[test]
    fn ignores_an_element_that_paints_nothing() {
        let painted = painted_by(&fixture_files(), DEFAULT_SKIN).unwrap();
        assert!(!painted.values().any(|resource| *resource == 0));
        assert_eq!(painted.len(), 4, "the skin, both halves of the underwear, and the one below");
    }

    // A layer whose texture this install does not hold is dropped rather than carried as a file
    // that is not there: the fixture's fourth material is a target with no picture behind it.
    #[test]
    fn drops_a_layer_whose_texture_no_install_holds() {
        let painted = painted_by(&fixture_files(), DEFAULT_SKIN).unwrap();
        assert_eq!(painted.get(&20), Some(&53_009));
        assert!(!skin().over.iter().any(|texture| texture.file == 0));
    }

    // A choice this install can say nothing about is an ordinary answer, and the body keeps the
    // flat tone it had before any of this: the game encrypts what it has not shipped, and a
    // build can renumber a choice out from under a hard-coded id.
    #[test]
    fn answers_with_nothing_for_a_choice_it_cannot_read() {
        let files = fixture_files();
        // 900 is the fixture's withheld choice; 40404 is in no section at all.
        for choice in [900, 40_404] {
            assert!(painted_by(&files, choice).unwrap().is_empty(), "choice {choice}");
        }
    }

    #[test]
    fn says_so_when_the_chain_starts_at_a_table_that_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = of(&DirFiles::new(temp.path())).unwrap_err();
        assert!(error.contains("3548976.db2"), "{error}");
    }
}
