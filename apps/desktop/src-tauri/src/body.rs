//! Whose body an appearance is shown on: the mesh, the atlas it is painted into, and the two
//! numbers every table downstream narrows itself by.
//!
//! Everything this module holds used to be a constant in [`crate::character`] — one model
//! FileDataID, one texture layout, one 2048 × 1024 atlas and ten hard-coded rectangles, every
//! one of them a Human Female's. There are two bodies now and there will be more, so the
//! constants are reads:
//!
//! ```text
//! ChrModel                                the body itself; id inline, in column 2
//!   col3 = Sex                             0 male, 1 female
//!   col5 = CharComponentTextureLayoutID    ← 103 and 104 are the two Human ones
//!      │
//!      ▼
//! CharComponentTextureLayouts             ChrModelMaterial
//!   col0 = Width   col1 = Height            col1 = the layout, col2 = TextureType
//!                                           col3 = Width, col4 = Height
//!      │
//!      ▼
//! CharComponentTextureSections            where each part of the body is painted
//!   col0 = the layout   col1 = SectionType
//!   col2 = X   col3 = Y   col4 = Width   col5 = Height
//! ```
//!
//! Read off build `12.0.5.67` on 2026-07-28, and each of them agrees with something already
//! written down: the layout for `ChrModel` 2 comes out as 104, and layout 104's ten sections
//! come out as exactly the table in `docs/character-rendering.md`, which was read independently
//! by wago.tools. The male body's layout, 103, states the same ten rectangles and the same atlas
//! — which is worth knowing and is *not* worth assuming, because the layouts the other races use
//! are not all 2048 × 1024.
//!
//! **The mesh is the one thing here that is not read**, and it is worth saying exactly why. The
//! chain to it is `ChrModel.DisplayID` → `CreatureDisplayInfo.ModelID` →
//! `CreatureModelData.FileDataID`, and it works: followed on 12.0.5.67, `ChrModel` 2 goes
//! 56658 → 7599 → **1000764**, which is the Human Female mesh this app has drawn since it drew
//! anything, and `ChrModel` 1 goes 57899 → 7661 → **1011653**. What is missing is the two
//! tables' own FileDataIDs — nothing in this repository knows them, and scanning the storage for
//! them came up empty — so the last hop was followed on [wago.tools](https://wago.tools) rather
//! than in the install, and its answer is written down here as a constant.
//!
//! Which makes each of these two numbers a hypothesis with a picture behind it. `1011653` parses
//! as a body, its geosets are a male body's — groups 1, 2 and 3, the beard and the moustache and
//! the sideburns, which no female body in the game holds anything in — the skin his own
//! `ChrModel`'s customization names paints onto it seamlessly, and a leg appearance composited
//! into layout 103's sections lands on his legs. `1005887`, which a scan of the storage offered
//! first, failed exactly that test: it drew a hooved, horned body wearing a Human's skin.
//!
//! So this table is the line to delete first when those two tables are found — and finding them
//! is what the races after these two need, because twenty more bodies is twenty more of these.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::casc::GameFiles;
use crate::db2::Db2;

/// `ChrModel` — every playable body the game has, and which texture layout each composites in.
const CHR_MODEL: u32 = 3384313;
/// `CharComponentTextureSections` — where each part of a body lands in that layout's atlas.
const CHAR_COMPONENT_TEXTURE_SECTIONS: u32 = 1360263;
/// `ChrModelMaterial` — how large each of a layout's atlases is, texture type by texture type.
const CHR_MODEL_MATERIAL: u32 = 3566562;

/// Columns of `ChrModel`, which keeps its id **inside** the row, in column 2.
mod model_column {
    pub const SEX: usize = 3;
    pub const LAYOUT: usize = 5;
}

/// Columns of `CharComponentTextureSections`. The layout is an ordinary column here rather than
/// a relationship block, unlike `ChrModelTextureLayer`'s.
mod section_column {
    pub const LAYOUT: usize = 0;
    pub const SECTION: usize = 1;
    pub const X: usize = 2;
    pub const Y: usize = 3;
    pub const WIDTH: usize = 4;
    pub const HEIGHT: usize = 5;
}

/// Columns of `ChrModelMaterial`, whose id is its own first column.
mod material_column {
    pub const LAYOUT: usize = 1;
    pub const TEXTURE_TYPE: usize = 2;
    pub const WIDTH: usize = 3;
    pub const HEIGHT: usize = 4;
}

/// The M2 texture type the composited body atlas is bound as, which is the one sized here.
///
/// The others — 6 hair, 19 eyes, 20 jewelry — have buffers of their own that are one picture
/// each rather than composites, so their size is whatever the picture's is.
const BODY_TEXTURE: u32 = 1;

/// The race every body this app draws belongs to, as `ChrRaces` numbers them.
///
/// One race, so it is a constant rather than a read. `ChrRaceXChrModel` is what says which race
/// a `ChrModel` is, and it is the table to reach for when the second race lands — the two
/// numbers it would fill in are [`Body::race`] and [`Body::sex`], and everything downstream
/// already narrows itself by those rather than by a Human.
const HUMAN: u32 = 1;

/// The sexes, as every table in the game that has an opinion writes them.
const MALE: u32 = 0;
const FEMALE: u32 = 1;

/// The body a reader who has never said otherwise is shown, which is the one this app has drawn
/// since it drew anything: Human Female. Gear is authored to look right on human proportions.
pub const DEFAULT: u32 = 2;

/// The bodies this app can draw, as `(ChrModel, mesh, race, sex, name)`.
///
/// The mesh is the community's FileDataID — see the module's last paragraph — and the name is
/// this app's own, because nothing in `ChrModel` carries one. Both go when `ChrRaceXChrModel`
/// and the creature-display chain land; the rest of a body is read out of the install already.
const KNOWN: [(u32, u32, u32, u32, &str); 2] = [
    (1, 1_011_653, HUMAN, MALE, "Human Male"),
    (DEFAULT, 1_000_764, HUMAN, FEMALE, "Human Female"),
];

/// One of the bodies, as something to offer a reader: enough to name it and to pick it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub id: u32,
    pub name: String,
}

/// Everything about a body that no appearance and no customization changes.
///
/// Built once per render — or once per gallery page, since [`crate::character::Mannequin`] holds
/// one — and threaded through every module that used to assume the answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Body {
    /// The `ChrModel` id, which is what `ChrCustomizationOption` files its questions under.
    pub id: u32,
    pub name: String,
    /// What `ComponentTextureFileData` and `HelmetGeosetData` narrow themselves by: an item is
    /// painted per body and a helm hides a different set of groups on each.
    pub race: u32,
    pub sex: u32,
    /// The mesh, and the layout its UVs are laid out in.
    pub model: u32,
    pub layout: u32,
    /// How large the composited body atlas is, which is the layout's own statement.
    pub atlas: (u32, u32),
    /// Where each `ComponentSection` is painted in it, in the order the table gives them.
    pub sections: Vec<(u32, Rect)>,
}

/// One rectangle of that atlas: where a part of the body is painted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Body {
    /// The rectangle a section is painted into, or nothing where this layout has none for it.
    ///
    /// **Section 8, the accessory, has no rectangle in either Human layout.**
    /// `ItemDisplayInfoMaterialRes` carries section-8 rows anyway, and on such a body they have
    /// nowhere to go — which is a row to drop rather than a file to reject.
    pub fn rect_of(&self, section: u32) -> Option<&Rect> {
        self.sections
            .iter()
            .find(|(which, _)| *which == section)
            .map(|(_, rect)| rect)
    }

    /// How much of her that section is, in atlas pixels, or nothing where it is painted nowhere.
    ///
    /// The layout is the only thing in the app that knows how much of a body a part of it is,
    /// and [`crate::qualities`] needs exactly that to say how big a piece of armour is: a
    /// texture filling the legs is a bigger garment than one filling the hands, and the
    /// rectangles are what says so. The two bodies state different sizes for the same section —
    /// hers is a 2048-wide atlas and his a 1024 — which is why this is a question asked of a
    /// body rather than a table anybody can read.
    pub fn area_of(&self, section: u32) -> Option<u32> {
        self.rect_of(section).map(|rect| rect.width * rect.height)
    }
}

/// Every body a reader may be shown on, in the order they are offered.
///
/// A list rather than a read, for as long as the meshes are: what makes a body drawable here is
/// having a mesh for it, and the install has nothing to add to a list of two.
pub fn playable() -> Vec<Named> {
    KNOWN
        .iter()
        .map(|(id, _, _, _, name)| Named {
            id: *id,
            name: (*name).to_string(),
        })
        .collect()
}

/// A body id as it will be stored, refusing one this build could not draw.
///
/// The other way round from [`of`], and deliberately: an id arriving from the window is the
/// window naming something that is not on offer, which is worth refusing rather than quietly
/// storing — and an id arriving from the settings file is a reader whose Chronie changed under
/// them, which is worth drawing the default for rather than failing.
pub fn known(id: u32) -> Result<u32, String> {
    if KNOWN.iter().any(|(known, ..)| *known == id) {
        Ok(id)
    } else {
        Err("There is no body of that kind to draw her on.".into())
    }
}

/// One body, with everything the install says about it.
///
/// A body this app has no mesh for falls back to [`DEFAULT`] rather than failing, because the
/// id comes out of a settings file that outlives an install and the fallback is the body every
/// reader had before there was anywhere to say otherwise. What is *not* tolerated is a layout
/// that cannot be read: an atlas of no stated size and a body with no rectangles to paint into
/// are not a character with something missing, they are nothing to draw at all.
#[tracing::instrument(name = "body.of", skip_all, fields(body = id))]
pub fn of(files: &dyn GameFiles, id: u32) -> Result<Body, String> {
    let (id, model, race, sex, name) = KNOWN
        .iter()
        .find(|(known, ..)| *known == id)
        .or_else(|| KNOWN.iter().find(|(known, ..)| *known == DEFAULT))
        .copied()
        .ok_or("this build of Chronie knows no body to draw")?;

    let layout = layout_of(files, id)?;
    let sections = sections_of(files, layout)?;
    let atlas = atlas_of(files, layout)?;
    Ok(Body {
        id,
        name: name.to_string(),
        race,
        sex,
        model,
        layout,
        atlas,
        sections,
    })
}

/// Which texture layout a body composites in, out of `ChrModel`.
///
/// The two Human bodies are 103 and 104 and they state the same rectangles as each other; the
/// races that follow do not all state 2048 × 1024, which is the whole reason this is read.
fn layout_of(files: &dyn GameFiles, id: u32) -> Result<u32, String> {
    let table = Db2::parse(files.read(CHR_MODEL)?)?;
    let row = table
        .rows()
        .find(|row| row.id() == id)
        .ok_or_else(|| format!("the installed game has no ChrModel {id} to draw"))?;
    // Read and checked rather than read and used: the sex decides which of an item's textures
    // this body wears, and a column that moved would be a body dressed as the other one.
    let sex = row.number(model_column::SEX);
    if sex != MALE && sex != FEMALE {
        return Err(format!("ChrModel {id} states no sex this app can dress"));
    }
    match row.number(model_column::LAYOUT) {
        0 => Err(format!("ChrModel {id} names no texture layout to composite in")),
        layout => Ok(layout),
    }
}

/// Where each part of a body lands in that layout's atlas.
///
/// In the table's own order, which is by section on this build — nothing downstream depends on
/// it, because a section is looked up by number rather than by position.
fn sections_of(files: &dyn GameFiles, layout: u32) -> Result<Vec<(u32, Rect)>, String> {
    let table = Db2::parse(files.read(CHAR_COMPONENT_TEXTURE_SECTIONS)?)?;
    let found: Vec<(u32, Rect)> = table
        .rows()
        .filter(|row| row.number(section_column::LAYOUT) == layout)
        .map(|row| {
            (
                row.number(section_column::SECTION),
                Rect {
                    x: row.number(section_column::X),
                    y: row.number(section_column::Y),
                    width: row.number(section_column::WIDTH),
                    height: row.number(section_column::HEIGHT),
                },
            )
        })
        .collect();
    if found.is_empty() {
        return Err(format!(
            "the installed game gives texture layout {layout} no sections to paint into"
        ));
    }
    Ok(found)
}

/// How large the composited body atlas is, out of `ChrModelMaterial`.
///
/// The atlas layout *is* the model's UV layout, so this number is not a quality setting: a
/// buffer of the wrong size puts every rectangle in the wrong place.
fn atlas_of(files: &dyn GameFiles, layout: u32) -> Result<(u32, u32), String> {
    let table = Db2::parse(files.read(CHR_MODEL_MATERIAL)?)?;
    let sized: HashMap<u32, (u32, u32)> = table
        .rows()
        .filter(|row| row.number(material_column::TEXTURE_TYPE) == BODY_TEXTURE)
        .map(|row| {
            (
                row.number(material_column::LAYOUT),
                (
                    row.number(material_column::WIDTH),
                    row.number(material_column::HEIGHT),
                ),
            )
        })
        .collect();
    match sized.get(&layout).copied() {
        Some((width, height)) if width > 0 && height > 0 => Ok((width, height)),
        _ => Err(format!(
            "the installed game states no atlas size for texture layout {layout}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// The two bodies the fixtures hold, which are the two the app draws.
    const HUMAN_FEMALE: u32 = 2;
    const HUMAN_MALE: u32 = 1;

    fn body(id: u32) -> Body {
        of(&fixture_files(), id).unwrap()
    }

    // What a body is, end to end: the mesh this app holds for it, and the three things the
    // install says about the layout it is painted in.
    #[test]
    fn reads_what_the_install_says_about_a_body() {
        let hers = body(HUMAN_FEMALE);
        assert_eq!((hers.layout, hers.atlas), (104, (2048, 1024)));
        assert_eq!(hers.sections.len(), 10);
        assert_eq!(hers.rect_of(5), Some(&Rect { x: 512, y: 384, width: 512, height: 256 }));
        assert_eq!(hers.sex, FEMALE);
    }

    // And the other body, which is the whole point: a different `ChrModel`, a different mesh,
    // and a layout of its own — read rather than assumed, because the races after these two
    // do not all composite into a buffer this size.
    #[test]
    fn reads_a_second_body_as_itself_rather_than_as_the_first() {
        let his = body(HUMAN_MALE);
        let hers = body(HUMAN_FEMALE);
        assert_ne!(his.model, hers.model, "two bodies drawn from one mesh");
        assert_ne!(his.layout, hers.layout);
        assert_eq!(his.sex, MALE);
        // This layout is smaller in the fixtures, which nothing but the read could know — and
        // is what a race whose atlas is 1024 × 1024 would look like from here.
        assert_eq!(his.atlas, (1024, 512));
        assert_eq!(his.rect_of(5), Some(&Rect { x: 256, y: 192, width: 256, height: 128 }));
    }

    // A section this layout has no rectangle for. `ItemDisplayInfoMaterialRes` carries rows for
    // the accessory section and no Human layout has one, so it is a row to drop.
    #[test]
    fn has_no_rectangle_for_a_section_the_layout_does_not_lay_out() {
        assert_eq!(body(HUMAN_FEMALE).rect_of(8), None);
    }

    // The offer, which is what the window draws a picker from.
    #[test]
    fn offers_the_bodies_it_has_a_mesh_for() {
        let names: Vec<String> = playable().into_iter().map(|body| body.name).collect();
        assert_eq!(names, vec!["Human Male", "Human Female"]);
    }

    // A settings file naming a body this build has no mesh for is a reader whose install or
    // whose Chronie moved under them, and the answer is the body everybody started on rather
    // than an error where a character should be.
    #[test]
    fn falls_back_to_the_body_every_reader_starts_on() {
        assert_eq!(body(4040), body(DEFAULT));
    }

    // But a layout that cannot be read is not a body with something missing — it is an atlas of
    // no stated size and no rectangles to paint into, which is nothing to draw at all.
    #[test]
    fn says_so_when_the_install_cannot_say_how_a_body_is_laid_out() {
        let temp = tempfile::tempdir().unwrap();
        let error = of(&DirFiles::new(temp.path()), HUMAN_FEMALE).unwrap_err();
        assert!(error.contains("3384313.db2"), "{error}");
    }
}
