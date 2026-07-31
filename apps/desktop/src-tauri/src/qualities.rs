//! What a look is *like*, worked out from the game's own pictures rather than from its words.
//!
//! Everything else this app reads about an appearance is something the game wrote down: a name,
//! a slot, a class mask, an icon. None of it answers the two questions a reader browsing five
//! thousand chestpieces actually has — **what colour is it** and **how big is it** — because the
//! game never wrote those down anywhere. They are properties of the pixels and of the mesh, and
//! the only way to have them is to go and measure them.
//!
//! So this module measures them, and it is deliberately the *only* place that does. What comes
//! out is not shipped to the window from a running install: `examples/dump_qualities` runs this
//! over a whole install once, writes the answers into `apps/desktop/data/qualities/`, and those
//! files are committed. A reader with no game on the machine still gets the colours, and the
//! app pays nothing at startup for them. That is the whole shape of the feature — see
//! `qualities.ts` for the other end of it.
//!
//! Two consequences of "committed" run through everything below.
//!
//! **It has to be deterministic.** The same install has to produce the same bytes, or the store
//! is a file that churns every time somebody regenerates it and nobody can read a diff. Every
//! map that feeds an answer here is a [`BTreeMap`] and every tie is broken by something stated
//! rather than by iteration order, which is why the histogram is not a `HashMap`.
//!
//! **It is measured on one body.** Which textures a piece of armour resolves to is a question
//! `ComponentTextureFileData` answers per race and sex, and how much of a body a section is is
//! the layout's answer and differs between the two — so a look measured on him and on her is two
//! measurements. The store is one file, so it is the default body's: see [`crate::body::DEFAULT`].
//! That is the body gear is authored to look right on and the one every reader is shown until
//! they say otherwise.
//!
//! **It has to say what it measured.** A helm has geometry and a chestpiece does not, so "how
//! big" is answered two different ways — the bounding box of a mesh, and how much of the body a
//! set of textures actually paints. Those two numbers share no units and must never be compared,
//! which is why [`Size`] carries [`By`] and why the bands are cut per measure. *Relative* size is
//! all this can honestly offer: a dagger is small against staves, not against boots.

use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Value};

use crate::body::Body;
use crate::casc::GameFiles;
use crate::icons::pixels_of;
use crate::m2::{Model, Paint};
use crate::worn::{self, Piece};

/// The largest texture worth reading, a side at a time — the bound the rest of the app puts on
/// anything it decodes, and here a sign that a lookup landed somewhere unintended.
const LARGEST_TEXTURE: u32 = 2048;

/// How coarsely colours are gathered before they are counted: the top four bits of each channel.
///
/// Sixteen levels a channel, so 4,096 buckets. Fine enough that a red pauldron and its brown
/// straps are counted apart, coarse enough that the two thousand shades of one leather texture
/// are counted together — which is the entire job, since counting exact RGB triples over a
/// photograph-like texture returns two thousand buckets of one pixel each and no majority.
const BUCKET: u8 = 0xf0;

/// How far apart two colours have to be before the second is worth calling an accent.
///
/// Stated as a squared distance in RGB so nothing takes a square root per bucket. 96 per the
/// straight line, which is about the distance from a mid brown to the gold on it — below that,
/// the "accent" is the shading on the primary and saying so twice tells a reader nothing.
const APART: i64 = 96 * 96;

/// A pixel too see-through to be part of what the piece looks like.
///
/// Armour textures are authored into a rectangle the size of the whole limb and most of that
/// rectangle is empty — a bracer is a band across an arm-sized sheet. Counting the empty half
/// would make every piece in the game the same colour, which is whatever the format leaves in
/// its transparent texels.
const SOLID: u8 = 128;

/// How much of the body a cloak that fills its sheet counts as covering.
///
/// A cloak is the one slot whose "model" is geometry the body already carries, so it paints no
/// [`crate::worn::ComponentTexture`] and would otherwise measure as covering none of her. What
/// differs between two cloaks is how much of a fixed sheet the texture fills, so the sheet is
/// given a share of the body and the opaque fraction does the rest. A quarter is a stated
/// nominal — `CharComponentTextureSections` holds no rectangle for a cape at all — and it is
/// only ever compared against other cloaks, which is what makes a nominal good enough here.
const CAPE_SHARE: f64 = 0.25;

/// The sections a piece of armour paints, and what the whole of them comes to.
///
/// The body from the scalp down without the scalp: 0 to 7 are the two halves of the arms, the
/// hands, the two halves of the torso, the two halves of the legs and the feet. 8 is the
/// accessory, which neither Human layout has a rectangle for at all, and 9 and 10 are the
/// scalp, which is under a helm — and a helm has a mesh, so it never reaches this measure.
const BODY_SECTIONS: [u32; 8] = [0, 1, 2, 3, 4, 5, 6, 7];

/// A colour, as the three channels a reader sees. Alpha is not part of what a thing looks like.
pub type Colour = [u8; 3];

/// Which way an appearance's size was arrived at.
///
/// **The two are not comparable and nothing may compare them.** A [`By::Geometry`] measure is in
/// the model's own units and a [`By::Cover`] measure is a fraction of the body's atlas; a helm
/// and a chestpiece put side by side would order by which method answered rather than by size.
/// [`cuts`] is taken per measure, which is what keeps that from happening.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum By {
    /// The longest side of the mesh's bounding box — a helm, a pauldron, anything held.
    Geometry,
    /// How much of the body the textures actually paint, as a fraction of it.
    Cover,
}

impl By {
    /// What the store calls it, which is also what the window reads back.
    pub fn word(self) -> &'static str {
        match self {
            By::Geometry => "geometry",
            By::Cover => "cover",
        }
    }
}

/// How big an appearance is, and by which of the two readings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub by: By,
    pub of: f64,
}

/// Everything measured about one look.
///
/// The accent and the size are both optional and for the same reason: a texture of one flat
/// colour has no second colour to name, and an appearance whose every texture this install
/// withholds has no mesh and no pixels to measure. Neither is a failure — a row saying only
/// "brown" is worth more than a row saying nothing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Look {
    pub primary: Colour,
    pub accent: Option<Colour>,
    pub size: Option<Size>,
}

/// What one appearance looks like, measured out of the pictures the game paints it with.
///
/// A batch of one, and it goes through [`each`] like any other — see there for why a batch is
/// the unit.
pub fn of(files: &dyn GameFiles, body: &Body, piece: Piece) -> Result<Option<Look>, String> {
    Ok(each(files, body, &[piece])?
        .pop()
        .expect("one piece in, one answer out"))
}

/// The same, for a batch, sharing every table and every texture between its rows.
///
/// A batch rather than a loop for the reason every other read in this app is batched:
/// [`crate::worn::each`] walks `ItemDisplayInfoMaterialRes`, `TextureFileData` and three more
/// tables once for whatever it is handed, and [`crate::db2::Db2::rows`] materialises a whole
/// table before it yields the first row. Asked one appearance at a time, a run over the game's
/// fifty-five thousand looks would walk six hundred thousand rows fifty-five thousand times.
///
/// The textures are shared too, which matters more here than it looks: the game sells one look
/// as a dozen items and a dozen looks off one recoloured sheet, so a batch of a few hundred
/// neighbouring appearances decodes considerably fewer than a few hundred textures.
///
/// `None` for a row is the ordinary answer whenever the install can say nothing: the game
/// encrypts the displays of content it has not shipped, and an appearance whose only texture was
/// painted for another body resolves to nothing at all.
#[tracing::instrument(name = "qualities.each", skip_all, fields(pieces = pieces.len()))]
pub fn each(
    files: &dyn GameFiles,
    body: &Body,
    pieces: &[Piece],
) -> Result<Vec<Option<Look>>, String> {
    if pieces.is_empty() {
        return Ok(Vec::new());
    }

    // One outfit per piece: nothing measured here is ever worn beside anything else, so there is
    // nothing for the draw order or the priority table to settle. What the pieces share is the
    // tables underneath, which is the whole reason this is one call.
    let alone: Vec<&[Piece]> = pieces.iter().map(std::slice::from_ref).collect();
    let worn = worn::each(files, body, &alone)?;

    let mut textures: HashMap<u32, Option<Painted>> = HashMap::new();
    let mut meshes: HashMap<u32, Option<Modelled>> = HashMap::new();

    let mut looks = Vec::with_capacity(pieces.len());
    for worn in &worn {
        let mut gathered = Gathered::over(body);

        // What it hangs off her, which is both where its size comes from and — for a helm or a
        // weapon, whose textures are the model's own — where the whole of its colour does.
        //
        // Gathered before any of it is read, because what each texture is worth depends on how
        // much of the mesh it is painted on and that is only known once every part of every
        // model the appearance hangs has been counted.
        let mut hung: Vec<(u32, u64)> = Vec::new();
        for model in &worn.models {
            let held = meshes
                .entry(model.file)
                .or_insert_with(|| modelled(files, model.file));
            let Some(held) = held.as_ref() else {
                continue;
            };
            gathered.extent = gathered.extent.max(held.extent);
            for (paint, indices) in &held.paints {
                // A part asking for whatever the item supplies gets the appearance's own
                // material, which is what makes one helm mesh serve every recolour of it.
                if let Some(file) = paint.or(model.texture) {
                    hung.push((file, *indices));
                }
            }
        }
        let mesh: u64 = hung.iter().map(|(_, indices)| indices).sum();
        for (file, indices) in hung {
            let share = indices as f64 / mesh as f64;
            gathered.paint(files, &mut textures, file, Weight::Mesh(share));
        }

        // And what it paints onto her, which is the whole of a chestpiece and none of a sword.
        for texture in &worn.textures {
            if let Some(area) = body.area_of(texture.section) {
                gathered.paint(
                    files,
                    &mut textures,
                    texture.file,
                    Weight::Body(f64::from(area)),
                );
            }
        }
        if let Some(cape) = worn.cape {
            gathered.paint(
                files,
                &mut textures,
                cape,
                Weight::Body(gathered.whole * CAPE_SHARE),
            );
        }

        looks.push(gathered.look());
    }
    Ok(looks)
}

/// What one texture is worth to the appearance it belongs to.
///
/// Both arms of this end up as a share of the appearance — a number that the whole of it sums to
/// roughly one of — and that is the entire reason the enum exists. A mesh's textures and a body's
/// are counted in units that have nothing to do with each other, and a helm that both hangs a
/// mesh and paints the scalp would otherwise have its colour decided by whichever unit happened
/// to be larger.
#[derive(Debug, Clone, Copy)]
enum Weight {
    /// This much of the mesh is painted with it, as a fraction of every mesh the appearance
    /// hangs.
    Mesh(f64),
    /// It is painted into a rectangle of the body this many atlas pixels across — of which it is
    /// worth however much of that rectangle it actually fills.
    Body(f64),
}

/// One appearance's measurements as they are being collected, before they are a [`Look`].
#[derive(Default)]
struct Gathered {
    /// Every colour seen, quantised to [`BUCKET`], with how much of the appearance is that
    /// colour and what those texels add up to — so the colour reported is the average of the
    /// bucket rather than the corner of it.
    buckets: BTreeMap<Colour, (f64, [f64; 3])>,
    /// The longest side of the largest mesh it hangs, in the model's own units.
    extent: f64,
    /// How much of the body its textures actually paint, in atlas pixels.
    covered: f64,
    /// How much body there is to cover, which is this body's layout's answer and not another's:
    /// her atlas is 2048 wide and his 1024, so the same section is four times the pixels on her.
    whole: f64,
}

impl Gathered {
    /// An empty collection, ready to measure something against one body.
    fn over(body: &Body) -> Self {
        Self {
            whole: BODY_SECTIONS
                .iter()
                .filter_map(|section| body.area_of(*section))
                .map(f64::from)
                .sum(),
            ..Self::default()
        }
    }
}

impl Gathered {
    /// Reads one texture into the collection, decoding it if this batch has not already.
    ///
    /// The whole of the texture is worth `weight` between them, however many texels it holds:
    /// what a texture says about an appearance is how much of the appearance is painted with
    /// it, and that has nothing to do with the resolution it was authored at. A 512-pixel
    /// bracer sheet counted texel for texel against a 256-pixel chestpiece sheet would make
    /// every set of armour in the game the colour of its wrists.
    fn paint(
        &mut self,
        files: &dyn GameFiles,
        decoded: &mut HashMap<u32, Option<Painted>>,
        file: u32,
        weight: Weight,
    ) {
        let held = decoded.entry(file).or_insert_with(|| painted(files, file));
        let Some(held) = held.as_ref() else {
            return;
        };
        let share = match weight {
            Weight::Mesh(share) => share,
            // What it fills of the rectangle it lands in, as a fraction of the whole body — so a
            // legging that fills its sheet says more about the appearance than a garter that
            // fills a tenth of the same sheet, which is exactly the difference between them.
            Weight::Body(area) => {
                self.covered += held.solid * area;
                held.solid * area / self.whole
            }
        };
        if !share.is_finite() || share <= 0.0 {
            return;
        }
        for (colour, (count, sum)) in &held.buckets {
            let each = share / held.counted;
            let held = self.buckets.entry(*colour).or_insert((0.0, [0.0; 3]));
            held.0 += count * each;
            for (into, channel) in held.1.iter_mut().zip(sum) {
                *into += channel * each;
            }
        }
    }

    /// What was measured, as an answer — or nothing at all, where nothing could be read.
    fn look(self) -> Option<Look> {
        let primary = self.primary()?;
        Some(Look {
            primary,
            accent: self.accent(primary),
            size: self.size(),
        })
    }

    /// The colour most of it is, which is the fullest bucket averaged out.
    ///
    /// Ties go to the lowest colour rather than to whichever the map happened to yield, because
    /// two textures of a recoloured pair can genuinely tie and the store has to be the same
    /// bytes twice.
    fn primary(&self) -> Option<Colour> {
        let (_, (count, sum)) =
            self.buckets
                .iter()
                .max_by(|(left, (mine, _)), (right, (theirs, _))| {
                    // The fuller bucket wins, and where two are equally full the lower colour does — so
                    // the tie is broken by something stated rather than by where the iteration ended up.
                    mine.total_cmp(theirs).then_with(|| right.cmp(left))
                })?;
        Some(average(*count, *sum))
    }

    /// The fullest colour that is not a shade of the primary, where there is one.
    ///
    /// Descending by how much of the piece is that colour, so the accent is the second thing a
    /// reader would name and not merely the furthest-off pixel in the texture — a single stray
    /// highlight is the wrong answer to "and what else is it".
    fn accent(&self, primary: Colour) -> Option<Colour> {
        let mut ordered: Vec<(&Colour, &(f64, [f64; 3]))> = self.buckets.iter().collect();
        ordered.sort_by(|(left, (mine, _)), (right, (theirs, _))| {
            theirs.total_cmp(mine).then_with(|| left.cmp(right))
        });
        ordered
            .into_iter()
            .map(|(_, (count, sum))| average(*count, *sum))
            .find(|colour| apart(primary, *colour) >= APART)
    }

    /// How big it is, by whichever of the two readings this appearance admits.
    ///
    /// Geometry wins where there is any: a helm both hangs a mesh and can paint the scalp, and
    /// the mesh is the thing a reader means by the size of a helm. A measure of zero is not an
    /// answer — a mesh of no extent, or textures that paint nowhere at all — so it is dropped
    /// rather than reported as the smallest thing in the game.
    fn size(&self) -> Option<Size> {
        if self.extent > 0.0 {
            return Some(Size {
                by: By::Geometry,
                of: self.extent,
            });
        }
        let covered = self.covered / self.whole;
        (covered > 0.0 && covered.is_finite()).then_some(Size {
            by: By::Cover,
            of: covered,
        })
    }
}

/// One texture, counted: what colours are in it and how much of it is there at all.
struct Painted {
    /// Its solid texels by colour, quantised to [`BUCKET`], with what each bucket's texels add
    /// up to. Counted in texels here and turned into a share of the appearance by
    /// [`Gathered::paint`], which is the only place that knows what this texture is worth.
    buckets: BTreeMap<Colour, (f64, [f64; 3])>,
    /// How many texels those buckets hold between them.
    counted: f64,
    /// The fraction of its texels that are solid enough to be seen — which is what says whether
    /// a sheet the size of a leg holds a legging or a garter.
    solid: f64,
}

/// Decodes one texture and counts it, or nothing where this install cannot show it.
///
/// Nothing is ordinary and stays quiet: the game withholds what it has not shipped, an install
/// can be missing a file an appearance names, and a texture in an encoding this build cannot
/// read is the same story from the row's point of view.
fn painted(files: &dyn GameFiles, file: u32) -> Option<Painted> {
    let pixels = files
        .read(file)
        .and_then(|blp| pixels_of(&blp, LARGEST_TEXTURE))
        .ok()?;
    let mut buckets: BTreeMap<Colour, (f64, [f64; 3])> = BTreeMap::new();
    let mut solid = 0u64;
    for pixel in pixels.pixels() {
        let [red, green, blue, alpha] = pixel.0;
        if alpha < SOLID {
            continue;
        }
        solid += 1;
        let held = buckets
            .entry([red & BUCKET, green & BUCKET, blue & BUCKET])
            .or_insert((0.0, [0.0; 3]));
        held.0 += 1.0;
        held.1[0] += f64::from(red);
        held.1[1] += f64::from(green);
        held.1[2] += f64::from(blue);
    }
    let texels = u64::from(pixels.width()) * u64::from(pixels.height());
    (solid > 0).then(|| Painted {
        buckets,
        counted: solid as f64,
        solid: solid as f64 / texels as f64,
    })
}

/// One mesh, measured: how long its longest side is and what each part of it is painted with.
struct Modelled {
    extent: f64,
    /// Every part of it, as the texture it asks for and how many indices the part holds.
    ///
    /// `None` is the part asking for whatever the item supplies, which is what makes one helm
    /// mesh serve every recolour of it — the caller is the only one who knows which item this
    /// is. The index count is how much of the mesh that part is, which is what says whether a
    /// texture is the sword or the gem in its pommel.
    paints: Vec<(Option<u32>, u64)>,
}

/// Reads one `.m2` and its skin profile, or nothing where the install holds neither.
///
/// A model that is there and will not parse is dropped too, which is the one place this differs
/// from [`crate::models::each`] — that answers a reader who asked to look at the thing, and this
/// is a sweep over the whole game writing a file. One unreadable mesh in fifty-five thousand
/// should cost that row its size, not the run.
fn modelled(files: &dyn GameFiles, file: u32) -> Option<Modelled> {
    let bytes = files.read(file).ok()?;
    let model = Model::parse(&bytes).ok()?;
    // Both the geometry and the parts are in the skin profile's own reading of the model, so a
    // model whose skin this install does not hold is a model nothing can be measured of.
    let mesh = model
        .skin_file_data_id()
        .and_then(|skin| files.read(skin).ok())
        .and_then(|skin| model.with_skin(&skin).ok())?;
    Some(Modelled {
        extent: longest(&mesh.vertices),
        paints: mesh
            .parts
            .iter()
            .map(|part| {
                let file = match part.paint {
                    Paint::File(file) => Some(file),
                    // An item's model only ever asks for the one thing, which is the material
                    // its own `ItemDisplayInfo` row names. Only a character declares several.
                    Paint::Supplied(_) => None,
                };
                (file, part.indices.len() as u64)
            })
            .collect(),
    })
}

/// The longest side of the box a set of vertices fits in.
///
/// The longest side rather than the diagonal or the volume, because it is the one that matches
/// what a reader means: a staff is large because it is long, and a greatsword is large next to a
/// dagger for the same reason and by the same axis.
fn longest(vertices: &[crate::m2::Vertex]) -> f64 {
    let mut low = [f32::INFINITY; 3];
    let mut high = [f32::NEG_INFINITY; 3];
    for vertex in vertices {
        for axis in 0..3 {
            low[axis] = low[axis].min(vertex.position[axis]);
            high[axis] = high[axis].max(vertex.position[axis]);
        }
    }
    (0..3)
        .map(|axis| high[axis] - low[axis])
        .filter(|side| side.is_finite())
        .map(f64::from)
        .fold(0.0, f64::max)
}

/// A bucket's colour: what its texels average to, rounded.
fn average(count: f64, sum: [f64; 3]) -> Colour {
    [
        (sum[0] / count).round() as u8,
        (sum[1] / count).round() as u8,
        (sum[2] / count).round() as u8,
    ]
}

/// How far apart two colours are, squared, so nothing takes a root to compare them.
fn apart(left: Colour, right: Colour) -> i64 {
    (0..3)
        .map(|channel| i64::from(left[channel]) - i64::from(right[channel]))
        .map(|difference| difference * difference)
        .sum()
}

/// A colour as the store writes it, which is what CSS reads back.
pub fn hex(colour: Colour) -> String {
    format!("#{:02x}{:02x}{:02x}", colour[0], colour[1], colour[2])
}

/* ---------- the store ---------- */

/// The three words a size is reported as, smallest first.
pub const BANDS: [&str; 3] = ["small", "medium", "large"];

/// Where the two cuts between the bands fall for one way of measuring.
///
/// A third of the rows below the first and a third above the second, which is what makes the
/// answer *relative*: there is no absolute number of metres that makes a helm large, and every
/// attempt to write one down is a constant that a patch full of new tabards invalidates. What
/// there is, is the game's own distribution of that slot — and a third of it either side.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cuts {
    pub small: f64,
    pub large: f64,
    /// How many rows the cuts were taken over, which is the one thing that says whether to
    /// believe them: two staves make a distribution of two.
    pub rows: usize,
}

/// The thirds of a set of measurements, in the order they were handed over.
///
/// Sorted here rather than by the caller, and by a total order rather than by `partial_cmp`,
/// so that a measurement that came out as `NaN` — which nothing here produces, but a mesh of
/// one degenerate vertex could — sorts somewhere stated instead of poisoning the sort.
pub fn cuts(measures: &[f64]) -> Option<Cuts> {
    if measures.is_empty() {
        return None;
    }
    let mut sorted = measures.to_vec();
    sorted.sort_by(f64::total_cmp);
    let at =
        |fraction: f64| sorted[((sorted.len() as f64 * fraction) as usize).min(sorted.len() - 1)];
    Some(Cuts {
        small: at(1.0 / 3.0),
        large: at(2.0 / 3.0),
        rows: sorted.len(),
    })
}

/// Which band a measurement falls in, given the cuts for the way it was measured.
///
/// **Cuts that have collapsed onto each other are no cuts at all.** A slot where two thirds of
/// the rows measure the same — every cloak in the game covering exactly as much of her as every
/// other — has nothing to say about which of them is large, and splitting it at a value half of
/// it is equal to would hand out words at random. Medium throughout is the honest answer, and a
/// band nobody can act on beats one that is wrong.
pub fn band(of: f64, cuts: Cuts) -> &'static str {
    if cuts.small >= cuts.large {
        return BANDS[1];
    }
    if of < cuts.small {
        return BANDS[0];
    }
    if of >= cuts.large {
        return BANDS[2];
    }
    BANDS[1]
}

/// One slot's whole file, as `examples/dump_qualities` writes it and `qualities.ts` reads it.
///
/// The rows are keyed by the appearance, sorted ascending, and carry only what the window draws:
/// the two colours and the word. What they do *not* carry is the measurement behind the word,
/// which is deliberate — it is a number in units that differ by row, it is worth nothing to a
/// reader, and at fifty-five thousand rows it is a megabyte of file that only the tool that
/// wrote it could interpret. The cuts it was read against are in the header instead, where the
/// whole slot's reading can be audited in four numbers.
pub fn stored(display_type: u32, build: &str, looks: &[(u32, Look)]) -> Value {
    let mut measured: BTreeMap<&'static str, Vec<f64>> = BTreeMap::new();
    for (_, look) in looks {
        if let Some(size) = look.size {
            measured.entry(size.by.word()).or_default().push(size.of);
        }
    }
    let cut: BTreeMap<&'static str, Cuts> = measured
        .iter()
        .filter_map(|(by, measures)| Some((*by, cuts(measures)?)))
        .collect();

    let mut rows: Vec<&(u32, Look)> = looks.iter().collect();
    rows.sort_by_key(|(appearance_id, _)| *appearance_id);
    let appearances: Vec<Value> = rows
        .iter()
        .map(|(appearance_id, look)| {
            let mut row = serde_json::Map::new();
            row.insert("id".into(), json!(appearance_id));
            row.insert("primary".into(), json!(hex(look.primary)));
            if let Some(accent) = look.accent {
                row.insert("accent".into(), json!(hex(accent)));
            }
            if let Some(size) = look.size {
                if let Some(cuts) = cut.get(size.by.word()) {
                    row.insert("size".into(), json!(band(size.of, *cuts)));
                }
            }
            Value::Object(row)
        })
        .collect();

    json!({
        "displayType": display_type,
        "build": build,
        "sizeCuts": cut
            .iter()
            .map(|(by, cuts)| {
                (
                    (*by).to_string(),
                    json!({ "small": cuts.small, "large": cuts.large, "rows": cuts.rows }),
                )
            })
            .collect::<serde_json::Map<String, Value>>(),
        "appearances": appearances,
    })
}

/// The file as it is committed: a header a reader can take in, and one row to a line.
///
/// Not `to_string_pretty`, and the reason is the diff. A slot is five thousand rows and the
/// pretty printer spends six lines on each of them, which is half a megabyte of file where a
/// tenth of that says the same thing — and, worse, a change to one appearance shows up as a
/// change to a paragraph. One row to a line is what makes the store reviewable: a regenerated
/// file after a patch is a handful of changed lines, each of which is one look.
///
/// The layout is this shape's rather than a general one: the top level is an object whose values
/// are either a list of rows or a small thing that fits on a line, and both are written the way
/// somebody reading the file would want them. [`crate::shapes`] writes its own store — which is
/// cached on the reader's machine rather than committed — through here for the same reason: a
/// store nobody can open when they doubt it is a store nobody can check.
pub fn text(file: &Value) -> String {
    let mut out = String::from("{\n");
    let object = file.as_object().expect("a stored file is an object");
    for (at, (key, value)) in object.iter().enumerate() {
        let comma = if at + 1 < object.len() { "," } else { "" };
        match value.as_array() {
            Some(rows) if !rows.is_empty() => {
                out.push_str(&format!("  {}: [\n", json!(key)));
                for (at, row) in rows.iter().enumerate() {
                    let comma = if at + 1 < rows.len() { "," } else { "" };
                    out.push_str(&format!("    {}{comma}\n", row));
                }
                out.push_str(&format!("  ]{comma}\n"));
            }
            _ => out.push_str(&format!("  {}: {}{comma}\n", json!(key), value)),
        }
    }
    out.push_str("}\n");
    out
}

/// The sets' own file: what a set is like, as the looks in it are.
///
/// A set has no size — a dozen pieces covering a body is every set in the game — so it keeps
/// only the colours, and it takes them by counting what its pieces are rather than by measuring
/// anything again. That is the point of doing it here rather than in the window: the answer is a
/// function of the rows above and can be written down once beside them.
pub fn stored_sets(build: &str, sets: &[(u32, Vec<Look>)]) -> Value {
    let mut rows: Vec<&(u32, Vec<Look>)> = sets.iter().collect();
    rows.sort_by_key(|(set_id, _)| *set_id);
    let sets: Vec<Value> = rows
        .iter()
        .filter_map(|(set_id, looks)| {
            let gathered = of_set(looks)?;
            let mut row = serde_json::Map::new();
            row.insert("id".into(), json!(set_id));
            row.insert("primary".into(), json!(hex(gathered.primary)));
            if let Some(accent) = gathered.accent {
                row.insert("accent".into(), json!(hex(accent)));
            }
            Some(Value::Object(row))
        })
        .collect();
    json!({ "build": build, "sets": sets })
}

/// What a set is, out of what its pieces are.
///
/// Each piece votes once with its primary, quantised the way a texel is, so a set of five brown
/// pieces and one gold one is brown with gold on it — which is what somebody looking at it would
/// say. Voting by piece rather than by texel is the deliberate part: a tabard's sheet is many
/// times a bracer's and counting texels would let one piece decide a set of twelve.
pub fn of_set(looks: &[Look]) -> Option<Look> {
    let mut gathered = Gathered::default();
    for look in looks {
        // The primary counts double, so a piece cannot be outvoted by the trim on it.
        for (colour, weight) in [(Some(look.primary), 2.0), (look.accent, 1.0)] {
            let Some(colour) = colour else {
                continue;
            };
            let held = gathered
                .buckets
                .entry([colour[0] & BUCKET, colour[1] & BUCKET, colour[2] & BUCKET])
                .or_insert((0.0, [0.0; 3]));
            held.0 += weight;
            for (into, channel) in held.1.iter_mut().zip(colour) {
                *into += f64::from(channel) * weight;
            }
        }
    }
    let primary = gathered.primary()?;
    Some(Look {
        primary,
        accent: gathered.accent(primary),
        size: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// The body everything here is measured on, which is the body the store is written for.
    fn hers() -> Body {
        crate::body::of(&fixture_files(), crate::body::DEFAULT).unwrap()
    }

    /// The fixture displays, by what the generator made each of them. The slot and the place the
    /// item is worn travel with each, because a piece is all three.
    const HELM: Piece = worn(900_001, 0);
    const SHOULDERS: Piece = worn(900_002, 1);
    const CHESTPIECE: Piece = worn(900_003, 3);
    const BOOTS: Piece = worn(900_004, 5);
    const ROBE: Piece = worn(900_012, 3);
    const WEAPON: Piece = Piece {
        display_info_id: 900_007,
        display_type: 11,
        inventory_type: 13,
    };
    /// A display in a section the game encrypts, so nothing can be read about it.
    const WITHHELD: Piece = worn(900_900, 3);

    const fn worn(display_info_id: u32, display_type: u32) -> Piece {
        Piece {
            display_info_id,
            display_type,
            inventory_type: 0,
        }
    }

    /// The colours the fixture generator painted the chestpiece's four sections, which is what
    /// makes an assertion about a colour here an assertion rather than a judgement call.
    const LOWER_ARMS: Colour = [120, 40, 200];
    const LOWER_TORSO: Colour = [30, 210, 170];
    const UPPER_ARMS: Colour = [90, 200, 60];

    fn look(piece: Piece) -> Look {
        of(&fixture_files(), &hers(), piece)
            .unwrap()
            .expect("the fixture can be measured")
    }

    // What the module is for: a piece of armour comes back as the colours it is painted.
    #[test]
    fn reads_the_colours_a_piece_of_armour_is_painted_with() {
        let chestpiece = look(CHESTPIECE);
        assert_eq!(chestpiece.primary, LOWER_ARMS);
        assert_eq!(chestpiece.accent, Some(LOWER_TORSO));
    }

    // And the rule that decides *which* of them is the primary. Every one of the fixture's body
    // textures is 8 × 8, so counting texels would leave a four-way tie broken by nothing a
    // reader would recognise. What breaks it is where each lands: the lower arms are a rectangle
    // of the atlas twice the size of the lower torso's, so that is what the piece mostly is.
    #[test]
    fn weighs_a_texture_by_how_much_of_the_body_it_covers() {
        assert_eq!(look(CHESTPIECE).primary, LOWER_ARMS);
        // The same claim from the other side: the robe paints three sections instead, and its
        // primary is the one of them the layout gives the most room to.
        assert_eq!(look(ROBE).primary, [70, 20, 190]);
    }

    // Half of the chestpiece's upper-arm sheet is not there at all, and a texel that is not there
    // is not a colour the piece is. Counted, the green would tie with the two torso colours and
    // could take the accent from them.
    #[test]
    fn counts_only_the_texels_that_are_solid_enough_to_be_seen() {
        let chestpiece = look(CHESTPIECE);
        assert_ne!(chestpiece.primary, UPPER_ARMS);
        assert_ne!(chestpiece.accent, Some(UPPER_ARMS));
    }

    // The two ways size is answered, and the fact that a row says which. A chestpiece has no
    // geometry at all and is measured by the body it paints; a helm hangs a mesh and is measured
    // by it, and comparing the two numbers would be comparing atlas pixels with metres.
    #[test]
    fn measures_a_mesh_by_geometry_and_a_painted_slot_by_what_it_covers() {
        assert_eq!(look(HELM).size.map(|size| size.by), Some(By::Geometry));
        assert_eq!(look(SHOULDERS).size.map(|size| size.by), Some(By::Geometry));
        assert_eq!(look(WEAPON).size.map(|size| size.by), Some(By::Geometry));
        assert_eq!(look(CHESTPIECE).size.map(|size| size.by), Some(By::Cover));
        assert_eq!(look(BOOTS).size.map(|size| size.by), Some(By::Cover));
    }

    // Within one of those readings the numbers order the way a reader would: the fixture's
    // weapon is a longer mesh than its helm, and its chestpiece covers more of her than its
    // boots.
    #[test]
    fn orders_two_things_measured_the_same_way() {
        let extent = |piece| look(piece).size.expect("it has a size").of;
        assert!(
            extent(WEAPON) > extent(HELM),
            "a sword is longer than a helm"
        );
        assert!(
            extent(CHESTPIECE) > extent(BOOTS),
            "a chestpiece covers more of her than a pair of boots",
        );
    }

    // A section the body's layout has no rectangle for is painted nowhere, so it covers nothing —
    // the same answer `character::Atlas::wear` gives it. The boots name one, and counting it
    // would make them bigger than the sections they actually paint.
    #[test]
    fn gives_no_size_to_a_texture_the_layout_paints_nowhere() {
        // Sections 6 and 7 of the body, and nothing for the accessory the third texture is.
        let hers = hers();
        let painted = f64::from(hers.area_of(6).unwrap() + hers.area_of(7).unwrap());
        let whole: f64 = BODY_SECTIONS
            .iter()
            .filter_map(|section| hers.area_of(*section))
            .map(f64::from)
            .sum();
        assert_eq!(
            look(BOOTS).size.expect("the boots have a size").of,
            painted / whole
        );
    }

    // Nothing is the ordinary answer for a display the game withholds: there is no mesh, no
    // texture and nothing to measure, and the row keeps whatever the rest of the app knows.
    #[test]
    fn says_nothing_about_a_display_it_cannot_read() {
        assert_eq!(of(&fixture_files(), &hers(), WITHHELD).unwrap(), None);
        assert_eq!(
            of(&fixture_files(), &hers(), worn(404_040, 3)).unwrap(),
            None
        );
    }

    // A batch is an optimisation and nothing else: every row of one is the answer that row would
    // have got alone, in the order it was asked for.
    #[test]
    fn answers_a_batch_exactly_as_it_answers_one_at_a_time() {
        let files = fixture_files();
        let batch = [CHESTPIECE, WITHHELD, WEAPON, HELM];
        assert_eq!(
            each(&files, &hers(), &batch).unwrap(),
            batch
                .iter()
                .map(|piece| of(&files, &hers(), *piece).unwrap())
                .collect::<Vec<_>>(),
        );
    }

    // The same measurement twice, because what this writes is committed: a store whose bytes
    // move when nothing about the game moved is a diff nobody can read.
    #[test]
    fn measures_the_same_install_the_same_way_twice() {
        assert_eq!(
            each(&fixture_files(), &hers(), &[CHESTPIECE, HELM, WEAPON]).unwrap(),
            each(&fixture_files(), &hers(), &[CHESTPIECE, HELM, WEAPON]).unwrap()
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
    // game's tables has not measured fifty-five thousand blank appearances, it has not started.
    #[test]
    fn says_so_when_the_tables_are_not_there() {
        let temp = tempfile::tempdir().unwrap();
        assert!(each(&DirFiles::new(temp.path()), &hers(), &[CHESTPIECE]).is_err());
    }

    /* ---------- the bands ---------- */

    #[test]
    fn cuts_a_run_of_measurements_into_thirds() {
        let cuts = cuts(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]).expect("six is a distribution");
        assert_eq!((cuts.small, cuts.large, cuts.rows), (3.0, 5.0, 6));
        // Two of the six either side, and two left in the middle.
        let bands: Vec<&str> = (1..=6).map(|of| band(f64::from(of), cuts)).collect();
        assert_eq!(
            bands,
            ["small", "small", "medium", "medium", "large", "large"]
        );
    }

    // The order they arrive in is not the order they sort in, and the cuts are the sorted ones.
    #[test]
    fn cuts_the_same_measurements_whatever_order_they_arrive_in() {
        assert_eq!(
            cuts(&[6.0, 1.0, 4.0, 3.0, 2.0, 5.0]),
            cuts(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
        );
    }

    // A slot where every appearance measures the same is a slot with nothing to say about size,
    // and saying "small" about a third of it at random would be worse than saying nothing.
    #[test]
    fn calls_a_run_of_identical_measurements_medium_throughout() {
        let cuts = cuts(&[2.0, 2.0, 2.0, 2.0]).expect("four is a distribution");
        assert_eq!(band(2.0, cuts), "medium");
    }

    #[test]
    fn cuts_nothing_out_of_no_measurements() {
        assert_eq!(cuts(&[]), None);
    }

    /* ---------- the store ---------- */

    fn made(primary: Colour, accent: Option<Colour>, size: Option<Size>) -> Look {
        Look {
            primary,
            accent,
            size,
        }
    }

    const fn covering(of: f64) -> Option<Size> {
        Some(Size { by: By::Cover, of })
    }

    #[test]
    fn writes_a_slot_as_rows_keyed_by_the_appearance_and_sorted() {
        let file = stored(
            3,
            "12.0.5.67",
            &[
                (200, made([1, 2, 3], None, covering(0.9))),
                (100, made([255, 128, 0], Some([0, 0, 0]), covering(0.1))),
                (300, made([9, 9, 9], None, covering(0.5))),
            ],
        );
        assert_eq!(file["displayType"], 3);
        assert_eq!(file["build"], "12.0.5.67");
        assert_eq!(
            file["appearances"],
            serde_json::json!([
                { "id": 100, "primary": "#ff8000", "accent": "#000000", "size": "small" },
                // No accent at all rather than a null: a look of one colour has one colour, and
                // the window draws what the row holds.
                { "id": 200, "primary": "#010203", "size": "large" },
                { "id": 300, "primary": "#090909", "size": "medium" },
            ]),
        );
    }

    // The four numbers that make the words auditable. Without them "large" is an opinion; with
    // them it is a measurement against a stated cut, and a reader can see how many rows the cut
    // was taken over before believing it.
    #[test]
    fn writes_down_the_cuts_the_words_were_read_against() {
        let file = stored(
            3,
            "12.0.5.67",
            &[
                (1, made([1, 1, 1], None, covering(0.1))),
                (2, made([2, 2, 2], None, covering(0.5))),
                (3, made([3, 3, 3], None, covering(0.9))),
            ],
        );
        assert_eq!(file["sizeCuts"]["cover"]["small"], 0.5);
        assert_eq!(file["sizeCuts"]["cover"]["large"], 0.9);
        assert_eq!(file["sizeCuts"]["cover"]["rows"], 3);
    }

    // Two ways of measuring in one slot are cut apart, because a fraction of a body and the
    // length of a mesh have no order between them. A helm that paints the scalp is the case.
    #[test]
    fn cuts_each_way_of_measuring_apart_from_the_other() {
        let file = stored(
            0,
            "12.0.5.67",
            &[
                (
                    1,
                    made(
                        [1, 1, 1],
                        None,
                        Some(Size {
                            by: By::Geometry,
                            of: 1.0,
                        }),
                    ),
                ),
                (
                    2,
                    made(
                        [2, 2, 2],
                        None,
                        Some(Size {
                            by: By::Geometry,
                            of: 2.0,
                        }),
                    ),
                ),
                (
                    3,
                    made(
                        [3, 3, 3],
                        None,
                        Some(Size {
                            by: By::Geometry,
                            of: 3.0,
                        }),
                    ),
                ),
                (4, made([4, 4, 4], None, covering(0.1))),
            ],
        );
        assert_eq!(file["sizeCuts"]["geometry"]["rows"], 3);
        assert_eq!(file["sizeCuts"]["cover"]["rows"], 1);
        // The row measured the other way is not the smallest helm in the game; it is a row read
        // against its own single-row distribution and left in the middle.
        assert_eq!(file["appearances"][3]["size"], "medium");
    }

    // A row with nothing to say about size says nothing, rather than defaulting to a word.
    #[test]
    fn leaves_the_size_off_a_row_that_has_none() {
        let file = stored(3, "12.0.5.67", &[(1, made([1, 1, 1], None, None))]);
        assert_eq!(file["appearances"][0].get("size"), None);
        assert_eq!(file["sizeCuts"], serde_json::json!({}));
    }

    // What the committed file actually looks like, because that is the artefact: a header
    // somebody can take in at a glance and one look to a line, so that a regenerated store after
    // a patch is a diff of the appearances that changed rather than of the whole file.
    #[test]
    fn writes_one_row_to_a_line_under_a_header_that_fits_on_one() {
        let file = stored(
            3,
            "12.0.5.67",
            &[
                (1, made([255, 0, 0], None, covering(0.1))),
                (2, made([0, 255, 0], None, covering(0.5))),
                (3, made([0, 0, 255], None, covering(0.9))),
            ],
        );
        assert_eq!(
            text(&file),
            concat!(
                "{\n",
                "  \"appearances\": [\n",
                "    {\"id\":1,\"primary\":\"#ff0000\",\"size\":\"small\"},\n",
                "    {\"id\":2,\"primary\":\"#00ff00\",\"size\":\"medium\"},\n",
                "    {\"id\":3,\"primary\":\"#0000ff\",\"size\":\"large\"}\n",
                "  ],\n",
                "  \"build\": \"12.0.5.67\",\n",
                "  \"displayType\": 3,\n",
                "  \"sizeCuts\": {\"cover\":{\"large\":0.9,\"rows\":3,\"small\":0.5}}\n",
                "}\n",
            ),
        );
    }

    // A slot the install can say nothing about is still a file, and still one a reader can open:
    // an empty list on a line rather than a bracket with nothing between it and its partner.
    #[test]
    fn writes_a_slot_with_nothing_in_it() {
        let text = text(&stored(4, "12.0.5.67", &[]));
        assert!(text.contains("\"appearances\": [],\n"), "{text}");
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap()["appearances"],
            json!([])
        );
    }

    // Whatever it writes has to read back as the thing it was written from, because the window
    // parses it with an ordinary JSON reader and this is not an ordinary JSON writer.
    #[test]
    fn writes_something_a_json_reader_reads_back_unchanged() {
        let file = stored(
            0,
            "12.0.5.67",
            &[
                (
                    1,
                    made(
                        [255, 0, 0],
                        Some([0, 0, 0]),
                        Some(Size {
                            by: By::Geometry,
                            of: 1.5,
                        }),
                    ),
                ),
                (2, made([0, 255, 0], None, None)),
            ],
        );
        assert_eq!(serde_json::from_str::<Value>(&text(&file)).unwrap(), file);
        assert_eq!(
            serde_json::from_str::<Value>(&text(&stored_sets("12.0.5.67", &[]))).unwrap(),
            stored_sets("12.0.5.67", &[]),
        );
    }

    // A set is what its pieces are, counted by piece rather than by texel.
    #[test]
    fn reads_a_set_as_the_colours_of_the_looks_in_it() {
        let set = of_set(&[
            made([200, 40, 40], None, None),
            made([200, 40, 40], None, None),
            made([40, 40, 200], None, None),
        ])
        .expect("three pieces are a set");
        assert_eq!(set.primary, [200, 40, 40]);
        assert_eq!(set.accent, Some([40, 40, 200]));
        // A set covers a body whatever is in it, so there is no size to report.
        assert_eq!(set.size, None);
    }

    // The trim on a piece votes, but it cannot outvote the piece: two pieces of one colour beat
    // one piece whose primary and accent are both something else.
    #[test]
    fn lets_a_pieces_own_colour_count_for_more_than_the_trim_on_it() {
        // Three pieces, each red with a green trim. Counted evenly the two colours tie and the
        // set is whichever the tie-break happens to name; counted as a piece and its trim, it is
        // red with green on it, which is what anybody looking at it would say.
        let trimmed = made([200, 40, 40], Some([40, 200, 40]), None);
        let set = of_set(&[trimmed, trimmed, trimmed]).expect("three pieces are a set");
        assert_eq!(set.primary, [200, 40, 40]);
        assert_eq!(set.accent, Some([40, 200, 40]));
    }

    // A second colour close enough to the first is the shading on it rather than an accent, and
    // reporting it would tell a reader the same thing twice.
    #[test]
    fn calls_nothing_an_accent_that_is_a_shade_of_the_primary() {
        let set = of_set(&[
            made([100, 100, 100], None, None),
            made([110, 105, 100], None, None),
        ])
        .expect("two pieces are a set");
        assert_eq!(set.accent, None);
    }

    #[test]
    fn writes_the_sets_sorted_and_says_which_build_they_were_read_from() {
        let file = stored_sets(
            "12.0.5.67",
            &[
                (7, vec![made([0, 0, 255], None, None)]),
                (2, vec![made([255, 0, 0], None, None)]),
                // A set whose every piece this install withholds has nothing to say and is left
                // out rather than written down as black.
                (3, vec![]),
            ],
        );
        assert_eq!(file["build"], "12.0.5.67");
        assert_eq!(
            file["sets"],
            serde_json::json!([
                { "id": 2, "primary": "#ff0000" },
                { "id": 7, "primary": "#0000ff" },
            ]),
        );
    }
}
