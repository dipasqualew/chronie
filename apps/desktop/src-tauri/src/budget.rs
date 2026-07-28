//! What a click costs, counted rather than timed.
//!
//! Putting an outfit on the character was over two seconds and is on its way to a tenth of
//! one, a step at a time — and every step of that is somebody deciding to stop doing a piece
//! of work twice. What keeps a later change from quietly putting it back is a test, and the
//! only test that can say so in CI is one that counts the work rather than clocking it: a
//! stopwatch on a shared runner measures the runner it got, and would either fail on a slow
//! afternoon or pass through a change that doubled the reads.
//!
//! So this counts. Files asked of the game's storage, how many of those asks were for
//! something already in hand, rows walked out of the tables, and — for the half that happens
//! in the browser — how many bytes the `.glb` ships and how much of what it ships anything
//! draws.
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
//! | | counted |
//! |---|---|
//! | files read | 54, three of them twice |
//! | bytes those reads decoded | 117.7 MB |
//! | rows walked | 4,833,642 |
//! | `.glb` | 10.36 MB, 253,251 vertices in 4 meshes |
//! | her body | ships 248,958 and draws 4,894 — 2.0% |

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

use crate::casc::GameFiles;

/// What one run of the pipeline was counted doing.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Work {
    /// Every ask of the game's storage, repeats included.
    pub reads: usize,
    /// How many of those asks were for a file this run had already read. Zero is the
    /// destination: a table inflated once and kept is worth ~200ms of a real click.
    pub repeated: usize,
    /// Bytes handed back, decoded — which is what was inflated, and so what the reads cost.
    pub read_bytes: usize,
    /// Rows [`crate::db2::Db2::rows`] materialised, summed over every walk of every table.
    /// A walk costs the whole table however few rows the caller keeps, so this counts the
    /// table and not the answer.
    pub rows: usize,
}

/// Runs something against the game's files and says what it cost.
///
/// The run is handed a storage of its own rather than the one passed in, so that what it does
/// is counted without anything below it knowing it is being counted. Rows are counted through
/// a thread-local, because a table walk is four calls below here and threading a ledger down
/// to it would put a test's bookkeeping into the shape of the code it tests.
pub fn counting<T>(files: &dyn GameFiles, run: impl FnOnce(&dyn GameFiles) -> T) -> (T, Work) {
    let counted = Counted::over(files);
    ROWS.with(|rows| rows.set(0));
    let answer = run(&counted);
    (answer, counted.work())
}

/// A source of game files that keeps the receipts.
struct Counted<'a> {
    files: &'a dyn GameFiles,
    seen: RefCell<HashMap<u32, usize>>,
    reads: Cell<usize>,
    bytes: Cell<usize>,
}

impl<'a> Counted<'a> {
    fn over(files: &'a dyn GameFiles) -> Self {
        Self {
            files,
            seen: RefCell::new(HashMap::new()),
            reads: Cell::new(0),
            bytes: Cell::new(0),
        }
    }

    fn work(&self) -> Work {
        let seen = self.seen.borrow();
        Work {
            reads: self.reads.get(),
            repeated: seen.values().map(|asked| asked - 1).sum(),
            read_bytes: self.bytes.get(),
            rows: ROWS.with(Cell::get),
        }
    }
}

impl GameFiles for Counted<'_> {
    fn read(&self, fdid: u32) -> Result<Vec<u8>, String> {
        // Counted whether or not it succeeds: a read that fails still went and looked, and a
        // file this install does not hold is asked for once per ask like any other.
        self.reads.set(self.reads.get() + 1);
        *self.seen.borrow_mut().entry(fdid).or_insert(0) += 1;
        let bytes = self.files.read(fdid)?;
        self.bytes.set(self.bytes.get() + bytes.len());
        Ok(bytes)
    }
}

thread_local! {
    /// Rows walked since the last [`counting`] on this thread. Every read of the game's files
    /// happens on one thread — the command's worker, the example's main — so a counter per
    /// thread is a counter per run, and a test walking tables of its own cannot disturb one
    /// running beside it.
    static ROWS: Cell<usize> = const { Cell::new(0) };
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

/* ---------- the payload ---------- */

/// One mesh of a scene: what it carries and what anything points at.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    /// Vertices the file carries for this mesh.
    pub shipped: usize,
    /// Distinct vertices some primitive's indices actually point at. On a real body this is
    /// 1.3% of `shipped`, because hiding a geoset drops its triangles and keeps its vertices.
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
    /// Worth apart from the rest because it is the one that does not change with the outfit,
    /// and because it is where the ratio lives: a quarter of a million vertices of which a
    /// dressed body draws 1.3%.
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
    use crate::casc::{fixture_files, DirFiles};
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
        let worn = worn::of_set(files, &pieces).expect("the fixture outfit resolves");
        character::glb_of(files, Some(&worn)).expect("the fixture outfit draws")
    }

    fn cost() -> (Payload, Work) {
        let files = fixture_files();
        let (glb, work) = counting(&files, click);
        (payload_of(&glb).expect("what the pipeline wrote is a .glb"), work)
    }

    /* ---------- the ratchet ---------- */

    // Every read is an inflate of a table or a texture, and on a real install the 54 of them
    // are 117MB decoded and 190ms of a 450ms click. The storage is opened once already; the
    // files it holds are still read afresh every time.
    #[test]
    fn reads_no_more_files_than_it_used_to() {
        let (_, work) = cost();
        assert!(work.reads <= 41, "a click now reads {} files", work.reads);
    }

    // The one that is meant to reach zero. `TextureFileData` is read by both `worn` and
    // `skin`, `ItemDisplayInfo` by both `transmog` and `worn`, and on a real install the same
    // dozen tables are inflated again on every click of the session.
    #[test]
    fn asks_for_no_more_files_twice_than_it_used_to() {
        let (_, work) = cost();
        assert!(work.repeated <= 2, "a click reads {} files twice", work.repeated);
    }

    // `Db2::rows` materialises every row of a table before it yields the first, so a caller
    // that walks a table once per piece of an outfit pays for the whole table eight times.
    // A real click walks 4.8 million rows for an outfit of eight pieces.
    #[test]
    fn walks_no_more_rows_than_it_used_to() {
        let (_, work) = cost();
        assert!(work.rows <= 450, "a click walks {} rows", work.rows);
    }

    // The invariant behind sending the body once and only the atlas per click: the vertices
    // the body ships do not depend on what is worn. Only what hangs off her is added, and only
    // the atlas painted onto her changes. If this ever stops holding, the plan to send the
    // body once stops being possible, and this is where that is noticed.
    #[test]
    fn ships_the_same_body_whatever_is_worn() {
        let files = fixture_files();
        let bare = payload_of(&character::glb_of(&files, None).expect("the bare body draws"))
            .expect("a .glb");
        let dressed = payload_of(&click(&files)).expect("a .glb");
        assert_eq!(
            bare.body().shipped,
            dressed.body().shipped,
            "dressing her changed the body's vertex count"
        );
        assert!(
            dressed.meshes.len() > bare.meshes.len(),
            "the fixture outfit has to hang something off her"
        );
    }

    // 98% of a real body's `.glb` is vertices no index points at — 248,958 shipped and 4,894
    // drawn — because hiding a geoset drops its triangles and keeps its vertices. The fixture
    // body is 200 vertices where a real one is a quarter of a million, so what the suite can
    // hold still is the share and not the size. Asserted from *below*, because this is the one
    // number the work here is meant to push up rather than down.
    #[test]
    fn draws_no_smaller_a_share_of_what_it_ships_than_it_used_to() {
        let (payload, _) = cost();
        let body = payload.body();
        assert!(body.shipped > 0, "the .glb ships no body at all");
        assert!(
            body.drawn_share() >= 44.0,
            "only {:.1}% of the body's {} vertices are drawn",
            body.drawn_share(),
            body.shipped,
        );
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
        let glb = character::glb_of(&files, None).expect("the bare body draws");
        let payload = payload_of(&glb).unwrap();
        assert!(payload.drawn() <= payload.shipped(), "more drawn than shipped");
        assert_eq!(payload.bytes, glb.len());
    }
}
