//! What one click is allowed to cost, counted rather than timed.
//!
//! Putting an outfit on the character takes about two seconds, and the reasons are all of the
//! same shape: work done more times than it needs to be. The game's storage is opened afresh
//! for every command; a dozen tables are re-inflated for every outfit; a table is walked once
//! per piece where one walk would do; and 98% of the vertices in the `.glb` are never touched
//! by an index. `examples/trace_render` is what put numbers on all of that.
//!
//! **This module is what stops those numbers going back up.** Not by timing anything — a clock
//! in CI measures the runner it happened to get, and a threshold loose enough not to flake is
//! loose enough not to catch anything. What it measures instead is the *work*, which is
//! identical on a fixture and on a 123GB install and identical between two runs on the same
//! machine:
//!
//! - **`reads`** — files asked of the game. Each is a BLTE inflate on a real install, and the
//!   largest single one is 85ms.
//! - **`repeats`** — files asked for a second time, by two callers that do not know about each
//!   other. `TextureFileData` is one, read by both `worn::TextureFiles::read` and `skin::of`,
//!   and it is the one this can see. A real click has a second — `ItemDisplayInfo`, read by
//!   `transmog::set_items` and again by `worn::of_set` — which falls between two Tauri commands
//!   where [`cost_of`] drives only the later of them. So one here means two there.
//! - **`rows_walked`** — rows handed out by [`crate::db2::Db2::rows`], summed. This is the one
//!   that catches a scan put back inside a loop, which is what `worn::sections` does now.
//! - **`glb_bytes`**, **`vertices_shipped`** and **`vertices_drawn`** — the payload, which is
//!   what the browser half of the wait is made of. A vertex nothing references still costs
//!   32 bytes in the file, a base64 expansion on the way across, and a `BufferAttribute` at the
//!   other end.
//!
//! The ceilings live in the tests below, each written next to the number it is guarding and the
//! number it should become. They are a ratchet: when an optimisation lands, the ceiling comes
//! down with it in the same change, and the test is what says by how much.
//!
//! **The fixtures, always.** Nothing here reads an install — `cost_of` takes its files, so the
//! same measurement runs against `--fixtures` in CI and against a real install from
//! `trace_render` when somebody wants to see the absolute numbers.
//!
//! ## What a green suite here does not mean
//!
//! Three things are outside what this can see, and all three are worth knowing before reading a
//! passing run as "the click is fast".
//!
//! **Opening the storage is not measured at all.** `CascFiles::open` is 670ms to 1.47s and is
//! paid per Tauri command, which makes it the largest single cost there is — and `cost_of` is
//! handed its files already open, deliberately, because that is what lets one budget run against
//! a directory of fixtures and a 123GB install alike. Only `trace_render` sees it.
//!
//! **The fixtures are too small to show what the payload wastes.** Their body is 152 vertices at
//! 52% use; a real `humanfemale_hd.m2` ships 248,958 and draws 3,153 of them, which is 8.0MB of
//! a 10.8MB `.glb` that nothing renders. The ratio is guarded here, the megabytes are not.
//!
//! **A click is two commands and this is the second.** `transmog_set_items` runs before
//! `worn_set` and reads tables of its own, `ItemSparse` among them at 85ms. Nothing below counts
//! any of it.

use std::collections::HashSet;

use crate::casc::{Counted, GameFiles};
use crate::db2;
use crate::worn::Piece;

/// What one "put this outfit on the character" cost, in work rather than in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cost {
    /// Files asked of the game's storage, repeats included.
    pub reads: usize,
    /// Of those, the ones that had already been read once in this same click.
    pub repeats: usize,
    /// Rows handed out by every call to `Db2::rows`, summed.
    pub rows_walked: u64,
    /// The `.glb` the window is sent, before the base64 expansion the data URL adds.
    pub glb_bytes: usize,
    /// Vertices written into the file.
    pub vertices_shipped: usize,
    /// Vertices any index actually points at. The gap between the two is dead weight.
    pub vertices_drawn: usize,
}

impl Cost {
    /// The share of the shipped vertices that are drawn, in percent.
    ///
    /// The headline number for the payload, because the absolute counts move with whatever
    /// model the fixtures hold and this ratio does not.
    pub fn vertex_use(&self) -> f64 {
        if self.vertices_shipped == 0 {
            return 100.0;
        }
        100.0 * self.vertices_drawn as f64 / self.vertices_shipped as f64
    }
}

/// Dresses the character and reports what it took, without timing any of it.
///
/// The same call the `worn_set` command makes, so what is counted is what a reader waits for —
/// with the storage handed in, which is the one thing the command does differently and the one
/// thing this cannot measure. Opening CASC is a cost of its own and belongs to `trace_render`.
pub fn cost_of(files: &dyn GameFiles, pieces: &[Piece]) -> Result<Cost, String> {
    let counted = Counted::new(files);
    db2::forget_rows_walked();
    let glb = crate::character::glb_of(&counted, worn(&counted, pieces)?.as_ref())?;
    let rows_walked = db2::rows_walked();

    let asked = counted.asked();
    let mut seen = HashSet::new();
    let repeats = asked.iter().filter(|fdid| !seen.insert(**fdid)).count();

    let (shipped, drawn) = vertices(&glb)?;
    Ok(Cost {
        reads: asked.len(),
        repeats,
        rows_walked,
        glb_bytes: glb.len(),
        vertices_shipped: shipped,
        vertices_drawn: drawn,
    })
}

/// What the outfit puts on the body, or nothing where it is the bare character being asked for.
fn worn(files: &dyn GameFiles, pieces: &[Piece]) -> Result<Option<crate::worn::Worn>, String> {
    if pieces.is_empty() {
        return Ok(None);
    }
    let worn = crate::worn::of_set(files, pieces)?;
    Ok((!worn.is_empty()).then_some(worn))
}

/// How many vertices the `.glb` carries, and how many of them anything draws.
///
/// Read back out of the finished file rather than counted on the way in, because the file is
/// what crosses the IPC and what three.js is handed — a count taken before the writer would be
/// measuring an intention rather than a payload.
///
/// **Everything here is keyed by the POSITION accessor rather than by the mesh it hangs off**,
/// which matters more than it looks. `glb::write_piece` gives every primitive of a piece the
/// same vertex list today, so a mesh could stand in for the list and the arithmetic would come
/// out the same — but only today. A writer that gave each primitive a list of its own would,
/// under the simpler reading, have its vertices counted once instead of once each: the ratio
/// this file exists to guard would go *up* on a change that made the payload larger, which is
/// the one way an instrument can be wrong that a green suite will never tell you about. Two
/// distinct lists are two distinct lists, and index 7 of one is not index 7 of the other.
fn vertices(glb: &[u8]) -> Result<(usize, usize), String> {
    let json = chunk(glb, 0).ok_or("the glb has no JSON chunk")?;
    let bin_at = 12 + 8 + align(json.len());
    let bin = glb.get(bin_at + 8..).ok_or("the glb has no binary chunk")?;
    let root: serde_json::Value =
        serde_json::from_slice(json).map_err(|error| format!("the glb's JSON: {error}"))?;

    let accessors = root["accessors"].as_array().ok_or("the glb lists no accessors")?;
    let views = root["bufferViews"].as_array().ok_or("the glb lists no buffer views")?;
    let number = |value: &serde_json::Value| value.as_u64().unwrap_or(0) as usize;

    let mut lists: HashSet<usize> = HashSet::new();
    let mut drawn: HashSet<(usize, u32)> = HashSet::new();
    for primitive in root["meshes"]
        .as_array()
        .ok_or("the glb lists no meshes")?
        .iter()
        .filter_map(|mesh| mesh["primitives"].as_array())
        .flatten()
    {
        let list = number(&primitive["attributes"]["POSITION"]);
        lists.insert(list);

        let accessor = &accessors[number(&primitive["indices"])];
        let view = &views[number(&accessor["bufferView"])];
        let at = number(&view["byteOffset"]) + number(&accessor["byteOffset"]);
        let count = number(&accessor["count"]);
        let indices = bin
            .get(at..at + count * 4)
            .ok_or("an index buffer runs past the end of the glb")?;
        drawn.extend(
            indices
                .chunks_exact(4)
                .map(|four| (list, u32::from_le_bytes(four.try_into().unwrap()))),
        );
    }
    let shipped = lists.iter().map(|list| number(&accessors[*list]["count"])).sum();
    Ok((shipped, drawn.len()))
}

/// The body of the `which`th chunk of a `.glb`, which is a length, a type and then the bytes.
fn chunk(glb: &[u8], which: usize) -> Option<&[u8]> {
    let mut at = 12;
    for index in 0..=which {
        let length = u32::from_le_bytes(glb.get(at..at + 4)?.try_into().ok()?) as usize;
        if index == which {
            return glb.get(at + 8..at + 8 + length);
        }
        at += 8 + length;
    }
    None
}

/// Chunks are padded to a four-byte boundary.
fn align(length: usize) -> usize {
    length + (4 - length % 4) % 4
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::fixture_files;

    /// The display ids the transmog fixtures hold, as `scripts/make-transmog-fixtures.ts` writes
    /// them, with the slot each is worn in.
    const HELM: (u32, u32) = (900001, 0);
    const SHOULDERS: (u32, u32) = (900002, 1);
    const ROBE: (u32, u32) = (900012, 3);
    const LEGS: (u32, u32) = (900006, 5);
    const BOOTS: (u32, u32) = (900004, 6);
    const GLOVES: (u32, u32) = (900005, 8);
    const CAPE: (u32, u32) = (900013, 9);

    /// A whole outfit: one piece in every slot the fixtures hold an appearance for.
    const OUTFIT: &[(u32, u32)] = &[HELM, SHOULDERS, ROBE, LEGS, BOOTS, GLOVES, CAPE];

    fn pieces(worn: &[(u32, u32)]) -> Vec<Piece> {
        worn.iter()
            .map(|(display_info_id, display_type)| Piece {
                display_info_id: *display_info_id,
                display_type: *display_type,
                inventory_type: 0,
            })
            .collect()
    }

    fn cost(worn: &[(u32, u32)]) -> Cost {
        cost_of(&fixture_files(), &pieces(worn)).unwrap()
    }

    /// One outfit of each shape the pipeline treats differently, and what each is allowed to
    /// cost. Every number is the one this branch measures against the fixtures, so all five are
    /// exactly reproducible — nothing here is a timing and nothing here has a tolerance.
    struct Budget {
        /// What the outfit is, for the failure message.
        what: &'static str,
        worn: &'static [(u32, u32)],
        /// Ceiling. Files asked of the game, repeats included; each is a BLTE inflate on a real
        /// install. Comes down when the tables stop being re-read for every click.
        reads: usize,
        /// Ceiling. Of those, the ones already read once in this same click. Comes down to zero
        /// when the two callers of `TextureFileData` stop asking for it independently.
        repeats: usize,
        /// Ceiling. Rows handed out by `Db2::rows`, summed. The one that catches a scan put back
        /// inside a loop; see [`does_not_walk_the_tables_once_per_piece`] for the marginal cost,
        /// which is the sharper form of the same question.
        rows_walked: u64,
        /// Ceiling. The `.glb` itself, before the base64 expansion the data URL adds.
        glb_bytes: usize,
        /// **Floor**, in percent of shipped vertices that any index points at.
        ///
        /// This guards the *ratio*, not the megabytes, and it has to: the fixtures' body is 152
        /// vertices at 52.63% use, and no fixture can reproduce the 1.3% that a real
        /// `humanfemale_hd.m2` wastes — 8.0MB of a 10.8MB payload that nothing renders. The
        /// absolute number is only visible against an install, and
        /// `cargo run --release --example trace_render` is what prints it. What this catches is
        /// the ratio getting *worse*, which is the same mistake at whatever scale.
        ///
        /// Compacting the vertex lists down to what the surviving geosets reference is what
        /// raises these; anything near 100% would mean it has been done.
        vertex_use: f64,
    }

    /// The budgets, per outfit.
    ///
    /// **These are a ratchet and not a description.** Each is the number this branch measures,
    /// so the suite is green now and any *new* work shows up as a failure with the two numbers
    /// side by side. When an optimisation lands, its own change lowers the ceiling it moved —
    /// that is what makes the milestone a thing the suite knows about rather than a thing
    /// somebody remembers.
    const BUDGETS: &[Budget] = &[
        // The floor. Nothing is worn, so no item table is opened at all: this is the body, its
        // skin profile, the customization chain behind her skin, and the pictures that chain
        // names. Whatever a click costs, it costs at least this.
        Budget {
            what: "bare",
            worn: &[],
            reads: 9,
            repeats: 0,
            rows_walked: 95,
            glb_bytes: 71_200,
            vertex_use: 52.63,
        },
        // One piece, which is what a reader clicking a single appearance asks for.
        Budget {
            what: "one robe",
            worn: &[ROBE],
            reads: 16,
            repeats: 1,
            rows_walked: 154,
            glb_bytes: 71_220,
            vertex_use: 52.63,
        },
        // A whole outfit, which is what a set opens as — and the shape where reading a table
        // once per piece rather than once for the outfit shows up.
        Budget {
            what: "seven pieces",
            worn: OUTFIT,
            reads: 33,
            repeats: 1,
            rows_walked: 254,
            glb_bytes: 76_432,
            vertex_use: 59.09,
        },
    ];

    /// Every dimension of every outfit, in one pass.
    ///
    /// One test walking the table rather than one test per dimension, for two reasons. Dressing
    /// the character is the slowest thing in this file, and a test apiece dressed her again for
    /// every assertion. And a change that moves the cost usually moves several dimensions at
    /// once — one failure listing every breach is a description of what happened, where three
    /// failures each naming a third of it are a puzzle.
    #[test]
    fn an_outfit_costs_no_more_than_it_costs_today() {
        let mut over: Vec<String> = Vec::new();
        for budget in BUDGETS {
            let cost = cost(budget.worn);
            let ceilings: [(&str, u64, u64, &str); 4] = [
                (
                    "files read",
                    cost.reads as u64,
                    budget.reads as u64,
                    "something is asking the game's storage for more than it needs, and every \
                     one of those is a BLTE inflate",
                ),
                (
                    "of them read a second time",
                    cost.repeats as u64,
                    budget.repeats as u64,
                    "a file inflated twice inside one click; on a real install the cheapest of \
                     those is 8ms and the dearest 85ms, paid again for nothing",
                ),
                (
                    "rows walked",
                    cost.rows_walked,
                    budget.rows_walked,
                    "a scan has gone inside a loop, or a table is being read that the app \
                     already has the answer for",
                ),
                (
                    "bytes of .glb",
                    cost.glb_bytes as u64,
                    budget.glb_bytes as u64,
                    "the payload grew, and it is base64 across the IPC and a parse at the far end",
                ),
            ];
            for (what, measured, allowed, why) in ceilings {
                if measured > allowed {
                    over.push(format!(
                        "{}: {measured} {what}, over the {allowed} allowed — {why}",
                        budget.what,
                    ));
                }
            }
            if cost.vertex_use() < budget.vertex_use {
                over.push(format!(
                    "{}: {:.2}% of the shipped vertices are drawn, under the {:.2}% floor — the \
                     `.glb` is carrying a larger share of geometry nothing renders than it was",
                    budget.what,
                    cost.vertex_use(),
                    budget.vertex_use,
                ));
            }
        }
        assert!(
            over.is_empty(),
            "a click costs more than it did:\n{}\n\nThese are counts and not timings, so they \
             moved because the code did, not because CI was busy. Run \
             `cargo run --release --example trace_render` against a real install to see what the \
             extra work costs in milliseconds and where it goes. If it was deliberate, moving \
             the number in `BUDGETS` is part of the change that moved the cost.",
            over.join("\n"),
        );
    }

    /// What the *next* piece costs, which is the sharper form of `rows_walked`.
    ///
    /// A total can absorb a great deal. `worn::of_set` opens each table once for the whole
    /// outfit, so the honest question is not what seven pieces cost but what the seventh cost,
    /// and the answer today is a whole extra pass: `worn::sections` takes the parsed
    /// `ItemDisplayInfoMaterialRes` and calls `Db2::rows` on it once per piece, and `rows` is not
    /// an iterator that stops early — it builds a `Vec` of every row and a `HashMap` of every row
    /// id before it yields the first one. The fixtures' copy of that table is 13 rows, so 13 of
    /// the 17 below are that whole table walked again on behalf of one piece, which keeps the
    /// two or three rows that are its own and drops the rest.
    ///
    /// **After the fix this should approach zero.** One pass that groups the rows by display id,
    /// or an index built once and asked seven times, leaves an extra piece costing no table at
    /// all — so the ceiling comes down to single digits and then to nothing, and it is this test,
    /// not the totals above, that says whether it really did.
    #[test]
    fn does_not_walk_the_tables_once_per_piece() {
        /// Rows an eighth piece is allowed to add. Today's marginal cost is 100 rows over the six
        /// pieces the robe does not account for, so 17 is a hair over what it already does and
        /// nothing more — put a scan back inside a loop and this fails by multiples.
        const PER_EXTRA_PIECE: u64 = 17;

        let one = cost(&[ROBE]).rows_walked;
        let outfit = cost(OUTFIT).rows_walked;
        let extra = outfit.saturating_sub(one);
        let pieces = OUTFIT.len() as u64 - 1;
        assert!(
            extra <= PER_EXTRA_PIECE * pieces,
            "one robe walks {one} rows and the whole outfit walks {outfit}, so the {pieces} \
             pieces past the first cost {extra} rows — {:.1} each, over the {PER_EXTRA_PIECE} \
             allowed. A piece is paying for a pass over a table rather than for its own rows; \
             look for `Db2::rows` inside a loop over the outfit.",
            extra as f64 / pieces as f64,
        );
    }

    /// A `.glb` that is mostly geometry nothing draws is still a `.glb` that has to parse.
    ///
    /// `character::dressed` hides geosets by dropping their *indices* and leaves the vertex list
    /// alone, so the body carries exactly as much dead weight dressed as it does bare. Two things
    /// make that worth asserting rather than merely noting. It is what makes "send the body once
    /// and only the atlas per outfit" possible — the geometry does not depend on the outfit — and
    /// it is the thing compacting the vertex list would change, so when that lands this test
    /// failing is the good news and the new numbers are what goes in its place.
    #[test]
    fn dressing_the_character_does_not_change_how_much_geometry_she_carries() {
        let bare = cost(&[]);
        let dressed = cost(OUTFIT);
        let dead = |cost: &Cost| cost.vertices_shipped - cost.vertices_drawn;

        // Without this the equality below would be 0 == 0 and would assert nothing at all.
        assert!(
            dead(&bare) > 0,
            "the bare body ships {} vertices and draws all of them, so there is no dead weight \
             here to be invariant — either the fixture body changed or the compaction landed",
            bare.vertices_shipped,
        );
        assert!(
            dressed.vertices_shipped > bare.vertices_shipped,
            "dressing her added no geometry at all ({} vertices either way), so the outfit is \
             not being hung off her and this test is measuring the bare body twice",
            bare.vertices_shipped,
        );
        assert_eq!(
            dead(&bare),
            dead(&dressed),
            "bare she ships {} vertices and draws {}; dressed she ships {} and draws {}. Those \
             two dead-weight counts should be the same number — the body's own list is untouched \
             by what she wears, and the pieces hung off her carry only geometry that is drawn. \
             If you have just made the writer compact the list, this failing is the point: write \
             the new counts down here, and raise the `vertex_use` floors in `BUDGETS` to match.",
            bare.vertices_shipped,
            bare.vertices_drawn,
            dressed.vertices_shipped,
            dressed.vertices_drawn,
        );
    }

    /// Which file it is that gets read twice, by name rather than by count.
    ///
    /// `repeats` in `BUDGETS` is a ceiling and a ceiling says nothing about *what*. There is
    /// exactly one duplicated read in a dressed click and it is `TextureFileData`, asked for by
    /// `worn::TextureFiles::read` and again by `skin::of`, neither of which knows the other
    /// exists. Naming it is what makes this a ratchet in both directions: dedupe it and this
    /// fails saying so, and read something else twice and it fails saying that instead.
    #[test]
    fn reads_the_texture_table_twice_and_nothing_else_twice() {
        use crate::models::TEXTURE_FILE_DATA;

        // The same drive `cost_of` does, because what is wanted here is the list `Cost` reduces
        // to a number: which fdids came back twice, not how many of them did.
        let files = fixture_files();
        let counted = Counted::new(&files);
        let outfit = pieces(OUTFIT);
        crate::character::glb_of(&counted, worn(&counted, &outfit).unwrap().as_ref()).unwrap();

        let mut seen = HashSet::new();
        let mut twice: Vec<u32> = counted
            .asked()
            .into_iter()
            .filter(|fdid| !seen.insert(*fdid))
            .collect();
        twice.sort_unstable();
        assert_eq!(
            twice,
            vec![TEXTURE_FILE_DATA],
            "the files read twice in one click are {twice:?}, not just `TextureFileData` \
             ({TEXTURE_FILE_DATA}). If that list is empty the duplicate is gone and `repeats` in \
             `BUDGETS` should come down to zero with it; if it grew, a second pair of callers \
             has started asking for the same table without knowing about each other.",
        );
    }

    /// The counter the other tests lean on, checked against something with a known answer.
    ///
    /// A budget asserted with a broken instrument is worse than no budget, because it goes green
    /// either way.
    #[test]
    fn counts_the_rows_it_walks() {
        db2::forget_rows_walked();
        assert_eq!(db2::rows_walked(), 0);

        let table = crate::db2::Db2::parse(fixture_files().read(1266429).unwrap()).unwrap();
        let rows = table.rows().count() as u64;
        assert!(rows > 0, "the fixture table has no rows to walk");

        db2::forget_rows_walked();
        table.rows().count();
        let once = db2::rows_walked();
        // Rows and not calls: a counter that ticked once per `rows()` would read 1 here and
        // would go on reading 1 however large the table a loop was walking.
        assert!(
            once >= rows,
            "one walk of a {rows}-row table was counted as {once} — the counter is counting \
             something other than rows, and every budget resting on it is meaningless",
        );
        table.rows().count();
        assert_eq!(db2::rows_walked(), once * 2, "a second walk was not counted");
    }

    /// And the read counter, likewise.
    #[test]
    fn counts_the_files_it_reads_and_the_ones_it_reads_twice() {
        let files = Counted::new(fixture_files());
        files.read(1266429).unwrap();
        files.read(1266429).unwrap();
        files.read(1280614).unwrap();
        assert_eq!(files.asked(), vec![1266429, 1266429, 1280614]);
    }
}
