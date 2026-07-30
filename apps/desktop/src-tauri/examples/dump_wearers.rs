//! Reads who can really wear each of the game's sets, and holds it up against the class mask.
//!
//! The census behind `wearers.rs`: how many sets the game files under an armour type, how many
//! under one class, and what the items behind each of them actually allow. What it is for is
//! the claim that those two masks are different kinds of fact — an armour type is who wears
//! cloth and a class lock is a wall — which is a claim only a shipping install can settle.
//!
//! ```sh
//! cargo run --release --example dump_wearers -- "/Applications/World of Warcraft"
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files.
//!
//! What right looks like on 12.x: about a thousand sets masked to one armour type, nearly all
//! of which the items open to everybody who can wear that armour, against a couple of thousand
//! locked to one class, only about a fifth of which anything sells around. A run where every
//! set comes back as every class means `ItemSparse.AllowableClass` has moved — check it with
//! `dump_item_facts` — and one where no set comes back at all means the sets themselves could
//! not be read.

use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use chronie_desktop_lib::{casc, transmog, wearers};

/// The four armour masks the game files a set under, in the order they are named below.
const ARMOUR: [(u32, &str); 4] = [
    (0x0190, "cloth"),
    (0x0e08, "leather"),
    (0x1044, "mail"),
    (0x0023, "plate"),
];

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_wearers <wow install> | --fixtures <dir>");
        std::process::exit(2);
    });
    let files: Box<dyn casc::GameFiles> = if first == "--fixtures" {
        let dir = args.next().unwrap_or_else(|| {
            eprintln!("--fixtures needs a directory");
            std::process::exit(2);
        });
        Box::new(casc::DirFiles::new(dir))
    } else {
        match casc::CascFiles::open(std::path::Path::new(&first)) {
            Ok(storage) => Box::new(storage),
            Err(error) => {
                eprintln!("Could not open {first}: {error}");
                std::process::exit(1);
            }
        }
    };

    let started = Instant::now();
    let payload = wearers::sets(files.as_ref()).unwrap_or_else(|error| {
        eprintln!("Could not read who wears the sets: {error}");
        std::process::exit(1);
    });
    let read = started.elapsed();

    let wearers: HashMap<u32, u32> = payload["wearers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|row| {
            (
                row["setId"].as_u64().unwrap_or_default() as u32,
                row["classMask"].as_u64().unwrap_or_default() as u32,
            )
        })
        .collect();
    println!("{} sets answered for, in {read:?}", wearers.len());

    let sets = transmog::sets(files.as_ref()).unwrap_or_else(|error| {
        eprintln!("Could not read the sets: {error}");
        std::process::exit(1);
    });

    // What kind of mask the game filed each set under, against what the items say about it.
    let mut census: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    let mut nobody: Vec<u32> = Vec::new();
    let mut unknown = 0usize;
    for set in sets["sets"].as_array().cloned().unwrap_or_default() {
        let id = set["id"].as_u64().unwrap_or_default() as u32;
        let mask = set["classMask"].as_u64().unwrap_or_default() as u32;
        let Some(&who) = wearers.get(&id) else {
            unknown += 1;
            continue;
        };
        if who == 0 {
            nobody.push(id);
        }
        *census.entry((filed(mask), says(who))).or_default() += 1;
    }

    println!("filed as → the items say:");
    for ((filed, says), count) in &census {
        println!("  {filed:>12} → {says:<12} {count}");
    }
    println!("{unknown} sets no item of which this install can describe");
    if !nobody.is_empty() {
        println!(
            "{} sets nobody can wear whole — {:?}",
            nobody.len(),
            &nobody[..nobody.len().min(20)]
        );
    }
}

/// Which kind of mask the game filed a set under.
fn filed(mask: u32) -> &'static str {
    if mask == 0 || mask == 0x7fff || mask == (1 << 13) - 1 {
        return "any class";
    }
    if ARMOUR.iter().any(|(armour, _)| *armour == mask) {
        return "armour type";
    }
    if mask.count_ones() == 1 {
        return "one class";
    }
    "some classes"
}

/// And what the items behind it come to.
fn says(who: u32) -> &'static str {
    if who == wearers::EVERY_CLASS {
        return "anyone";
    }
    if who == 0 {
        return "nobody";
    }
    if let Some((_, name)) = ARMOUR.iter().find(|(armour, _)| *armour == who) {
        return name;
    }
    if who.count_ones() == 1 {
        return "one class";
    }
    "some classes"
}
