//! Measures every look in the game and writes the answers into the repository.
//!
//! This is the generator behind `apps/desktop/data/qualities/`, which is committed. Nothing in
//! the shipped app runs it: a reader with no World of Warcraft on the machine still gets the
//! colours and the sizes, because somebody with one ran this and committed what came out.
//!
//! ```sh
//! # The whole game, into the folder the window reads. Release, or it is an hour rather than
//! # a few minutes — this decodes a few hundred thousand textures.
//! cargo run --release --example dump_qualities -- "/Applications/World of Warcraft"
//!
//! # One slot, to look at what changed before committing sixteen files.
//! cargo run --release --example dump_qualities -- "/Applications/World of Warcraft" --only 11
//!
//! # And what CI can run: the committed fixtures, into a directory of its own.
//! cargo run --example dump_qualities -- --fixtures apps/desktop/fixtures/transmog --out /tmp/q
//! ```
//!
//! **It is idempotent, and that is the property to keep.** Run twice against the same install it
//! writes the same bytes, so a diff is a change in the game or a change in
//! [`chronie_desktop_lib::qualities`] and never a change in the weather. Everything that could
//! have made it otherwise is settled in that module — the histograms are ordered maps, the ties
//! are broken by stated rules, and the rows come out sorted by appearance. What is left here is
//! to write the files in a stated order and to say which build they were read from.
//!
//! What right looks like on 12.0.5.67: sixteen files and a seventeenth for the sets, about four
//! megabytes in total, roughly 55,000 appearances of which a few hundred measure as nothing at
//! all. A slot that comes back empty means `wardrobe::appearances` found nothing to measure, and
//! `dump_wardrobe` is the tool that says why.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use chronie_desktop_lib::qualities::{self, Look};
use chronie_desktop_lib::worn::Piece;
use chronie_desktop_lib::{casc, transmog, wardrobe};

/// Every display type the game files an appearance under.
const EVERY_SLOT: [u32; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/// How many appearances are measured in one go.
///
/// A batch shares one walk of each of the game's tables and one decode of each texture between
/// its rows, so bigger is faster — up to the point where the decoded textures of a batch stop
/// fitting comfortably in memory. A few hundred rows of one slot are neighbours in the game's
/// own numbering and share a great deal of their artwork, which is where most of the saving
/// comes from and why this is worth more than it looks.
const BATCH: usize = 512;

fn main() {
    let options = parse();

    let files: Box<dyn casc::GameFiles> = match &options.source {
        Source::Fixtures(dir) => Box::new(casc::DirFiles::new(dir)),
        Source::Install(install) => match casc::CascFiles::open(install) {
            Ok(storage) => Box::new(storage),
            Err(error) => {
                eprintln!("Could not open {}: {error}", install.display());
                std::process::exit(1);
            }
        },
    };
    let files = files.as_ref();

    // Which build every one of these files says it was read from. An install states its own; the
    // fixtures are this repository's own invention and state that instead, because a fixture run
    // that claimed a game version would be the one lie in a file whose whole job is to be true.
    let build = match &options.source {
        Source::Fixtures(_) => "fixtures".to_string(),
        Source::Install(install) => match casc::live_version(install) {
            Ok(version) => version,
            Err(error) => {
                eprintln!("Could not read the build version: {error}");
                std::process::exit(1);
            }
        },
    };
    println!("build  {build}");

    if let Err(error) = std::fs::create_dir_all(&options.out) {
        eprintln!("Could not make {}: {error}", options.out.display());
        std::process::exit(1);
    }

    // Every look measured, kept across the slots so that the sets can be answered out of what
    // was already read rather than by measuring their pieces a second time.
    let mut measured: HashMap<u32, Look> = HashMap::new();
    for slot in options.slots {
        measured.extend(slot_file(files, slot, &build, &options.out));
    }

    if options.slots_were_asked_for {
        println!("\nThe sets are left alone: they are read out of every slot at once.");
        return;
    }
    sets_file(files, &build, &options.out, &measured);
}

/// One slot: measured, banded, and written.
fn slot_file(
    files: &dyn casc::GameFiles,
    slot: u32,
    build: &str,
    out: &Path,
) -> HashMap<u32, Look> {
    let started = Instant::now();
    let payload = match wardrobe::appearances(files, &[slot]) {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("display type {slot}: {error}");
            std::process::exit(1);
        }
    };
    let rows: Vec<(u32, Piece)> = payload["appearances"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|row| {
            let number = |name: &str| row[name].as_u64().unwrap_or_default() as u32;
            (
                number("appearanceId"),
                Piece {
                    display_info_id: number("displayInfoId"),
                    display_type: number("displayType"),
                    inventory_type: number("inventoryType"),
                },
            )
        })
        .collect();

    let mut looks: Vec<(u32, Look)> = Vec::new();
    for batch in rows.chunks(BATCH) {
        let pieces: Vec<Piece> = batch.iter().map(|(_, piece)| *piece).collect();
        let answers = match qualities::each(files, &pieces) {
            Ok(answers) => answers,
            Err(error) => {
                eprintln!("display type {slot}: {error}");
                std::process::exit(1);
            }
        };
        for ((appearance_id, _), look) in batch.iter().zip(answers) {
            if let Some(look) = look {
                looks.push((*appearance_id, look));
            }
        }
        print!("\r  slot {slot}: {} of {} measured", looks.len(), rows.len());
        let _ = std::io::Write::flush(&mut std::io::stdout());
    }

    let file = out.join(format!("{slot}.json"));
    write(&file, &qualities::stored(slot, build, &looks));
    println!(
        "\r  slot {slot}: {} of {} appearances measured, into {} in {:?}",
        looks.len(),
        rows.len(),
        file.display(),
        started.elapsed(),
    );
    looks.into_iter().collect()
}

/// The sets, out of what the slots already measured.
fn sets_file(files: &dyn casc::GameFiles, build: &str, out: &Path, measured: &HashMap<u32, Look>) {
    let started = Instant::now();
    let held = match transmog::set_appearances(files) {
        Ok(held) => held,
        Err(error) => {
            eprintln!("the sets: {error}");
            std::process::exit(1);
        }
    };
    let sets: Vec<(u32, Vec<Look>)> = held
        .into_iter()
        .map(|(set_id, looks)| {
            let looks = looks
                .iter()
                .filter_map(|appearance_id| measured.get(appearance_id).copied())
                .collect();
            (set_id, looks)
        })
        .collect();

    let file = out.join("sets.json");
    write(&file, &qualities::stored_sets(build, &sets));
    println!(
        "  sets: {} read, into {} in {:?}",
        sets.len(),
        file.display(),
        started.elapsed(),
    );
}

/// Writes one file, laid out by `qualities::text` — one look to a line, so a diff is readable.
fn write(path: &Path, what: &serde_json::Value) {
    if let Err(error) = std::fs::write(path, qualities::text(what)) {
        eprintln!("{}: {error}", path.display());
        std::process::exit(1);
    }
}

/// Where the game is read from, which is the one thing this tool cannot guess.
enum Source {
    Install(PathBuf),
    Fixtures(PathBuf),
}

struct Options {
    source: Source,
    out: PathBuf,
    slots: Vec<u32>,
    /// Whether the slots were named rather than defaulted, which is what says the sets are not
    /// this run's business: they are read out of every slot at once, and a run over one slot
    /// would write a sets file describing a twelfth of each set.
    slots_were_asked_for: bool,
}

fn parse() -> Options {
    let mut argv = std::env::args().skip(1);
    let mut source: Option<Source> = None;
    let mut out: Option<PathBuf> = None;
    let mut slots: Vec<u32> = Vec::new();

    while let Some(argument) = argv.next() {
        match argument.as_str() {
            "--fixtures" => {
                source = Some(Source::Fixtures(argv.next().unwrap_or_else(|| usage()).into()));
            }
            "--out" => out = Some(argv.next().unwrap_or_else(|| usage()).into()),
            "--only" => {
                let slot = argv.next().unwrap_or_else(|| usage());
                slots.push(slot.parse().unwrap_or_else(|_| usage()));
            }
            _ if argument.starts_with("--") => usage(),
            _ => source = Some(Source::Install(argument.into())),
        }
    }

    Options {
        source: source.unwrap_or_else(|| usage()),
        out: out.unwrap_or_else(store),
        slots_were_asked_for: !slots.is_empty(),
        slots: if slots.is_empty() {
            EVERY_SLOT.to_vec()
        } else {
            slots
        },
    }
}

/// The committed store, found from this crate rather than from where the tool was run.
fn store() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("data")
        .join("qualities")
}

fn usage() -> ! {
    eprintln!(
        "usage: dump_qualities <wow install> | --fixtures <dir>\n\
         \x20                  [--out <dir>] [--only <display type>]...\n\
         \n\
         Without --out the answers go into apps/desktop/data/qualities, which is committed.\n\
         Without --only every one of the game's sixteen display types is measured, and the\n\
         sets are written from what they say."
    );
    std::process::exit(2);
}
