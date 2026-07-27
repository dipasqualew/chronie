//! The character an appearance is worn on, with nothing on it yet.
//!
//! Most of a transmog set has no model of its own — chest, waist, legs, feet, wrist, hands,
//! back and tabard are textures painted onto a body, as `docs/game-files.md` measures and
//! `docs/character-rendering.md` explains. Showing them at all therefore starts with the body:
//! one fixed model, standing there correctly, before anything is composited onto it.
//!
//! Human Female, because gear is authored to look right on human proportions and because
//! Dracthyr, Worgen and Mechagnome carry extra geoset groups and limb handling worth avoiding.
//!
//! Reading it is the same two hops as an item's model, through the same parser — and then the
//! three things an item's model never exercises:
//!
//! - **The mesh is large enough for the `level` trap to matter.** That is [`crate::m2`]'s
//!   problem and it is handled there, but a character is where it actually bites: a body runs
//!   well past 65,535 indices, and a part read from the wrong place is a missing limb rather
//!   than a spare cube nobody looks at.
//! - **Every geoset is in the file at once.** A body holds bare arms *and* the sleeves a
//!   chestpiece switches on, bare feet *and* boots. Drawing them all is what doubled geometry
//!   and z-fighting look like from the outside, so [`bare`] picks one variant per group.
//! - **The skin comes from the caller.** The body's texture is M2 type 1, the composited
//!   2048 × 1024 atlas this module builds, rather than a file the model names.
//!
//! And then the point of all of it: **one appearance, worn.** What an item does to a body is
//! two things and no more — it paints textures into rectangles of that atlas, and it switches
//! geoset variants on in place of the bare defaults. [`crate::worn`] reads both out of the
//! game's tables; [`Atlas::wear`] and [`dressed`] are where they land on the character.
//!
//! One item at a time, which is what keeps this small. The two subsystems that make an
//! assembled outfit hard — the priority table that arbitrates which of two items owns the
//! sleeves, and the per-slot draw order that puts bracers over them — exist to settle
//! arguments between items, and one item cannot argue with itself.

use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ImageEncoder, Rgba, RgbaImage};
use serde_json::Value;

use crate::casc::GameFiles;
use crate::glb;
use crate::icons::{data_url, pixels_of, png_of};
use crate::m2::{Mesh, Model, Paint};
use crate::worn::{ComponentTexture, Geoset, Worn};

/// `humanfemale_hd.m2`, from the community listfile.
///
/// Note that 119563 (`humanfemale.m2`) is the *vanilla* model and not this one: retail has
/// used the `_hd` mesh since Warlords, and the old file is still shipped.
pub const HUMAN_FEMALE: u32 = 1_000_764;

/// The composited body atlas, which is what M2 texture type 1 on a character wants.
///
/// 2048 × 1024 is what `ChrModelMaterial` states for `CharComponentTextureLayoutID` 104 and
/// texture type 1, read off build 12.0.5.67 and recorded in `docs/character-rendering.md`. The
/// atlas layout *is* the model's UV layout, so nothing about the character's texture
/// coordinates depends on what gets composited into it.
const ATLAS_WIDTH: u32 = 2048;
const ATLAS_HEIGHT: u32 = 1024;

/// The M2 texture type the composited atlas is bound as.
///
/// The other types a body asks for — 6 hair, 19 eyes, 20 jewelry — have atlases of their own
/// and are not what armour is painted into. A part that wants one of those is drawn untextured
/// rather than painted with this, which is the difference between hair that is grey and hair
/// with somebody's kneecap on it.
const BODY_TEXTURE: u32 = 1;

/// One rectangle of the atlas: where a part of the body is painted.
struct Rect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

/// What compositing an appearance actually managed.
///
/// The count is not the interesting half; the sentences are. Every one of them is a thing the
/// appearance says it paints and this install could not — and until this existed, all of them
/// were a `continue` in a loop, which is why a body with nothing on it and a body the game
/// paints nothing for looked the same from the outside. The window shows them to the reader,
/// so they are worded for somebody looking at a character that is barer than they expected
/// rather than for somebody reading a log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Painting {
    /// How many of the appearance's textures landed in the atlas.
    pub painted: usize,
    /// One line per part of the body that stayed as it was, saying why.
    pub missing: Vec<String>,
}

/// Where each `ComponentSection` lands, for `CharComponentTextureLayoutID` 104.
///
/// Read off `CharComponentTextureSections` on build 12.0.5.67 and tabulated in
/// `docs/character-rendering.md`, where the same numbers came back independently from
/// wago.tools. Note the asymmetry: the body occupies only the left 1024 × 1024 of the atlas,
/// and the right half is the face and the scalp.
///
/// **Section 8, the accessory, has no rectangle in this layout.** `ItemDisplayInfoMaterialRes`
/// carries section-8 rows anyway, and on this model they have nowhere to go — which is a row
/// to drop rather than a file to reject. Sections 9 and 10 are the scalp, and share theirs.
const SECTIONS: [(u32, Rect); 10] = [
    (0, Rect { x: 0, y: 0, width: 512, height: 256 }),        // arms upper
    (1, Rect { x: 0, y: 256, width: 512, height: 256 }),      // arms lower
    (2, Rect { x: 0, y: 512, width: 512, height: 128 }),      // hands
    (3, Rect { x: 512, y: 0, width: 512, height: 256 }),      // torso upper
    (4, Rect { x: 512, y: 256, width: 512, height: 128 }),    // torso lower
    (5, Rect { x: 512, y: 384, width: 512, height: 256 }),    // legs upper
    (6, Rect { x: 512, y: 640, width: 512, height: 256 }),    // legs lower
    (7, Rect { x: 512, y: 896, width: 512, height: 128 }),    // feet
    (9, Rect { x: 1024, y: 0, width: 1024, height: 1024 }),   // scalp upper
    (10, Rect { x: 1024, y: 0, width: 1024, height: 1024 }),  // scalp lower
];

/// What an atlas holds where nothing has been composited into it.
///
/// A flat tone rather than transparency or magenta: the point of this view is the shape of a
/// body, and a body with see-through patches reads as broken geometry rather than as a missing
/// texture. See [`Atlas::base`] for why nothing better is put here yet.
const UNPAINTED: [u8; 4] = [0xc8, 0xa2, 0x8c, 0xff];

/// Whether a geoset is drawn on a body with nothing on it.
///
/// A geoset id is `group × 100 + value`, and **value 1 is every group's "nothing here"**: bare
/// arms rather than sleeves, bare legs rather than trousers, bare feet rather than boots, no
/// helm, no cape, no belt. Geoset 0 is the skin itself, and the one id with no group of its
/// own. Everything else in the file is a variant that some item switches on in place of the
/// default, and the file holds all of them at once.
///
/// So this is the whole of "hide everything, then show geoset 0 and the defaults" from
/// `docs/character-rendering.md`, and getting it wrong has three faces, all of them geometry
/// rather than an error: draw too much and limbs double and z-fight, draw too little and they
/// go missing.
///
/// When an item is composited onto the body — the next step, not this one — it hides its
/// groups' whole hundred and shows the one value it drives instead. That replaces the default
/// this picks; it does not fight with it.
pub fn bare(geoset: u16) -> bool {
    geoset == 0 || geoset % 100 == 1
}

/// The composited body texture: one buffer the whole character is painted out of.
///
/// Held as a type of its own because compositing is where the work of showing armour goes.
/// Every item texture lands in a rectangle of this same buffer, alpha-blended in a fixed
/// per-slot order — so this is the seam that grows, and the model, the UVs and the viewer
/// above it do not.
pub struct Atlas {
    pixels: RgbaImage,
}

impl Atlas {
    /// An atlas with nothing composited into it.
    pub fn unpainted() -> Self {
        Self {
            pixels: RgbaImage::from_pixel(ATLAS_WIDTH, ATLAS_HEIGHT, Rgba(UNPAINTED)),
        }
    }

    /// Lays the character's own skin over the whole buffer, which is what everything else is
    /// composited on top of.
    ///
    /// A straight copy rather than a blend, because this *is* the bottom of the stack — the
    /// alpha-compositing rule in `docs/character-rendering.md` is about the item layers above
    /// it, where a straight copy would punch a hole in the arm for every sleeveless chestpiece.
    ///
    /// Scaled with a linear filter: a skin is authored a few hundred pixels a side and this
    /// buffer is 2048 wide, and nearest-neighbour at that ratio shows the reader the texels.
    ///
    /// **Nothing in the app calls this yet, and that is the one thing missing from the bare
    /// body.** Which BLP a character's skin is comes out of the player's own customization —
    /// `ChrCustomizationChoice` to `ChrCustomizationElement` to `ChrCustomizationMaterial` and
    /// only then into `TextureFileData` — and not one of those four tables' column positions
    /// has been read off an install the way the chains in `docs/game-files.md` were. Guessing
    /// at four in a row would paint the body with whatever the guess landed on and call it a
    /// skin. So the atlas stays [`Atlas::unpainted`] until that chain is verified, and this is
    /// the one function that changes when it is.
    pub fn base(&mut self, blp: &[u8]) -> Result<(), String> {
        let skin = pixels_of(blp, ATLAS_WIDTH)?;
        self.pixels = image::imageops::resize(&skin, ATLAS_WIDTH, ATLAS_HEIGHT, FilterType::Triangle);
        Ok(())
    }

    /// Paints one appearance's textures into the rectangles the layout gives them.
    ///
    /// This is the whole of showing armour. Each row of `ItemDisplayInfoMaterialRes` is a
    /// picture and a part of the body; each lands in its rectangle, scaled to fill it, over
    /// whatever the atlas already held.
    ///
    /// Three things decide whether it looks right, and all three fail as a picture rather than
    /// as an error — `docs/character-rendering.md` has them:
    ///
    /// - **Always alpha-blend.** The game's layer data nominally asks for a straight copy on
    ///   some layers, and a copy erases the body wherever the item texture is transparent. Do
    ///   that and every sleeveless chestpiece punches a hole in the arm.
    /// - **Scale with a linear filter.** Armour textures are authored small — 128 × 64 upward
    ///   — and land in rectangles a few hundred pixels wide. Nearest-neighbour shows the
    ///   reader the texels against a 2048-wide base.
    /// - **Drop what the layout has no room for**, which is section 8 and nothing else.
    ///
    /// A texture this install cannot produce leaves its part of the body bare rather than
    /// failing the whole character: a chestpiece whose lower torso is missing is still most of
    /// what the reader asked to see, and the alternative is an error where a body should be.
    pub fn wear(&mut self, files: &dyn GameFiles, textures: &[ComponentTexture]) -> Painting {
        let mut report = Painting::default();
        for texture in textures {
            let Some(rect) = rect_of(texture.section) else {
                // Section 8, and nothing else. The layout has nowhere to put it, which is a
                // fact about this body rather than a loss the reader could act on, so it is
                // dropped as quietly as it always was.
                continue;
            };
            let decoded = match files
                .read(texture.file)
                .and_then(|blp| pixels_of(&blp, ATLAS_WIDTH))
            {
                Ok(decoded) => decoded,
                Err(why) => {
                    report
                        .missing
                        .push(format!("{}: {why}", name_of(texture.section)));
                    continue;
                }
            };
            let scaled =
                image::imageops::resize(&decoded, rect.width, rect.height, FilterType::Triangle);
            // `overlay` composites source-over, which is the blend the paragraph above is
            // about; `replace` is the copy that would take the holes with it.
            image::imageops::overlay(&mut self.pixels, &scaled, i64::from(rect.x), i64::from(rect.y));
            report.painted += 1;
        }
        report
    }

    /// The atlas as PNG bytes, which is the one picture format a `.glb` carries and a browser
    /// reads.
    pub fn png(&self) -> Result<Vec<u8>, String> {
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(
                self.pixels.as_raw(),
                self.pixels.width(),
                self.pixels.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|error| format!("the body atlas would not encode: {error}"))?;
        Ok(png)
    }
}

/// What a reader would call the part of the body a section covers.
///
/// The layout numbers them and the reader does not, so a sentence about section 6 says nothing
/// to the person looking at the legs it did not paint.
fn name_of(section: u32) -> &'static str {
    match section {
        0 => "the upper arms",
        1 => "the lower arms",
        2 => "the hands",
        3 => "the upper torso",
        4 => "the lower torso",
        5 => "the upper legs",
        6 => "the lower legs",
        7 => "the feet",
        9 | 10 => "the scalp",
        _ => "one part of the body",
    }
}

/// The rectangle a section is painted into, or nothing where the layout has none for it.
fn rect_of(section: u32) -> Option<&'static Rect> {
    SECTIONS
        .iter()
        .find(|(which, _)| *which == section)
        .map(|(_, rect)| rect)
}

/// The bare character, as a `.glb` in a data URL for the window to load.
///
/// Unlike an appearance's model there is no `null` answer here. Every armour slot in the game
/// is drawn on this one mesh, so an install that cannot produce it has nothing to fall back to
/// and the failure is worth reporting rather than showing an empty pane over.
pub fn model_of(files: &dyn GameFiles) -> Result<Value, String> {
    let glb = glb_of(files, None)?;
    Ok(serde_json::json!({ "model": data_url("model/gltf-binary", &glb) }))
}

/// The same character with one appearance on it, or `null` when there is nothing to put there.
///
/// `null` is an ordinary answer, and it is the same one an appearance with no model of its own
/// gives: the game encrypts the displays of content it has not shipped, and a slot whose only
/// texture was painted for another body resolves to nothing. Either way the window keeps
/// showing the icon it already has, rather than a bare body that pretends to be dressed.
pub fn worn_model_of(
    files: &dyn GameFiles,
    display_info_id: u32,
    display_type: u32,
) -> Result<Value, String> {
    let worn = crate::worn::of(files, display_info_id, display_type)?;
    if worn.is_empty() {
        return Ok(serde_json::json!({
            "displayInfoId": display_info_id,
            "model": Value::Null,
            "missing": Vec::<String>::new(),
        }));
    }
    let (glb, painting) = painted_glb_of(files, Some(&worn))?;
    Ok(serde_json::json!({
        "displayInfoId": display_info_id,
        "model": data_url("model/gltf-binary", &glb),
        "missing": unshown(&worn, &painting),
    }))
}

/// Everything the appearance says it does to the body and this install could not show.
///
/// Three ways that happens and the reader can tell none of them apart by looking, so each says
/// which part of the body it cost and why: a section the game's tables put no file behind, a
/// file that would not read or decode, and — the quiet one — an appearance whose whole
/// texture chain came back empty while its geosets did not. That last is a character wearing
/// the *shape* of a piece of armour in the colour of bare skin, which is exactly the thing
/// nobody could account for before this said so.
fn unshown(worn: &Worn, painting: &Painting) -> Vec<String> {
    let mut missing: Vec<String> = worn
        .unpaintable
        .iter()
        .map(|section| format!("{}: the game's tables name no texture for it", name_of(*section)))
        .collect();
    missing.extend(painting.missing.iter().cloned());
    if worn.textures.is_empty() && !worn.geosets.is_empty() {
        missing.push(
            "this appearance changes the shape of the body and paints nothing on it: the game's \
             tables give it no textures at all"
                .into(),
        );
    }
    missing
}

/// The `.glb` bytes themselves — which is what `dump_model` writes to a file.
///
/// `worn` is the one appearance being shown, when there is one. Nothing else about the body
/// changes with it: the same mesh, the same UVs, the same atlas, one layer deeper.
pub fn glb_of(files: &dyn GameFiles, worn: Option<&Worn>) -> Result<Vec<u8>, String> {
    painted_glb_of(files, worn).map(|(glb, _)| glb)
}

/// The same, keeping what the compositing managed — which is what the window is told.
pub fn painted_glb_of(
    files: &dyn GameFiles,
    worn: Option<&Worn>,
) -> Result<(Vec<u8>, Painting), String> {
    let model = Model::parse(&files.read(HUMAN_FEMALE)?)?;
    let skin = model
        .skin_file_data_id()
        .ok_or("the character model names no skin profile, so nothing says how to draw it")?;
    let mesh = dressed(
        &model.with_skin(&files.read(skin)?)?,
        worn.map_or(&[], |worn| worn.geosets.as_slice()),
    );

    // No base skin: see `Atlas::base` for what is missing and why.
    let mut atlas = Atlas::unpainted();
    let painting = match worn {
        Some(worn) => atlas.wear(files, &worn.textures),
        None => Painting::default(),
    };
    let painted = atlas.png()?;

    let glb = glb::write(&mesh, &|paint| match paint {
        // The model's own textures, which on a body are the few things not customized.
        Paint::File(fdid) => decode_file(files, fdid),
        Paint::Supplied(BODY_TEXTURE) => Some(painted.clone()),
        // Hair, eyes and jewelry: real texture types this composites nothing for.
        Paint::Supplied(_) => None,
    })?;
    Ok((glb, painting))
}

/// The mesh with only the parts a body wearing this — or nothing — draws.
///
/// Per `docs/character-rendering.md`: hide everything, show the skin and the defaults, then
/// for each group the appearance drives, hide that group's whole hundred and show the one
/// value it names. [`bare`] is the first two lines of that; this is the third.
///
/// **A group is only taken over when the body actually holds the geoset it asks for.** That is
/// a deliberate floor rather than an optimisation: the column those values come out of has not
/// been verified against an install, as [`crate::worn`] says, and every way of getting it
/// wrong shows up as geometry rather than as an error. Hiding a group and then showing nothing
/// in it is the worst of those — a leg that is simply absent — and this turns it into the body
/// as it was, which reads as an appearance that changed nothing.
///
/// The vertices are left whole rather than compacted down to the ones the surviving parts
/// use. They are shared by every part, a body has tens of thousands of them, and the indices
/// would all have to be renumbered to save loading the ones the hidden geosets pointed at.
fn dressed(mesh: &Mesh, geosets: &[Geoset]) -> Mesh {
    let taken: Vec<&Geoset> = geosets
        .iter()
        .filter(|worn| mesh.parts.iter().any(|part| part.geoset == worn.geoset))
        .collect();
    let shown = |geoset: u16| match taken.iter().find(|worn| worn.group == geoset / 100) {
        Some(worn) => geoset == worn.geoset,
        None => bare(geoset),
    };
    Mesh {
        vertices: mesh.vertices.clone(),
        parts: mesh.parts.iter().filter(|part| shown(part.geoset)).cloned().collect(),
    }
}

/// A texture the model names, as PNG, or nothing when this install cannot show it.
///
/// A picture that will not decode leaves its part grey rather than failing the whole body,
/// which is the same bargain the item models make: the shape is most of what was asked for.
fn decode_file(files: &dyn GameFiles, fdid: u32) -> Option<Vec<u8>> {
    files.read(fdid).and_then(|blp| png_of(&blp, ATLAS_WIDTH)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// The character's own skin, which nothing in the app supplies yet.
    const BASE_SKIN: u32 = 160_001;

    /// The four colours every fixture icon is painted in, one per quadrant, as the generator
    /// writes them.
    const QUADRANTS: [[u8; 3]; 4] = [[66, 130, 198], [198, 65, 66], [255, 0, 132], [0, 195, 255]];

    /// The fixture displays whose appearances are worn rather than shown on their own, and the
    /// slots `ItemAppearance` gives them.
    const CHESTPIECE: (u32, u32) = (900_003, 3);
    const BOOTS: (u32, u32) = (900_004, 6);
    const ROBE: (u32, u32) = (900_012, 3);

    fn mesh() -> Mesh {
        worn_mesh(&[])
    }

    /// The body as it is drawn with a given set of geosets switched on.
    fn worn_mesh(geosets: &[Geoset]) -> Mesh {
        let files = fixture_files();
        let model = Model::parse(&files.read(HUMAN_FEMALE).unwrap()).unwrap();
        let skin = model.skin_file_data_id().unwrap();
        dressed(&model.with_skin(&files.read(skin).unwrap()).unwrap(), geosets)
    }

    /// The geosets the fixture's own tables say an appearance switches on.
    fn geosets_of((display_info_id, display_type): (u32, u32)) -> Vec<Geoset> {
        crate::worn::of(&fixture_files(), display_info_id, display_type)
            .unwrap()
            .geosets
    }

    /// The geosets a body ends up drawing, which is what the whole selection comes down to.
    fn drawn(mesh: &Mesh) -> Vec<u16> {
        mesh.parts.iter().map(|part| part.geoset).collect()
    }

    /// The atlas an appearance paints, as pixels, ready to be sampled a rectangle at a time.
    fn atlas_of((display_info_id, display_type): (u32, u32)) -> RgbaImage {
        let files = fixture_files();
        let worn = crate::worn::of(&files, display_info_id, display_type).unwrap();
        let mut atlas = Atlas::unpainted();
        atlas.wear(&files, &worn.textures);
        image::load_from_memory(&atlas.png().unwrap()).unwrap().into_rgba8()
    }

    /// The colour in the middle of one of the atlas's section rectangles.
    ///
    /// The middle rather than a corner: a rectangle is filled by scaling a texture into it, and
    /// what a test wants to know is which texture landed there rather than how its edges were
    /// resolved against the neighbouring one.
    fn middle_of(atlas: &RgbaImage, section: u32) -> [u8; 4] {
        let rect = rect_of(section).expect("the layout has a rectangle for that section");
        atlas.get_pixel(rect.x + rect.width / 2, rect.y + rect.height / 4).0
    }

    /// The JSON half of a `.glb`, which is where everything worth asserting on lives.
    fn scene(bytes: &[u8]) -> Value {
        let length = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        serde_json::from_slice(&bytes[20..20 + length]).unwrap()
    }

    // The rule itself, stated as the game numbers geosets. Value 1 is every group's "nothing
    // here" and 0 is the skin; everything else is a variant an item switches on.
    #[test]
    fn draws_the_skin_and_one_default_per_group() {
        // The skin, bare arms, bare legs, bare feet, no helm, hair, the skull.
        for shown in [0, 801, 1101, 2001, 2701, 101, 2101, 1501, 1801] {
            assert!(bare(shown), "{shown} is a default and has to be drawn");
        }
        // Sleeves, trousers, boots, a helm, a cape, a belt: what an item switches on instead.
        for hidden in [802, 804, 1102, 1104, 2002, 2005, 2702, 2703, 1502, 1802] {
            assert!(!bare(hidden), "{hidden} is an item's variant and has to be hidden");
        }
    }

    // The whole point of selecting at all: the file holds every variant of every group, and a
    // reader that drew them would put two pairs of legs in the same trousers. What that looks
    // like on screen is z-fighting and doubled limbs rather than an error, so the count and the
    // geosets themselves are what has to be checked.
    #[test]
    fn draws_each_part_of_the_body_once() {
        let body = mesh();
        let geosets = drawn(&body);
        assert_eq!(geosets, vec![0, 801, 1101, 2001, 2701, 101, 1001, 1301, 501, 2101]);

        // One group, one part. Group 0 is the skin, which is the id with no group of its own.
        let mut groups: Vec<u16> = geosets.iter().map(|geoset| geoset / 100).collect();
        groups.sort_unstable();
        let mut distinct = groups.clone();
        distinct.dedup();
        assert_eq!(groups, distinct, "a group drawn twice is a limb drawn twice");
    }

    // The `level` trap, on the one model where it is not academic. The fixture's skull sits
    // past the first 64k of the index list *and* is one of the parts a bare body draws — so a
    // reader that ignored the level would not draw something spare, it would draw the head
    // out of the vertices at the very front of the model. That is the missing limb.
    #[test]
    fn draws_a_default_geoset_that_sits_past_the_first_64k_indices() {
        let body = mesh();
        let skull = body.parts.iter().find(|part| part.geoset == 2101).expect("the body has a skull");
        // The generator puts each geoset on a cube of its own, eight vertices at a time, and
        // the skull's is the eleventh.
        assert!(skull.indices.iter().all(|index| (80..88).contains(index)), "{:?}", &skull.indices[..6]);
    }

    // The atlas is bound as texture type 1 and nothing else. Hair is type 6 and has an atlas
    // of its own, and painting it with the body's would put somebody's kneecap on the reader's
    // head — which is geometry that looks right and a picture that is nonsense.
    #[test]
    fn paints_the_body_with_the_atlas_and_leaves_the_hair_alone() {
        let asked = std::cell::RefCell::new(Vec::new());
        let mesh = mesh();
        glb::write(&mesh, &|paint| {
            asked.borrow_mut().push(paint);
            match paint {
                Paint::Supplied(BODY_TEXTURE) => Some(b"the atlas".to_vec()),
                _ => None,
            }
        })
        .unwrap();
        // Once each, however many parts share them: the body's six parts ask for one atlas.
        assert_eq!(asked.into_inner(), vec![Paint::Supplied(1), Paint::Supplied(6)]);
    }

    // The atlas is the size the game states for layout 104, and it is a picture rather than a
    // buffer by the time it leaves here. Every UV on the character model is addressed against
    // these dimensions, so a buffer of the wrong size is armour landing somewhere else.
    #[test]
    fn composites_an_atlas_the_size_the_layout_states() {
        let png = Atlas::unpainted().png().unwrap();
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2048, 1024));
    }

    // The base skin covers the whole buffer rather than a corner of it: the fixture texture is
    // eight pixels square and the atlas is 2048 × 1024, which is the scaling every real skin
    // needs too.
    #[test]
    fn lays_the_base_skin_over_the_whole_atlas() {
        let mut atlas = Atlas::unpainted();
        atlas.base(&fixture_files().read(BASE_SKIN).unwrap()).unwrap();
        let decoded = image::load_from_memory(&atlas.png().unwrap()).unwrap().into_rgba8();
        assert_eq!((decoded.width(), decoded.height()), (2048, 1024));

        // A quarter of the fixture skin per quarter of the atlas, sampled well inside each so
        // that the linear filter's seams are not what is being measured.
        for (quadrant, (x, y)) in [(256, 128), (1792, 128), (256, 896), (1792, 896)].iter().enumerate() {
            let pixel = decoded.get_pixel(*x, *y);
            assert_eq!(
                [pixel[0], pixel[1], pixel[2]],
                QUADRANTS[quadrant],
                "quadrant {quadrant} of the atlas"
            );
            assert_eq!(pixel[3], 255, "the base skin is opaque throughout");
        }
    }

    // The whole module, as the window asks for it: a body with geometry and a picture in it.
    #[test]
    fn hands_the_window_a_body_to_turn_around() {
        let answer = model_of(&fixture_files()).unwrap();
        let url = answer["model"].as_str().expect("the answer holds a model");
        let encoded = url.strip_prefix("data:model/gltf-binary;base64,").expect(url);
        use base64::{engine::general_purpose::STANDARD, Engine};
        let scene = scene(&STANDARD.decode(encoded).unwrap());

        assert_eq!(scene["asset"]["version"], "2.0");
        assert_eq!(scene["meshes"][0]["primitives"].as_array().unwrap().len(), 10);
        // One picture: the atlas. The hair asks for a type this composites nothing for, and a
        // part with no picture keeps its geometry.
        assert_eq!(scene["images"].as_array().unwrap().len(), 1);
        assert_eq!(scene["images"][0]["mimeType"], "image/png");
    }

    /* ---------- wearing one appearance ---------- */

    // The geoset half of showing armour, on the three the acceptance names. Each swaps its own
    // groups' defaults for the variant the item drives and leaves every other group alone —
    // and the robe is the one worth reading twice, because it fills the same slot as the
    // chestpiece and takes a different part of the body over.
    #[test]
    fn swaps_the_bare_default_of_each_group_an_appearance_drives() {
        // Sleeves in place of bare arms, a chest in place of the bare torso.
        assert_eq!(
            drawn(&worn_mesh(&geosets_of(CHESTPIECE))),
            vec![0, 802, 1101, 2001, 2701, 101, 1002, 1301, 501, 2101]
        );
        // The boot itself and the booted feet: two groups from one item, and the feet group is
        // the one whose zero means booted rather than bare.
        assert_eq!(
            drawn(&worn_mesh(&geosets_of(BOOTS))),
            vec![0, 801, 1101, 2002, 2701, 101, 1001, 1301, 502, 2101]
        );
        // The robe leaves the chest bare and hangs a skirt over the legs instead.
        assert_eq!(
            drawn(&worn_mesh(&geosets_of(ROBE))),
            vec![0, 802, 1101, 2001, 2701, 101, 1001, 1302, 501, 2101]
        );
    }

    // Every one of those draws the same number of parts as a bare body: one per group, still.
    // Which is what says the group was taken over rather than added to — a variant drawn
    // beside its own default is two pairs of legs in the same trousers.
    #[test]
    fn draws_no_more_parts_dressed_than_bare() {
        let bare = mesh().parts.len();
        for appearance in [CHESTPIECE, BOOTS, ROBE] {
            let body = worn_mesh(&geosets_of(appearance));
            assert_eq!(body.parts.len(), bare, "{appearance:?}");
            let mut groups: Vec<u16> = drawn(&body).iter().map(|geoset| geoset / 100).collect();
            groups.sort_unstable();
            let mut distinct = groups.clone();
            distinct.dedup();
            assert_eq!(groups, distinct, "{appearance:?} draws a group twice");
        }
    }

    // The floor under the geoset column, which has not been read off an install: an item that
    // asks for a variant this body does not hold leaves the group as it was. A leg that is
    // simply absent is the worst way to be wrong about a geoset, and this is what rules it out.
    #[test]
    fn leaves_a_group_alone_when_the_body_holds_nothing_it_asks_for() {
        let absent = [Geoset { group: 11, geoset: 1177 }, Geoset { group: 4, geoset: 402 }];
        assert_eq!(drawn(&worn_mesh(&absent)), drawn(&mesh()));
    }

    // The compositing half: each texture into the rectangle the layout gives its section, and
    // nothing outside it. A section blitted into its neighbour's rectangle is armour on the
    // wrong limb, which is a picture rather than an error.
    #[test]
    fn paints_each_texture_into_the_rectangle_its_section_names() {
        let atlas = atlas_of(CHESTPIECE);
        assert_eq!(middle_of(&atlas, 0), [90, 200, 60, 255]); // upper arms
        assert_eq!(middle_of(&atlas, 1), [120, 40, 200, 255]); // lower arms
        assert_eq!(middle_of(&atlas, 3), [40, 160, 220, 255]); // upper torso
        assert_eq!(middle_of(&atlas, 4), [30, 210, 170, 255]); // lower torso
        // The parts of the body it does not paint keep the tone underneath. The legs are the
        // ones worth naming: they sit directly under the torso in the atlas, so a rectangle
        // one row too tall shows up here rather than anywhere else.
        assert_eq!(middle_of(&atlas, 5), UNPAINTED);
        assert_eq!(middle_of(&atlas, 7), UNPAINTED);

        // And a different appearance paints a different set of them.
        let robe = atlas_of(ROBE);
        assert_eq!(middle_of(&robe, 3), [240, 130, 20, 255]);
        assert_eq!(middle_of(&robe, 5), [70, 20, 190, 255]);
        assert_eq!(middle_of(&robe, 6), [200, 240, 40, 255]);
        assert_eq!(middle_of(&robe, 0), UNPAINTED);
    }

    // The trap: an item layer is alpha-blended even where the game's own layer data says to
    // copy it. A copy erases the body wherever the texture is transparent, which is a hole in
    // the arm for every sleeveless chestpiece — and looks like a rendering bug rather than a
    // compositing one.
    #[test]
    fn blends_an_item_layer_rather_than_copying_it_over_the_body() {
        let atlas = atlas_of(CHESTPIECE);
        let arms = rect_of(0).unwrap();
        // The upper-arm texture is painted for its top half and empty for its bottom one, so
        // the sleeve is there and the arm below it is still the body.
        assert_eq!(atlas.get_pixel(arms.x + arms.width / 2, arms.y + arms.height / 4).0, [90, 200, 60, 255]);
        let below = atlas.get_pixel(arms.x + arms.width / 2, arms.y + arms.height - 8);
        assert_eq!(below.0, UNPAINTED, "a transparent sleeve punched a hole in the arm");
    }

    // The other trap: armour textures are authored a few dozen pixels tall and land in
    // rectangles a few hundred deep, so the scale has to interpolate. Nearest-neighbour leaves
    // the seam between two bands a hard edge; a linear filter leaves a run of blends, and this
    // is what tells the two apart at the one row where they differ.
    #[test]
    fn scales_a_texture_up_with_a_linear_filter() {
        let atlas = atlas_of(CHESTPIECE);
        let torso = rect_of(3).unwrap();
        let seam = atlas.get_pixel(torso.x + torso.width / 2, torso.y + torso.height / 2).0;
        let (top, bottom) = ([40, 160, 220, 255], [220, 60, 140, 255]);
        assert_ne!(seam, top);
        assert_ne!(seam, bottom);
        for channel in 0..3 {
            let (low, high) = (top[channel].min(bottom[channel]), top[channel].max(bottom[channel]));
            assert!((low..=high).contains(&seam[channel]), "{seam:?} is not between the two bands");
        }
    }

    // Section 8 is in the game's tables and has no rectangle in this layout at all, so the row
    // is dropped rather than treated as an error — and nothing else the appearance paints is
    // lost with it. The boots carry one.
    #[test]
    fn drops_a_section_the_layout_has_nowhere_to_put() {
        let boots = crate::worn::of(&fixture_files(), BOOTS.0, BOOTS.1).unwrap();
        assert!(boots.textures.iter().any(|texture| texture.section == 8));
        let atlas = atlas_of(BOOTS);
        assert_eq!(middle_of(&atlas, 7), [20, 100, 240, 255]);
        assert_eq!(middle_of(&atlas, 6), [150, 30, 90, 255]);
        assert!(rect_of(8).is_none());
    }

    // A texture this install does not hold leaves its part of the body bare. A chestpiece with
    // one section missing is most of what the reader asked to see, and an error where a body
    // should be is none of it.
    #[test]
    fn leaves_a_part_bare_when_its_texture_cannot_be_read() {
        // The shirt's only texture is a file the fixture directory deliberately omits.
        let atlas = atlas_of((900_008, 10));
        assert_eq!(middle_of(&atlas, 3), UNPAINTED);
    }

    // And says so. Bare is the right thing to draw and the wrong thing to draw silently: a
    // reader looking at an unpainted torso cannot tell a file this install lacks from an
    // appearance the game paints nothing for, and until this was reported neither could
    // anybody else without running a tool over the install.
    #[test]
    fn says_which_part_of_the_body_a_texture_it_could_not_read_cost() {
        let files = fixture_files();
        let worn = crate::worn::of(&files, 900_008, 2).unwrap();
        let report = Atlas::unpainted().wear(&files, &worn.textures);
        assert_eq!(report.painted, 0);
        assert_eq!(report.missing.len(), 1, "{:?}", report.missing);
        assert!(report.missing[0].starts_with("the upper torso: "), "{:?}", report.missing);
    }

    // The section the layout has nowhere to put is the one silence that stays: it costs the
    // reader nothing and there is nothing they could do about it. The boots carry one, and
    // the two sections that do land are still counted.
    #[test]
    fn keeps_quiet_about_the_section_this_body_has_no_room_for() {
        let files = fixture_files();
        let worn = crate::worn::of(&files, BOOTS.0, BOOTS.1).unwrap();
        let report = Atlas::unpainted().wear(&files, &worn.textures);
        assert_eq!(report.painted, 2);
        assert_eq!(report.missing, Vec::<String>::new());
    }

    // What the window is handed, which is where all of this was going: the model, and every
    // part of the body the appearance says it paints that this install could not.
    #[test]
    fn tells_the_window_what_it_could_not_paint() {
        let answer = worn_model_of(&fixture_files(), 900_008, 2).unwrap();
        assert!(answer["model"].is_string());
        let missing = answer["missing"].as_array().expect("the answer carries the list");
        assert_eq!(missing.len(), 1);
        assert!(missing[0].as_str().unwrap().starts_with("the upper torso: "));

        // An appearance that paints everything it names says nothing, rather than saying so.
        assert_eq!(
            worn_model_of(&fixture_files(), ROBE.0, ROBE.1).unwrap()["missing"],
            serde_json::json!([])
        );
    }

    // The quiet one, and the reason the sentence exists at all: an appearance whose geosets
    // switch geometry on and whose texture chain comes back empty. That is a character wearing
    // the shape of a piece of armour in the colour of bare skin — which is what a body with
    // boots on and no colour anywhere actually is, and it used to arrive with no explanation.
    #[test]
    fn says_so_when_an_appearance_changes_the_shape_of_the_body_and_paints_nothing() {
        // The helm's display drives a geoset and has no row in `ItemDisplayInfoMaterialRes`.
        let worn = crate::worn::of(&fixture_files(), 900_001, 0).unwrap();
        assert!(worn.textures.is_empty() && !worn.geosets.is_empty());
        let missing = unshown(&worn, &Painting::default());
        assert_eq!(missing.len(), 1);
        assert!(missing[0].contains("paints nothing on it"), "{missing:?}");
    }

    // A section the game's tables name and no file can be found for is the third way, and it
    // is the one that says which part of the body went without rather than only that one did.
    #[test]
    fn names_the_part_of_the_body_no_file_could_be_found_for() {
        let worn = Worn {
            textures: Vec::new(),
            geosets: Vec::new(),
            unpaintable: vec![7],
        };
        assert_eq!(
            unshown(&worn, &Painting::default()),
            vec!["the feet: the game's tables name no texture for it"]
        );
    }

    // The whole module as the window asks for it: a body with an appearance on it, still one
    // picture and still the same mesh.
    #[test]
    fn hands_the_window_a_body_with_one_appearance_on_it() {
        let answer = worn_model_of(&fixture_files(), ROBE.0, ROBE.1).unwrap();
        assert_eq!(answer["displayInfoId"], ROBE.0);
        let url = answer["model"].as_str().expect("the answer holds a model");
        let encoded = url.strip_prefix("data:model/gltf-binary;base64,").expect(url);
        use base64::{engine::general_purpose::STANDARD, Engine};
        let scene = scene(&STANDARD.decode(encoded).unwrap());
        assert_eq!(scene["meshes"][0]["primitives"].as_array().unwrap().len(), 10);
        assert_eq!(scene["images"].as_array().unwrap().len(), 1);
    }

    // An appearance this install can say nothing about answers with nothing, the same way one
    // with no model of its own does — and the window keeps showing the icon it has.
    #[test]
    fn answers_with_nothing_for_an_appearance_it_cannot_read() {
        for display in [900_900, 404_040] {
            let answer = worn_model_of(&fixture_files(), display, CHESTPIECE.1).unwrap();
            assert_eq!(answer["model"], Value::Null, "display {display}");
        }
    }

    // The browser tests load `character.glb` into three.js, which is the only place anything
    // actually reads what this module writes. That is worth nothing if the file has drifted
    // from what the converter now produces, so this is what ties the two together:
    //
    //     cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog \
    //         character apps/desktop/fixtures/transmog/character.glb
    //     cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog \
    //         worn/900012/3 apps/desktop/fixtures/transmog/robe.glb
    #[test]
    fn writes_the_glbs_the_browser_tests_load() {
        let robe = crate::worn::of(&fixture_files(), ROBE.0, ROBE.1).unwrap();
        for (name, written) in [
            ("character.glb", glb_of(&fixture_files(), None).unwrap()),
            ("robe.glb", glb_of(&fixture_files(), Some(&robe)).unwrap()),
        ] {
            let committed = std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("fixtures")
                    .join("transmog")
                    .join(name),
            )
            .unwrap_or_else(|_| panic!("{name} is committed"));
            assert_eq!(
                written, committed,
                "{name} is stale; regenerate it with the dump_model example"
            );
        }
    }

    // An install this app cannot read the body out of is worth saying so about rather than
    // showing an empty pane over: unlike an appearance with no model, there is no icon to fall
    // back to and nothing ordinary about a game with no Human Female in it.
    #[test]
    fn says_so_when_the_install_holds_no_character_model() {
        let temp = tempfile::tempdir().unwrap();
        let error = glb_of(&DirFiles::new(temp.path()), None).unwrap_err();
        assert!(error.contains("1000764"), "{error}");
    }
}
