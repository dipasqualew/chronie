//! Which appearances *look* like one another, worked out from the pictures rather than the mesh.
//!
//! [`crate::shapes`] answers the slots that hang geometry, exactly, and refuses the rest. The
//! rest is most of a wardrobe: chest, waist, legs, feet, wrist, hands, back and tabard are paint
//! on a body every one of them shares, so there is no mesh to compare and the only signal left
//! is the pixels. This is that signal, and unlike the geometry it is a **ranking somebody
//! confirms rather than a verdict** — everything below is a measurement with a stated cut and
//! neither of those is an equality.
//!
//! # What one look comes to
//!
//! A 16 × 16 grid of one bit a cell, per picture the appearance paints, in a stated order. The
//! bit is the sign of the cell's luminance against the mean of the picture's own cells, which is
//! the classic difference hash and is what makes the measure **colour-blind by construction**: a
//! dark recolour and its bright twin have the same lights and darks in the same places, and the
//! sign of a contrast-normalised luminance is all that survives of either. Transparent texels are
//! skipped the way [`crate::qualities`] skips them, a bracer being a band across an arm-sized
//! sheet, and a picture with nothing solid in it at all is not a picture.
//!
//! One bit a cell rather than the luminance itself, and that is not a compression. Measured
//! against float32 on the ground truth below, one bit scored *better*: the sign is a denoiser,
//! and the 235 MB of floats bought nothing the 55 bytes did not already have.
//!
//! # It answers armour and must never be asked about a weapon
//!
//! A weapon paints nothing on the body, so its only picture is the one on its own mesh — and
//! that is a UV atlas rather than a picture of the sword. Measured on a 12.0.5.67823 install the
//! populations do not separate at all: a median of 0.477 between known recolours against 0.484
//! between strangers, which is 3.3% recall. Shields and bows are the same story. So [`PAINTED`]
//! is the eleven places on the body and nothing carried in a hand, and the reason it is a
//! constant here rather than a filter at the call site is that offering a reader the nearest
//! sword by this measure would be offering them noise with a number beside it. Geometry is
//! *exact* for weapons and at its best there; that is what answers them.
//!
//! # What the cut is, and why it is measured per slot
//!
//! Pooling every slot into one comparison collapses recall to 6–13%, for the reason
//! [`crate::qualities`] refuses to compare a size across measures: a chestpiece paints four
//! rectangles of her and a belt paints one, so the two are near each other for reasons that have
//! nothing to do with either. Restricted to one display type the same store recalls 42–81%.
//!
//! So the cut is taken **per display type, off the install's own distribution of strangers**:
//! [`stranger_pairs`] walks the slot pairing each look with one it has no reason to resemble,
//! and [`cut`] takes the distance the nearest [`RANDOM_PAIR_RATE`] of those pairs sit within.
//! Anything at least that near is worth offering. That is a relative answer for the reason the
//! size bands are relative — there is no absolute distance that makes two chestpieces the same
//! chestpiece, and every attempt to write one down is a constant the next patch invalidates.
//!
//! # Where it is kept
//!
//! **Computed on the reader's machine and cached in the app's own data directory, keyed on the
//! build**, exactly as [`crate::shapes`] is and for a sharper reason. A 16 × 16 thumbnail is a
//! *downsampled copy of* Blizzard's texture — lossy, tiny, and still a reproduction of the
//! picture — where the colours and size bands [`crate::qualities`] commits are facts *about* one
//! and reconstruct nothing. This repository carries no reproduction of the game's art, so this
//! store is never committed.
//!
//! What that costs is a minute. The sweep decodes about 68,000 textures on a shipping install
//! and takes 49–61 s warm, against the second [`crate::shapes`] costs, which is why the app
//! computes it in the background and says "not ready yet" rather than making anybody wait for
//! it. It is single-threaded because [`GameFiles`] is a reader with a cache of its own rather
//! than something several threads may hold, and the decode is the whole minute.
//!
//! **Measured on one body**, for the reason both other stores are: which pictures a chestpiece
//! resolves to is `ComponentTextureFileData`'s answer per race and sex, so a store taken on her
//! and one taken on him are two different claims about one piece of armour.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::body::Body;
use crate::casc::GameFiles;
use crate::icons::pixels_of;
use crate::worn::{self, Piece, Worn};

/// How many cells a side one picture is reduced to.
///
/// Sixteen, which is 256 bits and 32 bytes a picture. Eight was measured too and is half the
/// bytes for a few points of recall; the bytes are not what this costs and the sixteen is what
/// every number quoted above was measured on.
const SIDE: usize = 16;

/// How many cells that is, which is also how many bits a grid holds.
const CELLS: usize = SIDE * SIDE;

/// How many `u64`s hold them.
const WORDS: usize = CELLS / 64;

/// A texel too see-through to be part of what the piece looks like — [`crate::qualities::SOLID`]
/// by another name, and the same reason: armour is authored into a rectangle the size of the
/// whole limb and most of that rectangle is empty.
const SOLID: u8 = 128;

/// The largest texture worth reading, a side at a time, as everywhere else in this app.
const LARGEST_TEXTURE: u32 = 2048;

/// The eleven places on the body this measure answers.
///
/// Every `ItemAppearance.DisplayType` that is worn rather than carried. What is missing is 11
/// to 15 — weapon, ranged, shield, relic and held — and the module note says why: the only
/// picture such a look has is its mesh's own UV atlas, which is not a picture of the thing.
pub const PAINTED: [u32; 11] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/// How often a pair of looks that have nothing to do with each other may be offered anyway.
///
/// The rate the cut is taken at, and the number every recall above was quoted against. Half a
/// percent of the strangers in a slot is a handful of wrong rows in a list somebody is reading
/// as suggestions — which is the whole shape of this feature, and is a very different budget
/// from the one a verdict would have.
const RANDOM_PAIR_RATE: f64 = 0.005;

/// How few stranger pairs is too few to have cut anything off.
///
/// A slot of two looks has no distribution: its one pair is its nearest pair whatever it
/// measures, and a cut taken there says only that something was nearest. Below this the slot has
/// no cut and [`Fingerprints::nearest`] offers nothing for it, which is the same refusal
/// [`crate::qualities::band`] makes of a slot whose thirds have collapsed onto each other.
const FEWEST_PAIRS: usize = 4;

/// The multiplier that pairs a look with a stranger — Knuth's, and any large odd number would
/// do. See [`stranger_pairs`] for why the pairing is arithmetic rather than random.
const STRIDE: usize = 2_654_435_761;

/// And the offset, so that the first look is not paired with itself.
const OFFSET: usize = 40_503;

/// What the cache is called inside the directory it is kept in.
const FILE: &str = "fingerprints.json";

/// What a half-written cache is called until it is whole — see [`crate::shapes`], where the
/// same rename guards the same failure: a store truncated halfway through parses as far as it
/// goes, and every look past the cut then reads as "nothing in the game looks like this".
const PARTIAL: &str = "fingerprints.json.part";

/// Where one grid of a fingerprint was taken from.
///
/// A fingerprint is compared place by place, so what a place *is* has to mean the same thing on
/// both sides of a comparison. A section does by construction — the game numbers them and two
/// chestpieces paint the same rectangles of the same body. A mesh's own picture does not, so it
/// is indexed by position after a sort on the mesh's FileDataID: a recolour hangs the same
/// meshes in the same order, so its pictures land in the same positions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Place {
    /// The nth picture the appearance paints its own geometry with.
    Mesh(u32),
    /// A `ComponentSection` of the body it paints, as the game numbers them.
    Section(u32),
    /// The one picture a cloak is, the back slot's geometry being the body's own.
    Cape,
}

impl Place {
    /// What the store calls it, which is also what reads it back.
    fn word(self) -> String {
        match self {
            Place::Mesh(at) => format!("m{at}"),
            Place::Section(section) => format!("s{section}"),
            Place::Cape => "c".to_string(),
        }
    }

    fn read(word: &str) -> Option<Self> {
        match (word.get(..1)?, &word[1..]) {
            ("m", at) => at.parse().ok().map(Place::Mesh),
            ("s", section) => section.parse().ok().map(Place::Section),
            ("c", "") => Some(Place::Cape),
            _ => None,
        }
    }
}

/// One picture, reduced to where it is lighter than itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Grid([u64; WORDS]);

impl Grid {
    /// How many of the 256 cells the two disagree about.
    fn differing(self, other: Self) -> u32 {
        (0..WORDS)
            .map(|word| (self.0[word] ^ other.0[word]).count_ones())
            .sum()
    }

    fn hex(self) -> String {
        self.0.iter().fold(String::new(), |mut out, word| {
            let _ = write!(out, "{word:016x}");
            out
        })
    }

    fn read(hex: &str) -> Option<Self> {
        if hex.len() != WORDS * 16 {
            return None;
        }
        let mut words = [0u64; WORDS];
        for (at, word) in words.iter_mut().enumerate() {
            *word = u64::from_str_radix(&hex[at * 16..(at + 1) * 16], 16).ok()?;
        }
        Some(Self(words))
    }
}

/// What one appearance looks like: one grid per picture it paints, by where the picture goes.
///
/// Never empty — an appearance with no readable picture has no fingerprint at all rather than a
/// fingerprint of zeroes. That rule is [`crate::shapes`]'s, learnt the same way: 3,915 looks of
/// a shipping install decode to nothing, and written down as a grid of zeroes every one of them
/// becomes every other one's nearest neighbour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint(BTreeMap<Place, Grid>);

impl Fingerprint {
    /// How unalike two looks are, between 0 and 1, or nothing where they cannot be compared.
    ///
    /// **Over the places both of them paint, and nothing else.** A robe and a breastplate share
    /// a torso and disagree about legs the breastplate never touches; counting the legs against
    /// it would be scoring a garment for what it is not. Two looks with no place in common — a
    /// cloak against a pair of gloves — are not near or far, they are incomparable, and that is
    /// `None` rather than 1.
    pub fn distance(&self, other: &Self) -> Option<f64> {
        let mut differing = 0u32;
        let mut cells = 0usize;
        for (place, mine) in &self.0 {
            let Some(theirs) = other.0.get(place) else {
                continue;
            };
            differing += mine.differing(*theirs);
            cells += CELLS;
        }
        (cells > 0).then(|| f64::from(differing) / cells as f64)
    }

    /// The fingerprint as the store writes it: `s3:<64 hex>|s4:<64 hex>`, places ascending.
    pub fn as_str(&self) -> String {
        self.0
            .iter()
            .map(|(place, grid)| format!("{}:{}", place.word(), grid.hex()))
            .collect::<Vec<String>>()
            .join("|")
    }

    /// A fingerprint back out of that, or nothing where the text is not one.
    ///
    /// Strict, because the caller is [`Fingerprints::read`] and what it does with a store it
    /// cannot read whole is throw it away and measure the game again.
    pub fn read(text: &str) -> Option<Self> {
        let mut held = BTreeMap::new();
        for part in text.split('|') {
            let (place, hex) = part.split_once(':')?;
            held.insert(Place::read(place)?, Grid::read(hex)?);
        }
        (!held.is_empty()).then_some(Self(held))
    }
}

/// What one appearance looks like, out of the pictures the game paints it with.
///
/// A batch of one, and it goes through [`each`] like any other — see there for why a batch is
/// the unit.
pub fn of(files: &dyn GameFiles, body: &Body, piece: Piece) -> Result<Option<Fingerprint>, String> {
    Ok(each(files, body, &[piece])?
        .pop()
        .expect("one piece in, one answer out"))
}

/// The same, for a batch, sharing every table and every decoded picture between its rows.
///
/// A batch for the reason [`crate::qualities::each`] is one — [`crate::worn::each`] materialises
/// six hundred thousand rows of `ItemDisplayInfoMaterialRes` before it yields the first answer,
/// so asked a look at a time a sweep of the game would walk that fifty thousand times — and,
/// unlike that one, there is no reason to keep a batch small. What a decoded texture leaves
/// behind here is 32 bytes rather than an image, so the whole game's 68,000 pictures come to two
/// megabytes of grids and every one of them is decoded once.
#[tracing::instrument(name = "fingerprints.each", skip_all, fields(pieces = pieces.len()))]
pub fn each(
    files: &dyn GameFiles,
    body: &Body,
    pieces: &[Piece],
) -> Result<Vec<Option<Fingerprint>>, String> {
    if pieces.is_empty() {
        return Ok(Vec::new());
    }
    // One outfit per piece: what a look is like is what it is like alone, and there is nothing
    // for the draw order or the priority table to settle between one garment and itself.
    let alone: Vec<&[Piece]> = pieces.iter().map(std::slice::from_ref).collect();
    let worn = worn::each(files, body, &alone)?;

    let mut grids: HashMap<u32, Option<Grid>> = HashMap::new();
    Ok(worn
        .iter()
        .map(|worn| printed(files, &mut grids, worn))
        .collect())
}

/// One look's fingerprint, decoding whatever this batch has not already.
fn printed(
    files: &dyn GameFiles,
    grids: &mut HashMap<u32, Option<Grid>>,
    worn: &Worn,
) -> Option<Fingerprint> {
    let mut held: BTreeMap<Place, Grid> = BTreeMap::new();
    let mut take = |grids: &mut HashMap<u32, Option<Grid>>, place: Place, file: u32| {
        if let Some(grid) = *grids.entry(file).or_insert_with(|| grid_of(files, file)) {
            held.entry(place).or_insert(grid);
        }
    };

    // The pictures on its own geometry, sorted by the mesh that carries them so that a recolour
    // — which hangs the same meshes — lands its pictures in the same positions. Deduplicated by
    // file, because a pair of pauldrons painted from one sheet is one picture drawn twice.
    let mut hung: Vec<(u32, u32)> = worn
        .models
        .iter()
        .filter_map(|model| Some((model.file, model.texture?)))
        .collect();
    hung.sort_unstable();
    hung.dedup_by_key(|(_, texture)| *texture);
    for (at, (_, texture)) in hung.into_iter().enumerate() {
        take(grids, Place::Mesh(at as u32), texture);
    }

    // And the pictures it paints onto her, which are the whole of a chestpiece and none of a
    // helm. Keyed by the section, which the game numbers and two garments share.
    for texture in &worn.textures {
        take(grids, Place::Section(texture.section), texture.file);
    }
    if let Some(cape) = worn.cape {
        take(grids, Place::Cape, cape);
    }

    (!held.is_empty()).then_some(Fingerprint(held))
}

/// One texture, decoded and reduced — or nothing, where this install cannot show it.
///
/// Nothing is ordinary and stays quiet, exactly as it is in [`crate::qualities`]: the game
/// withholds what it has not shipped, an install can be missing a file an appearance names, and
/// a texture in an encoding this build cannot read is the same story from the row's side. A
/// picture with no solid texel at all is the fourth way — a sheet authored for a body this is
/// not — and is likewise not a picture.
fn grid_of(files: &dyn GameFiles, file: u32) -> Option<Grid> {
    let pixels = files
        .read(file)
        .and_then(|blp| pixels_of(&blp, LARGEST_TEXTURE))
        .ok()?;

    // The average brightness of each cell over the texels of it that are actually there, and
    // how many cells had any. A cell of nothing but empty sheet is left at zero rather than
    // dropped: a bracer is a band across an arm, and *where the band is not* is as much of what
    // it looks like as where it is.
    let mut cells = [0i64; CELLS];
    let mut painted = 0usize;
    for (at, cell) in cells.iter_mut().enumerate() {
        let (light, texels) = lit(&pixels, at % SIDE, at / SIDE);
        if texels > 0 {
            *cell = light_as_whole(light / texels as f64);
            painted += 1;
        }
    }
    if painted == 0 {
        return None;
    }

    // Contrast-normalised against the picture's own cells, which is the whole of what makes this
    // blind to colour: the mean moves with a recolour and the signs about it do not.
    //
    // Against the mean *times the cell count*, rather than against the mean, and in whole
    // numbers — because the picture this has to be exactly right about is the flat one. Every
    // cell of a picture of one colour is the mean of it, and a mean arrived at by dividing a sum
    // of two hundred and fifty-six floats lands a hair either side of that: the same flat sheet
    // in two colours would then come out as every cell set in one and no cell set in the other,
    // which is precisely the disagreement this measure exists not to have.
    let total: i64 = cells.iter().sum();
    let mut words = [0u64; WORDS];
    for (at, cell) in cells.iter().enumerate() {
        if *cell * CELLS as i64 > total {
            words[at / 64] |= 1 << (at % 64);
        }
    }
    Some(Grid(words))
}

/// One cell's brightness as a whole number, which is what makes the comparison above exact.
///
/// Thousandths of a level, so that two cells a shade apart are still two numbers — 255 levels
/// rounded to whole ones would call the top and bottom of a gradient one flat colour.
fn light_as_whole(light: f64) -> i64 {
    (light * 1000.0).round() as i64
}

/// How bright one cell of a picture is, and over how many texels that was.
///
/// The rectangle of the source the cell covers, and at least one texel of it wherever the
/// picture is smaller than the grid — so an 8-pixel sheet reduces to a grid that says something
/// rather than to a grid half of whose cells fell between two texels.
fn lit(pixels: &image::RgbaImage, column: usize, row: usize) -> (f64, u64) {
    let span = |at: usize, of: u32| {
        let from = at * of as usize / SIDE;
        (
            from as u32,
            ((at + 1) * of as usize / SIDE).max(from + 1) as u32,
        )
    };
    let (left, right) = span(column, pixels.width());
    let (top, bottom) = span(row, pixels.height());

    let mut light = 0.0;
    let mut texels = 0u64;
    for y in top..bottom.min(pixels.height()) {
        for x in left..right.min(pixels.width()) {
            let [red, green, blue, alpha] = pixels.get_pixel(x, y).0;
            if alpha < SOLID {
                continue;
            }
            // Rec. 601 luma, which is what "how light is it" means to an eye rather than to a
            // sum of channels: a saturated green reads far brighter than a saturated blue.
            light += 0.299 * f64::from(red) + 0.587 * f64::from(green) + 0.114 * f64::from(blue);
            texels += 1;
        }
    }
    (light, texels)
}

/// One look, with the slot it fills and what it looks like.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Printed {
    pub appearance_id: u32,
    /// Which place on the body it fills, as `ItemAppearance` numbers them. Kept beside the
    /// fingerprint because both the comparison and the cut are per slot — see the module note.
    pub display_type: u32,
    pub print: Fingerprint,
}

/// Every appearance of those display types, with what each of them looks like.
///
/// One walk, whatever is asked for, exactly as [`crate::shapes::sweep`] makes it:
/// [`crate::wardrobe::looks`] reads `ItemAppearance`, `ItemModifiedAppearance`, `Item` and
/// `ItemSparse` once for every kind named, and [`each`] then walks the display tables once for
/// the lot. The rows come back sorted by appearance, which is what makes the store the same
/// bytes twice.
#[tracing::instrument(name = "fingerprints.sweep", skip_all, fields(kinds = display_types.len()))]
pub fn sweep(
    files: &dyn GameFiles,
    body: &Body,
    display_types: &[u32],
) -> Result<Vec<Printed>, String> {
    let mut looks = crate::wardrobe::looks(files, display_types)?.found;
    looks.sort_by_key(|look| look.appearance_id);
    let pieces: Vec<Piece> = looks
        .iter()
        .map(|look| Piece {
            display_info_id: look.display_info_id,
            display_type: look.display_type,
            inventory_type: look.inventory_type,
        })
        .collect();
    Ok(each(files, body, &pieces)?
        .into_iter()
        .zip(&looks)
        .filter_map(|(print, look)| {
            Some(Printed {
                appearance_id: look.appearance_id,
                display_type: look.display_type,
                print: print?,
            })
        })
        .collect())
}

/* ---------- the cut ---------- */

/// How near two looks of one slot have to be before the second is worth offering for the first.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cut {
    /// The distance at or under which a pair is offered.
    pub near: f64,
    /// Where the middle of the same sample sat, which is the only thing that scales the number
    /// above. A cut is not a distance somebody chose, it is a quantile — and a cut that has
    /// crept up towards its own median is a slot this install can read too few pictures of to
    /// tell apart, which is a thing a reader doubting a suggestion should be able to see.
    pub median: f64,
    /// How many stranger pairs the two were taken over, which is what says whether to believe
    /// either. See [`FEWEST_PAIRS`].
    pub pairs: usize,
}

/// One slot's looks paired with looks they have no particular reason to resemble.
///
/// Arithmetic rather than random, because the store has to be the same bytes twice and a cut
/// taken off a different sample every run is a threshold nobody can reason about. Each look is
/// paired with the one [`STRIDE`] steps along modulo the slot, which is a gap that changes with
/// every row — a constant gap over rows sorted by appearance id would step in and out of the
/// recolour families the game files consecutively, and would measure that rather than the slot.
///
/// The pairs deliberately **include** the real recolours: a slot's strangers are the whole slot,
/// and the pairs this feature exists to find are in there among them. That is why the rate this
/// is cut at overstates the error rather than understating it.
fn stranger_pairs(rows: &[&Printed]) -> Vec<f64> {
    if rows.len() < 2 {
        return Vec::new();
    }
    (0..rows.len())
        .filter_map(|at| {
            let other = at.wrapping_mul(STRIDE).wrapping_add(OFFSET) % rows.len();
            if other == at {
                return None;
            }
            rows[at].print.distance(&rows[other].print)
        })
        .collect()
}

/// Where the nearest [`RANDOM_PAIR_RATE`] of a slot's strangers sit, or nothing where the slot
/// has too little to say.
///
/// **A cut that excludes nothing is not a cut.** A slot every look of which measures the same
/// distance from every other — a handful of tabards this install can read one picture of between
/// them — has nothing to say about which two of them are the same tabard, and a threshold at the
/// top of that distribution would hand the whole slot back as its own lookalikes. Silence is the
/// honest answer, exactly as it is for a size band whose thirds have collapsed.
///
/// Sorted by a total order rather than by `partial_cmp`, as [`crate::qualities::cuts`] is, so
/// that a distance that came out as `NaN` — which nothing here produces, but which a future
/// weighting could — sorts somewhere stated instead of poisoning the sort.
pub fn cut(distances: &[f64]) -> Option<Cut> {
    if distances.len() < FEWEST_PAIRS {
        return None;
    }
    let mut sorted = distances.to_vec();
    sorted.sort_by(f64::total_cmp);
    let at = ((sorted.len() as f64 * RANDOM_PAIR_RATE) as usize).min(sorted.len() - 1);
    let near = sorted[at];
    (near < sorted[sorted.len() - 1]).then_some(Cut {
        near,
        median: sorted[sorted.len() / 2],
        pairs: sorted.len(),
    })
}

/// The cut for each slot in a sweep, which is the header of the store.
pub fn cuts(rows: &[Printed]) -> BTreeMap<u32, Cut> {
    // Sorted before they are paired, and not merely grouped. [`stranger_pairs`] walks a slot in
    // the order it is handed, so a cut taken over the sweep's order would be a threshold that
    // moved when nothing about the game did — which is the one thing a cached store may not do.
    let mut sorted: Vec<&Printed> = rows.iter().collect();
    sorted.sort_by_key(|row| row.appearance_id);
    let mut per_slot: BTreeMap<u32, Vec<&Printed>> = BTreeMap::new();
    for row in sorted {
        per_slot.entry(row.display_type).or_default().push(row);
    }
    per_slot
        .iter()
        .filter_map(|(display_type, rows)| Some((*display_type, cut(&stranger_pairs(rows))?)))
        .collect()
}

/* ---------- the store ---------- */

/// The store as it is written, and as it is read back.
///
/// The rows are keyed by appearance and sorted, the cuts sit in the header where a slot's whole
/// threshold can be audited in two numbers, and the build is the install's own version string —
/// the same `12.0.5.67823` [`crate::qualities`] stamps into what it writes, and here the thing
/// that decides whether the file may be believed at all.
pub fn stored(build: &str, rows: &[Printed]) -> Value {
    let mut sorted: Vec<&Printed> = rows.iter().collect();
    sorted.sort_by_key(|row| row.appearance_id);
    let appearances: Vec<Value> = sorted
        .iter()
        .map(|row| {
            json!({
                "id": row.appearance_id,
                "displayType": row.display_type,
                "print": row.print.as_str(),
            })
        })
        .collect();
    json!({
        "build": build,
        "cuts": cuts(rows)
            .iter()
            .map(|(display_type, cut)| {
                (
                    display_type.to_string(),
                    json!({ "near": cut.near, "median": cut.median, "pairs": cut.pairs }),
                )
            })
            .collect::<serde_json::Map<String, Value>>(),
        "appearances": appearances,
    })
}

/// One look this store offers for another, and how alike the two are.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Near {
    pub appearance_id: u32,
    /// Between 0 and 1, and never above the slot's own cut. A number rather than a verdict:
    /// what the window does with it is draw it, and what a reader does with it is look.
    pub distance: f64,
}

/// A store read back: what each look looks like, and which others look like it.
pub struct Fingerprints {
    build: String,
    /// Every look, by appearance. A [`BTreeMap`] rather than a hash map so that anything walking
    /// the whole store walks it in a stated order.
    of: BTreeMap<u32, Printed>,
    /// The looks of each slot, appearance ids ascending — which is what a search walks, there
    /// being no index over a distance the way there is over an equality.
    per_slot: BTreeMap<u32, Vec<u32>>,
    cuts: BTreeMap<u32, Cut>,
}

impl Fingerprints {
    /// A store out of what [`stored`] wrote, or a complaint about what was found instead.
    pub fn read(text: &str) -> Result<Self, String> {
        let file: Value = serde_json::from_str(text)
            .map_err(|error| format!("the fingerprint store: {error}"))?;
        let build = file["build"]
            .as_str()
            .ok_or("the fingerprint store says no build.")?
            .to_string();
        let rows = file["appearances"]
            .as_array()
            .ok_or("the fingerprint store holds no appearances.")?;

        let mut of: BTreeMap<u32, Printed> = BTreeMap::new();
        let mut per_slot: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for row in rows {
            let number = |name: &str| row[name].as_u64().map(|number| number as u32);
            let (Some(appearance_id), Some(display_type), Some(print)) = (
                number("id"),
                number("displayType"),
                row["print"].as_str().and_then(Fingerprint::read),
            ) else {
                return Err(format!(
                    "the fingerprint store holds a row it cannot read: {row}"
                ));
            };
            per_slot
                .entry(display_type)
                .or_default()
                .push(appearance_id);
            of.insert(
                appearance_id,
                Printed {
                    appearance_id,
                    display_type,
                    print,
                },
            );
        }

        let mut cuts: BTreeMap<u32, Cut> = BTreeMap::new();
        for (display_type, held) in file["cuts"]
            .as_object()
            .ok_or("the fingerprint store holds no cuts.")?
        {
            let (Ok(display_type), Some(near), Some(median), Some(pairs)) = (
                display_type.parse::<u32>(),
                held["near"].as_f64(),
                held["median"].as_f64(),
                held["pairs"].as_u64(),
            ) else {
                return Err(format!(
                    "the fingerprint store holds a cut it cannot read: {display_type}"
                ));
            };
            cuts.insert(
                display_type,
                Cut {
                    near,
                    median,
                    pairs: pairs as usize,
                },
            );
        }

        Ok(Self {
            build,
            of,
            per_slot,
            cuts,
        })
    }

    /// Which build of the game these were read off.
    pub fn build(&self) -> &str {
        &self.build
    }

    /// How many looks it holds.
    pub fn len(&self) -> usize {
        self.of.len()
    }

    pub fn is_empty(&self) -> bool {
        self.of.is_empty()
    }

    /// Every look it holds, by appearance ascending.
    pub fn rows(&self) -> impl Iterator<Item = &Printed> {
        self.of.values()
    }

    /// What one look looks like, where this store knows it.
    pub fn of(&self, appearance_id: u32) -> Option<&Printed> {
        self.of.get(&appearance_id)
    }

    /// The cut this install measured for one slot, where it could measure one.
    pub fn cut(&self, display_type: u32) -> Option<Cut> {
        self.cuts.get(&display_type).copied()
    }

    /// The looks of the same slot that are at least as near as the slot's cut, nearest first.
    ///
    /// **The same slot and nothing else.** A grid says nothing about which garment it came off,
    /// so a belt and a chestpiece painting one rectangle of her in similar tones measure near
    /// each other for a reason that has nothing to do with either — which is the whole of why
    /// pooling the slots collapsed the measure. The cut is the slot's too.
    ///
    /// Empty for a look the store does not hold, and empty for a slot it could measure no cut
    /// for. Ties break on the appearance id, so the list is the same list twice.
    pub fn nearest(&self, appearance_id: u32, most: usize) -> Vec<Near> {
        let Some(row) = self.of(appearance_id) else {
            return Vec::new();
        };
        let (Some(cut), Some(slot)) = (
            self.cut(row.display_type),
            self.per_slot.get(&row.display_type),
        ) else {
            return Vec::new();
        };
        let mut found: Vec<Near> = slot
            .iter()
            .filter(|held| **held != appearance_id)
            .filter_map(|held| {
                let other = self.of.get(held)?;
                let distance = row.print.distance(&other.print)?;
                (distance <= cut.near).then_some(Near {
                    appearance_id: *held,
                    distance,
                })
            })
            .collect();
        found.sort_by(|left, right| {
            left.distance
                .total_cmp(&right.distance)
                .then(left.appearance_id.cmp(&right.appearance_id))
        });
        found.truncate(most);
        found
    }
}

/// The fingerprints of this install: out of the cache when it was written for this build, and by
/// measuring the game when it was not.
///
/// The same bargain [`crate::shapes::cached`] makes, at fifty times the price — a minute of
/// decoding rather than a second of walking tables — which is why the app runs this behind a
/// reader rather than in front of one. A build that does not match is not a store to patch up: a
/// patch repaints armour, and a thumbnail of a picture that has been repainted is wrong rather
/// than stale.
///
/// A cache that cannot be read is recomputed rather than reported, for the reason it is there:
/// there is nothing a reader could do about a corrupt file that this cannot do for them.
#[tracing::instrument(name = "fingerprints.cached", skip_all, fields(build = build))]
pub fn cached(
    files: &dyn GameFiles,
    body: &Body,
    build: &str,
    dir: &Path,
) -> Result<Fingerprints, String> {
    if let Some(held) = read_cache(dir).filter(|held| held.build() == build) {
        return Ok(held);
    }
    let swept = sweep(files, body, &PAINTED)?;
    // Laid out by `qualities::text` — one look to a line under a header that fits on one — for
    // the reason that store is: six megabytes on one line is a file nobody can look at when they
    // doubt what it says.
    let text = crate::qualities::text(&stored(build, &swept));
    write(dir, &dir.join(FILE), &text)?;
    Fingerprints::read(&text)
}

/// The store already on this machine, whatever build it was written for.
///
/// Separate from [`cached`] because the app asks the two different questions: a reader who has
/// opened the transmog view wants whatever is already there *now*, and the background task
/// behind them is the only thing that may spend a minute of the game's textures on the answer.
pub fn read_cache(dir: &Path) -> Option<Fingerprints> {
    std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|text| Fingerprints::read(&text).ok())
}

/// Writes the store whole or not at all — see [`PARTIAL`].
fn write(dir: &Path, path: &Path, text: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    let partial: PathBuf = dir.join(PARTIAL);
    std::fs::write(&partial, text).map_err(|error| format!("{}: {error}", partial.display()))?;
    std::fs::rename(&partial, path).map_err(|error| format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// The body every fingerprint here is taken on, which is the body a store is written for.
    fn hers() -> Body {
        crate::body::of(&fixture_files(), crate::body::DEFAULT).unwrap()
    }

    /// The fixture's displays, by what the generator made each of them.
    const CHESTPIECE: Piece = worn_piece(900_003, 3);
    const ROBE: Piece = worn_piece(900_012, 3);
    const BOOTS: Piece = worn_piece(900_004, 5);
    const CAPE: Piece = worn_piece(900_013, 9);
    const SHOULDERS: Piece = worn_piece(900_002, 1);
    /// A helm whose mesh names a picture this install holds no file for.
    const HELM: Piece = worn_piece(900_001, 0);
    /// A display in a section the game encrypts, so nothing can be read about it.
    const WITHHELD: Piece = worn_piece(900_900, 3);

    /// Three of the pictures the generator paints the fixture's armour with. The first two are
    /// one flat colour each and wildly different colours; the third is two bands.
    const FLAT_PURPLE: u32 = 151_004;
    const FLAT_TEAL: u32 = 151_005;
    const FLAT_ORANGE: u32 = 151_006;
    const BANDED: u32 = 151_002;
    /// And one no install here holds a file for at all.
    const MISSING: u32 = 151_900;

    const fn worn_piece(display_info_id: u32, display_type: u32) -> Piece {
        Piece {
            display_info_id,
            display_type,
            inventory_type: 0,
        }
    }

    fn print(piece: Piece) -> Option<Fingerprint> {
        of(&fixture_files(), &hers(), piece).unwrap()
    }

    fn places(piece: Piece) -> Vec<String> {
        print(piece)
            .expect("the fixture can be measured")
            .0
            .keys()
            .map(|place| place.word())
            .collect()
    }

    /* ---------- one picture ---------- */

    // The whole of what makes the measure colour-blind, on the game's own pictures: three of the
    // fixture's textures are one flat colour each — purple, teal, orange — and the three of them
    // reduce to the same grid, because what a grid holds is where a picture is lighter than
    // itself and a flat picture is nowhere lighter than itself.
    #[test]
    fn reduces_two_pictures_of_one_shape_and_two_colours_to_one_grid() {
        let files = fixture_files();
        let purple = grid_of(&files, FLAT_PURPLE).expect("the fixture holds it");
        assert_eq!(purple, grid_of(&files, FLAT_TEAL).unwrap());
        assert_eq!(purple, grid_of(&files, FLAT_ORANGE).unwrap());
    }

    // And the other half of that claim, which is the one that makes it worth anything: what is
    // *not* colour survives. The banded texture is light over dark, so its top half is set and
    // its bottom half is not.
    #[test]
    fn keeps_where_a_picture_is_lighter_than_itself() {
        let files = fixture_files();
        let banded = grid_of(&files, BANDED).expect("the fixture holds it");
        assert_ne!(banded, grid_of(&files, FLAT_PURPLE).unwrap());
        // Eight rows of sixteen, which is the top half of the grid and nothing else.
        assert_eq!(banded.0, [u64::MAX, u64::MAX, 0, 0]);
    }

    // A picture this install does not hold is not a grid of zeroes. It is the commonest thing in
    // the game — 3,915 textures of a shipping install will not decode — and written down as a
    // grid every one of them would be every other one's nearest neighbour.
    #[test]
    fn reduces_a_picture_it_cannot_read_to_nothing_at_all() {
        assert_eq!(grid_of(&fixture_files(), MISSING), None);
    }

    /* ---------- one look ---------- */

    // What a fingerprint is: one grid per picture the look paints, named by where it goes. The
    // chestpiece paints four rectangles of her and has four.
    #[test]
    fn names_one_place_per_picture_a_look_paints() {
        assert_eq!(places(CHESTPIECE), ["s0", "s1", "s3", "s4"]);
        assert_eq!(places(ROBE), ["s3", "s5", "s6"]);
        // The boots' third texture is section 8, which this layout has no rectangle for — and
        // which is a place all the same, because what the measure compares is pictures.
        assert_eq!(places(BOOTS), ["s6", "s7", "s8"]);
    }

    // The two slots that are not paint on her, and both are still pictures. A cloak's geometry is
    // the body's own and what an appearance supplies is the one sheet on it; a pair of pauldrons
    // hangs two meshes and paints each with a material of its own, which is two.
    #[test]
    fn takes_a_pauldrons_picture_off_its_mesh_and_a_cloaks_off_the_body() {
        assert_eq!(places(CAPE), ["c"]);
        assert_eq!(places(SHOULDERS), ["m0", "m1"]);
    }

    // A look this install can read nothing about has no fingerprint, for the reason a picture it
    // cannot read has no grid — and this is the case that produced the rule, an encrypted
    // display resolving to no texture at all rather than to an unreadable one.
    #[test]
    fn has_no_fingerprint_for_a_look_it_can_read_nothing_about() {
        assert_eq!(print(WITHHELD), None);
        assert_eq!(print(worn_piece(404_040, 3)), None);
        // And the third way, which is the one a real install produces four thousand times: the
        // display resolves, the picture it names is a file, and the file is not in this install.
        // A look with nothing readable on it is absent rather than blank — see [`grid_of`].
        assert_eq!(print(HELM), None);
    }

    // A batch is an optimisation and nothing else: every row of one is the answer that row would
    // have got alone, in the order it was asked for.
    #[test]
    fn answers_a_batch_exactly_as_it_answers_one_at_a_time() {
        let files = fixture_files();
        let batch = [CHESTPIECE, WITHHELD, ROBE, CAPE];
        assert_eq!(
            each(&files, &hers(), &batch).unwrap(),
            batch.iter().map(|piece| print(*piece)).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn asks_the_game_nothing_for_an_empty_batch() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            each(&DirFiles::new(temp.path()), &hers(), &[]).unwrap(),
            Vec::new()
        );
    }

    // The failure worth reporting rather than answering nothing over: a run that cannot open the
    // game's tables has not found fifty thousand blank looks, it has not started.
    #[test]
    fn says_so_when_the_tables_are_not_there() {
        let temp = tempfile::tempdir().unwrap();
        assert!(sweep(&DirFiles::new(temp.path()), &hers(), &PAINTED).is_err());
    }

    // Nothing carried in a hand is in the store at all. A weapon paints nothing on the body, so
    // its only picture is its mesh's UV atlas — which is not a picture of the sword, and measured
    // on a real install separates known recolours from strangers not at all. See the module note.
    #[test]
    fn sweeps_the_places_on_the_body_and_nothing_carried_in_a_hand() {
        let held: Vec<u32> = sweep(&fixture_files(), &hers(), &PAINTED)
            .unwrap()
            .iter()
            .map(|row| row.display_type)
            .filter(|display_type| *display_type > 10)
            .collect();
        assert_eq!(held, Vec::<u32>::new());
        assert!(!PAINTED.contains(&11), "a weapon is not fingerprinted");
    }

    /* ---------- the measure ---------- */

    /// A fingerprint written out by hand, so that a claim about the ranking is a claim about the
    /// ranking rather than about which pictures the fixture happens to hold.
    ///
    /// One grid a place, each a run of set cells followed by clear ones — so two of them differ
    /// in exactly the number of cells their arguments differ by, which is what makes a distance
    /// below a stated number rather than a measured one.
    fn made(places: &[(&str, u32)]) -> Fingerprint {
        let text = places
            .iter()
            .map(|(place, set)| {
                let mut words = [0u64; WORDS];
                for cell in 0..*set as usize {
                    words[cell / 64] |= 1 << (cell % 64);
                }
                format!("{place}:{}", Grid(words).hex())
            })
            .collect::<Vec<String>>()
            .join("|");
        Fingerprint::read(&text).expect("a fingerprint this wrote is one it can read")
    }

    // Nought is the same picture and one is its negative, and the scale between them is the
    // share of the cells the two disagree about.
    #[test]
    fn measures_how_many_of_the_cells_two_looks_disagree_about() {
        let one = made(&[("s3", 128)]);
        assert_eq!(one.distance(&one), Some(0.0));
        assert_eq!(one.distance(&made(&[("s3", 0)])), Some(0.5));
        assert_eq!(one.distance(&made(&[("s3", 256)])), Some(0.5));
        assert_eq!(
            made(&[("s3", 0)]).distance(&made(&[("s3", 256)])),
            Some(1.0)
        );
    }

    // Over the places both of them paint and nothing else. A robe and a breastplate share a
    // torso and disagree about legs the breastplate never touches, and counting those against it
    // would be scoring a garment for what it is not.
    #[test]
    fn measures_only_the_places_both_looks_paint() {
        let robe = made(&[("s3", 64), ("s5", 0), ("s6", 0)]);
        let breastplate = made(&[("s3", 64), ("s0", 256)]);
        assert_eq!(robe.distance(&breastplate), Some(0.0));
    }

    // And two looks with no place in common are not near or far, they are incomparable — which
    // is nothing rather than the 1.0 that would sort them behind every real answer.
    #[test]
    fn refuses_to_measure_two_looks_that_paint_nothing_in_common() {
        assert_eq!(made(&[("c", 8)]).distance(&made(&[("s2", 8)])), None);
    }

    // The store's own grammar, written down where it can fail: a store is read back by a later
    // run of this code, so the text of a fingerprint is the compatibility surface between them.
    #[test]
    fn writes_a_fingerprint_as_a_grid_a_place_in_a_stated_order() {
        let print = made(&[("s4", 1), ("m0", 0), ("c", 0)]);
        let zeroes = "0".repeat(64);
        assert_eq!(
            print.as_str(),
            format!("m0:{zeroes}|s4:{}|c:{zeroes}", Grid([1, 0, 0, 0]).hex()),
        );
        assert_eq!(Fingerprint::read(&print.as_str()), Some(print));
    }

    #[test]
    fn refuses_text_that_is_not_a_fingerprint() {
        assert_eq!(Fingerprint::read(""), None);
        assert_eq!(Fingerprint::read("s3"), None);
        assert_eq!(Fingerprint::read("s3:beef"), None);
        assert_eq!(Fingerprint::read(&format!("x3:{}", "0".repeat(64))), None);
    }

    /* ---------- the cut ---------- */

    #[test]
    fn cuts_a_slot_where_its_nearest_strangers_sit() {
        let cut = cut(&[0.9, 0.1, 0.5, 0.7, 0.6]).expect("five is a distribution");
        assert_eq!((cut.near, cut.median, cut.pairs), (0.1, 0.6, 5));
    }

    // A slot of two looks has no distribution of strangers: its one pair is its nearest pair
    // whatever it measures, and a cut taken there says only that something was nearest.
    #[test]
    fn cuts_nothing_off_a_slot_with_too_few_looks_to_say() {
        assert_eq!(cut(&[]), None);
        assert_eq!(cut(&[0.1, 0.9]), None);
    }

    // And a slot every pair of which measures the same has nothing to say either. A cut at the
    // top of that distribution excludes nothing and would hand the whole slot back as its own
    // lookalikes, which is worse than saying nothing.
    #[test]
    fn cuts_nothing_off_a_slot_whose_pairs_all_measure_the_same() {
        assert_eq!(cut(&[0.4, 0.4, 0.4, 0.4, 0.4]), None);
    }

    /* ---------- the store ---------- */

    fn printed(appearance_id: u32, display_type: u32, places: &[(&str, u32)]) -> Printed {
        Printed {
            appearance_id,
            display_type,
            print: made(places),
        }
    }

    /// A slot of chestpieces: two that are the same garment in two colours, and four strangers
    /// spread far enough apart that the slot has a distribution to cut.
    fn slot() -> Vec<Printed> {
        vec![
            printed(1, 3, &[("s3", 100)]),
            printed(2, 3, &[("s3", 100)]),
            printed(3, 3, &[("s3", 20)]),
            printed(4, 3, &[("s3", 180)]),
            printed(5, 3, &[("s3", 250)]),
            printed(6, 3, &[("s3", 0)]),
            // A belt, which is a different slot and is never compared against any of them.
            printed(7, 4, &[("s3", 100)]),
        ]
    }

    fn store(rows: &[Printed]) -> Fingerprints {
        Fingerprints::read(&crate::qualities::text(&stored("fixtures", rows))).unwrap()
    }

    // What the module is for. The recolour is offered first and at nought, and the strangers
    // that the slot's own cut puts outside it are not offered at all.
    #[test]
    fn offers_the_same_garment_in_another_colour_ahead_of_the_field() {
        let nearest = store(&slot()).nearest(1, 8);
        assert_eq!(
            nearest
                .first()
                .map(|near| (near.appearance_id, near.distance)),
            Some((2, 0.0)),
        );
        assert!(!nearest.iter().any(|near| near.appearance_id == 6));
    }

    // The slot and nothing else. A grid says nothing about which garment it came off, so a belt
    // painting one rectangle of her in the same tones as a chestpiece measures nought away from
    // it — which is the whole of why pooling the slots collapsed the measure.
    #[test]
    fn never_offers_a_look_from_another_slot() {
        let found = store(&slot()).nearest(1, 8);
        assert!(
            !found.iter().any(|near| near.appearance_id == 7),
            "{found:?}"
        );
    }

    // A slot the install could measure no cut for is a slot this says nothing about, rather than
    // one whose nearest is offered on no evidence.
    #[test]
    fn offers_nothing_for_a_slot_it_could_cut_no_threshold_for() {
        let store = store(&slot());
        assert_eq!(store.cut(4), None);
        assert_eq!(store.nearest(7, 8), Vec::new());
        // And nothing at all for a look it does not hold.
        assert_eq!(store.nearest(404, 8), Vec::new());
    }

    #[test]
    fn offers_no_more_than_it_was_asked_for() {
        assert_eq!(store(&slot()).nearest(1, 1).len(), 1);
    }

    // The same install measured twice is the same store, and the order the rows were swept in is
    // not the order they are written in: a cache that moves when the game did not is one nobody
    // can reason about, and one the reader would recompute for nothing.
    #[test]
    fn writes_the_same_bytes_for_the_same_install_however_the_rows_arrived() {
        let mut backwards = slot();
        backwards.reverse();
        assert_eq!(
            crate::qualities::text(&stored("fixtures", &backwards)),
            crate::qualities::text(&stored("fixtures", &slot())),
        );
    }

    #[test]
    fn writes_a_row_a_look_and_a_cut_a_slot_under_the_build_it_read() {
        let file = stored("12.0.5.67823", &slot());
        assert_eq!(file["build"], "12.0.5.67823");
        assert_eq!(file["appearances"][0]["id"], 1);
        assert_eq!(file["appearances"][0]["displayType"], 3);
        assert_eq!(file["cuts"]["3"]["pairs"], 6);
        assert_eq!(file["cuts"].as_object().unwrap().len(), 1, "{file}");
    }

    #[test]
    fn reads_back_what_it_wrote() {
        let store = store(&slot());
        assert_eq!(store.build(), "fixtures");
        assert_eq!(store.len(), slot().len());
        assert_eq!(
            store
                .rows()
                .map(|row| row.appearance_id)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 6, 7],
        );
        assert_eq!(store.of(1).map(|row| row.display_type), Some(3));
    }

    #[test]
    fn refuses_a_store_it_cannot_read_whole() {
        assert!(Fingerprints::read("not json at all").is_err());
        assert!(Fingerprints::read(&json!({ "appearances": [] }).to_string()).is_err());
        assert!(Fingerprints::read(&json!({ "build": "12.0" }).to_string()).is_err());
        assert!(Fingerprints::read(
            &json!({ "build": "12.0", "cuts": {}, "appearances": [{ "id": 1 }] }).to_string()
        )
        .is_err());
        assert!(Fingerprints::read(
            &json!({ "build": "12.0", "cuts": { "3": {} }, "appearances": [] }).to_string()
        )
        .is_err());
    }

    /* ---------- the cache ---------- */

    /// Files that answer nothing, which is what a machine with no game on it is.
    fn no_game() -> DirFiles {
        DirFiles::new(Path::new("/nowhere/there/is/no/game"))
    }

    // The bargain the cache makes, and the reason there is one: the sweep behind it is a minute
    // of decoding on a real install. The second run here is handed files that hold nothing at
    // all and still comes back with the whole store.
    #[test]
    fn measures_the_game_once_and_reads_the_file_after_that() {
        let temp = tempfile::tempdir().unwrap();
        let first = cached(&fixture_files(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        assert!(!first.is_empty());

        let again = cached(&no_game(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        assert_eq!(again.build(), "12.0.5.67823");
        assert_eq!(again.len(), first.len());
    }

    // And the one thing that ends it. A patch repaints armour, so a thumbnail of a picture that
    // has been repainted is wrong rather than stale, and the game is what it is replaced from.
    #[test]
    fn measures_the_game_again_when_the_build_has_moved() {
        let temp = tempfile::tempdir().unwrap();
        cached(&fixture_files(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        assert!(cached(&no_game(), &hers(), "12.0.6.70000", temp.path()).is_err());

        let after = cached(&fixture_files(), &hers(), "12.0.6.70000", temp.path()).unwrap();
        assert_eq!(after.build(), "12.0.6.70000");
    }

    // A half-written file is the failure a reader cannot see: it parses as far as it goes, and
    // every look past the cut then answers "nothing in the game looks like this".
    #[test]
    fn recomputes_a_cache_it_cannot_read_rather_than_believing_half_of_it() {
        let temp = tempfile::tempdir().unwrap();
        let whole = cached(&fixture_files(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        let path = temp.path().join(FILE);
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, &text[..text.len() / 2]).unwrap();

        let again = cached(&fixture_files(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        assert_eq!(again.len(), whole.len());
        assert!(!temp.path().join(PARTIAL).exists());
    }

    // What the window asks between the reader opening the view and the background sweep
    // finishing: whatever is already on this machine, and never a minute of the game's textures.
    #[test]
    fn reads_whatever_is_already_on_the_machine_without_measuring_anything() {
        let temp = tempfile::tempdir().unwrap();
        assert!(read_cache(temp.path()).is_none());
        cached(&fixture_files(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        assert_eq!(
            read_cache(temp.path()).map(|held| held.build().to_string()),
            Some("12.0.5.67823".to_string()),
        );
    }
}
