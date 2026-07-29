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
//!   and z-fighting look like from the outside, so one variant per group is picked — by
//!   [`crate::customization`] where the character has an opinion, and by [`bare`] where she has
//!   none. Her head is the part of a body that no rule about armour can reach: group 32's value
//!   1 is the stub a helm leaves rather than a bare default, so it comes from her own face shape
//!   where the game asks her one and from [`WORN_ANYWAY`] on the forty-four bodies it does not.
//! - **The skin comes from the caller.** The body's texture is M2 type 1, the composited
//!   2048 × 1024 atlas this module builds, rather than a file the model names. So do her hair
//!   and her eyes, which are types 6 and 19 and atlases of their own — a part handed nothing
//!   for one of those is drawn in flat white, which on a hairstyle reads as a bald cap.
//!
//! And then the point of all of it: **a set of clothes, worn.** What an item does to a body is
//! two things and no more — it paints textures into rectangles of that atlas, and it switches
//! geoset variants on in place of the bare defaults. [`crate::worn`] reads both out of the
//! game's tables; [`Atlas::wear`] and [`dressed`] are where they land on the character.
//!
//! Twelve items do the same two things twelve times over, and the arguments between them are
//! settled before anything gets here: [`crate::worn::of_set`] hands over the textures already in
//! draw order and at most one geoset per group, priority resolved. So both of the functions
//! below stayed lists — [`Atlas::wear`] paints what it is given in the order it is given, and
//! [`dressed`] finds one owner per group because there is one to find.
//!
//! # The body, kept
//!
//! Everything above is about one outfit, and almost none of it is about the outfit. Her mesh, her
//! skin resized onto the atlas, her face composited over that, her hair and eye atlases decoded,
//! and the skeleton that says where a helm hangs are the same for every appearance ever shown on
//! her — so [`Mannequin`] is all of that, built once and worn many times. [`crate::gallery`] is
//! why: a page of the wardrobe is twenty appearances each on a body of her own, and building
//! twenty bodies to show twenty hats is most of the cost of the feature.

use std::cell::OnceCell;

use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ImageEncoder, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::body::{self, Body};
use crate::casc::GameFiles;
use crate::customization::{Customization, Picked};
use crate::glb;
use crate::icons::{data_url, pixels_of, png_of};
use crate::m2::{self, Mesh, Model, Paint};
use crate::worn::{ComponentTexture, Geoset, Worn};

/// The M2 texture type the composited atlas is bound as.
///
/// The other types a body asks for — 6 hair, 19 eyes, 20 jewelry — have atlases of their own
/// and are not what armour is painted into. A part that wants one of those is painted with the
/// picture [`crate::customization`] found for that type instead, which is a different picture
/// and not this one: painting hair with the body's atlas would put somebody's kneecap on the
/// reader's head, and painting it with nothing at all leaves a white cap where a hairstyle is.
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

/// What an atlas holds where nothing has been composited into it.
///
/// A flat tone rather than transparency or magenta: the point of this view is the shape of a
/// body, and a body with see-through patches reads as broken geometry rather than as a missing
/// texture. [`Atlas::base`] covers every pixel of it on an install this app can read a skin
/// out of, so what is left of this is the install that cannot — see
/// [`crate::customization::of`].
const UNPAINTED: [u8; 4] = [0xc8, 0xa2, 0x8c, 0xff];

/// Whether a geoset is drawn on a body with nothing on it.
///
/// A geoset id is `group × 100 + value`, and **value 1 is every group's "nothing here"**: bare
/// arms rather than sleeves, bare legs rather than trousers, bare feet rather than boots, no
/// helm, no cape, no belt. Geoset 0 is the skin itself, and the one id with no group of its
/// own. Everything else in the file is a variant that some item switches on in place of the
/// default, and the file holds all of them at once.
///
/// So this is "hide everything, then show geoset 0 and the defaults" from
/// `docs/character-rendering.md`, and getting it wrong has three faces, all of them geometry
/// rather than an error: draw too much and limbs double and z-fight, draw too little and they
/// go missing.
///
/// **It is the floor and not the answer.** Value 1 is a convention the armour groups keep and
/// the groups a *customization* owns do not: group 32's value 1 is a scrap at the top of the
/// neck rather than a head, group 7 has no value 1 at all, and group 36's is a necklace where
/// the character chose none. Where the game asks the reader about one of those, the answer is
/// settled by [`crate::customization`] before this is consulted. Where it asks nothing —
/// which is most bodies for most of those groups — [`WORN_ANYWAY`] is what stands in.
///
/// When an item is composited onto the body — the step after that one — it hides its groups'
/// whole hundred and shows the one value it drives instead. That replaces whatever was there;
/// it does not fight with it.
pub fn bare(geoset: u16) -> bool {
    geoset == 0 || geoset % 100 == 1
}

/// The groups whose value 1 is not "nothing here" but *nothing left*, and what a body wears in
/// them when the game asks nobody about it.
///
/// A helm can take the head and the ears away — `HelmetGeosetData` names group 32 on 385 of its
/// rows and group 7 on 2,467 — and value 1 of each is what it leaves behind rather than what a
/// bare body has. Read off build 12.0.5.67823 on 2026-07-29, over all fifty-one bodies: group
/// 32's value 1 runs from 58 to 208 triangles and its value 2 from 654 to 2,726 — the closed
/// neck, and the head. Group 7's value 1 is absent altogether on nineteen of the twenty-six
/// bodies nothing asks about their ears, and twenty to twenty-nine triangles on five more.
///
/// So [`bare`] is exactly backwards for these two, and it was invisible for as long as the only
/// body drawn was a Human's: a Human is asked *Face Shape* and *Ears*, and an answer takes the
/// group over before this is reached. Forty-four of the fifty-one bodies are asked neither, and
/// every one of them was drawn with the stub at the top of the neck — which is issue #185.
///
/// **Value 2 is what the bodies that do answer say.** Of the seven that name a head, six name
/// `3202`; of the twenty-five that name a pair of ears, twenty-three name `702`. The exceptions
/// are the Dracthyr's head and the Night Elf's ears, and both are *asked*, so neither ever falls
/// through to this. The floor below still holds regardless: a value this body has nothing for
/// leaves the group where [`bare`] had it, so a body whose only head is its first value keeps it.
const WORN_ANYWAY: [(u16, u16); 2] = [(EARS, 2), (HEAD, 2)];

/// The ears, and the head. Both are groups the game asks about on some bodies and not others.
const EARS: u16 = 7;
const HEAD: u16 = 32;

/// The composited body texture: one buffer the whole character is painted out of.
///
/// Held as a type of its own because compositing is where the work of showing armour goes.
/// Every item texture lands in a rectangle of this same buffer, alpha-blended in a fixed
/// per-slot order — so this is the seam that grows, and the model, the UVs and the viewer
/// above it do not.
/// Cloneable, and that is what a gallery is built on: the skin, the face and the resize that
/// puts them on a 2048-wide buffer are the same for every appearance shown, and a clone of the
/// result is a memcpy against the 27ms of doing it again.
#[derive(Clone)]
pub struct Atlas {
    pixels: RgbaImage,
}

impl Atlas {
    /// An atlas the size this body's layout states, with nothing composited into it.
    pub fn unpainted(body: &Body) -> Self {
        Self {
            pixels: RgbaImage::from_pixel(body.atlas.0, body.atlas.1, Rgba(UNPAINTED)),
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
    #[tracing::instrument(name = "atlas.base", skip_all)]
    pub fn base(&mut self, body: &Body, blp: &[u8]) -> Result<(), String> {
        crate::budget::note_atlas();
        let skin = pixels_of(blp, body.atlas.0)?;
        self.pixels =
            image::imageops::resize(&skin, body.atlas.0, body.atlas.1, FilterType::Triangle);
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
    #[tracing::instrument(name = "atlas.wear", skip_all, fields(textures = textures.len()))]
    pub fn wear(&mut self, body: &Body, files: &dyn GameFiles, textures: &[ComponentTexture]) {
        for texture in textures {
            let Some(rect) = body.rect_of(texture.section) else {
                continue;
            };
            let blp = match files.read(texture.file) {
                Ok(blp) => blp,
                Err(_) => continue,
            };
            let _held = tracing::info_span!("atlas.paint", fdid = texture.file).entered();
            let Ok(decoded) = pixels_of(&blp, body.atlas.0) else {
                continue;
            };
            let scaled =
                image::imageops::resize(&decoded, rect.width, rect.height, FilterType::Triangle);
            // `overlay` composites source-over, which is the blend the paragraph above is
            // about; `replace` is the copy that would take the holes with it.
            image::imageops::overlay(
                &mut self.pixels,
                &scaled,
                i64::from(rect.x),
                i64::from(rect.y),
            );
        }
    }

    /// The atlas as PNG bytes, which is the one picture format a `.glb` carries and a browser
    /// reads.
    pub fn png(&self) -> Result<Vec<u8>, String> {
        crate::budget::note_encode();
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
pub fn model_of(files: &dyn GameFiles, who: &Who) -> Result<Value, String> {
    let glb = glb_of(files, None, who)?;
    Ok(serde_json::json!({ "model": data_url("model/gltf-binary", &glb) }))
}

/// The character wearing a set of clothes, or `null` when there is nothing to put on her.
///
/// One request for a whole outfit rather than one per piece, which is what the window asks now:
/// a reader opens a set and sees the set, and taking a piece off is the same question asked
/// again with one fewer piece in it.
///
/// `null` is an ordinary answer and means what it has always meant, only across the outfit
/// rather than the item: the game encrypts the displays of content it has not shipped, and a
/// slot whose only texture was painted for another body resolves to nothing. A set every one of
/// whose pieces is one of those has nothing to show, and the window keeps the icons it has. An
/// outfit of no pieces at all is the same answer arrived at the other way, and is what taking
/// everything off comes to — the bare body is [`model_of`], and the window already holds it.
#[tracing::instrument(name = "character.worn_set", skip_all, fields(pieces = pieces.len()))]
pub fn worn_set_of(
    files: &dyn GameFiles,
    pieces: &[crate::worn::Piece],
    who: &Who,
) -> Result<Value, String> {
    let body = body::of(files, who.body)?;
    let worn = crate::worn::of_set(files, &body, pieces)?;
    if worn.is_empty() {
        return Ok(serde_json::json!({ "model": Value::Null }));
    }
    let glb = Mannequin::standing(files, &body, &who.picked)?.wearing(Some(&worn))?;
    Ok(serde_json::json!({ "model": data_url("model/gltf-binary", &glb) }))
}

/// The same outfit on a body belonging to somebody the reader actually plays, and how much of
/// that body is really theirs.
///
/// **A character this install knows nothing about is drawn as nothing at all**, and that is the
/// whole of what this adds over [`worn_set_of`]. Falling back to the reader's own invented body
/// was the old answer and it is the wrong one *here*, however right it is in the wardrobe. There
/// a look is being chosen and any body it is chosen on is a fair picture of the clothes; this is
/// a portrait, its one job is "who is this", and the settings file has no opinion about somebody
/// else's alt. On the machine that reported this it was a Kul Tiran Male standing in for every
/// night elf on the roster.
///
/// So the answer says which of the three it is and the window says so out loud. `null` for the
/// model keeps every meaning it already had — see [`worn_set_of`] — and gains one: nobody to draw.
pub fn own_worn_set_of(
    files: &dyn GameFiles,
    pieces: &[crate::worn::Piece],
    who: Option<&Who>,
) -> Result<Value, String> {
    let Some(who) = who else {
        return Ok(serde_json::json!({ "model": Value::Null, "likeness": Likeness::Nobody }));
    };
    let likeness = if who.picked.is_empty() {
        Likeness::Race
    } else {
        Likeness::Themselves
    };
    let mut drawn = worn_set_of(files, pieces, who)?;
    // Written into what `worn_set_of` built rather than assembled beside it, because the model is
    // the expensive half and there is nothing to be gained by copying it into a second object.
    drawn["likeness"] = serde_json::to_value(likeness)
        .map_err(|error| format!("the likeness would not serialise: {error}"))?;
    Ok(drawn)
}

/// How much of who a character is went into the body they were drawn on.
///
/// **A portrait is worth nothing if it is somebody else's**, which is the whole reason this
/// travels beside the picture. Two of the three answers below are pictures the app can draw and
/// only one of them is the character; a pane that showed all three the same way would be
/// confidently wrong about most of a roster, and nothing on screen would say which.
///
/// The distinction is the game's rather than this app's. `UnitRace` and `UnitSex` are readable
/// wherever a character is standing, so the *body* arrives for anybody the addon has seen log
/// in; what they are made of only enumerates at a barber's chair, so the *colouring* arrives
/// for a character somebody has had a haircut on and for nobody else. See `look.rs`, and
/// `docs/character-rendering.md` for the read off the client that settled it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Likeness {
    /// Nobody at all: the addon has never read this character's race, so there is no body to
    /// draw them on and none is drawn. **Not the reader's own body**, which is what this used to
    /// be — a Kul Tiran Male standing in for every night elf on the roster, with the pane
    /// saying nothing about it.
    Nobody,
    /// The body their race and sex name, at the swatches the game itself opens on. The clothes
    /// are theirs and the shape is theirs; the skin, the hair and the face are the game's
    /// defaults rather than the ones the player chose.
    Race,
    /// Their own colouring as well, off a character the addon caught in a barber's chair.
    Themselves,
}

/// One of the reader's own characters as somebody to draw, or nothing where they cannot be.
///
/// The way from a name — which is what the character view has, and the only thing it has — to
/// the pair every render in this app is asked for. It is the same resolution the transmog
/// panel's shortcut makes, arrived at from the other end: there a reader picks somebody off a
/// list that was already resolved, and here a pane already showing one asks who they are.
///
/// **Nothing is the ordinary answer for most of a roster.** The addon only learns what a
/// character is made of at a barber's chair — see `look.rs` — so a name is here at all only once
/// one has been read, and a race the installed game does not have drops out at
/// [`crate::look::resolve`] besides.
pub fn who_is(
    files: &dyn GameFiles,
    looks: &[crate::look::Look],
    character: &str,
) -> Result<Option<Who>, String> {
    Ok(crate::look::resolve(files, looks)?
        .into_iter()
        .find(|known| known.character == character)
        .map(|known| Who {
            body: known.body,
            picked: known.picked,
        }))
}

/// Who the app is drawing: which body, and which swatch of each question about it.
///
/// The two travel together everywhere because neither means anything without the other — a
/// swatch belongs to one `ChrModel`'s question and to no other body, and [`crate::body::of`]
/// and [`crate::customization::of`] both have to be told the same one. Out of the settings
/// file, and every field of it is the reader's.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Who {
    /// The `ChrModel` to draw, or anything this build has no mesh for — which falls back to
    /// [`crate::body::DEFAULT`] rather than failing. See [`crate::body::of`].
    pub body: u32,
    pub picked: Vec<Picked>,
}

/// The `.glb` bytes themselves — which is what `dump_model` writes to a file.
///
/// `worn` is the one appearance being shown, when there is one. Nothing else about the body
/// changes with it: the same mesh, the same UVs, the same atlas, one layer deeper.
///
/// One outfit, so the body underneath it is built and thrown away. A gallery wants the body kept
/// — see [`Mannequin`], which is what this is, held on to.
pub fn glb_of(files: &dyn GameFiles, worn: Option<&Worn>, who: &Who) -> Result<Vec<u8>, String> {
    Mannequin::standing(files, &body::of(files, who.body)?, &who.picked)?.wearing(worn)
}

/// The body every appearance in this app is shown on, with everything about it that no
/// appearance changes already done.
///
/// **It exists because of the gallery.** Twenty items shown one at a time is the same body twenty
/// times over, and building one is not cheap: the skin is resized onto a 2048 × 1024 buffer, her
/// face is composited onto that, the mesh is read out of a 12MB `.m2` and its skin profile, her
/// hair and eye atlases are decoded, and the skeleton that says where a helm hangs is 16MB. None
/// of that depends on what she is wearing, and all of it used to happen per render.
///
/// What is left per appearance is what actually differs: which geosets survive, what it paints
/// into a *clone* of the base atlas, the models it hangs, and writing the `.glb`. See
/// [`wearing`](Mannequin::wearing).
///
/// Two of the fields are read the first time something wants them rather than when she is built,
/// and both for the same reason: most of a wardrobe hangs nothing off the body, so the skeleton
/// is 16MB nobody asked for — and most of a wardrobe paints nothing onto it either, so the
/// encoded base atlas is a PNG of 2 million pixels that a gallery of helms would never look at.
/// What answers one hung piece's requests for a picture, as `glb` asks them: a closure per piece,
/// each owning the texture that piece is painted with and borrowing the install for the rest.
type Painter<'a> = Box<dyn Fn(Paint) -> Option<Vec<u8>> + 'a>;

pub struct Mannequin<'a> {
    files: &'a dyn GameFiles,
    /// Whose body it is: the mesh it was read out of, and the atlas its parts are painted in.
    body: &'a Body,
    model: Model,
    /// The body with every geoset it holds still in it. [`dressed`] is what cuts it down, and it
    /// cuts a different way for every appearance.
    whole: Mesh,
    herself: Option<Customization>,
    /// Her skin and her face, and nothing worn: what every appearance is painted on top of.
    base: Atlas,
    /// The same, encoded — for the appearances that paint nothing, which is every helm, every
    /// weapon and every pair of shoulders in the game.
    unpainted_png: OnceCell<Vec<u8>>,
    /// Her hair and her eyes: atlases of their own, bound whole rather than composited.
    hers: Vec<(u32, Vec<u8>)>,
    /// Where things hang off her, out of a skeleton nothing but a helm or a weapon needs.
    attachments: OnceCell<Vec<m2::Attachment>>,
}

impl<'a> Mannequin<'a> {
    /// Reads the body and everything about it that no appearance changes.
    ///
    /// `picked` is who she is — the reader's answers to what the character creation screen asks,
    /// out of the settings file. It belongs here rather than in [`wearing`](Mannequin::wearing)
    /// because none of it changes with what she has on: her skin, her face, her hair and her
    /// head are the *body*, and that is the whole thing this type exists to build once.
    #[tracing::instrument(name = "character.mannequin", skip_all)]
    pub fn standing(
        files: &'a dyn GameFiles,
        body: &'a Body,
        picked: &[Picked],
    ) -> Result<Self, String> {
        let model = Model::parse(&files.read(body.model)?)?;
        let skin = model
            .skin_file_data_id()
            .ok_or("the character model names no skin profile, so nothing says how to draw it")?;
        let whole = model.with_skin(&files.read(skin)?)?;
        let herself = crate::customization::of(files, body, picked)?;

        let mut base = Atlas::unpainted(body);
        if let Some(herself) = herself.as_ref() {
            if herself.base != 0 {
                base.base(body, &files.read(herself.base)?)?;
            }
            base.wear(body, files, &herself.over);
        }

        // Each decoded once here rather than per part, because several parts ask for one of them.
        let hers: Vec<(u32, Vec<u8>)> = herself
            .iter()
            .flat_map(|herself| herself.atlases.iter())
            .filter_map(|(kind, file)| decode_file(files, *file).map(|png| (*kind, png)))
            .collect();

        Ok(Self {
            files,
            body,
            model,
            whole,
            herself,
            base,
            unpainted_png: OnceCell::new(),
            hers,
            attachments: OnceCell::new(),
        })
    }

    /// Her, wearing one appearance or a whole outfit, as the bytes of a `.glb`.
    ///
    /// Everything here is what actually changes with what is worn. The one that is not obvious
    /// is the atlas: an appearance that paints nothing gets the encoded base back rather than a
    /// clone, a paint and a re-encode of the same two million pixels — and "paints nothing" is
    /// every helm, weapon, shoulder and shield in the game, which is most of what a gallery of
    /// geometry holds.
    #[tracing::instrument(name = "character.glb", skip_all)]
    pub fn wearing(&self, worn: Option<&Worn>) -> Result<Vec<u8>, String> {
        let files = self.files;
        let mesh = {
            let _held = tracing::info_span!("character.dressed").entered();
            dressed(&self.whole, worn, self.herself.as_ref())
        };

        let painted = self.atlas_png(worn)?;
        let cape = worn
            .and_then(|worn| worn.cape)
            .and_then(|fdid| decode_file(files, fdid));
        let body = |paint| match paint {
            // The model's own textures, which on a body are the few things not customized.
            Paint::File(fdid) => decode_file(files, fdid),
            Paint::Supplied(BODY_TEXTURE) => Some(painted.clone()),
            Paint::Supplied(CAPE_TEXTURE) => cape.clone(),
            // And every other type a body declares is one of hers, or nothing on an install that
            // could not say — which is the white cap this used to draw in every case.
            Paint::Supplied(kind) => self
                .hers
                .iter()
                .find(|(which, _)| *which == kind)
                .map(|(_, png)| png.clone()),
        };

        // Held in three lists rather than in the pieces themselves because a piece borrows both
        // its mesh and the closure that paints it, and each of those closures owns a picture of
        // its own — a helm's texture is not a shoulder's and neither is the atlas.
        let hung = self.hung_on(worn)?;
        let painters: Vec<Painter> = hung
            .iter()
            .map(|(_, _, texture)| {
                let texture = texture.clone();
                let painter: Painter = Box::new(move |paint| match paint {
                    // An item's model wants the one picture, whatever type it asked for. Only
                    // a body declares several and has to tell them apart.
                    Paint::File(fdid) => decode_file(files, fdid),
                    Paint::Supplied(_) => texture.clone(),
                });
                painter
            })
            .collect();

        let _writing = tracing::info_span!("character.assemble").entered();
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

    /// The one picture the whole body is painted out of, encoded.
    ///
    /// The order is the whole of the compositing rule, and [`standing`](Mannequin::standing) has
    /// already done the bottom two layers of it: the skin covers all 2048 × 1024 as a straight
    /// copy, because it is the bottom of the stack and has nothing to blend against, and her face
    /// lands in its own rectangles over that. What is left here is the appearance, which blends
    /// for the same reason her face does — an item painted over the underwear covers it, and
    /// nothing an item paints reaches the right half where the face is.
    ///
    /// An install that cannot say which skin leaves the flat tone underneath, which is what every
    /// body in this app looked like before that chain was read. What is *not* tolerated is a skin
    /// that resolves and will not decode: that is either a build whose columns have moved or this
    /// app being wrong about BLP, and a body quietly back to being a mannequin hides both. See
    /// [`crate::customization::of`] — and note that it is [`standing`](Mannequin::standing) that
    /// says so now, once, rather than every render.
    #[tracing::instrument(name = "character.atlas_png", skip_all)]
    fn atlas_png(&self, worn: Option<&Worn>) -> Result<Vec<u8>, String> {
        let textures = worn.map_or(&[][..], |worn| worn.textures.as_slice());
        if textures.is_empty() {
            return match self.unpainted_png.get() {
                Some(png) => Ok(png.clone()),
                None => {
                    let png = self.base.png()?;
                    let _ = self.unpainted_png.set(png.clone());
                    Ok(png)
                }
            };
        }
        let mut atlas = self.base.clone();
        atlas.wear(self.body, self.files, textures);
        atlas.png()
    }

    /// The geometry an appearance hangs off the body: a mesh, where it goes, and its picture.
    ///
    /// Where it goes comes out of the body's own skeleton rather than the item — an item's model
    /// is authored around the attachment it belongs on, so a helm's vertices sit around the
    /// origin and mean nothing until the head's position is added to them.
    ///
    /// Two absences, and they are not the same. A body with no skeleton is this app being wrong
    /// about a file every character in the game has one of, and is worth saying so about. An
    /// attachment the skeleton does not name, or a model file this install does not hold, is a
    /// piece that cannot be placed — and a pauldron drawn at the origin, which is inside her
    /// pelvis, is worse than a pauldron not drawn.
    #[allow(clippy::type_complexity)]
    #[tracing::instrument(name = "character.hung_on", skip_all)]
    fn hung_on(
        &self,
        worn: Option<&Worn>,
    ) -> Result<Vec<(Mesh, m2::Attachment, Option<Vec<u8>>)>, String> {
        let wanted = worn.map_or(&[][..], |worn| worn.models.as_slice());
        if wanted.is_empty() {
            // The skeleton is 16 MB on a real install, and most of a wardrobe hangs nothing.
            return Ok(Vec::new());
        }
        let attachments = self.attachments()?;

        let mut hung = Vec::with_capacity(wanted.len());
        for model in wanted {
            let Some(at) = attachments
                .iter()
                .find(|attachment| attachment.id == model.attachment)
                .copied()
            else {
                continue;
            };
            let Ok(bytes) = self.files.read(model.file) else {
                continue;
            };
            let parsed = Model::parse(&bytes)?;
            let skin = parsed
                .skin_file_data_id()
                .ok_or("a worn model names no skin profile, so nothing says how to draw it")?;
            let mesh = parsed.with_skin(&self.files.read(skin)?)?;
            let texture = model.texture.and_then(|fdid| {
                self.files
                    .read(fdid)
                    .and_then(|blp| png_of(&blp, LARGEST_TEXTURE))
                    .ok()
            });
            hung.push((mesh, at, texture));
        }
        Ok(hung)
    }

    /// Where things hang off her, read the first time one does.
    #[tracing::instrument(name = "character.attachments", skip_all)]
    fn attachments(&self) -> Result<&[m2::Attachment], String> {
        if let Some(read) = self.attachments.get() {
            return Ok(read);
        }
        let skeleton = self
            .model
            .skeleton_file_data_id()
            .ok_or("the character model names no skeleton, so nothing says where a helm goes")?;
        let found = m2::attachments(&self.files.read(skeleton)?)?;
        let _ = self.attachments.set(found);
        Ok(self.attachments.get().expect("just set"))
    }
}

/// The mesh with only the parts a body wearing this — or nothing — draws.
///
/// Per `docs/character-rendering.md`: hide everything, show the skin, then the character's own
/// customization geosets, then for each group the appearance drives hide that group's whole
/// hundred and show the one value it names. [`bare`] is the floor under all of it, `herself` is
/// the second line, and `worn` is the third.
///
/// **The three lines are not the same rule, and the middle one is the head.** An appearance's
/// geosets are read out of a column that has never been checked against an install, so they get
/// a floor: a value this body has nothing for leaves the group alone. A *customization's* are
/// read out of the game's own answer to "what is this character", and a value the body has
/// nothing for is the game saying the group is **off** — which is what "no necklace" is, and
/// what stops the same rule that loses the head from hanging jewellery on her. Give the
/// customization the appearance's floor and group 36 keeps its bare default; give the
/// appearance the customization's certainty and a wrong column costs a limb.
///
/// **And the first line is not one rule either**, which is [`WORN_ANYWAY`]: the head and the
/// ears are groups the game asks only some bodies about, and value 1 of each is the stub a helm
/// leaves rather than what a bare body wears. A body nobody is asked about takes value 2 of them
/// instead — with the same floor an appearance gets, since emptying a group is the one way of
/// being wrong here that costs a part.
///
/// **A group is only taken over when the body actually holds the geoset it asks for.** That is
/// a deliberate floor rather than an optimisation: the column those values come out of has not
/// been verified against an install, as [`crate::worn`] says, and every way of getting it
/// wrong shows up as geometry rather than as an error. Hiding a group and then showing nothing
/// in it is the worst of those — a leg that is simply absent — and this turns it into the body
/// as it was, which reads as an appearance that changed nothing.
///
/// **An outfit does not lower that floor, and priority is what keeps it from doing so.** Two
/// pieces claiming one group is settled before anything reaches here, so what arrives is still
/// at most one value per group and the line above still reads it the same way. A winner whose
/// value this body has nothing for leaves the group where a bare body had it, exactly as a
/// single item's would; what it does not do is fall through to the piece that lost, because the
/// game's answer to "who owns this group" is one item and not a queue.
///
/// And then the third thing, which only a helm does: **a group taken away rather than swapped.**
/// `Worn::hidden` is the groups `HelmetGeosetData` says the helm covers — hair, ears, a beard —
/// and every variant in them goes, because there is no variant of hair that fits under a helm.
///
/// The trap is that hair is **group 0**, and geoset 0 is the body itself. Read off 12.0.5.67:
/// `humanfemale_hd` carries hairstyles as geosets 1 to 33, and the skin as 0 — so hiding "the
/// whole hundred" of group 0 without excepting the one id that has no group takes the character
/// with the hair. She is also the one thing here with a hairstyle *chosen* for her, so group 0
/// has an owner on every body and the exception has to come first rather than last.
///
/// The vertices are left whole here rather than compacted down to the ones the surviving parts
/// use, because in this mesh a vertex id is still the game's own and the parts share the list.
/// They do get compacted, one step later and at the edge: [`crate::glb::write`] carries only
/// the vertices something points at and renumbers the indices to match, which on a real body
/// is 248,958 shipped becoming 4,894.
fn dressed(mesh: &Mesh, worn: Option<&Worn>, herself: Option<&Customization>) -> Mesh {
    let geosets = worn.map_or(&[][..], |worn| worn.geosets.as_slice());
    let hidden = worn.map_or(&[][..], |worn| worn.hidden.as_slice());
    let hers = herself.map_or(&[][..], |herself| herself.geosets.as_slice());
    let taken: Vec<&Geoset> = geosets
        .iter()
        .filter(|worn| mesh.parts.iter().any(|part| part.geoset == worn.geoset))
        .collect();
    let owner = |group: u16| {
        taken
            .iter()
            .copied()
            .find(|worn| worn.group == group)
            .or_else(|| hers.iter().find(|hers| hers.group == group))
    };
    // And what a group nobody was asked about wears: `bare`, except for the two groups whose
    // value 1 is the stub a helm leaves rather than a body's own default. `WORN_ANYWAY` says
    // what those wear instead, and only where this body holds it — the same floor an item's
    // geosets get, because emptying a group is the one way of being wrong that costs a part.
    let unasked = |group: u16| {
        WORN_ANYWAY
            .iter()
            .find(|(named, _)| *named == group)
            .map(|(_, value)| group * 100 + value)
            .filter(|geoset| mesh.parts.iter().any(|part| part.geoset == *geoset))
    };
    // Geoset 0 is the skin, and the one id that belongs to no group — least of all group 0's
    // hairstyles, which is the hundred it shares.
    let shown = |geoset: u16| match owner(geoset / 100) {
        _ if geoset == 0 => true,
        Some(owner) => geoset == owner.geoset,
        None => match unasked(geoset / 100) {
            Some(worn_anyway) => geoset == worn_anyway,
            None => bare(geoset),
        },
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
    files
        .read(fdid)
        .and_then(|blp| png_of(&blp, LARGEST_TEXTURE))
        .ok()
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

    /// The body the fixtures describe, which is the one every test here draws on.
    fn hers() -> Body {
        body::of(&fixture_files(), body::DEFAULT).unwrap()
    }

    fn mesh() -> Mesh {
        worn_mesh(&Worn::default())
    }

    /// The body as it is drawn with a given appearance on it, and as the character the
    /// fixture's own customization tables say she is.
    fn worn_mesh(worn: &Worn) -> Mesh {
        let files = fixture_files();
        let hers = hers();
        let herself = crate::customization::of(&files, &hers, &[]).unwrap();
        let model = Model::parse(&files.read(hers.model).unwrap()).unwrap();
        let skin = model.skin_file_data_id().unwrap();
        dressed(
            &model.with_skin(&files.read(skin).unwrap()).unwrap(),
            Some(worn),
            herself.as_ref(),
        )
    }

    /// The body as it is drawn with a given set of geosets switched on and nothing else.
    fn geoset_mesh(geosets: &[Geoset]) -> Mesh {
        worn_mesh(&Worn {
            geosets: geosets.to_vec(),
            ..Default::default()
        })
    }

    /// The same three numbers as one piece of an outfit, which is what the window sends.
    fn piece((display_info_id, display_type, inventory_type): Appearance) -> crate::worn::Piece {
        crate::worn::Piece {
            display_info_id,
            display_type,
            inventory_type,
        }
    }

    /// What the fixture's own tables say an appearance does to the body.
    fn worn_of(appearance: Appearance) -> Worn {
        crate::worn::of_set(&fixture_files(), &hers(), &[piece(appearance)]).unwrap()
    }

    /// And what they say a whole outfit does to it.
    fn outfit_of(appearances: &[Appearance]) -> Worn {
        let pieces: Vec<crate::worn::Piece> = appearances.iter().copied().map(piece).collect();
        crate::worn::of_set(&fixture_files(), &hers(), &pieces).unwrap()
    }

    /// The geosets a body ends up drawing, which is what the whole selection comes down to.
    fn drawn(mesh: &Mesh) -> Vec<u16> {
        mesh.parts.iter().map(|part| part.geoset).collect()
    }

    /// The atlas an appearance paints on its own, over nothing — which is how the rectangles
    /// each texture lands in are read without the skin underneath colouring the answer.
    fn atlas_of((display_info_id, display_type, inventory_type): Appearance) -> RgbaImage {
        let files = fixture_files();
        let worn = crate::worn::of(
            &files,
            &hers(),
            display_info_id,
            display_type,
            inventory_type,
        )
        .unwrap();
        let mut atlas = Atlas::unpainted(&hers());
        atlas.wear(&hers(), &files, &worn.textures);
        image::load_from_memory(&atlas.png().unwrap())
            .unwrap()
            .into_rgba8()
    }

    /// The atlas the app actually paints a body with: the skin, and an appearance over it.
    fn body_atlas(worn: Option<Appearance>) -> RgbaImage {
        let files = fixture_files();
        let worn = worn.map(|(display_info_id, display_type, inventory_type)| {
            crate::worn::of(
                &files,
                &hers(),
                display_info_id,
                display_type,
                inventory_type,
            )
            .unwrap()
        });

        let png = Mannequin::standing(&files, &hers(), &[])
            .unwrap()
            .atlas_png(worn.as_ref())
            .unwrap();
        image::load_from_memory(&png).unwrap().into_rgba8()
    }

    /// The colour in the middle of one of the atlas's section rectangles.
    ///
    /// The middle rather than a corner: a rectangle is filled by scaling a texture into it, and
    /// what a test wants to know is which texture landed there rather than how its edges were
    /// resolved against the neighbouring one.
    fn middle_of(atlas: &RgbaImage, section: u32) -> [u8; 4] {
        let hers = hers();
        let rect = hers
            .rect_of(section)
            .expect("the layout has a rectangle for that section");
        atlas
            .get_pixel(rect.x + rect.width / 2, rect.y + rect.height / 4)
            .0
    }

    /// The scene the window is handed for one appearance worn on the body.
    fn worn_scene(appearance: Appearance) -> Value {
        let worn = worn_of(appearance);
        scene(&glb_of(&fixture_files(), Some(&worn), &Who::default()).unwrap())
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
            assert!(
                !bare(hidden),
                "{hidden} is an item's variant and has to be hidden"
            );
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
        assert_eq!(
            geosets,
            vec![0, 801, 1101, 2001, 2701, 2, 1001, 1301, 501, 3202, 702, 1701, 2101]
        );

        // One group, one part — for every group but the hair's, which is group 0 and which
        // the skin shares because the skin is the one geoset with no group of its own.
        let mut groups: Vec<u16> = geosets
            .iter()
            .filter(|geoset| **geoset != 0)
            .map(|geoset| geoset / 100)
            .collect();
        groups.sort_unstable();
        let mut distinct = groups.clone();
        distinct.dedup();
        assert_eq!(
            groups, distinct,
            "a group drawn twice is a limb drawn twice"
        );
    }

    // The head, which is the one part of a body no appearance ever asks for and no rule about
    // armour ever reaches. Group 32 has no "nothing here" value: `3201` is a scrap at the top
    // of the neck and the head itself is whichever value the character's own face shape names,
    // so a body assembled out of its groups' first values wears a hairstyle over a stump. The
    // ears are the same sentence with the group empty instead — there is no `701` at all — and
    // the necklace is it inverted: a group whose chosen value is *nothing*, hung with jewellery
    // by the same rule that loses the head.
    #[test]
    fn draws_the_head_and_ears_her_own_customization_names() {
        let geosets = drawn(&mesh());
        assert!(geosets.contains(&3202), "she has no head: {geosets:?}");
        assert!(
            !geosets.contains(&3201),
            "and not the scrap beside it: {geosets:?}"
        );
        assert!(geosets.contains(&702), "she has no ears: {geosets:?}");
        assert!(
            !geosets.contains(&3601),
            "she is wearing jewellery nobody chose: {geosets:?}"
        );
        // And the hairstyle she was given rather than the first the file happens to hold.
        assert!(geosets.contains(&2), "{geosets:?}");
        assert!(!geosets.contains(&1), "{geosets:?}");
    }

    /* ---------- the other body ---------- */

    /// The body beside hers, which is the whole of what a second `ChrModel` comes to here.
    fn his() -> Body {
        body::of(&fixture_files(), OTHER_BODY).unwrap()
    }

    /// `ChrModel` 1 — the male body, as `body::KNOWN` numbers it.
    const OTHER_BODY: u32 = 1;

    /// The mesh he is drawn from, as `drawn` reads a mesh.
    fn his_mesh(picked: &[Picked]) -> Vec<u16> {
        let files = fixture_files();
        let his = his();
        let herself = crate::customization::of(&files, &his, picked).unwrap();
        let model = Model::parse(&files.read(his.model).unwrap()).unwrap();
        let skin = model.skin_file_data_id().unwrap();
        let whole = model.with_skin(&files.read(skin).unwrap()).unwrap();
        drawn(&dressed(&whole, None, herself.as_ref()))
    }

    // A second body is a second mesh, and the parts that come out of it are his. The beard is
    // the one worth naming: group 1 is a group the female body holds nothing in at all, so a
    // part in it cannot have come from her mesh however the rest of this went.
    #[test]
    fn draws_the_body_it_was_asked_for_rather_than_the_one_it_always_drew() {
        let his = his_mesh(&[Picked {
            question: 42,
            swatch: 421,
        }]);
        assert!(his.contains(&101), "his beard: {his:?}");
        assert!(
            !drawn(&mesh()).contains(&101),
            "the female body has no group 1 to draw"
        );
        // And his own hairstyle, out of a question only his body is asked.
        assert!(his.contains(&2), "his hairstyle: {his:?}");
    }

    // His skin, which is a different picture on a differently sized buffer: the atlas is the
    // layout's own statement and his layout is not hers. A body composited at the other body's
    // size is every rectangle in the wrong place, and it is what the read replaced.
    #[test]
    fn paints_the_other_body_in_the_atlas_its_own_layout_states() {
        let files = fixture_files();
        let his = his();
        let mannequin = Mannequin::standing(&files, &his, &[]).unwrap();
        let png = mannequin.atlas_png(None).unwrap();
        let atlas = image::load_from_memory(&png).unwrap().into_rgba8();

        assert_eq!((atlas.width(), atlas.height()), his.atlas);
        assert_ne!(
            his.atlas,
            hers().atlas,
            "the two layouts have to differ to prove anything"
        );
        // The colour his own skin swatch paints, over the whole buffer — and not hers.
        assert_eq!(atlas.get_pixel(1, 1).0, [90, 90, 90, 255]);
    }

    // And the same appearance on him: a chestpiece paints into his rectangles, which are his
    // layout's rather than hers.
    #[test]
    fn wears_an_appearance_on_the_body_it_is_being_shown_on() {
        let files = fixture_files();
        let his = his();
        let worn = crate::worn::of_set(&files, &his, &[piece(CHESTPIECE)]).unwrap();
        let mannequin = Mannequin::standing(&files, &his, &[]).unwrap();
        let png = mannequin.atlas_png(Some(&worn)).unwrap();
        let atlas = image::load_from_memory(&png).unwrap().into_rgba8();

        let torso = his.rect_of(3).expect("his layout lays out an upper torso");
        let painted = atlas.get_pixel(torso.x + 4, torso.y + 4).0;
        assert_ne!(painted, [90, 90, 90, 255], "nothing was painted onto him");
        // The male texture of the pair, which is the one `ComponentTextureFileData` keeps for
        // his body — hers is the other colour entirely.
        assert_eq!(painted, [180, 90, 30, 255]);
    }

    // And the same body once somebody has said who she is, which is the whole of what an answer
    // does at this end: one group takes another of its values and nothing else about her moves.
    // Her head is the part worth naming in that "nothing else" — it comes out of a question of
    // its own, and an answer that reset the questions it was not about would take it with it.
    #[test]
    fn draws_the_hairstyle_the_reader_chose_rather_than_the_one_the_game_opens_on() {
        let files = fixture_files();
        let hers = hers();
        let herself = crate::customization::of(
            &files,
            &hers,
            &[Picked {
                question: 16,
                swatch: 133,
            }],
        )
        .unwrap();
        let model = Model::parse(&files.read(hers.model).unwrap()).unwrap();
        let skin = model.skin_file_data_id().unwrap();
        let body = model.with_skin(&files.read(skin).unwrap()).unwrap();

        let geosets = drawn(&dressed(&body, None, herself.as_ref()));

        assert!(geosets.contains(&1), "the hairstyle she chose: {geosets:?}");
        assert!(
            !geosets.contains(&2),
            "and not the one the game opens on: {geosets:?}"
        );
        assert!(geosets.contains(&3202), "she has no head: {geosets:?}");
        assert!(geosets.contains(&702), "she has no ears: {geosets:?}");
    }

    // And the forty-four bodies the game asks neither of those questions about, which is what
    // issue #185 was: a Human is asked her face shape and her ears and the answer takes both
    // groups over, and a Draenei, an Orc or a Tauren is asked neither — so both fell through to
    // `bare`, and `bare` is the armour convention. Group 32's value 1 is the stub a helm leaves
    // where the head was, so a body with no question about its head was drawn with the stub.
    #[test]
    fn draws_the_head_of_a_body_the_game_asks_nothing_about() {
        // A body with a head and the stub beside it, ears with no bare value, and one armour
        // group so that the convention this does *not* change is in the same picture.
        let body = body_of(&[0, 3201, 3202, 702, 703, 801, 802]);
        // Everything she is asked about, which on such a body is her hairstyle and no more.
        let herself = Customization {
            geosets: vec![Geoset {
                group: 0,
                geoset: 2,
            }],
            ..Default::default()
        };

        let geosets = drawn(&dressed(&body, None, Some(&herself)));

        assert!(geosets.contains(&3202), "he has no head: {geosets:?}");
        assert!(
            !geosets.contains(&3201),
            "only the stub a helm leaves: {geosets:?}"
        );
        assert!(geosets.contains(&702), "he has no ears: {geosets:?}");
        assert!(
            !geosets.contains(&703),
            "and only the one pair: {geosets:?}"
        );
        // The armour groups keep the convention that is theirs: bare arms rather than sleeves.
        assert!(
            geosets.contains(&801) && !geosets.contains(&802),
            "{geosets:?}"
        );
    }

    // And the floor under it, which is the one this repository keeps everywhere else: a value
    // this body has nothing for leaves the group as it was rather than emptying it. A body with
    // a head in the group's first value and nothing in its second is the Dracthyr's shape, and
    // the Dracthyr is drawn with the head it holds.
    #[test]
    fn keeps_the_only_head_a_body_holds_whichever_value_it_is() {
        let body = body_of(&[0, 3201]);
        let geosets = drawn(&dressed(&body, None, None));
        assert!(
            geosets.contains(&3201),
            "he has no head at all: {geosets:?}"
        );
    }

    /// A body holding exactly the geosets named, one part each, and nothing else about it.
    fn body_of(geosets: &[u16]) -> Mesh {
        Mesh {
            vertices: Vec::new(),
            parts: geosets
                .iter()
                .map(|geoset| crate::m2::Part {
                    indices: Vec::new(),
                    geoset: *geoset,
                    paint: crate::m2::Paint::Supplied(1),
                    blend: crate::m2::Blend::Opaque,
                    two_sided: false,
                })
                .collect(),
        }
    }

    // The last thing on that head, and the one geoset selection has nothing to say about: her
    // eye glow is *selected* — no ordinary eye colour turns group 17 off — and it is composited
    // by adding, which glTF cannot write. So the scene comes out with one primitive fewer than
    // the body draws parts, and that difference is the whole of it. Painted as a plain blend
    // instead, the glow is a solid slab across both eyes.
    #[test]
    fn selects_the_eye_glow_and_leaves_it_out_of_the_picture() {
        let body = mesh();
        assert!(
            drawn(&body).contains(&1701),
            "the glow is one of the parts a bare body draws"
        );

        let scene = scene(&glb_of(&fixture_files(), None, &Who::default()).unwrap());
        assert_eq!(
            scene["meshes"][0]["primitives"].as_array().unwrap().len(),
            body.parts.len() - 1
        );
    }

    // The `level` trap, on the one model where it is not academic. The fixture's skull sits
    // past the first 64k of the index list *and* is one of the parts a bare body draws — so a
    // reader that ignored the level would not draw something spare, it would draw the head
    // out of the vertices at the very front of the model. That is the missing limb.
    #[test]
    fn draws_a_default_geoset_that_sits_past_the_first_64k_indices() {
        let body = mesh();
        let skull = body
            .parts
            .iter()
            .find(|part| part.geoset == 2101)
            .expect("the body has a skull");
        // The generator puts each geoset on a cube of its own, eight vertices at a time, and
        // the skull's is the eleventh.
        assert!(
            skull.indices.iter().all(|index| (80..88).contains(index)),
            "{:?}",
            &skull.indices[..6]
        );
    }

    // A body asks for its pictures by type, and the types are different pictures. Type 1 is the
    // composited atlas; type 6 is the hair, which has an atlas of its own — painting it with the
    // body's would put somebody's kneecap on the reader's head, which is geometry that looks
    // right and a picture that is nonsense. Each is asked for once however many parts share it.
    #[test]
    fn asks_for_each_of_the_bodys_pictures_once_and_by_type() {
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
        assert_eq!(
            asked.into_inner(),
            vec![Paint::Supplied(1), Paint::Supplied(6)]
        );
    }

    // And the hair is handed a picture rather than nothing, which is the whole of the difference
    // between a hairstyle and a white cap: a part whose material carries no `baseColorTexture`
    // is drawn in glTF's default colour, and on a head that reads as a mask.
    #[test]
    fn paints_the_hair_with_the_atlas_of_its_own_rather_than_leaving_it_white() {
        let herself = crate::customization::of(&fixture_files(), &hers(), &[])
            .unwrap()
            .expect("a character");
        assert_eq!(herself.atlases, vec![(6, 160_007), (19, 160_008)]);

        let scene = scene(&glb_of(&fixture_files(), None, &Who::default()).unwrap());
        let materials = scene["materials"].as_array().unwrap();
        assert!(
            materials
                .iter()
                .all(|material| material["pbrMetallicRoughness"]
                    .get("baseColorTexture")
                    .is_some()),
            "{materials:?}"
        );
        // The body's own atlas and the hair's, and no third picture: the eyes' atlas is hers
        // too and nothing on this body asks for that type.
        assert_eq!(scene["images"].as_array().unwrap().len(), 2);
    }

    // The atlas is the size the game states for layout 104, and it is a picture rather than a
    // buffer by the time it leaves here. Every UV on the character model is addressed against
    // these dimensions, so a buffer of the wrong size is armour landing somewhere else.
    #[test]
    fn composites_an_atlas_the_size_the_layout_states() {
        let png = Atlas::unpainted(&hers()).png().unwrap();
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2048, 1024));
    }

    // The base skin covers the whole buffer rather than a corner of it: the fixture texture is
    // eight pixels square and the atlas is 2048 × 1024, which is the scaling every real skin
    // needs too.
    #[test]
    fn lays_the_base_skin_over_the_whole_atlas() {
        let mut atlas = Atlas::unpainted(&hers());
        atlas
            .base(&hers(), &fixture_files().read(BASE_SKIN).unwrap())
            .unwrap();
        let decoded = image::load_from_memory(&atlas.png().unwrap())
            .unwrap()
            .into_rgba8();
        assert_eq!((decoded.width(), decoded.height()), (2048, 1024));

        // A quarter of the fixture skin per quarter of the atlas, sampled well inside each so
        // that the linear filter's seams are not what is being measured.
        for (quadrant, (x, y)) in [(256, 128), (1792, 128), (256, 896), (1792, 896)]
            .iter()
            .enumerate()
        {
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
    // mannequin in one flat tone. The left half is the body, and it is skin all the way down.
    #[test]
    fn opens_the_bare_body_with_skin_on_it() {
        let atlas = body_atlas(None);
        for (quadrant, (x, y)) in [(0, (256, 128)), (2, (256, 896))] {
            let pixel = atlas.get_pixel(x, y).0;
            assert_ne!(
                pixel, UNPAINTED,
                "the body is still the unpainted tone at {x},{y}"
            );
            assert_eq!(
                [pixel[0], pixel[1], pixel[2]],
                QUADRANTS[quadrant],
                "at {x},{y}"
            );
        }
    }

    // And the right half is her face — the one rectangle of the atlas the body's own UVs never
    // read and the head's do. It is a layer over the skin like any other, which is why an atlas
    // that resolved everything but this one row is a body with a blank where a face goes.
    #[test]
    fn paints_her_face_into_the_half_of_the_atlas_the_head_reads() {
        let atlas = body_atlas(None);
        assert_eq!(middle_of(&atlas, 10), [230, 170, 60, 255], "the face");
        assert_eq!(
            middle_of(&atlas, 9),
            middle_of(&atlas, 10),
            "which the scalp shares"
        );
        // And nowhere else: sections 9 and 10 are one rectangle, and it is not the torso's.
        assert_ne!(middle_of(&atlas, 3), middle_of(&atlas, 10));
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
        assert_eq!(
            middle_of(&chestpiece, 3),
            [40, 160, 220, 255],
            "and armour goes over it"
        );
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
        assert_eq!(
            middle_of(&robe, 0),
            middle_of(&bare, 0),
            "a sleeveless robe leaves the arm"
        );

        let chestpiece = body_atlas(Some(CHESTPIECE));
        assert_eq!(middle_of(&chestpiece, 0), [90, 200, 60, 255]); // upper arms
        assert_eq!(
            middle_of(&chestpiece, 5),
            middle_of(&bare, 5),
            "the chestpiece paints no legs"
        );
        assert_ne!(
            middle_of(&bare, 5),
            UNPAINTED,
            "and what is left there is skin"
        );
    }

    // The trap the base is the other side of: a sleeveless chestpiece is transparent where the
    // arm shows, and what shows through is now the character rather than a flat tone. Copy the
    // item layer instead of blending it and the hole is in the skin.
    #[test]
    fn shows_the_skin_through_a_transparent_item_layer() {
        let hers = hers();
        let arms = hers.rect_of(0).unwrap();
        let (x, y) = (arms.x + arms.width / 2, arms.y + arms.height - 8);
        let worn = body_atlas(Some(CHESTPIECE));
        let bare = body_atlas(None);
        assert_eq!(worn.get_pixel(x, y), bare.get_pixel(x, y));
        assert_ne!(bare.get_pixel(x, y).0, UNPAINTED);
    }

    // The whole module, as the window asks for it: a body with geometry and a picture in it.
    #[test]
    fn hands_the_window_a_body_to_turn_around() {
        let answer = model_of(&fixture_files(), &Who::default()).unwrap();
        let url = answer["model"].as_str().expect("the answer holds a model");
        let encoded = url
            .strip_prefix("data:model/gltf-binary;base64,")
            .expect(url);
        use base64::{engine::general_purpose::STANDARD, Engine};
        let scene = scene(&STANDARD.decode(encoded).unwrap());

        assert_eq!(scene["asset"]["version"], "2.0");
        assert_eq!(
            scene["meshes"][0]["primitives"].as_array().unwrap().len(),
            12
        );
        // Two pictures: the composited atlas, and the hair's, which is an atlas of its own.
        assert_eq!(scene["images"].as_array().unwrap().len(), 2);
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
            vec![0, 802, 1101, 2001, 2701, 2, 1002, 1301, 501, 3202, 702, 1701, 2101]
        );
        // The boot itself and the booted feet: two groups from one item, and the feet group is
        // the one whose zero means booted rather than bare.
        assert_eq!(
            drawn(&worn_mesh(&worn_of(BOOTS))),
            vec![0, 801, 1101, 2002, 2701, 2, 1001, 1301, 502, 3202, 702, 1701, 2101]
        );
        // The robe leaves the chest bare and hangs a skirt over the legs instead.
        assert_eq!(
            drawn(&worn_mesh(&worn_of(ROBE))),
            vec![0, 802, 1101, 2001, 2701, 2, 1001, 1302, 501, 3202, 702, 1701, 2101]
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
            let mut groups: Vec<u16> = drawn(&body)
                .iter()
                .filter(|geoset| **geoset != 0)
                .map(|geoset| geoset / 100)
                .collect();
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
        let absent = [
            Geoset {
                group: 11,
                geoset: 1177,
            },
            Geoset {
                group: 4,
                geoset: 402,
            },
        ];
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
        let hers = hers();
        let arms = hers.rect_of(0).unwrap();
        // The upper-arm texture is painted for its top half and empty for its bottom one, so
        // the sleeve is there and the arm below it is still the body.
        assert_eq!(
            atlas
                .get_pixel(arms.x + arms.width / 2, arms.y + arms.height / 4)
                .0,
            [90, 200, 60, 255]
        );
        let below = atlas.get_pixel(arms.x + arms.width / 2, arms.y + arms.height - 8);
        assert_eq!(
            below.0, UNPAINTED,
            "a transparent sleeve punched a hole in the arm"
        );
    }

    // The other trap: armour textures are authored a few dozen pixels tall and land in
    // rectangles a few hundred deep, so the scale has to interpolate. Nearest-neighbour leaves
    // the seam between two bands a hard edge; a linear filter leaves a run of blends, and this
    // is what tells the two apart at the one row where they differ.
    #[test]
    fn scales_a_texture_up_with_a_linear_filter() {
        let atlas = atlas_of(CHESTPIECE);
        let hers = hers();
        let torso = hers.rect_of(3).unwrap();
        let seam = atlas
            .get_pixel(torso.x + torso.width / 2, torso.y + torso.height / 2)
            .0;
        let (top, bottom) = ([40, 160, 220, 255], [220, 60, 140, 255]);
        assert_ne!(seam, top);
        assert_ne!(seam, bottom);
        for channel in 0..3 {
            let (low, high) = (
                top[channel].min(bottom[channel]),
                top[channel].max(bottom[channel]),
            );
            assert!(
                (low..=high).contains(&seam[channel]),
                "{seam:?} is not between the two bands"
            );
        }
    }

    // Section 8 is in the game's tables and has no rectangle in this layout at all, so the row
    // is dropped rather than treated as an error — and nothing else the appearance paints is
    // lost with it. The boots carry one.
    #[test]
    fn drops_a_section_the_layout_has_nowhere_to_put() {
        let boots = crate::worn::of(&fixture_files(), &hers(), BOOTS.0, BOOTS.1, BOOTS.2).unwrap();
        assert!(boots.textures.iter().any(|texture| texture.section == 8));
        let atlas = atlas_of(BOOTS);
        assert_eq!(middle_of(&atlas, 7), [20, 100, 240, 255]);
        assert_eq!(middle_of(&atlas, 6), [150, 30, 90, 255]);
        assert!(hers().rect_of(8).is_none());
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
        let answer = worn_set_of(&fixture_files(), &[piece(ROBE)], &Who::default()).unwrap();
        let url = answer["model"].as_str().expect("the answer holds a model");
        let encoded = url
            .strip_prefix("data:model/gltf-binary;base64,")
            .expect(url);
        use base64::{engine::general_purpose::STANDARD, Engine};
        let scene = scene(&STANDARD.decode(encoded).unwrap());
        assert_eq!(
            scene["meshes"][0]["primitives"].as_array().unwrap().len(),
            12
        );
        assert_eq!(scene["images"].as_array().unwrap().len(), 2);
    }

    // An appearance this install can say nothing about answers with nothing, the same way one
    // with no model of its own does — and the window keeps showing the icon it has.
    #[test]
    fn answers_with_nothing_for_an_appearance_it_cannot_read() {
        for display in [900_900, 404_040] {
            let answer = worn_set_of(
                &fixture_files(),
                &[piece((display, CHESTPIECE.1, 0))],
                &Who::default(),
            )
            .unwrap();
            assert_eq!(answer["model"], Value::Null, "display {display}");
        }
        // And an outfit with nothing in it at all, which is what taking every piece off comes
        // to: the same `null`, and the window falls back to the bare body it already holds.
        assert_eq!(
            worn_set_of(&fixture_files(), &[], &Who::default()).unwrap()["model"],
            Value::Null
        );
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
        assert_eq!(
            scene["meshes"][1]["primitives"].as_array().unwrap().len(),
            1
        );
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
        // the body's two, and then one texture per pad.
        assert_eq!(scene["images"].as_array().unwrap().len(), 4);
    }

    // A cape is the odd one: geometry the body already carries, and all the appearance brings
    // is the picture that goes on it. So there is no extra node at all — one mesh, one more
    // part in it, and a second image beside the atlas.
    #[test]
    fn hangs_a_cape_off_her_back_without_a_model_to_hang() {
        let scene = worn_scene(CAPE);
        assert_eq!(scene["nodes"].as_array().unwrap().len(), 1);
        assert!(drawn(&worn_mesh(&worn_of(CAPE))).contains(&1502));
        // The body's two, and the cloak's own picture. A cape whose texture went unresolved is
        // a black sheet rather than an error, which is why the count is what this reads.
        assert_eq!(scene["images"].as_array().unwrap().len(), 3);
    }

    // The other half of the acceptance, and the trap under it. A helm hides hair, and hair is
    // **group 0** — the same hundred the skin is in. Hiding the group without excepting geoset
    // 0 takes the whole character with the hairstyle, which is an empty pane rather than a
    // helmed woman.
    #[test]
    fn a_helm_that_hides_hair_hides_it_and_leaves_the_body_on() {
        let bare = drawn(&mesh());
        assert!(
            bare.contains(&2),
            "a bare body wears the hairstyle she was given"
        );

        let helmed = drawn(&worn_mesh(&worn_of(HELM)));
        assert!(!helmed.contains(&2), "the helm covers the hair");
        assert!(helmed.contains(&0), "and not the body it is attached to");
        // The whole hundred, not only the one variant a bare body happened to draw.
        assert!(!helmed.contains(&1));
        // And nothing else: the helm's own group swaps as any item's does, and every other
        // group is where a bare body left it.
        assert_eq!(
            helmed,
            vec![0, 801, 1101, 2001, 2702, 1001, 1301, 501, 3202, 702, 1701, 2101]
        );
    }

    // Taking it off puts the hair back, which is the same sentence read the other way: the
    // hiding belongs to the appearance and not to the body.
    #[test]
    fn taking_the_helm_off_puts_the_hair_back() {
        assert_eq!(drawn(&worn_mesh(&Worn::default())), drawn(&mesh()));
        assert!(drawn(&worn_mesh(&worn_of(CHESTPIECE))).contains(&2));
    }

    // The acceptance for a weapon: it is *held* rather than hanging in mid-air beside her, and
    // *which* hand is the one thing the display cannot say. The same display, read as a
    // one-hander and as something held in the other hand, is the same mesh on two different
    // sides of her.
    //
    // All three parts of the node say so and the last two are what issue #134 was: the place is
    // the grip the body's helper bones state rather than the wrist above it, the rotation is the
    // angle a fist holds a weapon at, and the scale is the fraction of its modelled size this
    // body wears one at. A sword drawn at the wrist, unturned and full size, is a sword held by
    // nobody.
    #[test]
    fn puts_a_sword_in_the_hand_the_game_says_it_is_held_in() {
        let right = worn_scene(ONE_HANDER);
        let held = &right["nodes"][1];
        assert_eq!(held["translation"], serde_json::json!([1.0, 0.5, 3.5]));
        assert_eq!(held["scale"], serde_json::json!([0.8, 0.8, 0.8]));
        let roll = |node: &Value| {
            node["rotation"][0]
                .as_f64()
                .expect("a roll about the X axis")
        };
        assert!(roll(held) > 0.7, "{held}");
        // Geometry, and not merely a node: the weapon's two submeshes, whole.
        assert_eq!(
            right["meshes"][1]["primitives"].as_array().unwrap().len(),
            2
        );

        let left = worn_scene(OFF_HAND);
        assert_eq!(
            left["nodes"][1]["translation"],
            serde_json::json!([1.0, 0.5, -3.5])
        );
        assert!(
            roll(&left["nodes"][1]) < -0.7,
            "the other hand grips the other way"
        );
        assert_eq!(
            right["meshes"], left["meshes"],
            "the same weapon, the other hand"
        );
    }

    // A shield is neither hand: it hangs off the arm, and on the real body off a bone the
    // hands' chains do not pass through at all.
    #[test]
    fn hangs_a_shield_off_her_arm() {
        let scene = worn_scene(SHIELD);
        assert_eq!(scene["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(
            scene["nodes"][1]["translation"],
            serde_json::json!([0.0, 2.0, -3.0])
        );
    }

    // And the body underneath is untouched by any of it. A weapon paints nothing into the
    // atlas and switches no geoset, so what is left is a woman holding something — the same
    // parts a bare body draws, and one picture more than it has.
    #[test]
    fn a_weapon_changes_nothing_about_the_body_it_is_held_by() {
        assert_eq!(drawn(&worn_mesh(&worn_of(ONE_HANDER))), drawn(&mesh()));
        let scene = worn_scene(ONE_HANDER);
        assert_eq!(scene["images"].as_array().unwrap().len(), 3);
    }

    /* ---------- wearing the whole set ---------- */

    /// The fixture's remaining armour, which is what makes an outfit out of the pieces above.
    const LEGS: Appearance = (900_006, 5, 0);

    /// The atlas a whole outfit paints, over nothing — the same read as [`atlas_of`], one
    /// question wider.
    fn outfit_atlas(appearances: &[Appearance]) -> RgbaImage {
        let files = fixture_files();
        let mut atlas = Atlas::unpainted(&hers());
        atlas.wear(&hers(), &files, &outfit_of(appearances).textures);
        image::load_from_memory(&atlas.png().unwrap())
            .unwrap()
            .into_rgba8()
    }

    // The acceptance, from the far end of the pipe: a set on one body, with no doubled limbs and
    // none missing. One part per group is what says so — the same count a bare body draws, less
    // the hair the helm covers — and every part is a variant some piece of the set switched on
    // rather than the default that was there before.
    #[test]
    fn dresses_the_character_in_the_whole_set_at_once() {
        let dressed = worn_mesh(&outfit_of(&[HELM, SHOULDERS, CHESTPIECE, LEGS]));
        assert_eq!(
            drawn(&dressed),
            vec![
                0,    // the body
                802,  // the chestpiece's sleeves, in place of bare arms
                1104, // the legs' trousers
                2001, // bare feet, because the set has no boots in it
                2702, // the helm
                1002, // the chestpiece
                1301, // the robe group, which is the one two pieces asked for
                501,  // no boot
                3202, // the head her own face shape names
                702,  // and the ears, in a group nothing else fills
                1701, // the eye glow, which is selected here and drawn nowhere
                2101, // the skull
            ]
        );

        // One group, one part — which is the whole of "no doubled limbs and no z-fighting"
        // stated as arithmetic. A group awarded twice would show up here and nowhere else.
        let mut groups: Vec<u16> = drawn(&dressed)
            .iter()
            .filter(|geoset| **geoset != 0)
            .map(|geoset| geoset / 100)
            .collect();
        groups.sort_unstable();
        let mut distinct = groups.clone();
        distinct.dedup();
        assert_eq!(
            groups, distinct,
            "a group drawn twice is a limb drawn twice"
        );

        // And nothing went missing: a bare body draws ten parts and this draws nine, the one
        // difference being the hairstyle the helm covers.
        assert_eq!(drawn(&dressed).len(), drawn(&mesh()).len() - 1);
    }

    // The sentence the priority table exists for, read as geometry: a robe hangs *over* the
    // legs rather than beside them. Both pieces drive group 13 and the body holds a part for
    // each of the two values they ask for, so this is the one place where losing the argument
    // is visible rather than absorbed by the floor — 1302 is the skirt and 1301 is the nothing
    // that is there without one.
    #[test]
    fn a_robe_in_a_set_hangs_over_the_legs_rather_than_beside_them() {
        let dressed = drawn(&worn_mesh(&outfit_of(&[ROBE, LEGS])));
        assert!(dressed.contains(&1302), "{dressed:?}");
        assert!(!dressed.contains(&1301), "{dressed:?}");
        // And the trousers underneath are still the legs', which is what "over" means: the
        // robe took the group the two of them shared and none of the ones it did not.
        assert!(dressed.contains(&1104), "{dressed:?}");
        assert_eq!(dressed.len(), drawn(&mesh()).len());
    }

    // The compositing half of the same argument. Two pieces of one set can paint the same
    // rectangle — a robe's lower legs and a pair of boots' both land in section 6 — and which
    // one the reader sees is the draw order and nothing else. Boots composite below the chest,
    // so the robe's picture is the one on top whichever order the set named them in.
    #[test]
    fn paints_two_pieces_that_share_a_rectangle_in_the_order_they_composite() {
        for order in [[ROBE, BOOTS], [BOOTS, ROBE]] {
            let atlas = outfit_atlas(&order);
            assert_eq!(
                middle_of(&atlas, 6),
                [200, 240, 40, 255],
                "the robe's lower legs"
            );
            // And each piece still owns the rectangles nothing contests.
            assert_eq!(middle_of(&atlas, 7), [20, 100, 240, 255], "the boots' feet");
            assert_eq!(
                middle_of(&atlas, 3),
                [240, 130, 20, 255],
                "the robe's torso"
            );
        }
    }

    // The compositor underneath that, with the game's tables taken out of it: two pictures, one
    // rectangle, and the second is the one that is left. `Atlas::wear` takes the layers in the
    // order they go down and has never needed to know why they are in it.
    #[test]
    fn paints_a_later_layer_over_an_earlier_one_in_the_same_rectangle() {
        let files = fixture_files();
        let over = |first, second| {
            let mut atlas = Atlas::unpainted(&hers());
            atlas.wear(
                &hers(),
                &files,
                &[
                    ComponentTexture {
                        section: 6,
                        file: first,
                    },
                    ComponentTexture {
                        section: 6,
                        file: second,
                    },
                ],
            );
            let png = atlas.png().unwrap();
            middle_of(&image::load_from_memory(&png).unwrap().into_rgba8(), 6)
        };
        assert_eq!(over(151_010, 151_008), [200, 240, 40, 255]);
        assert_eq!(over(151_008, 151_010), [150, 30, 90, 255]);
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
            (
                "character.glb",
                glb_of(&fixture_files(), None, &Who::default()).unwrap(),
            ),
            (
                "robe.glb",
                glb_of(&fixture_files(), Some(&robe), &Who::default()).unwrap(),
            ),
            (
                "worn-helm.glb",
                glb_of(&fixture_files(), Some(&helm), &Who::default()).unwrap(),
            ),
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
    // back to and nothing ordinary about a game with no bodies in it.
    //
    // What it fails on now is `ChrRaces` rather than the mesh, because *which* body is read
    // before the body is — the races a person can be, the layout, the atlas size and the
    // rectangles all come out of the install, and a game with none of those is nothing to draw
    // rather than a character missing a part.
    #[test]
    fn says_so_when_the_install_holds_no_character_model() {
        let temp = tempfile::tempdir().unwrap();
        let error = glb_of(&DirFiles::new(temp.path()), None, &Who::default()).unwrap_err();
        assert!(error.contains("1305311.db2"), "{error}");
    }

    /* ---------- one of the reader's own, by name ---------- */

    /// The fixtures' races, as `look.rs`'s own tests name them: a Human, and the sexes the
    /// client numbers rather than the tables.
    const HUMAN: i64 = 1;
    const UNIT_FEMALE: i64 = 3;
    const HUMAN_FEMALE: u32 = 2;

    fn played(character: &str, race: i64, picked: Vec<Picked>) -> crate::look::Look {
        crate::look::Look {
            character: character.into(),
            race,
            sex: UNIT_FEMALE,
            observed_at: None,
            picked,
        }
    }

    #[test]
    fn finds_one_of_the_readers_own_characters_by_name() {
        let looks = vec![
            played("Zia-Vale", HUMAN, vec![]),
            played(
                "Aster-Vale",
                HUMAN,
                vec![Picked {
                    question: 14,
                    swatch: 133,
                }],
            ),
        ];

        let who = who_is(&fixture_files(), &looks, "Aster-Vale")
            .unwrap()
            .unwrap();

        assert_eq!(who.body, HUMAN_FEMALE);
        assert_eq!(
            who.picked,
            vec![Picked {
                question: 14,
                swatch: 133
            }]
        );
    }

    /// Which is most of a roster, and is why the portrait has to be able to say so.
    #[test]
    fn finds_nobody_for_a_character_the_addon_has_never_read_a_race_off() {
        let looks = vec![played("Zia-Vale", HUMAN, vec![])];

        assert_eq!(
            who_is(&fixture_files(), &looks, "Aster-Vale").unwrap(),
            None
        );
    }

    /// Two Asters on two realms are two people, and the whole database files them apart by the
    /// realm — so a name matched on its first half would draw one of them as the other.
    #[test]
    fn tells_two_characters_of_one_name_on_two_realms_apart() {
        let looks = vec![
            played(
                "Aster-Vale",
                HUMAN,
                vec![Picked {
                    question: 14,
                    swatch: 133,
                }],
            ),
            played(
                "Aster-Ridge",
                HUMAN,
                vec![Picked {
                    question: 14,
                    swatch: 21,
                }],
            ),
        ];

        let who = who_is(&fixture_files(), &looks, "Aster-Ridge")
            .unwrap()
            .unwrap();

        assert_eq!(
            who.picked,
            vec![Picked {
                question: 14,
                swatch: 21
            }]
        );
    }

    /* ---------- and drawn as themselves, or not drawn ---------- */

    /// The fault behind #222, stated at the level it lives at.
    ///
    /// A character the addon has never read a race off used to be handed to `worn_set_of` on the
    /// *reader's* body, and the picture that came back was a stranger wearing this character's
    /// clothes with nothing on screen to say so. On the machine that reported it, that was every
    /// character on the roster: no look had ever been stored, so the settings file's Kul Tiran
    /// Male stood in for sixteen night elves.
    #[test]
    fn draws_nobody_at_all_for_a_character_it_cannot_recognise() {
        let answer = own_worn_set_of(&fixture_files(), &[piece(ROBE)], None).unwrap();

        assert_eq!(answer["model"], Value::Null);
        assert_eq!(answer["likeness"], "nobody");
    }

    /// Most of a roster: the race is readable wherever they are standing, so the body is right
    /// and the colouring is the game's own defaults. Worth drawing, and worth being honest about.
    #[test]
    fn says_a_body_off_a_race_alone_is_not_their_colouring() {
        let who = Who {
            body: body::DEFAULT,
            picked: Vec::new(),
        };

        let answer = own_worn_set_of(&fixture_files(), &[piece(ROBE)], Some(&who)).unwrap();

        assert!(answer["model"].is_string());
        assert_eq!(answer["likeness"], "race");
    }

    /// And the one a barber's chair has been sat in: the body and the colours are both theirs.
    #[test]
    fn says_so_when_the_body_is_the_character_themselves() {
        let who = Who {
            body: body::DEFAULT,
            picked: vec![Picked {
                question: 14,
                swatch: 133,
            }],
        };

        let answer = own_worn_set_of(&fixture_files(), &[piece(ROBE)], Some(&who)).unwrap();

        assert!(answer["model"].is_string());
        assert_eq!(answer["likeness"], "themselves");
    }

    /// The `null` this already had keeps its meaning beside the new one, and the likeness is
    /// still the answer to a different question: there is somebody to draw and nothing to put on
    /// them. A window that read `null` as "nobody" would tell the reader their alt is unknown
    /// every time a set turned out to be undrawable.
    #[test]
    fn tells_a_set_it_cannot_draw_apart_from_a_character_it_cannot_recognise() {
        let who = Who {
            body: body::DEFAULT,
            picked: Vec::new(),
        };

        let answer = own_worn_set_of(&fixture_files(), &[], Some(&who)).unwrap();

        assert_eq!(answer["model"], Value::Null);
        assert_eq!(answer["likeness"], "race");
    }
}
