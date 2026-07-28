//! What a click costs, counted rather than timed.
//!
//! Putting an outfit on the character was over two seconds and is on its way to a tenth of
//! one, a step at a time — and every step of that is somebody deciding to stop doing a piece
//! of work twice. What keeps a later change from quietly putting it back is a test, and the
//! only test that can say so in CI is one that counts the work rather than clocking it: a
//! stopwatch on a shared runner measures the runner it got, and would either fail on a slow
//! afternoon or pass through a change that doubled the reads.
//!
//! So this counts. Files read out of the game's storage, how many of those were files it had
//! already decoded, rows walked out of the tables, and — for the half that happens in the
//! browser — how many bytes the `.glb` ships and how much of what it ships anything draws.
//!
//! **Where the counting happens is part of what it means.** [`Counted`] goes at the *bottom*
//! of the stack, underneath [`crate::casc::Remembered`], because a read that is answered from
//! memory costs nothing and counting it as work would make a ceiling say the opposite of what
//! it is for.
//!
//! **The ceilings are a ratchet.** Each number below is the work as it stands, asserted from
//! above, and the change that lowers one lowers its ceiling in the same commit. A number that
//! goes up is either a fact about the fixtures that moved or a regression, and both are worth
//! stopping for.
//!
//! **What the fixtures can and cannot say.** The fixture body is 200 vertices where a real one
//! is a quarter of a million, so the suite here guards *ratios* and *counts* — how many reads,
//! how many of them repeats, how many rows walked, how much of the geometry is referenced —
//! and never megabytes. The megabytes are `trace_render` against an install, which prints the
//! same two structures for a real outfit and is where a claim about payload size has to come
//! from. On build 12.0.5.67823, `set/5570`, eight pieces:
//!
//! | | first click | every click after |
//! |---|---|---|
//! | files read | 51 | **0** |
//! | bytes those reads decoded | 112.1 MB | **0** |
//! | rows walked | 1,810,174 | 1,810,174 |
//! | `.glb` | 2.83 MB, 6,474 vertices in 4 meshes | the same |
//! | her body | ships 4,894 and draws 4,894 — 100% | the same |
//!
//! Every walk left is one per table, and what remains is the large ones being read end to end
//! once each. The vertex share is all of it because [`crate::glb::write`] carries a vertex
//! only where something points at it: the same `.glb` was 10.36 MB and 253,251 vertices when
//! the body shipped every variant of every geoset and drew a fortieth of them.
//!
//! # A page of the wardrobe, which is twenty of them
//!
//! [`crate::gallery`] draws twenty appearances at once, each on a body of its own, and it is the
//! first thing in this app whose cost is a multiple of something a reader chose. So the second
//! half of this module's tests is a page rather than a click, and it asserts the two properties
//! the gallery is built on rather than a total: **the body is built once** for the whole page,
//! and **each table is walked once**. A page of twenty walks 279 rows against a single
//! eight-piece click's 407, which is what "walked once" buys.
//!
//! Two of the counters exist only because of that page. [`Work::atlases`] and [`Work::encodes`]
//! are the `atlas.base` and `character.atlas_png` spans — 27ms and 12ms of a click on a real
//! install, the two largest things issue #99 left behind, and the two that nothing here could
//! put a ceiling on: neither is a file read or a table walk, so a change that did them twenty
//! times over would have passed every test above.
//!
//! The set grid is drawn the same way and asserted for the same two properties, one page further
//! out: every card there is a whole outfit rather than one appearance, and the tables walked once
//! for it include the five behind saying what a set is made of. See
//! `builds_one_body_for_a_whole_page_of_sets`.
//!
//! And there is **one clock**, in `draws_a_page_faster_than_the_same_rows_one_at_a_time`, which
//! is not a contradiction of the paragraph at the top. It times two things on the same runner
//! seconds apart and asserts a *ratio* between them, and a ratio is what a shared runner can
//! still be trusted for: whatever makes the machine slow makes both sides slow. An absolute
//! millisecond ceiling is the thing that cannot be run in CI, not a stopwatch as such.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::casc::GameFiles;

/// What one run of the pipeline was counted doing.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Work {
    /// Every read that reached the storage, repeats included — which is every file actually
    /// inflated, rather than every file asked for.
    pub reads: usize,
    /// How many of those reached it for a file it had already decoded this run. Zero is what
    /// it should be: `crate::casc::Remembered` sits above and answers the second ask.
    pub repeated: usize,
    /// Bytes those reads decoded, which is what they cost.
    pub read_bytes: usize,
    /// Rows [`crate::db2::Db2::rows`] materialised, summed over every walk of every table.
    /// A walk costs the whole table however few rows the caller keeps, so this counts the
    /// table and not the answer.
    pub rows: usize,
    /// How many times a skin was resized onto a fresh 2048 × 1024 body atlas — the `atlas.base`
    /// span, and 27ms of a click whatever the install.
    ///
    /// Here because it was the largest thing left in issue #99 that nothing counted. The reads
    /// and the rows above are facts about the game's storage, and a change that stopped reading
    /// a file twice showed up in them; a change that stopped *resizing the same two million
    /// pixels* twenty times over showed up in neither, so a ceiling could not be put on it.
    pub atlases: usize,
    /// How many times one was encoded to PNG — the `character.atlas_png` span, and the other
    /// half of the same blind spot.
    pub encodes: usize,
}

/// A source of game files that keeps the receipts.
///
/// **Put it at the bottom of the stack, under whatever the app puts above it.** What a ceiling
/// here is worth depends on where the counting happens: above
/// [`crate::casc::Remembered`] this would count asks, and asks are free once the answer is in
/// hand. Underneath it, a read is a file inflated, which is the thing that costs 190ms.
///
/// Long-lived on purpose, and [`restart`](Counted::restart) between runs — because the cache
/// above it is long-lived too, and a counter that had to be built per run could only ever be
/// built above the cache.
pub struct Counted<'a> {
    files: &'a dyn GameFiles,
    seen: RefCell<HashMap<u32, usize>>,
    reads: Cell<usize>,
    bytes: Cell<usize>,
}

impl<'a> Counted<'a> {
    pub fn over(files: &'a dyn GameFiles) -> Self {
        Self {
            files,
            seen: RefCell::new(HashMap::new()),
            reads: Cell::new(0),
            bytes: Cell::new(0),
        }
    }

    /// Zeroes everything, so the next run is counted on its own.
    ///
    /// The three thread-local counters too, which is why this and not just dropping the struct:
    /// they belong to nothing that can be dropped.
    pub fn restart(&self) {
        self.seen.borrow_mut().clear();
        self.reads.set(0);
        self.bytes.set(0);
        for counter in [&ROWS, &ATLASES, &ENCODES] {
            counter.with(|count| count.set(0));
        }
    }

    /// What has been counted since the last [`restart`](Counted::restart).
    pub fn work(&self) -> Work {
        let seen = self.seen.borrow();
        Work {
            reads: self.reads.get(),
            repeated: seen.values().map(|asked| asked - 1).sum(),
            read_bytes: self.bytes.get(),
            rows: ROWS.with(Cell::get),
            atlases: ATLASES.with(Cell::get),
            encodes: ENCODES.with(Cell::get),
        }
    }
}

impl GameFiles for Counted<'_> {
    fn read(&self, fdid: u32) -> Result<Arc<Vec<u8>>, String> {
        // Counted whether or not it succeeds: a read that fails still went and looked, and a
        // file this install does not hold is asked for once per ask like any other.
        self.reads.set(self.reads.get() + 1);
        *self.seen.borrow_mut().entry(fdid).or_insert(0) += 1;
        let bytes = self.files.read(fdid)?;
        self.bytes.set(self.bytes.get() + bytes.len());
        Ok(bytes)
    }
}

/// Runs something against the game's files and says what it cost.
///
/// The plain case: no cache above, one run, counted from nothing. Anything holding a storage
/// between runs — the app, `trace_render` — wants [`Counted`] itself instead, kept underneath
/// what it holds.
pub fn counting<T>(files: &dyn GameFiles, run: impl FnOnce(&dyn GameFiles) -> T) -> (T, Work) {
    let counted = Counted::over(files);
    counted.restart();
    let answer = run(&counted);
    (answer, counted.work())
}

thread_local! {
    /// Rows walked since the last [`counting`] on this thread. Every read of the game's files
    /// happens on one thread — the command's worker, the example's main — so a counter per
    /// thread is a counter per run, and a test walking tables of its own cannot disturb one
    /// running beside it.
    static ROWS: Cell<usize> = const { Cell::new(0) };
    /// Body atlases built from a skin, on the same terms.
    static ATLASES: Cell<usize> = const { Cell::new(0) };
    /// Body atlases encoded to PNG, on the same terms.
    static ENCODES: Cell<usize> = const { Cell::new(0) };
}

/// Notes that a table walk materialised `rows` of them.
///
/// Called from [`crate::db2::Db2::rows`], which is the one place that decides how much of a
/// table a caller pays for. An increment of a thread-local `Cell` is a couple of nanoseconds
/// against a walk that is milliseconds, so this stays in the shipped build rather than behind
/// a feature: a counter that only exists in test builds cannot be printed by `trace_render`
/// against a real install, which is where the numbers that matter are.
pub(crate) fn note_rows(rows: usize) {
    ROWS.with(|walked| walked.set(walked.get() + rows));
}

/// Notes that a skin was resized onto a fresh body atlas. Called from
/// [`crate::character::Atlas::base`], on the same terms as [`note_rows`].
pub(crate) fn note_atlas() {
    ATLASES.with(|built| built.set(built.get() + 1));
}

/// Notes that a body atlas was encoded to PNG. Called from
/// [`crate::character::Atlas::png`], on the same terms.
pub(crate) fn note_encode() {
    ENCODES.with(|encoded| encoded.set(encoded.get() + 1));
}

/* ---------- the payload ---------- */

/// One mesh of a scene: what it carries and what anything points at.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    /// Vertices the file carries for this mesh.
    pub shipped: usize,
    /// Distinct vertices some primitive's indices actually point at. Equal to `shipped` since
    /// [`crate::glb::write`] stopped carrying the rest; it was 1.3% of it before, because
    /// hiding a geoset drops its triangles and leaves its vertices behind.
    pub drawn: usize,
}

impl Geometry {
    /// What share of the shipped vertices anything draws, as a percentage.
    pub fn drawn_share(&self) -> f64 {
        match self.shipped {
            0 => 0.0,
            shipped => 100.0 * self.drawn as f64 / shipped as f64,
        }
    }
}

/// What a `.glb` ships, and how much of what it ships is drawn.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Payload {
    /// The whole file, which is what crosses to the window base64-encoded and so a third
    /// larger again.
    pub bytes: usize,
    /// One entry per mesh, in the order the file lists them — which is the order
    /// [`crate::glb::write`] was handed the pieces, so the first is the character herself and
    /// the rest are what hangs off her.
    pub meshes: Vec<Geometry>,
}

impl Payload {
    /// The body itself, which is the first mesh a scene holds.
    ///
    /// Worth apart from the rest because it is the largest thing in the file by far and the
    /// one the ratio was always about: a quarter of a million vertices in the game's own mesh,
    /// of which a dressed body draws about 2%.
    pub fn body(&self) -> Geometry {
        self.meshes.first().copied().unwrap_or_default()
    }

    /// Vertices the file carries, across every mesh in it.
    pub fn shipped(&self) -> usize {
        self.meshes.iter().map(|mesh| mesh.shipped).sum()
    }

    /// Vertices anything in it draws.
    pub fn drawn(&self) -> usize {
        self.meshes.iter().map(|mesh| mesh.drawn).sum()
    }
}

/// Reads a `.glb` back and counts what it holds.
///
/// Written against the file rather than against the [`crate::m2::Mesh`] it came from on
/// purpose: the question is what the window is handed, and between the mesh and the file sit
/// the parts that get filtered out, the accessors the pieces share and the container's own
/// padding. A count taken before any of that is a count of something nobody downloads.
pub fn payload_of(glb: &[u8]) -> Result<Payload, String> {
    let (scene, bin) = split(glb)?;
    let accessors = scene["accessors"].as_array().map_or(&[][..], |all| all.as_slice());
    let views = scene["bufferViews"].as_array().map_or(&[][..], |all| all.as_slice());

    // Vertices are counted per POSITION accessor rather than per primitive, because
    // `glb::write` gives each piece one that every one of its primitives shares — a body
    // counted per part would be counted thirteen times. The drawn set is keyed by it for the
    // same reason and one more: index 7 of a helm is not index 7 of the body.
    let mut meshes = Vec::new();
    for mesh in scene["meshes"].as_array().unwrap_or(&Vec::new()) {
        let mut shipped: HashMap<usize, usize> = HashMap::new();
        let mut drawn: HashSet<(usize, u32)> = HashSet::new();
        for primitive in mesh["primitives"].as_array().unwrap_or(&Vec::new()) {
            let Some(positions) = number(&primitive["attributes"]["POSITION"]) else {
                continue;
            };
            let count = accessors
                .get(positions)
                .and_then(|accessor| number(&accessor["count"]))
                .ok_or("a primitive names a POSITION accessor the file does not hold")?;
            shipped.insert(positions, count);

            let Some(indices) = number(&primitive["indices"]) else {
                continue;
            };
            for index in indices_of(accessors, views, bin, indices)? {
                drawn.insert((positions, index));
            }
        }
        meshes.push(Geometry {
            shipped: shipped.values().sum(),
            drawn: drawn.len(),
        });
    }

    Ok(Payload {
        bytes: glb.len(),
        meshes,
    })
}

/// The JSON chunk and the binary one, which is all a `.glb` is under its header.
fn split(glb: &[u8]) -> Result<(serde_json::Value, &[u8]), String> {
    let word = |at: usize| -> Result<usize, String> {
        glb.get(at..at + 4)
            .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()) as usize)
            .ok_or_else(|| "the file ends inside its own header".to_string())
    };
    if word(0)? != 0x4654_6c67 {
        return Err("not a .glb".into());
    }
    let json_length = word(12)?;
    let json = glb
        .get(20..20 + json_length)
        .ok_or("the file ends inside its JSON chunk")?;
    let scene = serde_json::from_slice(json)
        .map_err(|error| format!("the .glb's JSON will not parse: {error}"))?;
    let bin_at = 20 + json_length;
    let bin_length = word(bin_at)?;
    let bin = glb
        .get(bin_at + 8..bin_at + 8 + bin_length)
        .ok_or("the file ends inside its binary chunk")?;
    Ok((scene, bin))
}

/// The values one index accessor holds.
///
/// Only the one component type, because there is only one writer: [`crate::glb::write`] writes
/// every index list as `u32` scalars. A file from anywhere else would want the other three
/// widths, and this is not a glTF reader.
fn indices_of(
    accessors: &[serde_json::Value],
    views: &[serde_json::Value],
    bin: &[u8],
    accessor: usize,
) -> Result<Vec<u32>, String> {
    let accessor = accessors
        .get(accessor)
        .ok_or("a primitive names an index accessor the file does not hold")?;
    if number(&accessor["componentType"]) != Some(5125) {
        return Err("an index accessor is not the u32 this app writes".into());
    }
    let count = number(&accessor["count"]).ok_or("an index accessor declares no count")?;
    let view = views
        .get(number(&accessor["bufferView"]).ok_or("an index accessor names no buffer view")?)
        .ok_or("an index accessor names a buffer view the file does not hold")?;
    let at = number(&view["byteOffset"]).unwrap_or(0) + number(&accessor["byteOffset"]).unwrap_or(0);
    let bytes = bin
        .get(at..at + count * 4)
        .ok_or("an index accessor reaches past the binary chunk")?;
    Ok(bytes
        .chunks_exact(4)
        .map(|value| u32::from_le_bytes(value.try_into().unwrap()))
        .collect())
}

fn number(value: &serde_json::Value) -> Option<usize> {
    usize::try_from(value.as_u64()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, DirFiles, Remembered};
    use crate::{character, transmog, worn};

    /// The fixture set a click is measured on: `Tideglass Regalia`, whose pieces are the ones
    /// with geometry as well as the ones that are only paint, so the count covers both halves
    /// of what an outfit makes the pipeline do.
    const SET: u32 = 201;

    /// The two commands one click sends, run as the window sends them.
    ///
    /// `transmog_set_items` and then `worn_set` — the first is what the row the reader clicked
    /// resolves to and the second is what draws it, and both read the game's tables, so a
    /// count of either alone is a count of half a click.
    fn click(files: &dyn GameFiles) -> Vec<u8> {
        let payload = transmog::set_items(files, SET).expect("the fixture holds set 201");
        let pieces: Vec<worn::Piece> = payload["appearances"]
            .as_array()
            .expect("a set answers with its appearances")
            .iter()
            .filter_map(|appearance| {
                let number = |key: &str| appearance[key].as_u64().unwrap_or(0) as u32;
                let display_info_id = number("displayInfoId");
                (display_info_id != 0).then_some(worn::Piece {
                    display_info_id,
                    display_type: number("displayType"),
                    inventory_type: number("inventoryType"),
                })
            })
            .collect();
        assert!(!pieces.is_empty(), "the fixture set has to dress her in something");
        let body = crate::body::of(files, crate::body::DEFAULT).expect("the fixture body");
        let worn = worn::of_set(files, &body, &pieces).expect("the fixture outfit resolves");
        character::glb_of(files, Some(&worn), &character::Who::default())
            .expect("the fixture outfit draws")
    }

    /// One click through the stack the app has: the storage, the counter under everything so
    /// that a read is counted where it costs something, and `Remembered` over it.
    fn cost() -> (Payload, Work) {
        let files = fixture_files();
        let counted = Counted::over(&files);
        let remembered = Remembered::over(&counted);
        counted.restart();
        let glb = click(&remembered);
        (
            payload_of(&glb).expect("what the pipeline wrote is a .glb"),
            counted.work(),
        )
    }

    /* ---------- the ratchet ---------- */

    // Every read that reaches the storage is a file inflated, and on a real install the 51 of
    // them are 117MB and 190ms of a 450ms click.
    //
    // Seven of them are the body itself, and none of them used to be read at all. Three say how
    // it is painted — `ChrModel`, its layout's sections and that layout's atlas size — and four
    // say which body it is: `ChrRaces` and `ChrRaceXChrModel` for the races a person can be, and
    // then `CreatureDisplayInfo` and `CreatureModelData` for the mesh, which used to be a table
    // of two constants and is now the far end of a chain. All seven were constants in
    // `character.rs` when there was one body; there are fifty-one now.
    //
    // Five of the seven are among the smallest tables on any of these chains — 107, 772, 336, 58
    // and 116 rows against `ItemDisplayInfoMaterialRes`'s 604,000. The other two are not, and
    // `CreatureDisplayInfo`'s 119,000 rows are the price of every playable race: see
    // `body::offered`, which pays it once for the whole list rather than once per body.
    #[test]
    fn reads_no_more_files_than_it_used_to() {
        let (_, work) = cost();
        assert!(work.reads <= 46, "a click now reads {} files", work.reads);
    }

    // Zero, and it stays zero. `TextureFileData` is read by both `worn` and `skin`,
    // `ItemDisplayInfo` by both `transmog` and `worn`; neither was worth untangling once
    // `Remembered` sits underneath them both and answers the second ask from the first.
    #[test]
    fn inflates_nothing_twice() {
        let (_, work) = cost();
        assert_eq!(work.repeated, 0, "a click inflated {} files twice", work.repeated);
    }

    // And the whole point of remembering: the same click again decodes nothing. On a real
    // install that is 117MB not inflated and 190ms not spent, on every click after the first.
    //
    // Bytes rather than reads, because one read does happen again: the fixture tables name a
    // texture the fixture directory holds no file for, and a read that found nothing is
    // deliberately not remembered — an install being patched under the app can fail a read and
    // answer the same one a moment later. It costs a look at the filesystem and decodes
    // nothing, which is what this asserts.
    #[test]
    fn decodes_nothing_again_for_the_same_click() {
        let files = fixture_files();
        let counted = Counted::over(&files);
        let remembered = Remembered::over(&counted);
        click(&remembered);

        counted.restart();
        click(&remembered);
        let again = counted.work();
        assert_eq!(
            again.read_bytes, 0,
            "the second click decoded {} bytes again",
            again.read_bytes
        );
    }

    // `Db2::rows` materialises every row of a table before it yields the first, so a walk costs
    // the whole table however few rows the caller keeps. Every walk left is one per table, and
    // a real click is 1.8 million rows — `ItemSparse` and `ChrCustomizationElement` being large
    // and read end to end.
    #[test]
    fn walks_no_more_rows_than_it_used_to() {
        let (_, work) = cost();
        assert!(work.rows <= 407, "a click walks {} rows", work.rows);
    }

    // What the body ships now depends on what is worn, and that is the point: a body holds
    // every variant of every geoset at once, so the file carries the vertices some primitive
    // points at and renumbers the indices to match. Dressing her changes which those are.
    //
    // This is where the invariant that used to be asserted here went. It said the body ships
    // the same vertices whatever is worn, and it was the ground under a plan to send the body
    // once and only the atlas per click. `glb::Kept` took that plan's reason away rather than
    // breaking it: what a click now carries is 2.8MB of which the geometry is ~0.3MB, so
    // sending the body once would save a tenth of the payload and cost the window a cache.
    #[test]
    fn hangs_what_she_wears_off_her_as_meshes_of_its_own() {
        let files = fixture_files();
        let bare = payload_of(&character::glb_of(&files, None, &character::Who::default()).expect("the bare body draws"))
            .expect("a .glb");
        let dressed = payload_of(&click(&files)).expect("a .glb");
        assert!(
            dressed.meshes.len() > bare.meshes.len(),
            "the fixture outfit has to hang something off her"
        );
    }

    // It used to be that 98% of a real body's `.glb` was vertices no index pointed at —
    // 248,958 shipped and 4,894 drawn — because hiding a geoset drops its triangles and keeps
    // its vertices. `glb::Kept` carries only the ones something draws, so the share is all of
    // it, and every mesh in the scene rather than only the body. Asserted from *below*,
    // because this is the one number the work here is meant to push up rather than down.
    #[test]
    fn draws_no_smaller_a_share_of_what_it_ships_than_it_used_to() {
        let (payload, _) = cost();
        assert!(payload.body().shipped > 0, "the .glb ships no body at all");
        for (which, mesh) in payload.meshes.iter().enumerate() {
            assert!(
                mesh.drawn_share() >= 100.0,
                "only {:.1}% of mesh {which}'s {} vertices are drawn",
                mesh.drawn_share(),
                mesh.shipped,
            );
        }
    }

    /* ---------- a page of the wardrobe ---------- */

    /// The appearances a page is measured on, as `(display, display type, inventory type)`.
    ///
    /// Ten of the fixture's displays, chosen so that the page covers both halves of what a
    /// wardrobe holds: four of them hang geometry off the body — a helm, two pairs of shoulders
    /// and a weapon — and six are texture painted onto it. A page of nothing but helms would
    /// never encode a second atlas, and a page of nothing but chestpieces would never read the
    /// skeleton, so a page of one kind measures half the work.
    ///
    /// The three the fixtures deliberately break are left out and belong to other tests: 900010
    /// names a model file the directory omits, 900011 names one that will not parse, and 900900
    /// is a display in a section the game encrypts.
    const WARDROBE: [(u32, u32, u32); 10] = [
        (900_001, 0, 0),   // head
        (900_002, 1, 0),   // shoulders
        (900_003, 3, 0),   // chest
        (900_004, 6, 0),   // feet
        (900_005, 8, 0),   // hands
        (900_006, 5, 0),   // legs
        (900_007, 11, 13), // a two-hander
        (900_008, 2, 0),   // shirt
        (900_009, 1, 0),   // shoulders whose model sits in the second slot
        (900_012, 3, 0),   // a robe
    ];

    /// How many rows a page of the wardrobe holds.
    ///
    /// Twenty, which is what the window draws at a time and what issue #129 asks about. The
    /// fixtures hold ten usable displays, so the page names each of them twice.
    ///
    /// **That repetition understates one number and only one.** A file read for the second copy
    /// is answered by `Remembered` and never reaches the counter, so a real page of twenty
    /// distinct items reads more textures than this one does. Everything else is per row and
    /// unaffected: the tables are walked once either way, and each row still dresses a body,
    /// paints an atlas and writes a `.glb` of its own.
    const PAGE: usize = 20;

    fn page() -> Vec<worn::Piece> {
        (0..PAGE)
            .map(|row| {
                let (display_info_id, display_type, inventory_type) = WARDROBE[row % WARDROBE.len()];
                worn::Piece {
                    display_info_id,
                    display_type,
                    inventory_type,
                }
            })
            .collect()
    }

    /// What one page of the wardrobe cost, through the stack the app has.
    fn page_cost(pieces: &[worn::Piece]) -> Work {
        let files = fixture_files();
        let counted = Counted::over(&files);
        let remembered = Remembered::over(&counted);
        counted.restart();
        let answer = crate::gallery::of(&remembered, pieces, &character::Who::default()).expect("the fixture page draws");
        assert_eq!(
            answer["models"].as_array().map(Vec::len),
            Some(pieces.len()),
            "a page answers for every row of itself"
        );
        counted.work()
    }

    /// The same appearances asked for one page at a time, which is the loop the batch replaces.
    fn one_at_a_time(pieces: &[worn::Piece]) -> Work {
        let files = fixture_files();
        let counted = Counted::over(&files);
        let remembered = Remembered::over(&counted);
        counted.restart();
        for piece in pieces {
            crate::gallery::of(&remembered, std::slice::from_ref(piece), &character::Who::default()).expect("a row draws");
        }
        counted.work()
    }

    // The body is read, resized and composited once for the whole page rather than once per row.
    // This is the largest single claim the gallery makes: `atlas.base` is 27ms on a real install
    // and was the biggest thing left in issue #99, and twenty of them is most of a page.
    #[test]
    fn builds_one_body_for_a_whole_page() {
        assert_eq!(page_cost(&page()).atlases, 1);
    }

    // And encodes one atlas per row that actually paints something into it, rather than one per
    // row. Six of the ten displays paint; the other four are geometry hung off a body whose
    // atlas is the bare one, and they share a single encode of it.
    //
    // Asserted against the page's own composition rather than as a bare number, because the
    // fixture wardrobe is what decides it and a display that changed kind should move this.
    #[test]
    fn encodes_an_atlas_only_for_the_rows_that_paint_one() {
        let painting = page()
            .iter()
            .filter(|piece| {
                !worn::of(
                    &fixture_files(),
                    &crate::body::of(&fixture_files(), crate::body::DEFAULT).expect("a body"),
                    piece.display_info_id,
                    piece.display_type,
                    piece.inventory_type,
                )
                .expect("the fixture display resolves")
                .textures
                .is_empty()
            })
            .count();
        assert!(painting > 0 && painting < PAGE, "the page has to hold both kinds");
        assert_eq!(page_cost(&page()).encodes, painting + 1);
    }

    // Every table is walked once for the page, not once per row. `Db2::rows` materialises the
    // whole table before it yields the first row, so this is the difference between walking
    // `ItemDisplayInfoMaterialRes` — 604,000 rows on a shipping install — once and twenty times.
    #[test]
    fn walks_the_tables_once_for_a_whole_page() {
        let pieces = page();
        let batched = page_cost(&pieces);
        let apart = one_at_a_time(&pieces);
        assert!(
            batched.rows * 8 < apart.rows,
            "a page walked {} rows against {} for the same items one at a time",
            batched.rows,
            apart.rows,
        );
    }

    // Each of the game's tables is opened once for the page rather than once per row. Counted
    // with nothing above the storage, unlike every other test here, and deliberately: with
    // `Remembered` in the way a loop reads each table once too, and what this is about is the
    // module underneath rather than the cache over it.
    #[test]
    fn opens_each_table_once_for_a_whole_page() {
        let files = fixture_files();
        let pieces = page();
        let (_, batched) = counting(&files, |files| crate::gallery::of(files, &pieces, &character::Who::default()));
        let (_, apart) = counting(&files, |files| {
            for piece in &pieces {
                crate::gallery::of(files, std::slice::from_ref(piece), &character::Who::default()).expect("a row draws");
            }
        });
        assert!(
            batched.reads * 4 < apart.reads,
            "a page opened {} files against {} for the same rows one at a time",
            batched.reads,
            apart.reads,
        );
    }

    // The ratchet, as elsewhere in this module: the work as it stands, asserted from above.
    //
    // The rows are worth looking at beside the click's 407: twenty rows of a wardrobe walk fewer
    // tables' worth of rows than one eight-piece outfit does, because a walk costs the whole
    // table and a page pays for one walk of each.
    //
    // **This page is a worst case the window cannot actually ask for**, and the row ceiling is
    // what that costs. A gallery draws armour on a body and a weapon as its own mesh, and those
    // are two subsystems reading an overlapping set of tables — so a page holding both walks
    // `ItemDisplayInfo` and the two model tables once for each half. Every kind the window
    // offers is one armour slot or the held ones and never a mix (see `wardrobe.ts`), so a real
    // page takes one branch or the other; the two tests below are what those cost. Mixing them
    // here is deliberate all the same, because it is the arrangement that measures both.
    #[test]
    fn draws_a_page_within_what_it_costs_today() {
        let work = page_cost(&page());
        assert!(work.reads <= 57, "a page reads {} files", work.reads);
        assert!(work.rows <= 279, "a page walks {} rows", work.rows);
        // Not zero, and for the reason `decodes_nothing_again_for_the_same_click` gives: the
        // fixture tables name a texture the fixture directory holds no file for, and a read that
        // found nothing is deliberately not remembered. The page names each display twice, so
        // that absent file is looked for twice. It costs a look at the filesystem and inflates
        // nothing.
        assert!(
            work.repeated <= PAGE / WARDROBE.len(),
            "a page inflated {} files twice",
            work.repeated,
        );
    }

    /// A page of one kind, which is the only kind of page the window ever asks for.
    ///
    /// Every kind in the picker is either one armour slot or the seventeen things held in a
    /// hand, so a reader is looking at heads, or at staves, and never at both. `of` splits on
    /// exactly that, and these two are what each side costs on its own.
    fn page_of(pieces: &[(u32, u32, u32)]) -> Work {
        let rows: Vec<worn::Piece> = (0..PAGE)
            .map(|row| {
                let (display_info_id, display_type, inventory_type) = pieces[row % pieces.len()];
                worn::Piece {
                    display_info_id,
                    display_type,
                    inventory_type,
                }
            })
            .collect();
        page_cost(&rows)
    }

    // A page of weapons never builds the body, which is the single largest thing a gallery
    // touches: her mesh, her skin resized onto a 2048x1024 atlas, her face composited over that,
    // and a 16MB skeleton. Seventeen of the thirty kinds a reader can pick are held in a hand,
    // so this is the common page rather than the exotic one.
    #[test]
    fn builds_no_body_and_paints_no_atlas_for_a_page_of_weapons() {
        let work = page_of(&[(900_007, 11, 13)]);
        assert_eq!(work.atlases, 0, "a page of weapons built a body");
        assert_eq!(work.encodes, 0, "a page of weapons painted an atlas");
    }

    // And is cheaper than the mixed page above by more than the rows it left out, because what
    // it left out is a whole subsystem rather than a share of one.
    #[test]
    fn draws_a_page_of_weapons_for_less_than_a_page_that_needs_a_body() {
        let carried = page_of(&[(900_007, 11, 13)]);
        let worn = page_of(&[(900_003, 3, 0)]);
        assert!(
            carried.rows < worn.rows,
            "a page of weapons walked {} rows against {} for a page of chestpieces",
            carried.rows,
            worn.rows,
        );
        assert!(
            carried.read_bytes < worn.read_bytes,
            "a page of weapons read {} bytes against {}",
            carried.read_bytes,
            worn.read_bytes,
        );
    }

    /// How much of the time twenty rows take a batch is allowed to spend, against the same
    /// twenty asked for one at a time.
    ///
    /// **A ratio, and that is the whole reason there is a clock in this file at all.** Everything
    /// above counts, because a stopwatch on a shared runner measures the runner it got. A ratio
    /// of two measurements taken on the same runner, seconds apart, does not: whatever makes the
    /// machine slow makes both sides slow, and what is left is the thing being asserted. So this
    /// is a wall-clock expectation that can be run in CI without being a flake, which the issue
    /// asks for and which nothing here had.
    ///
    /// The number is generous against what the fixtures actually do — the batch runs in about a
    /// third of the loop — because the point is to catch the sharing being undone rather than to
    /// pin the machine down. What it rules out is somebody rebuilding the body per row, which is
    /// the change that would take a page from half a second back to eight.
    const SHARE_OF_THE_LOOP: f64 = 0.7;

    fn taking(run: impl FnOnce()) -> std::time::Duration {
        let started = std::time::Instant::now();
        run();
        started.elapsed()
    }

    // One run of each side rather than the best of several, which is the usual way to steady a
    // wall clock. The page takes about a second here and the loop several, so best-of-three was
    // a minute of the suite — and the headroom does the same job: the ratio the fixtures give is
    // comfortably inside the ceiling above, and no amount of runner noise walks it across.
    #[test]
    fn draws_a_page_faster_than_the_same_rows_one_at_a_time() {
        let pieces = page();
        let files = fixture_files();
        let remembered = Remembered::over(&files);
        // Once through everything first, so that neither side is the one paying for whatever the
        // operating system and the allocator were going to warm up anyway.
        crate::gallery::of(&remembered, &pieces[..1], &character::Who::default()).expect("a row draws");

        let batched =
            taking(|| { crate::gallery::of(&remembered, &pieces, &character::Who::default()).expect("the page draws"); });
        let apart = taking(|| {
            for piece in &pieces {
                crate::gallery::of(&remembered, std::slice::from_ref(piece), &character::Who::default()).expect("a row draws");
            }
        });

        assert!(
            batched.as_secs_f64() <= apart.as_secs_f64() * SHARE_OF_THE_LOOP,
            "a page took {batched:?} against {apart:?} for the same rows one at a time",
        );
    }

    /* ---------- a page of the set grid, which is twenty outfits ---------- */

    /// The sets the fixtures hold something wearable in, which is what a page of the grid is.
    ///
    /// Eight rather than twenty, because eight is what the fixtures have — and the properties
    /// below are about sharing rather than about a total, so the number only has to be more
    /// than one. Set 205 is in it deliberately: its one readable row names a display the game
    /// encrypts, which is the row that has to cost the page nothing.
    const SET_PAGE: [u32; 8] = [201, 202, 203, 204, 205, 206, 207, 208];

    /// What one page of the set grid cost, through the stack the app has.
    fn set_page_cost(set_ids: &[u32]) -> Work {
        let files = fixture_files();
        let counted = Counted::over(&files);
        let remembered = Remembered::over(&counted);
        counted.restart();
        let answer = crate::gallery::sets(&remembered, set_ids, &character::Who::default())
            .expect("the fixture page of sets draws");
        assert_eq!(
            answer["models"].as_array().map(Vec::len),
            Some(set_ids.len()),
            "a page answers for every set of itself"
        );
        counted.work()
    }

    /// The same sets asked for one card at a time, which is the loop the batch replaces.
    fn sets_one_at_a_time(set_ids: &[u32]) -> Work {
        let files = fixture_files();
        let counted = Counted::over(&files);
        let remembered = Remembered::over(&counted);
        counted.restart();
        for set_id in set_ids {
            crate::gallery::sets(&remembered, std::slice::from_ref(set_id), &character::Who::default())
                .expect("a card draws");
        }
        counted.work()
    }

    // The same claim a page of the wardrobe makes, and the one that pays for the whole
    // arrangement: the body is read, resized and composited once for the page rather than once
    // per card — even though every card here is a *whole outfit* rather than one appearance.
    #[test]
    fn builds_one_body_for_a_whole_page_of_sets() {
        assert_eq!(set_page_cost(&SET_PAGE).atlases, 1);
    }

    // And every table is walked once for the page. This is the half a page of sets has that a
    // page of the wardrobe does not: the five tables `set_items` walks to say what one set is
    // made of are walked once here for the whole grid, on top of the six behind dressing her.
    #[test]
    fn walks_the_tables_once_for_a_whole_page_of_sets() {
        let batched = set_page_cost(&SET_PAGE);
        let apart = sets_one_at_a_time(&SET_PAGE);
        assert!(
            batched.rows * 4 < apart.rows,
            "a page of sets walked {} rows against {} for the same sets one at a time",
            batched.rows,
            apart.rows,
        );
    }

    // The ratchet, as elsewhere: the work as it stands, asserted from above.
    #[test]
    fn draws_a_page_of_sets_within_what_it_costs_today() {
        let work = set_page_cost(&SET_PAGE);
        assert!(work.reads <= 62, "a page of sets reads {} files", work.reads);
        assert!(work.rows <= 352, "a page of sets walks {} rows", work.rows);
    }

    /* ---------- the counting itself ---------- */

    #[test]
    fn counts_a_file_read_twice_as_one_repeat() {
        let files = fixture_files();
        let (_, work) = counting(&files, |files| {
            let table = transmog::ITEM_APPEARANCE;
            files.read(table).unwrap();
            files.read(table).unwrap();
            files.read(transmog::ITEM_DISPLAY_INFO).unwrap();
        });
        assert_eq!(work.reads, 3);
        assert_eq!(work.repeated, 1);
        assert!(work.read_bytes > 0);
    }

    // A file the install does not hold is still a read: it was looked for, and the looking is
    // what a count of reads is about.
    #[test]
    fn counts_a_read_that_found_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let files = DirFiles::new(temp.path());
        let (_, work) = counting(&files, |files| assert!(files.read(1).is_err()));
        assert_eq!(work.reads, 1);
        assert_eq!(work.read_bytes, 0);
    }

    #[test]
    fn counts_the_rows_a_table_walk_materialised() {
        let files = fixture_files();
        let (walked, work) = counting(&files, |files| {
            let table = crate::db2::Db2::parse(files.read(transmog::ITEM_APPEARANCE).unwrap())
                .unwrap();
            table.rows().count()
        });
        assert!(walked > 0, "the fixture table has rows");
        assert_eq!(work.rows, walked);
    }

    // Each run starts from nothing, or a suite's worth of clicks would add up into one number
    // and no ceiling would mean anything.
    #[test]
    fn starts_each_run_from_zero() {
        let files = fixture_files();
        let count = |files: &dyn GameFiles| {
            crate::db2::Db2::parse(files.read(transmog::ITEM_APPEARANCE).unwrap())
                .unwrap()
                .rows()
                .count()
        };
        let (_, first) = counting(&files, count);
        let (_, second) = counting(&files, count);
        assert_eq!(first, second);
    }

    /* ---------- reading a .glb back ---------- */

    #[test]
    fn refuses_something_that_is_not_a_glb() {
        assert!(payload_of(b"WDC5 and then some").is_err());
        assert!(payload_of(&[]).is_err());
    }

    // The count is of distinct vertices *pointed at*, not of indices: a body's triangles share
    // their corners, and counting the indices would report three times the geometry there is.
    #[test]
    fn counts_a_vertex_two_triangles_share_once() {
        let files = fixture_files();
        let glb = character::glb_of(&files, None, &character::Who::default()).expect("the bare body draws");
        let payload = payload_of(&glb).unwrap();
        assert!(payload.drawn() <= payload.shipped(), "more drawn than shipped");
        assert_eq!(payload.bytes, glb.len());
    }
}
