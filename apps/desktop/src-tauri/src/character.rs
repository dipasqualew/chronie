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
use crate::m2::{self, Mesh, Model, Paint};
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

/// The one exception to that, and the only slot whose geometry is the body's own: **type 2 is
/// the cape.**
///
/// A back appearance names no model at all. What it names is a picture, and the cloak it goes
/// on is geoset group 15 of the body — which asks for this type and which nothing else on
/// `humanfemale_hd` does, read off 12.0.5.67. So a cape is a geoset switched on and one
/// texture bound, and it needs neither an attachment nor a file of its own.
const CAPE_TEXTURE: u32 = 2;

/// The largest picture worth handing a model that hangs off the body.
///
/// The atlas is the biggest thing the game paints anything with, so an item's own texture has
/// no business being larger — the same bound `models` puts on a model shown alone.
const LARGEST_TEXTURE: u32 = 2048;

/// One rectangle of the atlas: where a part of the body is painted.
struct Rect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
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
/// texture. [`Atlas::base`] covers every pixel of it on an install this app can read a skin
/// out of, so what is left of this is the install that cannot — see [`crate::skin::of`].
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
    /// Which BLP to hand it is [`crate::skin`]'s question, out of the player's own
    /// customization; this end of it only paints.
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
    pub fn wear(&mut self, files: &dyn GameFiles, textures: &[ComponentTexture]) {
        for texture in textures {
            let Some(rect) = rect_of(texture.section) else {
                continue;
            };
            let Ok(decoded) = files
                .read(texture.file)
                .and_then(|blp| pixels_of(&blp, ATLAS_WIDTH))
            else {
                continue;
            };
            let scaled =
                image::imageops::resize(&decoded, rect.width, rect.height, FilterType::Triangle);
            // `overlay` composites source-over, which is the blend the paragraph above is
            // about; `replace` is the copy that would take the holes with it.
            image::imageops::overlay(&mut self.pixels, &scaled, i64::from(rect.x), i64::from(rect.y));
        }
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
    inventory_type: u32,
) -> Result<Value, String> {
    let worn = crate::worn::of(files, display_info_id, display_type, inventory_type)?;
    if worn.is_empty() {
        return Ok(serde_json::json!({ "displayInfoId": display_info_id, "model": Value::Null }));
    }
    let glb = glb_of(files, Some(&worn))?;
    Ok(serde_json::json!({
        "displayInfoId": display_info_id,
        "model": data_url("model/gltf-binary", &glb),
    }))
}

/// The `.glb` bytes themselves — which is what `dump_model` writes to a file.
///
/// `worn` is the one appearance being shown, when there is one. Nothing else about the body
/// changes with it: the same mesh, the same UVs, the same atlas, one layer deeper.
pub fn glb_of(files: &dyn GameFiles, worn: Option<&Worn>) -> Result<Vec<u8>, String> {
    let model = Model::parse(&files.read(HUMAN_FEMALE)?)?;
    let skin = model
        .skin_file_data_id()
        .ok_or("the character model names no skin profile, so nothing says how to draw it")?;
    let mesh = dressed(&model.with_skin(&files.read(skin)?)?, worn);

    let painted = atlas(files, worn)?.png()?;
    let cape = worn.and_then(|worn| worn.cape).and_then(|fdid| decode_file(files, fdid));
    let body = |paint| match paint {
        // The model's own textures, which on a body are the few things not customized.
        Paint::File(fdid) => decode_file(files, fdid),
        Paint::Supplied(BODY_TEXTURE) => Some(painted.clone()),
        Paint::Supplied(CAPE_TEXTURE) => cape.clone(),
        // Hair, eyes and jewelry: real texture types this composites nothing for.
        Paint::Supplied(_) => None,
    };

    // Held in three lists rather than in the pieces themselves because a piece borrows both
    // its mesh and the closure that paints it, and each of those closures owns a picture of
    // its own — a helm's texture is not a shoulder's and neither is the atlas.
    let hung = hung_on(files, &model, worn)?;
    let painters: Vec<Box<dyn Fn(Paint) -> Option<Vec<u8>>>> = hung
        .iter()
        .map(|(_, _, texture)| {
            let texture = texture.clone();
            let painter: Box<dyn Fn(Paint) -> Option<Vec<u8>>> = Box::new(move |paint| match paint {
                // An item's model wants the one picture, whatever type it asked for. Only a
                // body declares several and has to tell them apart.
                Paint::File(fdid) => decode_file(files, fdid),
                Paint::Supplied(_) => texture.clone(),
            });
            painter
        })
        .collect();

    let mut pieces = vec![glb::Piece::only(&mesh, &body)];
    for ((piece, at, _), painter) in hung.iter().zip(painters.iter()) {
        pieces.push(glb::Piece {
            mesh: piece,
            at: at.position,
            rotation: at.rotation,
            scale: at.scale,
            picture: painter.as_ref(),
        });
    }
    glb::write(&pieces)
}

/// The geometry an appearance hangs off the body: a mesh, where it goes, and its picture.
///
/// Where it goes comes out of the body's own skeleton rather than the item — an item's model
/// is authored around the attachment it belongs on, so a helm's vertices sit around the origin
/// and mean nothing until the head's position is added to them.
///
/// Two absences, and they are not the same. A body with no skeleton is this app being wrong
/// about a file every character in the game has one of, and is worth saying so about. An
/// attachment the skeleton does not name, or a model file this install does not hold, is a
/// piece that cannot be placed — and a pauldron drawn at the origin, which is inside her
/// pelvis, is worse than a pauldron not drawn.
#[allow(clippy::type_complexity)]
fn hung_on(
    files: &dyn GameFiles,
    body: &Model,
    worn: Option<&Worn>,
) -> Result<Vec<(Mesh, m2::Attachment, Option<Vec<u8>>)>, String> {
    let wanted = worn.map_or(&[][..], |worn| worn.models.as_slice());
    if wanted.is_empty() {
        // The skeleton is 16 MB on a real install, and most of a wardrobe hangs nothing.
        return Ok(Vec::new());
    }
    let skeleton = body
        .skeleton_file_data_id()
        .ok_or("the character model names no skeleton, so nothing says where a helm goes")?;
    let attachments = m2::attachments(&files.read(skeleton)?)?;

    let mut hung = Vec::with_capacity(wanted.len());
    for model in wanted {
        let Some(at) = attachments
            .iter()
            .find(|attachment| attachment.id == model.attachment)
            .copied()
        else {
            continue;
        };
        let Ok(bytes) = files.read(model.file) else {
            continue;
        };
        let parsed = Model::parse(&bytes)?;
        let skin = parsed
            .skin_file_data_id()
            .ok_or("a worn model names no skin profile, so nothing says how to draw it")?;
        let mesh = parsed.with_skin(&files.read(skin)?)?;
        let texture = model.texture.and_then(|fdid| {
            files.read(fdid).and_then(|blp| png_of(&blp, LARGEST_TEXTURE)).ok()
        });
        hung.push((mesh, at, texture));
    }
    Ok(hung)
}

/// The one picture the whole body is painted out of: her own skin, and the appearance over it.
///
/// The order is the whole of the compositing rule. The skin covers all 2048 × 1024 as a
/// straight copy, because it is the bottom of the stack and has nothing to blend against;
/// everything above it lands in its own rectangles and blends, because it has. That is the
/// same operation for the two halves of her underwear as for a chestpiece's sleeves — the
/// underwear is only lower down the stack, which is why an item painted over it covers it.
///
/// An install that cannot say which skin leaves the flat tone underneath — which is what every
/// body in this app looked like before that chain was read, so the worst case is the picture
/// this used to give rather than a broken one. What is *not* tolerated is a skin that resolves
/// and will not decode: that is either a build whose columns have moved or this app being
/// wrong about BLP, and a body quietly back to being a mannequin hides both. See
/// [`crate::skin::of`].
fn atlas(files: &dyn GameFiles, worn: Option<&Worn>) -> Result<Atlas, String> {
    let mut atlas = Atlas::unpainted();
    if let Some(skin) = crate::skin::of(files)? {
        atlas.base(&files.read(skin.base)?)?;
        atlas.wear(files, &skin.over);
    }
    if let Some(worn) = worn {
        atlas.wear(files, &worn.textures);
    }
    Ok(atlas)
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
/// And then the third thing, which only a helm does: **a group taken away rather than swapped.**
/// `Worn::hidden` is the groups `HelmetGeosetData` says the helm covers — hair, ears, a beard —
/// and every variant in them goes, because there is no variant of hair that fits under a helm.
///
/// The trap is that hair is **group 0**, and geoset 0 is the body itself. Read off 12.0.5.67:
/// `humanfemale_hd` carries hairstyles as geosets 1 to 33, and the skin as 0 — so hiding "the
/// whole hundred" of group 0 without excepting the one id that has no group takes the character
/// with the hair. That is the difference between a helmed woman and an empty pane.
///
/// The vertices are left whole rather than compacted down to the ones the surviving parts
/// use. They are shared by every part, a body has tens of thousands of them, and the indices
/// would all have to be renumbered to save loading the ones the hidden geosets pointed at.
fn dressed(mesh: &Mesh, worn: Option<&Worn>) -> Mesh {
    let geosets = worn.map_or(&[][..], |worn| worn.geosets.as_slice());
    let hidden = worn.map_or(&[][..], |worn| worn.hidden.as_slice());
    let taken: Vec<&Geoset> = geosets
        .iter()
        .filter(|worn| mesh.parts.iter().any(|part| part.geoset == worn.geoset))
        .collect();
    let shown = |geoset: u16| match taken.iter().find(|worn| worn.group == geoset / 100) {
        Some(worn) => geoset == worn.geoset,
        None => bare(geoset),
    };
    let covered = |geoset: u16| geoset != 0 && hidden.contains(&(geoset / 100));
    Mesh {
        vertices: mesh.vertices.clone(),
        parts: mesh
            .parts
            .iter()
            .filter(|part| shown(part.geoset) && !covered(part.geoset))
            .cloned()
            .collect(),
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

    /// One fixture appearance as the window asks for it: the display, the slot
    /// `ItemAppearance` gives it, and where `ItemSparse` says the item is worn — which is
    /// nothing at all for a piece of armour and the hand for a weapon.
    type Appearance = (u32, u32, u32);

    /// The fixture displays whose appearances are painted onto the body.
    const CHESTPIECE: Appearance = (900_003, 3, 0);
    const BOOTS: Appearance = (900_004, 6, 0);
    const ROBE: Appearance = (900_012, 3, 0);
    /// And the ones with geometry of their own, which are what hangs off her.
    const HELM: Appearance = (900_001, 0, 0);
    const SHOULDERS: Appearance = (900_002, 1, 0);
    const CAPE: Appearance = (900_013, 9, 0);
    /// And the weapon rack, which is the one kind of appearance whose third number does the
    /// work: the display and the slot say a weapon, and where it is worn says which hand.
    const ONE_HANDER: Appearance = (900_007, 11, 13);
    const OFF_HAND: Appearance = (900_007, 15, 23);
    const SHIELD: Appearance = (900_015, 13, 14);

    fn mesh() -> Mesh {
        worn_mesh(&Worn::default())
    }

    /// The body as it is drawn with a given appearance on it.
    fn worn_mesh(worn: &Worn) -> Mesh {
        let files = fixture_files();
        let model = Model::parse(&files.read(HUMAN_FEMALE).unwrap()).unwrap();
        let skin = model.skin_file_data_id().unwrap();
        dressed(&model.with_skin(&files.read(skin).unwrap()).unwrap(), Some(worn))
    }

    /// The body as it is drawn with a given set of geosets switched on and nothing else.
    fn geoset_mesh(geosets: &[Geoset]) -> Mesh {
        worn_mesh(&Worn {
            geosets: geosets.to_vec(),
            ..Default::default()
        })
    }

    /// What the fixture's own tables say an appearance does to the body.
    fn worn_of((display_info_id, display_type, inventory_type): Appearance) -> Worn {
        crate::worn::of(&fixture_files(), display_info_id, display_type, inventory_type).unwrap()
    }

    /// The geosets a body ends up drawing, which is what the whole selection comes down to.
    fn drawn(mesh: &Mesh) -> Vec<u16> {
        mesh.parts.iter().map(|part| part.geoset).collect()
    }

    /// The atlas an appearance paints on its own, over nothing — which is how the rectangles
    /// each texture lands in are read without the skin underneath colouring the answer.
    fn atlas_of((display_info_id, display_type, inventory_type): Appearance) -> RgbaImage {
        let files = fixture_files();
        let worn = crate::worn::of(&files, display_info_id, display_type, inventory_type).unwrap();
        let mut atlas = Atlas::unpainted();
        atlas.wear(&files, &worn.textures);
        image::load_from_memory(&atlas.png().unwrap()).unwrap().into_rgba8()
    }

    /// The atlas the app actually paints a body with: the skin, and an appearance over it.
    fn body_atlas(worn: Option<Appearance>) -> RgbaImage {
        let files = fixture_files();
        let worn = worn.map(|(display_info_id, display_type, inventory_type)| {
            crate::worn::of(&files, display_info_id, display_type, inventory_type).unwrap()
        });

        let png = atlas(&files, worn.as_ref()).unwrap().png().unwrap();
        image::load_from_memory(&png).unwrap().into_rgba8()
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

    /// The scene the window is handed for one appearance worn on the body.
    fn worn_scene(appearance: Appearance) -> Value {
        let worn = worn_of(appearance);
        scene(&glb_of(&fixture_files(), Some(&worn)).unwrap())
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
        // The skin, bare arms, bare legs, bare feet, no helm, the first hairstyle, the skull.
        for shown in [0, 801, 1101, 2001, 2701, 1, 2101, 1501, 1801] {
            assert!(bare(shown), "{shown} is a default and has to be drawn");
        }
        // Sleeves, trousers, boots, a helm, a cape, a belt, another hairstyle: what an item
        // switches on instead, or what the player picked instead.
        for hidden in [802, 804, 1102, 1104, 2002, 2005, 2702, 2703, 1502, 1802, 2] {
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
        assert_eq!(geosets, vec![0, 801, 1101, 2001, 2701, 1, 1001, 1301, 501, 2101]);

        // One group, one part — for every group but the hair's, which is group 0 and which
        // the skin shares because the skin is the one geoset with no group of its own.
        let mut groups: Vec<u16> = geosets.iter().filter(|geoset| **geoset != 0)
            .map(|geoset| geoset / 100).collect();
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
        glb::write(&[glb::Piece::only(&mesh, &|paint| {
            asked.borrow_mut().push(paint);
            match paint {
                Paint::Supplied(BODY_TEXTURE) => Some(b"the atlas".to_vec()),
                _ => None,
            }
        })])
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

    // The point of the whole chain: a bare body opens with skin on it rather than as a
    // mannequin in one flat tone. Every part of the atlas, because a skin covers all of it —
    // including the right half the body's own UVs never read.
    #[test]
    fn opens_the_bare_body_with_skin_on_it() {
        let atlas = body_atlas(None);
        for (quadrant, (x, y)) in [(256, 128), (1792, 128), (256, 896), (1792, 896)].iter().enumerate() {
            let pixel = atlas.get_pixel(*x, *y).0;
            assert_ne!(pixel, UNPAINTED, "the body is still the unpainted tone at {x},{y}");
            assert_eq!([pixel[0], pixel[1], pixel[2]], QUADRANTS[quadrant], "at {x},{y}");
        }
    }

    // The rest of what the same choice paints, which is why a bare body is not a nude one: the
    // underwear is two more layers over the skin rather than part of its picture, and each
    // lands in the one rectangle its section mask names. An item worn over it covers it, the
    // same way it covers anything else already in that rectangle.
    #[test]
    fn dresses_the_bare_body_in_what_the_rest_of_the_choice_paints() {
        let bare = body_atlas(None);
        assert_eq!(middle_of(&bare, 3), [40, 190, 40, 255], "the upper torso");
        assert_eq!(middle_of(&bare, 5), [190, 40, 40, 255], "the upper legs");
        // And nowhere else: a layer painted over the whole buffer instead of into its own
        // rectangle would be the body rather than a thing worn on it.
        assert_eq!(middle_of(&bare, 4), middle_of(&bare, 0));

        let chestpiece = body_atlas(Some(CHESTPIECE));
        assert_eq!(middle_of(&chestpiece, 3), [40, 160, 220, 255], "and armour goes over it");
    }

    // And the other half of it: an appearance worn on that body still lands where the layout
    // puts it, and the parts it does not paint are skin rather than the tone underneath. The
    // legs are the pair worth reading — the robe paints them and the chestpiece does not.
    #[test]
    fn paints_an_appearance_over_the_skin_rather_than_over_the_flat_tone() {
        // What a bare body has in each rectangle, which is what the parts an appearance does
        // not paint have to still be.
        let bare = body_atlas(None);

        let robe = body_atlas(Some(ROBE));
        assert_eq!(middle_of(&robe, 3), [240, 130, 20, 255]); // upper torso
        assert_eq!(middle_of(&robe, 5), [70, 20, 190, 255]); // upper legs
        assert_eq!(middle_of(&robe, 6), [200, 240, 40, 255]); // lower legs
        assert_eq!(middle_of(&robe, 0), middle_of(&bare, 0), "a sleeveless robe leaves the arm");

        let chestpiece = body_atlas(Some(CHESTPIECE));
        assert_eq!(middle_of(&chestpiece, 0), [90, 200, 60, 255]); // upper arms
        assert_eq!(middle_of(&chestpiece, 5), middle_of(&bare, 5), "the chestpiece paints no legs");
        assert_ne!(middle_of(&bare, 5), UNPAINTED, "and what is left there is skin");
    }

    // The trap the base is the other side of: a sleeveless chestpiece is transparent where the
    // arm shows, and what shows through is now the character rather than a flat tone. Copy the
    // item layer instead of blending it and the hole is in the skin.
    #[test]
    fn shows_the_skin_through_a_transparent_item_layer() {
        let arms = rect_of(0).unwrap();
        let (x, y) = (arms.x + arms.width / 2, arms.y + arms.height - 8);
        let worn = body_atlas(Some(CHESTPIECE));
        let bare = body_atlas(None);
        assert_eq!(worn.get_pixel(x, y), bare.get_pixel(x, y));
        assert_ne!(bare.get_pixel(x, y).0, UNPAINTED);
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
            drawn(&worn_mesh(&worn_of(CHESTPIECE))),
            vec![0, 802, 1101, 2001, 2701, 1, 1002, 1301, 501, 2101]
        );
        // The boot itself and the booted feet: two groups from one item, and the feet group is
        // the one whose zero means booted rather than bare.
        assert_eq!(
            drawn(&worn_mesh(&worn_of(BOOTS))),
            vec![0, 801, 1101, 2002, 2701, 1, 1001, 1301, 502, 2101]
        );
        // The robe leaves the chest bare and hangs a skirt over the legs instead.
        assert_eq!(
            drawn(&worn_mesh(&worn_of(ROBE))),
            vec![0, 802, 1101, 2001, 2701, 1, 1001, 1302, 501, 2101]
        );
    }

    // Every one of those draws the same number of parts as a bare body: one per group, still.
    // Which is what says the group was taken over rather than added to — a variant drawn
    // beside its own default is two pairs of legs in the same trousers.
    #[test]
    fn draws_no_more_parts_dressed_than_bare() {
        let bare = mesh().parts.len();
        for appearance in [CHESTPIECE, BOOTS, ROBE] {
            let body = worn_mesh(&worn_of(appearance));
            assert_eq!(body.parts.len(), bare, "{appearance:?}");
            let mut groups: Vec<u16> = drawn(&body).iter().filter(|geoset| **geoset != 0)
                .map(|geoset| geoset / 100).collect();
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
        assert_eq!(drawn(&geoset_mesh(&absent)), drawn(&mesh()));
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
        let boots = crate::worn::of(&fixture_files(), BOOTS.0, BOOTS.1, BOOTS.2).unwrap();
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
        let atlas = atlas_of((900_008, 10, 0));
        assert_eq!(middle_of(&atlas, 3), UNPAINTED);
    }

    // The whole module as the window asks for it: a body with an appearance on it, still one
    // picture and still the same mesh.
    #[test]
    fn hands_the_window_a_body_with_one_appearance_on_it() {
        let answer = worn_model_of(&fixture_files(), ROBE.0, ROBE.1, ROBE.2).unwrap();
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
            let answer = worn_model_of(&fixture_files(), display, CHESTPIECE.1, 0).unwrap();
            assert_eq!(answer["model"], Value::Null, "display {display}");
        }
    }

    /* ---------- wearing the four slots that have geometry ---------- */

    // The acceptance, for a helm: it is on her head rather than in mid-air. A node of its own
    // with a translation on it, and the translation is the head attachment the body's skeleton
    // states — which is what says the position came out of the game's files rather than out of
    // an eyeball. An item left at the origin would be inside her pelvis.
    #[test]
    fn puts_a_helm_on_her_head() {
        let scene = worn_scene(HELM);
        assert_eq!(
            scene["nodes"],
            serde_json::json!([
                { "mesh": 0 },
                { "mesh": 1, "translation": [0.0, 4.0, 0.0] },
            ])
        );
        // Geometry, not merely a node: the helm's own cube, whole.
        assert_eq!(scene["meshes"][1]["primitives"].as_array().unwrap().len(), 1);
    }

    // And for a pair of shoulders: two pads, on the two shoulders, either side of her. One pad
    // twice is what reading a single model resource and hanging it off both attachments looks
    // like, so what this reads is that the two nodes hold *different* meshes as well as
    // different positions.
    #[test]
    fn puts_a_pad_on_each_shoulder_rather_than_one_pad_twice() {
        let scene = worn_scene(SHOULDERS);
        let nodes = scene["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[1]["translation"], serde_json::json!([0.0, 3.0, -2.0]));
        assert_eq!(nodes[2]["translation"], serde_json::json!([0.0, 3.0, 2.0]));
        assert_ne!(nodes[1]["mesh"], nodes[2]["mesh"]);

        // Each with a picture of its own, which is the other half of two pads rather than one:
        // the body's atlas, and then one texture per pad.
        assert_eq!(scene["images"].as_array().unwrap().len(), 3);
    }

    // A cape is the odd one: geometry the body already carries, and all the appearance brings
    // is the picture that goes on it. So there is no extra node at all — one mesh, one more
    // part in it, and a second image beside the atlas.
    #[test]
    fn hangs_a_cape_off_her_back_without_a_model_to_hang() {
        let scene = worn_scene(CAPE);
        assert_eq!(scene["nodes"].as_array().unwrap().len(), 1);
        assert!(drawn(&worn_mesh(&worn_of(CAPE))).contains(&1502));
        // The atlas and the cloak's own picture. A cape whose texture went unresolved is a
        // black sheet rather than an error, which is why the count is what this reads.
        assert_eq!(scene["images"].as_array().unwrap().len(), 2);
    }

    // The other half of the acceptance, and the trap under it. A helm hides hair, and hair is
    // **group 0** — the same hundred the skin is in. Hiding the group without excepting geoset
    // 0 takes the whole character with the hairstyle, which is an empty pane rather than a
    // helmed woman.
    #[test]
    fn a_helm_that_hides_hair_hides_it_and_leaves_the_body_on() {
        let bare = drawn(&mesh());
        assert!(bare.contains(&1), "a bare body wears the first hairstyle");

        let helmed = drawn(&worn_mesh(&worn_of(HELM)));
        assert!(!helmed.contains(&1), "the helm covers the hair");
        assert!(helmed.contains(&0), "and not the body it is attached to");
        // The whole hundred, not only the one variant a bare body happened to draw.
        assert!(!helmed.contains(&2));
        // And nothing else: the helm's own group swaps as any item's does, and every other
        // group is where a bare body left it.
        assert_eq!(helmed, vec![0, 801, 1101, 2001, 2702, 1001, 1301, 501, 2101]);
    }

    // Taking it off puts the hair back, which is the same sentence read the other way: the
    // hiding belongs to the appearance and not to the body.
    #[test]
    fn taking_the_helm_off_puts_the_hair_back() {
        assert_eq!(drawn(&worn_mesh(&Worn::default())), drawn(&mesh()));
        assert_eq!(drawn(&worn_mesh(&worn_of(CHESTPIECE))).contains(&1), true);
    }

    // The acceptance for a weapon: it is in her hand rather than in mid-air, and *which* hand
    // is the one thing the display cannot say. The same display, read as a one-hander and as
    // something held in the other hand, is the same mesh on two different sides of her.
    #[test]
    fn puts_a_sword_in_the_hand_the_game_says_it_is_held_in() {
        let right = worn_scene(ONE_HANDER);
        assert_eq!(
            right["nodes"],
            serde_json::json!([
                { "mesh": 0 },
                { "mesh": 1, "translation": [1.0, 1.0, 3.0] },
            ])
        );
        // Geometry, and not merely a node: the weapon's two submeshes, whole.
        assert_eq!(right["meshes"][1]["primitives"].as_array().unwrap().len(), 2);

        let left = worn_scene(OFF_HAND);
        assert_eq!(left["nodes"][1]["translation"], serde_json::json!([1.0, 1.0, -3.0]));
        assert_eq!(right["meshes"], left["meshes"], "the same weapon, the other hand");
    }

    // A shield is neither hand: it hangs off the arm, and on the real body off a bone the
    // hands' chains do not pass through at all.
    #[test]
    fn hangs_a_shield_off_her_arm() {
        let scene = worn_scene(SHIELD);
        assert_eq!(scene["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(scene["nodes"][1]["translation"], serde_json::json!([0.0, 2.0, -3.0]));
    }

    // And the body underneath is untouched by any of it. A weapon paints nothing into the
    // atlas and switches no geoset, so what is left is a woman holding something — the same
    // parts a bare body draws, and one picture more than it has.
    #[test]
    fn a_weapon_changes_nothing_about_the_body_it_is_held_by() {
        assert_eq!(drawn(&worn_mesh(&worn_of(ONE_HANDER))), drawn(&mesh()));
        let scene = worn_scene(ONE_HANDER);
        assert_eq!(scene["images"].as_array().unwrap().len(), 2);
    }

    // A model the install does not hold leaves the body without it rather than dropping it at
    // the origin, which on a character is inside her pelvis. Display 900010 names a model
    // resource whose file the fixture deliberately omits.
    #[test]
    fn leaves_out_a_worn_model_this_install_cannot_read() {
        let scene = worn_scene((900_010, HELM.1, 0));
        assert_eq!(scene["nodes"].as_array().unwrap().len(), 1);
    }

    // The browser tests load `character.glb` into three.js, which is the only place anything
    // actually reads what this module writes. That is worth nothing if the file has drifted
    // from what the converter now produces, so this is what ties the two together:
    //
    //     cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog \
    //         character apps/desktop/fixtures/transmog/character.glb
    //     cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog \
    //         worn/900012/3 apps/desktop/fixtures/transmog/robe.glb
    //     cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog \
    //         worn/900001/0 apps/desktop/fixtures/transmog/worn-helm.glb
    //
    // `worn-helm.glb` is the one with more than one node in it, which is the shape three.js
    // had never been handed before this: a body, and a helm sitting above it on a translation.
    #[test]
    fn writes_the_glbs_the_browser_tests_load() {
        let robe = worn_of(ROBE);
        let helm = worn_of(HELM);
        for (name, written) in [
            ("character.glb", glb_of(&fixture_files(), None).unwrap()),
            ("robe.glb", glb_of(&fixture_files(), Some(&robe)).unwrap()),
            ("worn-helm.glb", glb_of(&fixture_files(), Some(&helm)).unwrap()),
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
