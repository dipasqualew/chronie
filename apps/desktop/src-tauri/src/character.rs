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

use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ImageEncoder, Rgba, RgbaImage};

use crate::casc::GameFiles;
use crate::glb;
use crate::icons::{data_url, pixels_of, png_of};
use crate::m2::{Mesh, Model, Paint};

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

/// The bare character, as a `.glb` in a data URL for the window to load.
///
/// Unlike an appearance's model there is no `null` answer here. Every armour slot in the game
/// is drawn on this one mesh, so an install that cannot produce it has nothing to fall back to
/// and the failure is worth reporting rather than showing an empty pane over.
pub fn model_of(files: &dyn GameFiles, base_skin: Option<u32>) -> Result<serde_json::Value, String> {
    let glb = glb_of(files, base_skin)?;
    Ok(serde_json::json!({ "model": data_url("model/gltf-binary", &glb) }))
}

/// The same, as the `.glb` bytes themselves — which is what `dump_model` writes to a file.
///
/// `base_skin` is the FileDataID of the character's own skin texture, when the caller has one.
/// See [`Atlas::base`] for why nothing does yet.
pub fn glb_of(files: &dyn GameFiles, base_skin: Option<u32>) -> Result<Vec<u8>, String> {
    let model = Model::parse(&files.read(HUMAN_FEMALE)?)?;
    let skin = model
        .skin_file_data_id()
        .ok_or("the character model names no skin profile, so nothing says how to draw it")?;
    let mesh = undressed(&model.with_skin(&files.read(skin)?)?);

    let mut atlas = Atlas::unpainted();
    if let Some(fdid) = base_skin {
        atlas.base(&files.read(fdid)?)?;
    }
    let painted = atlas.png()?;

    glb::write(&mesh, &|paint| match paint {
        // The model's own textures, which on a body are the few things not customized.
        Paint::File(fdid) => decode_file(files, fdid),
        Paint::Supplied(BODY_TEXTURE) => Some(painted.clone()),
        // Hair, eyes and jewelry: real texture types this composites nothing for.
        Paint::Supplied(_) => None,
    })
}

/// The mesh with only the parts a body wearing nothing draws.
///
/// The vertices are left whole rather than compacted down to the ones the surviving parts
/// use. They are shared by every part, a body has tens of thousands of them, and the indices
/// would all have to be renumbered to save loading the ones the hidden geosets pointed at.
fn undressed(mesh: &Mesh) -> Mesh {
    Mesh {
        vertices: mesh.vertices.clone(),
        parts: mesh.parts.iter().filter(|part| bare(part.geoset)).cloned().collect(),
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
    use serde_json::Value;

    /// The character's own skin, which nothing in the app supplies yet.
    const BASE_SKIN: u32 = 160_001;

    /// The four colours every fixture texture is painted in, one per quadrant, as the
    /// generator writes them.
    const QUADRANTS: [[u8; 3]; 4] = [[66, 130, 198], [198, 65, 66], [255, 0, 132], [0, 195, 255]];

    fn mesh() -> Mesh {
        let files = fixture_files();
        let model = Model::parse(&files.read(HUMAN_FEMALE).unwrap()).unwrap();
        let skin = model.skin_file_data_id().unwrap();
        undressed(&model.with_skin(&files.read(skin).unwrap()).unwrap())
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
        let geosets: Vec<u16> = body.parts.iter().map(|part| part.geoset).collect();
        assert_eq!(geosets, vec![0, 801, 1101, 2001, 2701, 101, 2101]);

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
        let answer = model_of(&fixture_files(), None).unwrap();
        let url = answer["model"].as_str().expect("the answer holds a model");
        let encoded = url.strip_prefix("data:model/gltf-binary;base64,").expect(url);
        use base64::{engine::general_purpose::STANDARD, Engine};
        let scene = scene(&STANDARD.decode(encoded).unwrap());

        assert_eq!(scene["asset"]["version"], "2.0");
        assert_eq!(scene["meshes"][0]["primitives"].as_array().unwrap().len(), 7);
        // One picture: the atlas. The hair asks for a type this composites nothing for, and a
        // part with no picture keeps its geometry.
        assert_eq!(scene["images"].as_array().unwrap().len(), 1);
        assert_eq!(scene["images"][0]["mimeType"], "image/png");
    }

    // The browser tests load `character.glb` into three.js, which is the only place anything
    // actually reads what this module writes. That is worth nothing if the file has drifted
    // from what the converter now produces, so this is what ties the two together:
    //
    //     cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog \
    //         character apps/desktop/fixtures/transmog/character.glb
    #[test]
    fn writes_the_glb_the_browser_tests_load() {
        let committed = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("fixtures")
                .join("transmog")
                .join("character.glb"),
        )
        .expect("the fixture glb is committed");
        assert_eq!(
            glb_of(&fixture_files(), None).unwrap(),
            committed,
            "character.glb is stale; regenerate it with the dump_model example"
        );
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
