//! Reads the shape of every look in the game, and says what that buys per slot.
//!
//! [`chronie_desktop_lib::shapes`] is the measure and this is how it is looked at. Unlike
//! `dump_qualities` it writes nothing into the repository: a signature names the FileDataIDs of
//! one build's meshes, which is content generated from Blizzard's files, so the store lives on
//! the machine that read it — `--out` is the same call the app makes, into a directory of your
//! choosing rather than the app's own data directory.
//!
//! ```sh
//! # What the measure says about a real install, slot by slot.
//! cargo run --release --example dump_shapes -- "/Applications/World of Warcraft"
//!
//! # The same, and keep the store — run it twice to see the second run read the file.
//! cargo run --release --example dump_shapes -- "/Applications/World of Warcraft" --out /tmp/mog
//!
//! # And what CI can run: the committed fixtures, which hold a couple of dozen looks.
//! cargo run --example dump_shapes -- --fixtures apps/desktop/fixtures/transmog
//! ```
//!
//! What right looks like on 12.0.5.67823: about 55,000 looks in a second or two, of which
//! roughly a third hang geometry. The slots that do — head, shoulder, and everything held in a
//! hand — come back with hundreds of distinct shapes and a median family of about three, and the
//! slots that do not collapse to a handful of signatures apiece. That collapse is the measure
//! saying it cannot answer those slots, and it is why the table below prints the two halves
//! apart.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use chronie_desktop_lib::shapes::{self, Shape, Shaped};
use chronie_desktop_lib::{body, casc};

/// What each display type is, for a table somebody has to read.
///
/// The window's own words for the same numbers, kept here because a table of sixteen rows keyed
/// by an integer is a table nobody can check against the claim it is being read for. Anything
/// past the eleven places on the body is carried rather than worn — see `worn::held`.
const SLOTS: [(u32, &str); 16] = [
    (0, "head"),
    (1, "shoulder"),
    (2, "shirt"),
    (3, "chest"),
    (4, "waist"),
    (5, "legs"),
    (6, "feet"),
    (7, "wrist"),
    (8, "hands"),
    (9, "back"),
    (10, "tabard"),
    (11, "weapon"),
    (12, "ranged"),
    (13, "shield"),
    (14, "relic"),
    (15, "held"),
];

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

    // Which build the store is keyed on. An install states its own; the fixtures are this
    // repository's own invention and say so, because a fixture run claiming a game version would
    // be a cache that a real install would then read and believe.
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
    // One body, and the one a store is written for: which `.m2` a helm resolves to is answered
    // per race and sex, so shapes taken on two bodies are two stores. See `shapes`'s own note.
    let body = match body::of(files, body::DEFAULT) {
        Ok(body) => body,
        Err(error) => {
            eprintln!("Could not read the body to measure against: {error}");
            std::process::exit(1);
        }
    };
    println!("build  {build}, shaped on {}", body.name);

    let started = Instant::now();
    let rows = match &options.out {
        // The call the app makes, and the whole of the storage decision: measured once against
        // the game, read from the file on every run after that until the build moves.
        Some(dir) => match shapes::cached(files, &body, &build, dir) {
            Ok(store) => {
                println!(
                    "store  {} looks in {}",
                    store.len(),
                    dir.join("shapes.json").display()
                );
                store.rows().cloned().collect()
            }
            Err(error) => {
                eprintln!("Could not read the shapes: {error}");
                std::process::exit(1);
            }
        },
        None => match shapes::sweep(files, &body, &shapes::EVERY_DISPLAY_TYPE) {
            Ok(rows) => rows,
            Err(error) => {
                eprintln!("Could not read the shapes: {error}");
                std::process::exit(1);
            }
        },
    };
    println!("read   {} looks in {:?}\n", rows.len(), started.elapsed());

    table(&rows);
}

/// The measure, slot by slot: what it discriminates and what it is blind to.
///
/// Two halves of every row, because they are two different claims. The looks that hang geometry
/// are the ones an equality of signatures says anything about, and the distinct shapes, the
/// median family and the largest are all read over those alone; the looks that hang none are
/// counted beside them and no family is quoted for them at all, because a "family" of every
/// bracer in the game is the measure's blindness rather than its answer.
fn table(rows: &[Shaped]) {
    let mut per_slot: BTreeMap<u32, Vec<&Shaped>> = BTreeMap::new();
    for row in rows {
        per_slot.entry(row.display_type).or_default().push(row);
    }

    println!(
        "{:<10} {:>7} {:>7} {:>7} {:>7} {:>8}",
        "slot", "looks", "meshed", "shapes", "median", "largest"
    );
    for (display_type, held) in &per_slot {
        let name = SLOTS
            .iter()
            .find(|(slot, _)| slot == display_type)
            .map(|(_, name)| *name)
            .unwrap_or("?");
        let mut families: BTreeMap<&Shape, usize> = BTreeMap::new();
        for row in held.iter().filter(|row| row.shape.names_a_mesh()) {
            *families.entry(&row.shape).or_default() += 1;
        }
        let meshed: usize = families.values().sum();
        let mut sizes: Vec<usize> = families.values().copied().collect();
        sizes.sort_unstable();
        let median = sizes.get(sizes.len() / 2).copied().unwrap_or(0);
        let largest = sizes.last().copied().unwrap_or(0);
        let say = |number: usize| {
            if meshed == 0 {
                "—".to_string()
            } else {
                number.to_string()
            }
        };
        println!(
            "{:<10} {:>7} {:>7} {:>7} {:>7} {:>8}",
            format!("{display_type} {name}"),
            held.len(),
            meshed,
            say(families.len()),
            say(median),
            say(largest),
        );
    }

    let meshed = rows.iter().filter(|row| row.shape.names_a_mesh()).count();
    println!(
        "\n{meshed} of {} looks hang geometry; the other {} are paint on a body every one of \
         them shares, and this measure says nothing about them.",
        rows.len(),
        rows.len() - meshed,
    );
}

/// Where the game is read from, which is the one thing this tool cannot guess.
enum Source {
    Install(PathBuf),
    Fixtures(PathBuf),
}

struct Options {
    source: Source,
    /// Where to keep the store, when it is worth keeping. Nothing by default: what this prints
    /// is a reading of the game, and the file behind it belongs to whoever asked for one.
    out: Option<PathBuf>,
}

fn parse() -> Options {
    let mut argv = std::env::args().skip(1);
    let mut source: Option<Source> = None;
    let mut out: Option<PathBuf> = None;

    while let Some(argument) = argv.next() {
        match argument.as_str() {
            "--fixtures" => {
                source = Some(Source::Fixtures(
                    argv.next().unwrap_or_else(|| usage()).into(),
                ));
            }
            "--out" => out = Some(argv.next().unwrap_or_else(|| usage()).into()),
            _ if argument.starts_with("--") => usage(),
            _ => source = Some(Source::Install(argument.into())),
        }
    }

    Options {
        source: source.unwrap_or_else(|| usage()),
        out,
    }
}

fn usage() -> ! {
    eprintln!(
        "usage: dump_shapes <wow install> | --fixtures <dir> [--out <dir>]\n\
         \n\
         Prints what the shape signature discriminates, slot by slot. With --out the store is\n\
         kept in that directory the way the app keeps its own, and a second run reads it back\n\
         rather than measuring the game again."
    );
    std::process::exit(2);
}
