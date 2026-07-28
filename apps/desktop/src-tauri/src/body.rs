//! Whose body an appearance is shown on: the mesh, the atlas it is painted into, and the two
//! numbers every table downstream narrows itself by.
//!
//! Everything this module holds used to be a constant in [`crate::character`] — one model
//! FileDataID, one texture layout, one 2048 × 1024 atlas and ten hard-coded rectangles, every
//! one of them a Human Female's. Every playable race is drawable now, so none of it is:
//!
//! ```text
//! ChrRaces                                every race the game ships, playable or not
//!   col2 = Name                            the one to show a reader: "Night Elf", "Haranir"
//!   col15 = Flags, bit 0                   set on a race nobody can make
//!      │
//!      ▼
//! ChrRaceXChrModel                        which bodies a race is made of
//!   col0 = ChrRacesID   col1 = ChrModelID
//!      │
//!      ▼
//! ChrModel                                the body itself; id inline, in column 2
//!   col3 = Sex                             0 male, 1 female, 3 a body worn by both
//!   col4 = DisplayID                       ── the mesh, three tables away
//!   col5 = CharComponentTextureLayoutID       │
//!      │                                      ▼
//!      │                                   CreatureDisplayInfo
//!      │                                     col1 = ModelID
//!      │                                        │
//!      │                                        ▼
//!      │                                   CreatureModelData
//!      │                                     col2 = FileDataID ──▶ MD21
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
//! Read off build `12.0.5.67823` on 2026-07-28, and each hop agrees with something already
//! written down: the layout for `ChrModel` 2 comes out as 104, and layout 104's ten sections
//! come out as exactly the table in `docs/character-rendering.md`, which was read independently
//! by wago.tools. The male body's layout, 103, states the same ten rectangles and the same atlas
//! — which is worth knowing and is *not* worth assuming, because the layouts the other races use
//! are not all 2048 × 1024.
//!
//! **The mesh used to be the one hop not read, and that is what kept this to two bodies.** The
//! chain above was known to work — `ChrModel` 2 goes 56658 → 7599 → **1000764** and `ChrModel` 1
//! goes 57899 → 7661 → **1011653** — but `CreatureDisplayInfo`'s and `CreatureModelData`'s own
//! FileDataIDs were not known here, so the last hop was followed on wago.tools and its two
//! answers were constants. They are `1108759` and `1365368`, out of the
//! [community listfile](https://github.com/wowdev/wow-listfile), and following the chain in the
//! install reproduces both of those numbers exactly. It also reproduces `1005887` for `ChrModel`
//! 21 — the hooved, horned body a scan once offered for the Human Female, which turns out to be
//! the Draenei Male and to have been right about everything except whose it was.
//!
//! **What "playable" means here is the game's own answer.** `ChrRaces`'s first flag bit is set on
//! every race nobody can make — the Naga, the Vrykul, the drakes a Dracthyr turns into, the two
//! rows still called `tbdNPCRace` — and clearing it leaves exactly the thirty-one the character
//! creation screen offers, from the Human to the Haranir. Those thirty-one name fifty-one
//! distinct `ChrModel`s between them, because the Pandaren's two bodies are shared by all three
//! of their races, the Earthen's and the Haranir's by both of theirs, and the Dracthyr's single
//! body by both of theirs *and* by both sexes.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::casc::GameFiles;
use crate::db2::Db2;

/// `ChrModel` — every playable body the game has, and which texture layout each composites in.
const CHR_MODEL: u32 = 3384313;
/// `CharComponentTextureSections` — where each part of a body lands in that layout's atlas.
const CHAR_COMPONENT_TEXTURE_SECTIONS: u32 = 1360263;
/// `ChrModelMaterial` — how large each of a layout's atlases is, texture type by texture type.
const CHR_MODEL_MATERIAL: u32 = 3566562;
/// `ChrRaces` — every race the game ships, with the name to show and whether anybody can be one.
const CHR_RACES: u32 = 1305311;
/// `ChrRaceXChrModel` — which bodies a race is made of.
const CHR_RACE_X_CHR_MODEL: u32 = 3490304;
/// `CreatureDisplayInfo` — what a `ChrModel`'s display id actually displays.
const CREATURE_DISPLAY_INFO: u32 = 1108759;
/// `CreatureModelData` — and the mesh behind that.
const CREATURE_MODEL_DATA: u32 = 1365368;

/// Columns of `ChrModel`, which keeps its id **inside** the row, in column 2.
mod model_column {
    pub const SEX: usize = 3;
    pub const DISPLAY: usize = 4;
    pub const LAYOUT: usize = 5;
}

/// Columns of `ChrRaces`. The name is the one a reader is shown — column 1 beside it is the
/// client's own word for the race, and it is the one that calls the Undead "Scourge" and the
/// Haranir "Harronir".
mod race_column {
    pub const NAME: usize = 2;
    pub const FLAGS: usize = 15;
}

/// Columns of `ChrRaceXChrModel`. It states a sex of its own in column 2, and it is not the one
/// used: a Dracthyr's single body is listed twice there, once under each, while the body itself
/// says it belongs to neither. What a body *is* comes from `ChrModel`.
mod race_model_column {
    pub const RACE: usize = 0;
    pub const MODEL: usize = 1;
}

/// The column of `CreatureDisplayInfo` that names the model, and the column of
/// `CreatureModelData` that names the file it is.
mod creature_column {
    pub const MODEL: usize = 1;
    pub const FILE: usize = 2;
}

/// `ChrRaces`'s first flag bit, which is set on every race nobody can make.
///
/// Clearing it leaves the thirty-one the game's own character creation screen offers. It is what
/// keeps the Naga, the Vrykul and the drakes a Dracthyr turns into off the list — and also three
/// that are subtler, because every other column of theirs reads like a playable race's: the
/// Gilnean a Worgen was, the "ThinHuman" the game keeps for cutscenes, and the visage a Dracthyr
/// wears, which is a form of a race rather than a race to be.
const NOT_PLAYABLE: u32 = 0x1;

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

/// The sexes, as every table in the game that has an opinion writes them.
const MALE: u32 = 0;
const FEMALE: u32 = 1;

/// The body a reader who has never said otherwise is shown, which is the one this app has drawn
/// since it drew anything: Human Female. Gear is authored to look right on human proportions.
pub const DEFAULT: u32 = 2;

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
    ///
    /// The race is the first playable one that names this `ChrModel`, which matters only for the
    /// four bodies more than one race names — and there it is a choice with nothing behind it,
    /// because `HelmetGeosetData` carries the same rows under each of a shared body's races.
    pub race: u32,
    /// 0 male, 1 female — and **3 for a body the game gives no sex**, which is the Dracthyr's
    /// one model. Every table downstream is asked with [`Body::helmet_slot`] or falls through to
    /// what the game marks as fitting any body, so a third value is a body that wears what was
    /// authored for everybody rather than a body that wears nothing.
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
    /// rectangles are what says so. Two bodies can state different sizes for the same section —
    /// the fifty-one on offer do not all composite into a 2048-wide atlas — which is why this is
    /// a question asked of a body rather than a table anybody can read.
    pub fn area_of(&self, section: u32) -> Option<u32> {
        self.rect_of(section).map(|rect| rect.width * rect.height)
    }

    /// Which of `ItemDisplayInfo.HelmetGeosetVis`'s two entries a helm hides this body by.
    ///
    /// A body the game states no sex for has no entry of its own, and the first is the one that
    /// was authored for it: the Dracthyr's single model is the only such body the game offers,
    /// and `HelmetGeosetData` carries its rows all the same. Reading past the pair instead would
    /// come back zero, which is the game's word for a helm that hides nothing — so getting this
    /// wrong is a full helm with a horn through it rather than an error.
    pub fn helmet_slot(&self) -> usize {
        match self.sex {
            FEMALE => 1,
            _ => 0,
        }
    }
}

/// One body as the offer is built up: everything that says a reader may be shown it, before the
/// layout it composites in is read.
#[derive(Debug, Clone)]
struct Offer {
    id: u32,
    name: String,
    race: u32,
    sex: u32,
    model: u32,
    layout: u32,
}

/// Every body a reader may be shown on, in the order they are offered.
///
/// Which is the game's own order: race by race as `ChrRaceXChrModel` lists them, from the Human
/// to the Haranir, and within a race the male body before the female. A body more than one race
/// names — the Pandaren's, the Earthen's, the Haranir's, the Dracthyr's — is offered once, under
/// the first race to name it.
pub fn playable(files: &dyn GameFiles) -> Result<Vec<Named>, String> {
    Ok(offered(files)?
        .into_iter()
        .map(|body| Named {
            id: body.id,
            name: body.name,
        })
        .collect())
}

/// A body id as it will be stored, refusing one this build could not draw.
///
/// The other way round from [`of`], and deliberately: an id arriving from the window is the
/// window naming something that is not on offer, which is worth refusing rather than quietly
/// storing — and an id arriving from the settings file is a reader whose Chronie changed under
/// them, which is worth drawing the default for rather than failing.
pub fn known(files: &dyn GameFiles, id: u32) -> Result<u32, String> {
    if offered(files)?.iter().any(|body| body.id == id) {
        Ok(id)
    } else {
        Err("There is no body of that kind to draw her on.".into())
    }
}

/// One body, with everything the install says about it.
///
/// A body this install does not offer falls back to [`DEFAULT`] rather than failing, because the
/// id comes out of a settings file that outlives an install and the fallback is the body every
/// reader had before there was anywhere to say otherwise. What is *not* tolerated is a layout
/// that cannot be read: an atlas of no stated size and a body with no rectangles to paint into
/// are not a character with something missing, they are nothing to draw at all.
#[tracing::instrument(name = "body.of", skip_all, fields(body = id))]
pub fn of(files: &dyn GameFiles, id: u32) -> Result<Body, String> {
    let offers = offered(files)?;
    let offer = offers
        .iter()
        .find(|body| body.id == id)
        .or_else(|| offers.iter().find(|body| body.id == DEFAULT))
        .ok_or("this build of the game offers no body to draw")?;

    let sections = sections_of(files, offer.layout)?;
    let atlas = atlas_of(files, offer.layout)?;
    Ok(Body {
        id: offer.id,
        name: offer.name.clone(),
        race: offer.race,
        sex: offer.sex,
        model: offer.model,
        layout: offer.layout,
        atlas,
        sections,
    })
}

/// Every body of every playable race that this install can actually draw, in the game's order.
///
/// One function behind all three of [`playable`], [`known`] and [`of`], so that what is offered,
/// what may be stored and what gets drawn cannot come apart. A body is on it when the game says
/// somebody can be that race, when the row says which layout it composites in, and when the
/// chain to its mesh comes out at a file — the last of which is why this is not free, and why
/// [`of`] takes the list rather than narrowing the tables to the one body it wants.
fn offered(files: &dyn GameFiles) -> Result<Vec<Offer>, String> {
    let races = Db2::parse(files.read(CHR_RACES)?)?;
    let named: HashMap<u32, String> = races
        .rows()
        .filter(|row| row.number(race_column::FLAGS) & NOT_PLAYABLE == 0)
        .map(|row| (row.id(), row.text(race_column::NAME)))
        .collect();

    let models = Db2::parse(files.read(CHR_MODEL)?)?;
    let bodies: HashMap<u32, (u32, u32, u32)> = models
        .rows()
        .map(|row| {
            (
                row.id(),
                (
                    row.number(model_column::SEX),
                    row.number(model_column::DISPLAY),
                    row.number(model_column::LAYOUT),
                ),
            )
        })
        .collect();

    let table = Db2::parse(files.read(CHR_RACE_X_CHR_MODEL)?)?;
    let mut wanted: Vec<(u32, u32, u32, u32, u32)> = Vec::new();
    for row in table.rows() {
        let race = row.number(race_model_column::RACE);
        let id = row.number(race_model_column::MODEL);
        if !named.contains_key(&race) {
            continue;
        }
        // A body two races share is offered once, under the first of them: the Pandaren's three
        // races and the Dracthyr's two are one body each however many ways the game files them.
        if wanted.iter().any(|(known, ..)| *known == id) {
            continue;
        }
        let Some(&(sex, display, layout)) = bodies.get(&id) else {
            continue;
        };
        // A body with nothing to composite into is not a body with something missing — it is a
        // row whose layout column moved, and every rectangle downstream would be nowhere.
        if layout == 0 || display == 0 {
            continue;
        }
        wanted.push((id, race, sex, display, layout));
    }

    let meshes = meshes(files, &wanted.iter().map(|(_, _, _, display, _)| *display).collect())?;
    let offers: Vec<Offer> = wanted
        .into_iter()
        .filter_map(|(id, race, sex, display, layout)| {
            Some(Offer {
                id,
                name: name_of(named.get(&race)?, sex),
                race,
                sex,
                model: meshes.get(&display).copied()?,
                layout,
            })
        })
        .collect();
    if offers.is_empty() {
        return Err("the installed game offers no playable body to draw".into());
    }
    Ok(offers)
}

/// What to call a body, which is a thing nothing in the game writes down.
///
/// The race carries a name and the body carries a sex, and the two together is what the
/// character creation screen shows. A body the game gives no sex — the Dracthyr's, which both
/// sexes wear — is its race and nothing more, because "Dracthyr Male" would be a distinction the
/// game does not draw at this level and the picker would show it twice.
fn name_of(race: &str, sex: u32) -> String {
    match sex {
        MALE => format!("{race} Male"),
        FEMALE => format!("{race} Female"),
        _ => race.to_string(),
    }
}

/// The mesh behind each of a set of `ChrModel` display ids.
///
/// `ChrModel.DisplayID` → `CreatureDisplayInfo.ModelID` → `CreatureModelData.FileDataID`, which
/// is the chain that used to be a table of constants in this module — see the module docs for
/// the two numbers that stand behind it. It takes a set rather than one id because both tables
/// are walked whole whichever is asked for, and `CreatureDisplayInfo` is the larger part of a
/// hundred thousand rows: a caller wanting every body's mesh should pay for it once.
fn meshes(files: &dyn GameFiles, displays: &HashSet<u32>) -> Result<HashMap<u32, u32>, String> {
    let table = Db2::parse(files.read(CREATURE_DISPLAY_INFO)?)?;
    let creatures: HashMap<u32, u32> = table
        .rows()
        .filter(|row| displays.contains(&row.id()))
        .map(|row| (row.id(), row.number(creature_column::MODEL)))
        .collect();

    let table = Db2::parse(files.read(CREATURE_MODEL_DATA)?)?;
    let wanted: HashSet<u32> = creatures.values().copied().collect();
    let files_of: HashMap<u32, u32> = table
        .rows()
        .filter(|row| wanted.contains(&row.id()))
        .map(|row| (row.id(), row.number(creature_column::FILE)))
        .collect();

    Ok(creatures
        .into_iter()
        .filter_map(|(display, creature)| {
            let file = files_of.get(&creature).copied().filter(|file| *file != 0)?;
            Some((display, file))
        })
        .collect())
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

    /// The bodies the fixtures hold. The first two are the app's own default and its opposite
    /// number; the rest are each a way of being offered or of being left off.
    const HUMAN_FEMALE: u32 = 2;
    const HUMAN_MALE: u32 = 1;
    /// A body whose only race nobody can be.
    const NAGA: u32 = 5;
    /// A body two races name, which is offered once under the first of them.
    const ORC_MALE: u32 = 7;
    /// A body the game gives no sex, which is what the Dracthyr's one model is.
    const SEXLESS: u32 = 8;
    /// A playable body whose display id names no model.
    const NO_MESH: u32 = 9;

    fn body(id: u32) -> Body {
        of(&fixture_files(), id).unwrap()
    }

    fn names() -> Vec<String> {
        playable(&fixture_files())
            .unwrap()
            .into_iter()
            .map(|body| body.name)
            .collect()
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

    // The offer, which is what the window draws a picker from — and which is now the game's
    // answer rather than this app's. Every name in it is a race's out of `ChrRaces` and a sex
    // out of `ChrModel`, and the order is the one `ChrRaceXChrModel` lists them in.
    #[test]
    fn offers_a_body_of_every_playable_race() {
        assert_eq!(
            names(),
            vec!["Human Male", "Human Female", "Orc Male", "Dracthyr"]
        );
    }

    // The one bit that decides what "playable" means. The Naga's body has a race, a layout, a
    // display and a mesh that resolves — every hop of the chain works — and the flag on the race
    // that names it is the whole of what keeps a reader from being offered one.
    #[test]
    fn leaves_off_a_body_whose_only_race_nobody_can_be() {
        assert!(!names().iter().any(|name| name.contains("Naga")), "{:?}", names());
        assert_eq!(known(&fixture_files(), NAGA), Err(NOT_ON_OFFER.into()));
        assert_eq!(body(NAGA), body(DEFAULT));
    }

    // A body more than one race names is one body. The Pandaren's two are shared by three races
    // and the Dracthyr's one by two, and a picker that listed them per race would show the same
    // body under half a dozen names.
    #[test]
    fn offers_a_body_two_races_share_once_under_the_first_of_them() {
        assert_eq!(names().iter().filter(|name| *name == "Orc Male").count(), 1);
        assert!(!names().iter().any(|name| name.starts_with("Mag'har")), "{:?}", names());
        // And the race it carries is that first one, which is what `HelmetGeosetData` and
        // `ComponentTextureFileData` are narrowed by.
        assert_eq!(body(ORC_MALE).race, 2);
    }

    // A body the game gives no sex, which is the Dracthyr's one model. It is named after its
    // race alone, and it hides a helm by the first of `HelmetGeosetVis`'s two entries rather
    // than by an entry past the end of them — which reads as zero, and zero is an open helm.
    #[test]
    fn draws_a_body_the_game_gives_no_sex() {
        let theirs = body(SEXLESS);
        assert_eq!(theirs.name, "Dracthyr");
        assert_eq!(theirs.sex, 3);
        assert_eq!(theirs.helmet_slot(), 0);
        assert_eq!(body(HUMAN_MALE).helmet_slot(), 0);
        assert_eq!(body(HUMAN_FEMALE).helmet_slot(), 1);
    }

    // A playable race this install has nothing to draw. What is offered and what can be drawn
    // are one list, so a body whose chain to a mesh runs out is off the picker rather than an
    // error a reader finds by choosing it.
    #[test]
    fn leaves_off_a_playable_body_with_no_mesh_behind_it() {
        assert!(!names().iter().any(|name| name.contains("Vulpera")), "{:?}", names());
        assert_eq!(known(&fixture_files(), NO_MESH), Err(NOT_ON_OFFER.into()));
    }

    // The mesh, which used to be a constant per body and is now the far end of a chain through
    // two of the game's largest tables. Both of these were read off build 12.0.5.67823 by
    // following it in the install, and both were what this app had written down.
    #[test]
    fn follows_a_display_id_through_to_the_file_the_body_is() {
        assert_eq!(body(HUMAN_FEMALE).model, 1_000_764);
        assert_eq!(body(HUMAN_MALE).model, 1_011_653);
    }

    // A settings file naming a body this install does not offer is a reader whose install or
    // whose Chronie moved under them, and the answer is the body everybody started on rather
    // than an error where a character should be.
    #[test]
    fn falls_back_to_the_body_every_reader_starts_on() {
        assert_eq!(body(4040), body(DEFAULT));
        assert_eq!(known(&fixture_files(), DEFAULT), Ok(DEFAULT));
    }

    // But a layout that cannot be read is not a body with something missing — it is an atlas of
    // no stated size and no rectangles to paint into, which is nothing to draw at all.
    #[test]
    fn says_so_when_the_install_cannot_say_how_a_body_is_laid_out() {
        let temp = tempfile::tempdir().unwrap();
        let error = of(&DirFiles::new(temp.path()), HUMAN_FEMALE).unwrap_err();
        assert!(error.contains("1305311.db2"), "{error}");
    }

    /// What [`known`] says about a body that is not on offer, kept here so that the tests
    /// asserting it cannot drift from the message a reader is shown.
    const NOT_ON_OFFER: &str = "There is no body of that kind to draw her on.";
}
