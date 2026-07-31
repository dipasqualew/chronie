//! Reads what every look in the game looks like, and says what that buys per slot.
//!
//! [`chronie_desktop_lib::fingerprints`] is the measure and this is how it is looked at. Like
//! `dump_shapes` it writes nothing into the repository — a 16 × 16 thumbnail is a downsampled
//! copy of Blizzard's texture, so the store lives on the machine that decoded it, and `--out` is
//! the same call the app makes into a directory of your choosing.
//!
//! ```sh
//! # What the measure says about a real install, slot by slot. Expect about a minute.
//! cargo run --release --example dump_fingerprints -- "/Applications/World of Warcraft"
//!
//! # The same, and keep the store — run it twice to see the second run read the file.
//! cargo run --release --example dump_fingerprints -- "/Applications/World of Warcraft" --out /tmp/mog
//!
//! # What one look's neighbours are, which is the question the window asks.
//! cargo run --release --example dump_fingerprints -- "/Applications/World of Warcraft" --near 11678
//!
//! # And what CI can run: the committed fixtures, which hold a couple of dozen looks.
//! cargo run --example dump_fingerprints -- --fixtures apps/desktop/fixtures/transmog
//! ```
//!
//! What right looks like on 12.0.5.67823: about 50,000 looks, a cut per slot well under the
//! median of that slot's strangers, and — for the case this feature was argued from — Ulduar's
//! Priest tier head answering with `Lifespark Visage`, a world drop belonging to no set at all,
//! ahead of the other helm of its own tier.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use chronie_desktop_lib::fingerprints::{self, Fingerprints};
use chronie_desktop_lib::{body, casc};

/// What each display type is, for a table somebody has to read — the window's own words for the
/// same numbers. Nothing past ten is here, because nothing past ten is fingerprinted at all.
const SLOTS: [(u32, &str); 11] = [
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
];

/// How many neighbours `--near` prints, which is rather more than the window offers: what this
/// is for is seeing where the field falls away, and a list cut at the cut cannot show that.
const NEIGHBOURS: usize = 10;

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
    // be a cache a real install would then read and believe.
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
    let body = match body::of(files, body::DEFAULT) {
        Ok(body) => body,
        Err(error) => {
            eprintln!("Could not read the body to measure against: {error}");
            std::process::exit(1);
        }
    };
    println!("build  {build}, printed on {}", body.name);

    let started = Instant::now();
    let store = match &options.out {
        // The call the app makes: measured once against the game, read from the file after.
        Some(dir) => fingerprints::cached(files, &body, &build, dir),
        None => fingerprints::sweep(files, &body, &fingerprints::PAINTED).and_then(|rows| {
            Fingerprints::read(&chronie_desktop_lib::qualities::text(
                &fingerprints::stored(&build, &rows),
            ))
        }),
    };
    let store = match store {
        Ok(store) => store,
        Err(error) => {
            eprintln!("Could not read the fingerprints: {error}");
            std::process::exit(1);
        }
    };
    println!("read   {} looks in {:?}\n", store.len(), started.elapsed());

    table(&store);
    for appearance_id in &options.near {
        neighbours(&store, *appearance_id);
    }
}

/// The measure, slot by slot: how many looks it holds and where it cut the slot.
///
/// The median of the same sample beside the cut, because the cut on its own is a number with
/// nothing to scale it. What a working slot looks like is a cut well under its median — a cut
/// that has crept up towards it is a slot whose looks this install can read too few pictures of
/// to tell apart, and a slot with no cut at all is one that said so.
fn table(store: &Fingerprints) {
    let mut per_slot: BTreeMap<u32, usize> = BTreeMap::new();
    for row in store.rows() {
        *per_slot.entry(row.display_type).or_default() += 1;
    }

    println!(
        "{:<12} {:>7} {:>9} {:>9} {:>8}",
        "slot", "looks", "cut", "median", "pairs"
    );
    for (display_type, looks) in &per_slot {
        let name = SLOTS
            .iter()
            .find(|(slot, _)| slot == display_type)
            .map(|(_, name)| *name)
            .unwrap_or("?");
        let cut = store.cut(*display_type);
        let say = |of: fn(&fingerprints::Cut) -> String| cut.as_ref().map_or("—".into(), of);
        println!(
            "{:<12} {:>7} {:>9} {:>9} {:>8}",
            format!("{display_type} {name}"),
            looks,
            say(|cut| format!("{:.4}", cut.near)),
            say(|cut| format!("{:.4}", cut.median)),
            say(|cut| cut.pairs.to_string()),
        );
    }
}

/// One look's neighbours, nearest first, past the cut so the field is visible.
fn neighbours(store: &Fingerprints, appearance_id: u32) {
    let Some(row) = store.of(appearance_id) else {
        println!("\n{appearance_id}: this install printed no such look.");
        return;
    };
    let mut found: Vec<(f64, u32)> = store
        .rows()
        .filter(|other| other.display_type == row.display_type)
        .filter(|other| other.appearance_id != appearance_id)
        .filter_map(|other| Some((row.print.distance(&other.print)?, other.appearance_id)))
        .collect();
    found.sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.cmp(&right.1)));

    let cut = store.cut(row.display_type);
    println!(
        "\n{appearance_id} (slot {}), cut at {}:",
        row.display_type,
        cut.map_or("nothing".to_string(), |cut| format!("{:.4}", cut.near)),
    );
    for (distance, other) in found.into_iter().take(NEIGHBOURS) {
        let offered = cut.is_some_and(|cut| distance <= cut.near);
        println!(
            "  {distance:.4}  {other:<8} {}",
            if offered { "<- offered" } else { "" }
        );
    }
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
    /// The looks whose neighbours are worth printing.
    near: Vec<u32>,
}

fn parse() -> Options {
    let mut argv = std::env::args().skip(1);
    let mut source: Option<Source> = None;
    let mut out: Option<PathBuf> = None;
    let mut near: Vec<u32> = Vec::new();

    while let Some(argument) = argv.next() {
        match argument.as_str() {
            "--fixtures" => {
                source = Some(Source::Fixtures(
                    argv.next().unwrap_or_else(|| usage()).into(),
                ));
            }
            "--out" => out = Some(argv.next().unwrap_or_else(|| usage()).into()),
            "--near" => near.push(
                argv.next()
                    .and_then(|of| of.parse().ok())
                    .unwrap_or_else(|| usage()),
            ),
            _ if argument.starts_with("--") => usage(),
            _ => source = Some(Source::Install(argument.into())),
        }
    }

    Options {
        source: source.unwrap_or_else(|| usage()),
        out,
        near,
    }
}

fn usage() -> ! {
    eprintln!(
        "usage: dump_fingerprints <wow install> | --fixtures <dir> [--out <dir>] \
         [--near <appearance>]...\n\
         \n\
         Prints where the texture fingerprint cut each slot, and with --near the nearest looks\n\
         to one appearance. With --out the store is kept in that directory the way the app keeps\n\
         its own, and a second run reads it back rather than measuring the game again."
    );
    std::process::exit(2);
}
