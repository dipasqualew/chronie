//! What holding the game's storage open costs, in seconds and in megabytes.
//!
//! `trace_render` answers where a click's time goes. This answers the question that decides
//! whether the storage can be *held* between clicks at all: an open [`CascFiles`] is three
//! tables built out of a 123GB install, and if keeping one resident costs a gigabyte then a
//! tray app cannot keep one however much time it would save.
//!
//! It opens the storage, reads one file through it, and reports the process's resident size
//! before and after — which is the only figure that answers the question, because a `Vec`'s
//! own `len` says nothing about the allocator's retained pages or about what a growth spike
//! left behind.
//!
//! ```sh
//! cargo run --release --example weigh_casc -- "/Applications/World of Warcraft"
//! cargo run --release --example weigh_casc -- "/Applications/World of Warcraft" --opens 2
//! ```
//!
//! **Release, always**, for the same reason `trace_render` says so: a debug inflate is ten
//! times slower and measures the wrong program.
//!
//! Resident size is read from `ps`, which is there on macOS and Linux and is not on Windows;
//! on Windows the timings still print and the megabytes come out as `?`.

use std::path::Path;
use std::time::Instant;

use chronie_desktop_lib::casc::{CascFiles, GameFiles};

/// `ItemSparse` — a table every outfit reads, so the read after the open is a real one.
const ITEM_SPARSE: u32 = 1572924;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let opens = take_number(&mut args, "--opens").unwrap_or(1);
    let Some(root) = args.first() else {
        eprintln!(
            "usage: weigh_casc <install root, the folder holding Data/> [--opens N]\n\
             e.g.   weigh_casc \"/Applications/World of Warcraft\""
        );
        std::process::exit(2);
    };

    report("before opening anything");
    let mut held = Vec::new();
    for open in 1..=opens {
        let started = Instant::now();
        let files = match CascFiles::open(Path::new(root)) {
            Ok(files) => files,
            Err(error) => {
                eprintln!("Could not open {root}: {error}");
                std::process::exit(1);
            }
        };
        let opened = started.elapsed();
        let started = Instant::now();
        let bytes = files.read(ITEM_SPARSE).map(|it| it.len()).unwrap_or(0);
        let read = started.elapsed();
        report(&format!(
            "after open {open}/{opens} ({opened:?} to open, {read:?} to read {bytes}B)"
        ));
        held.push(files);
    }

    // Every handle is still alive here, which is the point: this is what an app that holds
    // one — or, if the cache ever goes wrong, several — is carrying around between clicks.
    report(&format!("holding {} handle(s)", held.len()));
    std::hint::black_box(&held);
    drop(held);
    report("after dropping them");
}

fn report(label: &str) {
    match resident_bytes() {
        Some(bytes) => println!("{label:<58} {:>8.1} MB", bytes as f64 / 1_048_576.0),
        None => println!("{label:<58} {:>8} MB", "?"),
    }
}

/// The process's resident set, via `ps`, in bytes.
///
/// Shelling out rather than linking a crate for it: this is a development example that runs
/// on the machine with the game on it, and one `ps` per stage is not worth a dependency the
/// shipped app would also carry.
fn resident_bytes() -> Option<u64> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    let kilobytes: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(kilobytes * 1024)
}

fn take_number(args: &mut Vec<String>, flag: &str) -> Option<usize> {
    let at = args.iter().position(|arg| arg == flag)?;
    let value = args.get(at + 1)?.parse().ok();
    args.drain(at..=at + 1);
    value
}
