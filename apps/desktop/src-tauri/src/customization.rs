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
//! **Which body, and which of that body**, are both the reader's. [`crate::body`] is the first —
//! the `ChrModel` whose questions these are and whose texture layout the layers below belong to,
//! and both of those travel together because a body composited under another body's layout is
//! the failure that still draws. [`questions`] is the second: what the character creation screen
//! would ask about that body, [`Picked`] is one answer to one of them, and a question nobody has
//! answered keeps the swatch the game itself opens on — which is what every body in this app was
//! before there was anywhere to say otherwise.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::body::Body;
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
    /// `Name_lang`: "Skin Color", "Hair Style", "Ears" — what the screen calls the question.
    pub const NAME: usize = 0;
    /// `ChrModelID`: whose body this option belongs to.
    pub const MODEL: usize = 4;
    /// Where the question sits among this body's, in the order the screen lists them.
    pub const ORDER: usize = 5;
}

/// Columns of `ChrCustomizationChoice`, which keeps its id inside the row as well.
mod choice_column {
    /// `Name_lang`, which is empty for most swatches: a skin colour is a square of colour on
    /// the character creation screen and has nothing to be called. [`Swatch::name`] carries
    /// whatever is there and the window numbers the rest.
    pub const NAME: usize = 0;
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

/// One swatch of one question: a `ChrCustomizationChoice`, as something to offer a reader.
///
/// The name is what the game calls it and is usually nothing at all — hair colours and skin
/// tones are squares of colour on the character creation screen. That is the window's problem
/// rather than this module's: what is empty here is empty in the game's own table, and inventing
/// a name for it would be inventing it in the one place a later build could contradict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Swatch {
    pub id: u32,
    pub name: String,
}

/// One thing the character creation screen asks about this body: a `ChrCustomizationOption`.
///
/// "Question" rather than "option" because [`std::option::Option`] is a word this module cannot
/// spare, and because it is what the screen does with one — the answer is a [`Picked`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: u32,
    pub name: String,
    /// Every swatch of it, in the order the character creation screen lists them. The first is
    /// what a body nobody has answered for takes.
    pub swatches: Vec<Swatch>,
}

/// One answer: which swatch of which question the reader chose.
///
/// Stored in the settings file and handed back down to [`of`], so it is a shape that has to
/// survive a patch. Both halves are the game's own ids, and both are checked before anything is
/// drawn from them — a question this body does not have, or a swatch that belongs to another
/// question, is dropped rather than obeyed. See [`chosen_by`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    pub question: u32,
    pub swatch: u32,
}

/// How many answers the settings file is allowed to carry.
///
/// The whole file and not one body's: the questions are the game's own ids and no two bodies share
/// one, so what is stored is every body the reader has ever answered anything about — that is what
/// makes switching bodies and back find the answers still there. A Human Female has thirteen
/// questions, the game offers fifty-one bodies, and the largest of them are asked rather more, so
/// a reader who tries on their whole roster is carrying hundreds of answers and is not doing
/// anything unusual.
///
/// So this is a floor under a payload that is not a person's answers at all rather than a count of
/// anything. Deliberately far above what the game could ask: what a body may be asked is the
/// installed game's business and not this app's, and a backend that refused the answer after the
/// last one it had heard of would be the wrong end of the app to learn from a patch.
pub const ANSWER_LIMIT: usize = 2048;

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

/// What the character is, given whatever the reader has answered about her.
///
/// `picked` is the reader's, out of the settings file, and every question it says nothing about
/// keeps the swatch the game itself opens on — so an empty slice is the body this app drew
/// before there was anywhere to say otherwise, and one answer changes one thing about her.
///
/// `None` is an ordinary answer rather than a failure: the game encrypts what it has not
/// shipped, and a build that renumbers the tables above resolves to nothing. The body is then
/// drawn from its groups' bare defaults on the flat tone
/// [`crate::character::Atlas::unpainted`] holds — which is what every body looked like before
/// this chain was read, so the worst case is the old picture rather than a broken one.
#[tracing::instrument(name = "customization.of", skip_all)]
pub fn of(
    files: &dyn GameFiles,
    body: &Body,
    picked: &[Picked],
) -> Result<Option<Customization>, String> {
    let chosen = chosen_by(files, body.id, picked)?;
    if chosen.is_empty() {
        return Ok(None);
    }
    let elements = elements_of(files, &chosen)?;

    let mut found = Customization {
        geosets: geosets_of(files, &elements)?,
        ..Default::default()
    };
    paint(files, body, &elements, &mut found)?;
    if found == Customization::default() {
        return Ok(None);
    }
    Ok(Some(found))
}

/// The swatch of every one of this body's options that is to be applied to her.
///
/// The reader's answer where they gave one, and otherwise the swatch the game itself opens on —
/// the first by `OrderIndex`, which is the order the character creation screen lists them in and
/// not the order the rows sit in. Ties fall to the lower id so that two runs agree.
///
/// **An answer is checked against the table rather than believed.** It comes out of a settings
/// file that outlives patches, and the two ways it can be wrong are worth telling apart from
/// each other and from a swatch that is simply unusual: a question this body has not got is not
/// this body's business, and a swatch that belongs to *another* question would otherwise put
/// somebody else's hairstyle where an ear should be — `ChrCustomizationChoice` is one table for
/// every playable body there is. Both are dropped quietly, and the question keeps the swatch the
/// game opens on, because a body drawn as the game would draw it is the right answer to "this
/// install no longer has what you chose".
fn chosen_by(files: &dyn GameFiles, body: u32, picked: &[Picked]) -> Result<Vec<u32>, String> {
    let mine = questions_of(files, body)?;
    if mine.is_empty() {
        return Ok(Vec::new());
    }

    let choices = Db2::parse(files.read(CHR_CUSTOMIZATION_CHOICE)?)?;
    let mut first: HashMap<u32, (u32, u32)> = HashMap::new();
    // Which question each of this body's swatches belongs to, which is what an answer is checked
    // against. Only hers: the table holds every body's, and the whole point of the check is that
    // another body's swatch must not resolve.
    let mut belongs: HashMap<u32, u32> = HashMap::new();
    for row in choices.rows() {
        let option = row.number(choice_column::OPTION);
        if !mine.contains_key(&option) {
            continue;
        }
        belongs.insert(row.id(), option);
        // Held per option, so the count here is the body's options and not the table's rows.
        let swatch = (row.number(choice_column::ORDER), row.id());
        let held = first.entry(option).or_insert(swatch);
        if swatch < *held {
            *held = swatch;
        }
    }

    let answered: HashMap<u32, u32> = picked
        .iter()
        .filter(|answer| belongs.get(&answer.swatch) == Some(&answer.question))
        .map(|answer| (answer.question, answer.swatch))
        .collect();
    let mut chosen: Vec<u32> = first
        .into_iter()
        .map(|(option, (_, opens_on))| answered.get(&option).copied().unwrap_or(opens_on))
        .collect();
    chosen.sort_unstable();
    Ok(chosen)
}

/// Everything the character creation screen would ask about this body, and every answer to each.
///
/// This is the whole of what a reader may personalise, read out of the installed game rather
/// than listed anywhere: a patch that adds a hairstyle adds a swatch here, and one that adds a
/// question adds a question. The order is the screen's — `OrderIndex` on both tables, ties to
/// the lower id so that two runs agree.
///
/// **A question none of whose swatches does anything is left out.** The game asks a body several
/// things that a still picture cannot answer with — an eye style, an eyesight — and their
/// choices name no geoset and no material at all. Offering them would be offering a control that
/// demonstrably changes nothing, which is worse than not offering it: the reader would be left
/// deciding whether the render or their eyes were at fault. A swatch that does nothing *within*
/// a question is kept, because "none" is a real answer to "which necklace".
#[tracing::instrument(name = "customization.questions", skip_all)]
pub fn questions(files: &dyn GameFiles, body: u32) -> Result<Vec<Question>, String> {
    let mine = questions_of(files, body)?;
    if mine.is_empty() {
        return Ok(Vec::new());
    }

    let choices = Db2::parse(files.read(CHR_CUSTOMIZATION_CHOICE)?)?;
    // Keyed by question, and each list kept in the screen's order below.
    let mut swatches: HashMap<u32, Vec<(u32, u32, String)>> = HashMap::new();
    for row in choices.rows() {
        let option = row.number(choice_column::OPTION);
        if !mine.contains_key(&option) {
            continue;
        }
        swatches.entry(option).or_default().push((
            row.number(choice_column::ORDER),
            row.id(),
            row.text(choice_column::NAME),
        ));
    }

    let doing = doing_something(files, &swatches)?;
    let mut found: Vec<(u32, u32, Question)> = Vec::new();
    for (id, (order, name)) in mine {
        let Some(mut hers) = swatches.remove(&id) else {
            continue;
        };
        if !hers.iter().any(|(_, swatch, _)| doing.contains(swatch)) {
            continue;
        }
        hers.sort_by(|left, right| (left.0, left.1).cmp(&(right.0, right.1)));
        found.push((
            order,
            id,
            Question {
                id,
                name,
                swatches: hers
                    .into_iter()
                    .map(|(_, id, name)| Swatch { id, name })
                    .collect(),
            },
        ));
    }
    found.sort_by(|left, right| (left.0, left.1).cmp(&(right.0, right.1)));
    Ok(found.into_iter().map(|(_, _, question)| question).collect())
}

/// Every question that belongs to the body this app draws, as `id → (order, name)`.
///
/// A map rather than a set because what asks this asks two things of it — whether a question is
/// hers, and what to call it — and because `ChrCustomizationOption` describes every playable
/// body at once. Dropping the `ChrModelID` filter is what would give group 32 two owners.
fn questions_of(
    files: &dyn GameFiles,
    body: u32,
) -> Result<HashMap<u32, (u32, String)>, String> {
    let options = Db2::parse(files.read(CHR_CUSTOMIZATION_OPTION)?)?;
    Ok(options
        .rows()
        .filter(|row| row.number(option_column::MODEL) == body)
        .map(|row| {
            (
                row.id(),
                (
                    row.number(option_column::ORDER),
                    row.text(option_column::NAME),
                ),
            )
        })
        .collect())
}

/// Which of those swatches do anything this app could draw: a geoset, or a picture.
///
/// One walk of `ChrCustomizationElement` for all of them rather than one per question — it is
/// the largest table on the chain, and [`crate::db2::Db2::rows`] materialises every row of it
/// before yielding the first.
fn doing_something(
    files: &dyn GameFiles,
    swatches: &HashMap<u32, Vec<(u32, u32, String)>>,
) -> Result<HashSet<u32>, String> {
    let hers: HashSet<u32> = swatches
        .values()
        .flatten()
        .map(|(_, swatch, _)| *swatch)
        .collect();
    let elements = Db2::parse(files.read(CHR_CUSTOMIZATION_ELEMENT)?)?;
    Ok(elements
        .rows()
        .filter(|row| {
            row.number(element_column::GEOSET) != 0 || row.number(element_column::MATERIAL) != 0
        })
        .map(|row| row.number(element_column::CHOICE))
        .filter(|choice| hers.contains(choice))
        .collect())
}

/// The answers as they will be stored, refusing what could not be applied again.
///
/// The rules are the shape's rather than the game's — nothing here opens the install, so a
/// machine without the game can still save what a machine with it chose. What the *game* says
/// about an answer is settled at the other end, in [`chosen_by`], every time a body is drawn.
///
/// **One answer per question**, because a second is either the window sending its state twice or
/// two readings of what the reader chose, and a body cannot have both. The last wins, which is
/// what a form that sends everything it holds means by sending a question twice.
pub fn clean(picked: Vec<Picked>) -> Result<Vec<Picked>, String> {
    if picked.len() > ANSWER_LIMIT {
        return Err(format!("A character carries at most {ANSWER_LIMIT} choices."));
    }
    let mut cleaned: Vec<Picked> = Vec::with_capacity(picked.len());
    for answer in picked {
        if answer.question == 0 || answer.swatch == 0 {
            return Err("That choice names no question of hers, or no swatch of it.".into());
        }
        match cleaned.iter_mut().find(|held| held.question == answer.question) {
            Some(held) => held.swatch = answer.swatch,
            None => cleaned.push(answer),
        }
    }
    Ok(cleaned)
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
/// `geoset = GeosetType × 100 + GeosetID`, the same arithmetic an item's groups get — and the
/// two ways a row can decline to name a geoset are opposite, which is the whole of what is
/// fiddly here:
///
/// - **0 is the group switched off.** That is not a row to drop: a group switched off has to
///   take its bare default with it, or a character wears the jewellery she declined.
/// - **`-1` is no geoset at all**, the same sentinel `ItemDisplayInfo.GeosetGroup` carries, and
///   it *is* a row to drop. Read as a value it is 65,535 and the multiply on top of it is not a
///   number the body could hold; nothing in group 17 belongs to a swatch that says this.
///
/// No Human swatch carries `-1`, which is why nothing here had to know: every one of the
/// shipping table's is on a race added after the two this app used to draw.
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
        .filter_map(|row| {
            let group = u16::try_from(row.number(geoset_column::TYPE)).ok()?;
            let value = u16::try_from(row.number(geoset_column::VALUE)).ok()?;
            let geoset = group.checked_mul(100)?.checked_add(value)?;
            Some(Geoset { group, geoset })
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
    body: &Body,
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

    for layer in layers_of(files, body.layout)? {
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
fn layers_of(files: &dyn GameFiles, layout: u32) -> Result<Vec<Layer>, String> {
    let table = Db2::parse(files.read(CHR_MODEL_TEXTURE_LAYER)?)?;
    let mut found: Vec<(u32, Layer)> = table
        .rows()
        .filter(|row| row.foreign_id() == layout)
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

    /// The body the fixtures' own tables describe, which is the one this app opens on.
    fn hers() -> crate::body::Body {
        crate::body::of(&fixture_files(), crate::body::DEFAULT).unwrap()
    }

    fn herself() -> Customization {
        as_answered(&[])
    }

    /// Her, with the reader having answered some of what the screen asks.
    fn as_answered(picked: &[Picked]) -> Customization {
        of(&fixture_files(), &hers(), picked)
            .unwrap()
            .expect("the fixture install can say who this body is")
    }

    /// The choices the app makes on this body's behalf, which is what everything else follows
    /// from — one per option, and the one the character creation screen opens on.
    fn chosen() -> Vec<u32> {
        chosen_by(&fixture_files(), crate::body::DEFAULT, &[]).unwrap()
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

    // `-1` is the other thing a value can be, and it is the opposite of zero: not a group
    // switched off but a row that names no geoset at all, the same sentinel an item's
    // `GeosetGroup` carries. Read as a value it is 65,535, and `group × 100` on top of that is
    // not a number — which on a build where that arithmetic is checked is a panic in the middle
    // of drawing somebody, and on one where it is not is a geoset id that wrapped.
    //
    // No Human swatch carries one, which is why this went unseen while there were two bodies:
    // the shipping table's rows are all on races added later, in group 17, the eye glow.
    #[test]
    fn drives_no_geoset_at_all_for_a_value_of_minus_one() {
        let hers = herself().geosets;
        assert!(
            !hers.iter().any(|geoset| geoset.group == 17),
            "a row naming no geoset switched one on: {hers:?}"
        );
    }

    // Which swatch is the first one is the order index and not the row order. The fixture lists
    // the face, the hairstyle and the face shape second-swatch-first for exactly this reason,
    // and every one of those rows resolves.
    #[test]
    fn opens_on_the_first_swatch_of_each_option_by_order_rather_than_by_row() {
        assert_eq!(chosen(), vec![85, 102, 132, 156, 4150, 4908, 5059, 54_353, 56653]);
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
        let layers = layers_of(&fixture_files(), hers().layout).unwrap();
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
            .filter(|row| row.foreign_id() != hers().layout)
            .map(|row| row.element(layer_column::TEXTURE_TARGET, 0, TARGET_BITS))
            .collect();
        assert!(elsewhere.contains(&40), "the fixture holds another layout's base layer");
        let mine = layers_of(&fixture_files(), hers().layout).unwrap();
        assert!(!mine.iter().any(|layer| layer.target == 40));
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
        let error = of(&DirFiles::new(temp.path()), &hers(), &[]).unwrap_err();
        assert!(error.contains("3384247.db2"), "{error}");
    }

    /* ---------- what the reader is asked, and what their answer does ---------- */

    /// The fixture's second swatch of three of her questions, each of which resolves as fully as
    /// the first — a second skin with a face authored for it, a second hairstyle, a second head.
    const HAIR_STYLE: u32 = 16;
    /// The question of hers that drives nothing at all, which is the one she is not asked.
    const INERT_QUESTION: u32 = 8523;
    const ANOTHER_HAIRSTYLE: Picked = Picked { question: HAIR_STYLE, swatch: 133 };
    const ANOTHER_SKIN_SWATCH: Picked = Picked { question: 14, swatch: 86 };
    const ANOTHER_FACE_SHAPE: Picked = Picked { question: 526, swatch: 5060 };

    fn asked() -> Vec<Question> {
        questions(&fixture_files(), crate::body::DEFAULT).unwrap()
    }

    fn question(id: u32) -> Question {
        asked().into_iter().find(|question| question.id == id).expect("a question of hers")
    }

    // What there is to personalise at all: the screen's own questions, named, each with every
    // swatch of it. Everything below is one of these being answered.
    #[test]
    fn asks_what_the_character_creation_screen_asks_about_this_body() {
        let hers = asked();
        let named: Vec<(u32, &str)> =
            hers.iter().map(|question| (question.id, question.name.as_str())).collect();
        assert_eq!(
            named,
            vec![
                (15, "Face"),
                (14, "Skin Color"),
                (HAIR_STYLE, "Hair Style"),
                (17, "Hair Color"),
                (464, "Eye Color"),
                (510, "Necklace"),
                (526, "Face Shape"),
                (8790, "Ears"),
            ],
            "in the order the screen lists them, which is OrderIndex and not the row order",
        );
    }

    // And the swatches of one, in the screen's order rather than the table's. The fixture lists
    // the hairstyles second-swatch-first for exactly this reason.
    #[test]
    fn lists_the_swatches_of_a_question_in_the_order_the_screen_offers_them() {
        let ids: Vec<u32> = question(HAIR_STYLE).swatches.iter().map(|swatch| swatch.id).collect();
        assert_eq!(ids, vec![132, 133]);
    }

    // The one thing this app must not offer: another body's question. `ChrCustomizationOption`
    // describes every playable model at once, and the fixture holds a second body's face shape
    // whose every column reads.
    #[test]
    fn asks_nothing_that_belongs_to_another_body() {
        assert!(!asked().iter().any(|question| question.id == 9000));
    }

    // A question whose swatches do nothing is left out. The game asks a body several things a
    // still picture cannot answer with — an eye style, an eyesight — and a control that
    // demonstrably changes nothing is worse than no control at all.
    #[test]
    fn leaves_out_a_question_none_of_whose_swatches_does_anything() {
        assert!(!asked().iter().any(|question| question.id == INERT_QUESTION));
        // The rows are there and readable; what leaves them out is that nothing follows from
        // them, and a question one of whose swatches does something is kept whole.
        let choices = Db2::parse(fixture_files().read(CHR_CUSTOMIZATION_CHOICE).unwrap()).unwrap();
        assert!(choices
            .rows()
            .any(|row| row.number(choice_column::OPTION) == INERT_QUESTION));
    }

    // The point of all of it: an answer changes the body, and changes only what it is about.
    #[test]
    fn draws_the_swatch_the_reader_chose_rather_than_the_one_the_game_opens_on() {
        let hers = as_answered(&[ANOTHER_HAIRSTYLE]);
        assert!(
            hers.geosets.contains(&Geoset { group: 0, geoset: 1 }),
            "the hairstyle she chose: {:?}",
            hers.geosets
        );
        assert!(!hers.geosets.contains(&Geoset { group: 0, geoset: 2 }), "and not the first one");
        // Her head, her ears and her skin are not what was asked about and do not move.
        assert_eq!(hers.base, herself().base);
        assert!(hers.geosets.contains(&Geoset { group: 32, geoset: 3202 }));
    }

    // Several answers at once, which is what a settings file holds — and the conditional
    // elements have to follow: a face is authored per skin, so choosing another skin has to
    // bring the face authored for *that* skin with it.
    #[test]
    fn answers_every_question_the_reader_answered() {
        let hers = as_answered(&[ANOTHER_SKIN_SWATCH, ANOTHER_FACE_SHAPE]);
        assert_eq!(hers.base, ANOTHER_SKIN, "the skin she chose");
        assert!(
            hers.over.iter().any(|texture| texture.file == ANOTHER_FACE),
            "the face authored for that skin: {:?}",
            hers.over
        );
        assert!(hers.geosets.contains(&Geoset { group: 32, geoset: 3203 }), "the head she chose");
    }

    // An answer out of a settings file older than the install it is being applied to. Both ways
    // it can be stale are quiet, and neither may resolve: a question this body has not got is
    // nobody's, and a swatch of another question would put a hairstyle where an ear goes.
    #[test]
    fn ignores_an_answer_the_installed_game_does_not_bear_out() {
        let elsewhere = Picked { question: 9000, swatch: 9001 };
        let crossed = Picked { question: HAIR_STYLE, swatch: 5060 };
        let absent = Picked { question: HAIR_STYLE, swatch: 40_404 };
        for answer in [elsewhere, crossed, absent] {
            assert_eq!(as_answered(&[answer]), herself(), "{answer:?} was obeyed");
        }
    }

    // The rules the settings file is held to, which are about the shape and not about the game:
    // a machine with no install still saves what a machine with one chose.
    #[test]
    fn keeps_one_answer_per_question() {
        let twice = vec![ANOTHER_HAIRSTYLE, Picked { question: HAIR_STYLE, swatch: 132 }];
        assert_eq!(clean(twice), Ok(vec![Picked { question: HAIR_STYLE, swatch: 132 }]));
        let both = vec![ANOTHER_HAIRSTYLE, ANOTHER_SKIN_SWATCH];
        assert_eq!(clean(both.clone()), Ok(both));
    }

    #[test]
    fn refuses_an_answer_that_names_no_question_or_no_swatch() {
        assert!(clean(vec![Picked { question: 0, swatch: 132 }]).is_err());
        assert!(clean(vec![Picked { question: HAIR_STYLE, swatch: 0 }]).is_err());
        assert_eq!(clean(Vec::new()), Ok(Vec::new()), "nobody has answered anything yet");
    }

    // The limit is a floor under a payload that is not a person's answers rather than a count of
    // what a body is asked, so both ends of it are worth stating: a roster's worth of bodies, each
    // answered for, is an ordinary settings file and has to survive being saved.
    #[test]
    fn refuses_more_answers_than_a_settings_file_could_hold() {
        let answers = |how_many: u32| -> Vec<Picked> {
            (0..how_many).map(|at| Picked { question: at + 1, swatch: at + 1 }).collect()
        };
        assert!(clean(answers(ANSWER_LIMIT as u32 + 1)).is_err());
        // Fifty-one bodies of a dozen questions each, which is what trying on a whole roster in
        // the transmog view comes to — see `look.rs`.
        assert!(clean(answers(51 * 13)).is_ok());
    }

    /* ---------- the other body ---------- */

    /// `ChrModel` 1, the body beside hers.
    const OTHER_BODY: u32 = 1;
    /// His own questions, one of which no female body is ever asked.
    const HIS_HAIR: u32 = 41;
    const FACIAL_HAIR: u32 = 42;

    fn his() -> crate::body::Body {
        crate::body::of(&fixture_files(), OTHER_BODY).unwrap()
    }

    // Another body is asked another set of questions, out of the same table — which is the
    // filter this whole chain turns on. Offering hers against his body would be offering
    // swatches that resolve to nothing on him and a facial hair question she cannot have.
    #[test]
    fn asks_each_body_its_own_questions() {
        let asked_of_him = questions(&fixture_files(), OTHER_BODY).unwrap();
        let his: Vec<(u32, &str)> = asked_of_him
            .iter()
            .map(|question| (question.id, question.name.as_str()))
            .collect();
        assert_eq!(
            his,
            vec![(40, "Skin Color"), (HIS_HAIR, "Hair Style"), (FACIAL_HAIR, "Facial Hair")],
        );
        assert!(!asked().iter().any(|question| question.id == FACIAL_HAIR));
    }

    // And what those answers do lands on him: his skin is painted from a layer of his own
    // layout, and his beard is a geoset in a group her body has nothing in.
    #[test]
    fn draws_the_body_it_was_asked_about() {
        let his = of(&fixture_files(), &his(), &[Picked { question: FACIAL_HAIR, swatch: 421 }])
            .unwrap()
            .expect("the fixture install can say who this body is");
        assert_eq!(his.base, 160_101, "his skin, not hers");
        assert!(his.geosets.contains(&Geoset { group: 1, geoset: 101 }), "{:?}", his.geosets);
    }

    // An answer about him is an answer about his questions: the same rule the female body
    // follows, on the body that proves it is not hard-coded anywhere.
    #[test]
    fn answers_a_question_of_the_other_bodys() {
        let opens_on = of(&fixture_files(), &his(), &[]).unwrap().unwrap();
        assert!(opens_on.geosets.contains(&Geoset { group: 0, geoset: 2 }));

        let chosen = of(&fixture_files(), &his(), &[Picked { question: HIS_HAIR, swatch: 411 }])
            .unwrap()
            .unwrap();
        assert!(chosen.geosets.contains(&Geoset { group: 0, geoset: 1 }), "{:?}", chosen.geosets);
        assert!(!chosen.geosets.contains(&Geoset { group: 0, geoset: 2 }));
    }

    // Her answers are not his. Both bodies' answers live in one settings file, because the
    // question ids are the game's own and no two bodies share one — so what keeps his hair off
    // her head is the same check that drops a stale answer.
    #[test]
    fn ignores_the_other_bodys_answers_when_drawing_this_one() {
        let his_hair = Picked { question: HIS_HAIR, swatch: 411 };
        assert_eq!(as_answered(&[his_hair]), herself());
        // And the other way round, which is the same statement from the other end.
        let hers = of(&fixture_files(), &his(), &[ANOTHER_HAIRSTYLE]).unwrap().unwrap();
        assert_eq!(hers, of(&fixture_files(), &his(), &[]).unwrap().unwrap());
    }

    #[test]
    fn says_so_when_what_the_reader_may_be_asked_cannot_be_read() {
        let temp = tempfile::tempdir().unwrap();
        let error = questions(&DirFiles::new(temp.path()), crate::body::DEFAULT).unwrap_err();
        assert!(error.contains("3384247.db2"), "{error}");
    }
}
