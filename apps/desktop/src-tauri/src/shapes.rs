//! Which appearances are the same armour in another colour, settled by the geometry itself.
//!
//! Two looks that hang the same mesh, switch the same geosets and paint the same parts of the
//! body *are* the same piece of armour recoloured. That is not a judgement and not a threshold:
//! it is an equality between two lines this module writes down, and everything a colour could
//! disagree about has been left out of them. Where it fires it is exact, and where it cannot
//! fire it says so rather than guessing — which is the whole of what it offers over the pixel
//! measure that answers the rest.
//!
//! Everything it reads is already read. [`crate::worn::each`] says what one appearance does to a
//! bare body — the models it hangs, the geosets it switches, the sections it paints, the groups
//! a helm hides, whether there is a cape — and a signature is those five things sorted and
//! written out. No texture is decoded, no model is parsed, and the sweep over a whole install's
//! fifty-five thousand looks is a second or so of walking the tables `worn` walks anyway.
//!
//! # It answers the slots that hang geometry and is blind to the rest
//!
//! Head, shoulder, weapon, shield, ranged and held hang a mesh, so the mesh identifies them.
//! Chest, waist, legs, feet, wrist, hands, back and tabard are paint on the body — the "model"
//! *is* the body — so every appearance in those slots does very nearly the same thing to her and
//! the signatures collapse: measured on a 12.0.5.67823 install, 3,602 wrist looks come to two
//! distinct signatures and 4,345 legs to seventeen. A family of eighteen hundred bracers is not
//! a family, and [`Shapes::siblings`] refuses to answer for those rather than handing back a
//! third of the slot. What answers them is the texture fingerprint of #247; the two measures are
//! complementary and this is the half that costs nothing.
//!
//! That refusal is also what a look this install cannot read gets. An appearance whose display
//! sits in a section the game encrypts does nothing whatever to the body, and a store that wrote
//! it down as an empty signature would file every one of them as one enormous family of
//! identical armour — which is exactly what the prototype behind this did before the rule below
//! was stated.
//!
//! # Where it is kept
//!
//! **Computed on the reader's machine and cached in the app's own data directory, keyed on the
//! build it was read from.** Not committed: this repository carries no assets of Blizzard's and
//! nothing generated from them, and a signature naming the FileDataIDs of a build's meshes is
//! generated from them. A cache whose `build` is not the install's is recomputed rather than
//! read, because a patch that moves a mesh moves every signature naming it.
//!
//! **It is measured on one body**, for the reason [`crate::qualities`] is: which `.m2` a helm
//! resolves to is `ComponentModelFileData`'s answer per race and sex, so a signature taken on
//! him and one taken on her are two different lines about one helm. Every row of one store is
//! taken on the same body — [`crate::body::DEFAULT`] unless the caller says otherwise — and two
//! stores are never compared.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::body::Body;
use crate::casc::GameFiles;
use crate::worn::{self, Piece, Worn};

/// Every display type the game files an appearance under, which is what a store holds.
///
/// The sixteen `ItemAppearance.DisplayType` values: eleven places on the body and five ways of
/// carrying something. A store is written over all of them at once because the walk that reads
/// them is the same walk however many are asked for — see [`sweep`].
pub const EVERY_DISPLAY_TYPE: [u32; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/// What the cache is called inside the directory it is kept in.
const FILE: &str = "shapes.json";

/// What a half-written cache is called until it is whole.
///
/// The store is written under this and renamed on top of the real one, because the failure it
/// prevents is silent: a run interrupted halfway through three megabytes leaves a file that
/// parses as far as it goes, and a truncated store is not a store missing rows — it is a store
/// that answers "nothing else in the game looks like this" for everything past the cut.
const PARTIAL: &str = "shapes.json.part";

/// What one appearance does to a bare body, as the one line two appearances are compared by.
///
/// Opaque on purpose. The string inside is this module's own writing and nothing outside reads
/// it for its parts — what a caller may ask is whether two of them are equal, which is the only
/// question it can answer, and whether the shape names a mesh at all, which is what says whether
/// the answer means anything.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Shape(String);

/// How a signature that hangs nothing at all begins, which is the one thing readable off one.
///
/// The grammar is five fields in a fixed order, each a letter and a possibly-empty list,
/// separated by `|`: `m140001|g27:2702|s|h0|c0` is a helm hanging one mesh, switching the helm
/// group on, painting no part of her, hiding one group and wearing no cape. Every field is
/// written even when it holds nothing, and that is what makes an empty first field a thing this
/// can recognise without parsing the rest — see [`Shape::names_a_mesh`] and [`of`].
const HANGS_NOTHING: &str = "m|";

impl Shape {
    /// Whether this is geometry the game hung on the body, rather than paint on the body itself.
    ///
    /// The one thing readable off a signature, and the one thing a caller has to know: a shape
    /// with a mesh in it identifies a piece of armour, and a shape without one is the shared
    /// silhouette of every legging in the game. See the module note.
    pub fn names_a_mesh(&self) -> bool {
        !self.0.starts_with(HANGS_NOTHING)
    }

    /// The signature as it is written into the store.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What one appearance does to a bare body, or nothing where it does nothing at all.
///
/// Nothing is the ordinary answer for a look this install cannot read: the game encrypts the
/// displays of content it has not shipped, and an appearance whose every texture was painted for
/// another body resolves to nothing either. Both are silence rather than a shape, and writing
/// them down as one would make them all each other's siblings.
pub fn of(worn: &Worn) -> Option<Shape> {
    if worn.is_empty() {
        return None;
    }

    // The meshes, and deliberately not the pictures on them: `WornModel::texture` is the item's
    // own material and is the whole of what a recolour changes. Sorted and deduplicated because
    // a set can name one appearance twice and because the order `worn` hands them over in is the
    // draw order rather than anything about the shape.
    let mut meshes: Vec<u32> = worn.models.iter().map(|model| model.file).collect();
    meshes.sort_unstable();
    meshes.dedup();

    // Which variant of which group it switches on, which is what says a robe from a breastplate
    // in a slot where neither hangs a mesh.
    let mut geosets: Vec<(u16, u16)> = worn
        .geosets
        .iter()
        .map(|geoset| (geoset.group, geoset.geoset))
        .collect();
    geosets.sort_unstable();
    geosets.dedup();

    // Which parts of her it paints — the sections and not the files, for the same reason the
    // meshes carry no textures: two recolours of one chestpiece paint the same rectangles of the
    // same body out of different sheets.
    let mut sections: Vec<u32> = worn
        .textures
        .iter()
        .map(|texture| texture.section)
        .collect();
    sections.sort_unstable();
    sections.dedup();

    let mut hidden = worn.hidden.clone();
    hidden.sort_unstable();
    hidden.dedup();

    // The five fields, in the order [`HANGS_NOTHING`] states and always all five. The cape is a
    // yes or a no rather than the picture: the back slot's "model" is geometry the body already
    // carries, so what an appearance supplies there is only the colour of it.
    let mut key = String::new();
    let _ = write!(key, "m{}", numbers(&meshes));
    let _ = write!(key, "|g{}", pairs(&geosets));
    let _ = write!(key, "|s{}", numbers(&sections));
    let _ = write!(key, "|h{}", numbers(&hidden));
    let _ = write!(key, "|c{}", u8::from(worn.cape.is_some()));
    Some(Shape(key))
}

/// A sorted list of numbers, as a signature writes one.
fn numbers<T: std::fmt::Display>(of: &[T]) -> String {
    of.iter()
        .map(T::to_string)
        .collect::<Vec<String>>()
        .join(",")
}

/// A sorted list of pairs, likewise.
fn pairs(of: &[(u16, u16)]) -> String {
    of.iter()
        .map(|(left, right)| format!("{left}:{right}"))
        .collect::<Vec<String>>()
        .join(",")
}

/// The shapes of a batch of appearances, sharing every table between them.
///
/// A batch for the reason [`crate::worn::each`] exists at all: that walk materialises
/// `ItemDisplayInfoMaterialRes`'s six hundred thousand rows before it yields the first one, so
/// asked an appearance at a time a sweep over the whole game would walk it fifty-five thousand
/// times. Nothing here decodes anything, so unlike [`crate::qualities::each`] there is no reason
/// to keep the batch small — a whole install goes through in one.
#[tracing::instrument(name = "shapes.each", skip_all, fields(pieces = pieces.len()))]
pub fn each(
    files: &dyn GameFiles,
    body: &Body,
    pieces: &[Piece],
) -> Result<Vec<Option<Shape>>, String> {
    if pieces.is_empty() {
        return Ok(Vec::new());
    }
    // One outfit per piece: a shape is what an appearance does to a *bare* body, so there is
    // nothing for the priority table or the draw order to settle between them.
    let alone: Vec<&[Piece]> = pieces.iter().map(std::slice::from_ref).collect();
    Ok(worn::each(files, body, &alone)?.iter().map(of).collect())
}

/// One look, with the slot it fills and the shape it puts on the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shaped {
    pub appearance_id: u32,
    /// Which place it fills, as `ItemAppearance` numbers them. Kept beside the shape because a
    /// reader asking what else looks like a helm wants helms, and because it is what says which
    /// slots this measure is blind to without asking the game a second time.
    pub display_type: u32,
    pub shape: Shape,
}

/// Every appearance of those display types, with what each does to the body.
///
/// One walk, whatever is asked for. [`crate::wardrobe::looks`] reads `ItemAppearance`,
/// `ItemModifiedAppearance`, `Item` and `ItemSparse` once for every kind named — the inventory
/// type it brings back is not decoration, it is the only thing that says which hand a weapon
/// hangs in — and [`each`] then walks the display tables once for the lot. Asked slot by slot
/// instead, the sixteen display types are sixteen walks of the sixty-three megabytes of
/// `ItemSparse` to no purpose.
///
/// The rows come back sorted by appearance, which is what makes the store the same bytes twice.
#[tracing::instrument(name = "shapes.sweep", skip_all, fields(kinds = display_types.len()))]
pub fn sweep(
    files: &dyn GameFiles,
    body: &Body,
    display_types: &[u32],
) -> Result<Vec<Shaped>, String> {
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
        .filter_map(|(shape, look)| {
            Some(Shaped {
                appearance_id: look.appearance_id,
                display_type: look.display_type,
                shape: shape?,
            })
        })
        .collect())
}

/* ---------- the store ---------- */

/// The store as it is written, and as it is read back.
///
/// The rows are keyed by appearance and sorted, and the build is the install's own version
/// string — the same `12.0.5.67823` [`crate::qualities`] stamps into what it writes, and here
/// the thing that decides whether the file may be believed at all.
pub fn stored(build: &str, shapes: &[Shaped]) -> Value {
    let mut rows: Vec<&Shaped> = shapes.iter().collect();
    rows.sort_by_key(|row| row.appearance_id);
    let appearances: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.appearance_id,
                "displayType": row.display_type,
                "shape": row.shape.as_str(),
            })
        })
        .collect();
    json!({ "build": build, "appearances": appearances })
}

/// A store read back: what each look does to the body, and who else does the same thing.
pub struct Shapes {
    build: String,
    /// Every look, by appearance. A [`BTreeMap`] rather than a hash map so that anything walking
    /// the whole store walks it in a stated order.
    of: BTreeMap<u32, Shaped>,
    /// Who shares each signature, appearance ids ascending. Built once when the store is read,
    /// because the question this whole module exists for is asked of it and not of the rows —
    /// and only over the shapes that name a mesh, the rest having no family worth indexing.
    families: HashMap<Shape, Vec<u32>>,
}

impl Shapes {
    /// A store out of what [`stored`] wrote, or a complaint about what was found instead.
    ///
    /// Strict about the header and forgiving about nothing: a file this cannot read whole is a
    /// cache to recompute, and the caller that recomputes it is [`cached`].
    pub fn read(text: &str) -> Result<Self, String> {
        let file: Value =
            serde_json::from_str(text).map_err(|error| format!("the shape store: {error}"))?;
        let build = file["build"]
            .as_str()
            .ok_or("the shape store says no build.")?
            .to_string();
        let rows = file["appearances"]
            .as_array()
            .ok_or("the shape store holds no appearances.")?;
        let mut of: BTreeMap<u32, Shaped> = BTreeMap::new();
        for row in rows {
            let number = |name: &str| row[name].as_u64().map(|number| number as u32);
            let (Some(appearance_id), Some(display_type), Some(shape)) = (
                number("id"),
                number("displayType"),
                row["shape"].as_str().map(|shape| Shape(shape.to_string())),
            ) else {
                return Err(format!("the shape store holds a row it cannot read: {row}"));
            };
            of.insert(
                appearance_id,
                Shaped {
                    appearance_id,
                    display_type,
                    shape,
                },
            );
        }
        let mut families: HashMap<Shape, Vec<u32>> = HashMap::new();
        for row in of.values().filter(|row| row.shape.names_a_mesh()) {
            families
                .entry(row.shape.clone())
                .or_default()
                .push(row.appearance_id);
        }
        Ok(Self {
            build,
            of,
            families,
        })
    }

    /// Which build of the game these shapes were read off.
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
    pub fn rows(&self) -> impl Iterator<Item = &Shaped> {
        self.of.values()
    }

    /// What one look does to the body, where this store knows it.
    pub fn of(&self, appearance_id: u32) -> Option<&Shaped> {
        self.of.get(&appearance_id)
    }

    /// Every other appearance in the game that hangs exactly this geometry.
    ///
    /// The answer the module exists for, and it is an equality rather than a nearest: what comes
    /// back is the same armour in other colours, with nothing ranked and nothing approximate.
    /// Ascending by appearance, and never including the appearance asked about.
    ///
    /// **Empty for a look whose shape names no mesh**, which is every chestpiece, legging,
    /// bracer, glove, belt, boot, tabard and cloak in the game. Those slots are paint on a body
    /// every one of them shares, so their signatures are shared too and a "family" of them is
    /// three thousand unrelated leggings. Saying nothing is the honest answer and the pixel
    /// measure is what answers them — see the module note.
    pub fn siblings(&self, appearance_id: u32) -> Vec<u32> {
        let Some(row) = self.of.get(&appearance_id) else {
            return Vec::new();
        };
        if !row.shape.names_a_mesh() {
            return Vec::new();
        }
        self.families
            .get(&row.shape)
            .map(|family| {
                family
                    .iter()
                    .copied()
                    .filter(|held| *held != appearance_id)
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// The shapes of this install: out of the cache when it was written for this build, and by
/// measuring the game when it was not.
///
/// This is the whole of the storage decision. The store is **not** committed — it names the
/// FileDataIDs of one build's meshes, which is content generated from Blizzard's own files — so
/// every machine computes its own, once, and keeps it beside the settings and the database. A
/// build that does not match is not a store to patch up: a game patch moves meshes, and a
/// signature naming a mesh that has moved is wrong rather than stale.
///
/// A cache that cannot be read is recomputed rather than reported. There is nothing a reader
/// could do about a corrupt file that this cannot do for them, and the thing behind it — a
/// second of walking tables — is cheap enough to spend on the doubt.
#[tracing::instrument(name = "shapes.cached", skip_all, fields(build = build))]
pub fn cached(
    files: &dyn GameFiles,
    body: &Body,
    build: &str,
    dir: &Path,
) -> Result<Shapes, String> {
    let path = dir.join(FILE);
    if let Some(held) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| Shapes::read(&text).ok())
        .filter(|held| held.build() == build)
    {
        return Ok(held);
    }

    let swept = sweep(files, body, &EVERY_DISPLAY_TYPE)?;
    // Laid out by `qualities::text` — one look to a line under a header that fits on one — which
    // is the other store this repository writes and the same reason to write it that way: three
    // megabytes on one line is a file nobody can look at when they doubt what it says.
    let text = crate::qualities::text(&stored(build, &swept));
    write(dir, &path, &text)?;
    Shapes::read(&text)
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

    /// The body every shape here is taken on, which is the body a store is written for.
    fn hers() -> Body {
        crate::body::of(&fixture_files(), crate::body::DEFAULT).unwrap()
    }

    /// The fixture's looks, by what the generator made each of them.
    ///
    /// The weapons are the case the module is for. 80010 and 80016 are one display worn in
    /// either hand and 80015 is a *different* display that hangs the same mesh, so the three of
    /// them are one piece of geometry the game files under three display types.
    const HELM: u32 = 80001;
    const SAME_HELM: [u32; 3] = [80006, 80017, 80019];
    const SHOULDERS: u32 = 80002;
    const CHESTPIECE: u32 = 80008;
    const ROBE: u32 = 80003;
    const ONE_HANDER: u32 = 80010;
    const SHIELD: u32 = 80015;
    const OFF_HAND: u32 = 80016;

    /// The helm, as a piece — the display behind [`HELM`], which is what `worn` is asked about.
    const HELM_DISPLAY: u32 = 900_001;
    /// A display in a section the game encrypts, so nothing can be read about it.
    const WITHHELD_DISPLAY: u32 = 900_900;
    /// The cape, which is the slot with geometry the body already carries and no model of its
    /// own. No appearance of the fixture fills it, so it is asked about directly.
    const CAPE_DISPLAY: u32 = 900_013;

    const fn worn_piece(display_info_id: u32, display_type: u32) -> Piece {
        Piece {
            display_info_id,
            display_type,
            inventory_type: 0,
        }
    }

    fn shape(piece: Piece) -> Option<Shape> {
        each(&fixture_files(), &hers(), &[piece])
            .unwrap()
            .pop()
            .expect("one piece in, one answer out")
    }

    fn swept() -> Vec<Shaped> {
        sweep(&fixture_files(), &hers(), &EVERY_DISPLAY_TYPE).unwrap()
    }

    fn shapes() -> Shapes {
        Shapes::read(&crate::qualities::text(&stored("fixtures", &swept()))).unwrap()
    }

    fn shape_of(store: &Shapes, appearance_id: u32) -> String {
        store
            .of(appearance_id)
            .unwrap_or_else(|| panic!("the fixture holds {appearance_id}"))
            .shape
            .as_str()
            .to_string()
    }

    // What the module is for: two different displays that hang the same mesh are one shape, and
    // every member of the family answers with the rest of it.
    #[test]
    fn calls_two_displays_that_hang_the_same_mesh_one_shape() {
        let store = shapes();
        assert_eq!(store.siblings(ONE_HANDER), vec![SHIELD, OFF_HAND]);
        assert_eq!(store.siblings(SHIELD), vec![ONE_HANDER, OFF_HAND]);
        assert_eq!(shape_of(&store, ONE_HANDER), shape_of(&store, SHIELD));
    }

    // And the slot is not part of what a thing looks like. Those three are display types 11, 13
    // and 15 — the game files a sword, a shield and a thing held in an off hand apart and says
    // nothing about the mesh by doing it, which is why nothing is filtered by slot here. A
    // caller that wants one slot has the slot beside every row and can say so.
    #[test]
    fn keeps_one_mesh_one_shape_across_the_slots_the_game_files_it_under() {
        let store = shapes();
        let types: Vec<u32> = [ONE_HANDER, SHIELD, OFF_HAND]
            .iter()
            .map(|id| store.of(*id).expect("the fixture holds it").display_type)
            .collect();
        assert_eq!(types, vec![11, 13, 15]);
    }

    // A helm hangs a mesh, so the four appearances of one helm are its family and nothing else
    // of the fixture is in it — which is the claim that a signature discriminates at all.
    #[test]
    fn keeps_two_pieces_of_geometry_apart() {
        let store = shapes();
        assert_eq!(store.siblings(HELM), SAME_HELM.to_vec());
        assert_ne!(shape_of(&store, HELM), shape_of(&store, SHOULDERS));
        assert_eq!(store.siblings(SHOULDERS), Vec::<u32>::new());
    }

    // The refusal that keeps the measure honest. A chestpiece and a robe are paint on a body
    // every chestpiece shares, so a family of them would be a third of the slot rather than a
    // recolour. Their signatures are still written down, because saying "this one cannot be
    // answered this way" is what tells the pixel measure of #247 where it is needed.
    #[test]
    fn says_nothing_about_the_slots_that_hang_no_geometry() {
        let store = shapes();
        assert_eq!(store.siblings(CHESTPIECE), Vec::<u32>::new());
        assert_eq!(store.siblings(ROBE), Vec::<u32>::new());
        assert!(!store.of(CHESTPIECE).unwrap().shape.names_a_mesh());
        // A refusal rather than a blindness: the two do different things to her and the store
        // says so, having switched different geoset groups and painted different sections.
        assert_ne!(shape_of(&store, CHESTPIECE), shape_of(&store, ROBE));
    }

    // The grammar itself, written down where it can fail. A store is read back by a later run of
    // this same code, so the shape of a signature is the compatibility surface between the two,
    // and `names_a_mesh` reads the first field of it without parsing anything.
    #[test]
    fn writes_a_signature_as_the_five_fields_of_the_grammar() {
        let helm = shape(worn_piece(HELM_DISPLAY, 0)).expect("the fixture holds a helm");
        assert_eq!(helm.as_str(), "m140001|g27:2702|s|h0|c0");
        assert!(helm.names_a_mesh());
        let chestpiece = shape(worn_piece(900_003, 3)).expect("the fixture holds a chestpiece");
        assert_eq!(
            chestpiece.as_str(),
            "m|g8:802,10:1002,13:1301,22:2201,28:2801|s0,1,3,4|h|c0"
        );
        assert!(!chestpiece.names_a_mesh());
    }

    // A cloak is the other half of that: geometry, but geometry the body already carries, so
    // what an appearance supplies is the picture on it — its colour, and nothing to identify.
    #[test]
    fn treats_a_cape_as_paint_rather_than_as_geometry_of_its_own() {
        let cape = shape(worn_piece(CAPE_DISPLAY, 9)).expect("the fixture holds a cape");
        assert!(!cape.names_a_mesh());
        assert!(cape.as_str().ends_with("c1"), "{}", cape.as_str());
    }

    // A look this install can read nothing about is not a shape. Written down as an empty
    // signature it would be the sibling of every other unreadable look in the game, which is
    // the largest false family a store like this can hold.
    #[test]
    fn has_no_shape_for_a_look_it_can_read_nothing_about() {
        assert_eq!(shape(worn_piece(WITHHELD_DISPLAY, 3)), None);
        assert_eq!(shape(worn_piece(404_040, 3)), None);
        let store = shapes();
        assert!(store.of(80011).is_none());
        assert_eq!(store.siblings(80011), Vec::<u32>::new());
    }

    // The colour is the whole of what a recolour changes, so nothing about a texture may reach a
    // signature — not the sheets a chestpiece paints her with, and not the one picture a helm's
    // own mesh is painted with.
    #[test]
    fn writes_nothing_about_a_texture_into_a_signature() {
        let files = fixture_files();
        let helm = worn::of(&files, &hers(), HELM_DISPLAY, 0, 0).unwrap();
        let chest = worn::of(&files, &hers(), 900_003, 3, 0).unwrap();
        let named: Vec<u32> = helm
            .models
            .iter()
            .filter_map(|model| model.texture)
            .chain(chest.textures.iter().map(|texture| texture.file))
            .collect();
        assert!(!named.is_empty(), "the fixture paints something");

        let store = shapes();
        for shape in [shape_of(&store, HELM), shape_of(&store, CHESTPIECE)] {
            for file in &named {
                assert!(!shape.contains(&file.to_string()), "{shape} names {file}");
            }
        }
    }

    // A batch is an optimisation and nothing else: every row of one is the answer that row would
    // have got alone, in the order it was asked for.
    #[test]
    fn answers_a_batch_exactly_as_it_answers_one_at_a_time() {
        let files = fixture_files();
        let batch = [
            worn_piece(HELM_DISPLAY, 0),
            worn_piece(WITHHELD_DISPLAY, 3),
            worn_piece(900_003, 3),
        ];
        assert_eq!(
            each(&files, &hers(), &batch).unwrap(),
            batch.iter().map(|piece| shape(*piece)).collect::<Vec<_>>(),
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
    // game's tables has not found fifty-five thousand shapeless appearances, it has not started.
    #[test]
    fn says_so_when_the_tables_are_not_there() {
        let temp = tempfile::tempdir().unwrap();
        assert!(sweep(&DirFiles::new(temp.path()), &hers(), &EVERY_DISPLAY_TYPE).is_err());
    }

    /* ---------- the store ---------- */

    #[test]
    fn writes_a_row_a_look_under_a_header_saying_which_build_it_read() {
        let file = stored(
            "12.0.5.67823",
            &[Shaped {
                appearance_id: 11,
                display_type: 0,
                shape: Shape("m1|g|s|h|c0".into()),
            }],
        );
        assert_eq!(file["build"], "12.0.5.67823");
        assert_eq!(
            file["appearances"],
            json!([{ "id": 11, "displayType": 0, "shape": "m1|g|s|h|c0" }]),
        );
    }

    // The same install measured twice is the same store, and the order the rows were swept in is
    // not the order they are written in: a cache that moves when the game did not is one nobody
    // can reason about, and one the reader would recompute for nothing.
    #[test]
    fn writes_the_same_bytes_for_the_same_install_however_the_rows_arrived() {
        let mut backwards = swept();
        backwards.reverse();
        assert_eq!(
            crate::qualities::text(&stored("fixtures", &backwards)),
            crate::qualities::text(&stored("fixtures", &swept())),
        );
    }

    #[test]
    fn reads_back_what_it_wrote() {
        let store = shapes();
        let mut ids: Vec<u32> = swept().iter().map(|row| row.appearance_id).collect();
        ids.sort_unstable();
        assert_eq!(store.build(), "fixtures");
        assert_eq!(store.len(), ids.len());
        assert_eq!(
            store
                .rows()
                .map(|row| row.appearance_id)
                .collect::<Vec<_>>(),
            ids
        );
    }

    #[test]
    fn refuses_a_store_it_cannot_read_whole() {
        assert!(Shapes::read("not json at all").is_err());
        assert!(Shapes::read(&json!({ "appearances": [] }).to_string()).is_err());
        assert!(Shapes::read(&json!({ "build": "12.0" }).to_string()).is_err());
        assert!(Shapes::read(
            &json!({ "build": "12.0", "appearances": [{ "id": 1 }] }).to_string()
        )
        .is_err());
    }

    /* ---------- the cache ---------- */

    /// Files that answer nothing, which is what a machine with no game on it is.
    fn no_game() -> DirFiles {
        DirFiles::new(Path::new("/nowhere/there/is/no/game"))
    }

    // The bargain the cache makes: measured against the game once and read from the file every
    // time after. The second run here is handed files that hold nothing at all and still comes
    // back with the whole store.
    #[test]
    fn measures_the_game_once_and_reads_the_file_after_that() {
        let temp = tempfile::tempdir().unwrap();
        let first = cached(&fixture_files(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        assert!(!first.is_empty());

        let again = cached(&no_game(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        assert_eq!(again.build(), "12.0.5.67823");
        assert_eq!(again.len(), first.len());
        assert_eq!(again.siblings(ONE_HANDER), first.siblings(ONE_HANDER));
    }

    // And the one thing that ends it. A patch moves meshes, so a store stamped with another
    // build is not shapes to correct — it is shapes about a game that is no longer installed,
    // and the game is what it is replaced from.
    #[test]
    fn measures_the_game_again_when_the_build_has_moved() {
        let temp = tempfile::tempdir().unwrap();
        cached(&fixture_files(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        assert!(cached(&no_game(), &hers(), "12.0.6.70000", temp.path()).is_err());

        let after = cached(&fixture_files(), &hers(), "12.0.6.70000", temp.path()).unwrap();
        assert_eq!(after.build(), "12.0.6.70000");
    }

    // A half-written file is the failure a reader cannot see: it parses as far as it goes, and
    // every look past the cut answers "nothing else in the game looks like this".
    #[test]
    fn recomputes_a_cache_it_cannot_read_rather_than_believing_half_of_it() {
        let temp = tempfile::tempdir().unwrap();
        let whole = cached(&fixture_files(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        let path = temp.path().join(FILE);
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, &text[..text.len() / 2]).unwrap();

        let again = cached(&fixture_files(), &hers(), "12.0.5.67823", temp.path()).unwrap();
        assert_eq!(again.len(), whole.len());
        // And nothing of the half-written file is left where the next run would read it.
        assert!(!temp.path().join(PARTIAL).exists());
    }
}
