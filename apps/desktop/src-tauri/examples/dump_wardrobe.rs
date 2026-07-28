//! Reads every appearance filling one kind of place, the way the wardrobe list asks for them.
//!
//! The list browses the game by *kind* rather than by set, and a kind is a display type and —
//! below the armour slots — an item subclass: a dagger, a staff and a one-handed axe are all
//! display type 11, and only `Item.SubclassID` separates them. This is what says the numbers
//! the window's kind table is built out of are still the numbers a shipping install holds.
//!
//! ```sh
//! cargo run --example dump_wardrobe -- "/Applications/World of Warcraft" 0
//! cargo run --example dump_wardrobe -- "/Applications/World of Warcraft" 11 12 13 14 15
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files. With no display
//! types it walks all sixteen, one at a time, and prints what each costs.
//!
//! What right looks like on 12.0.5.67: display type 0 answers 5,111 heads in about a second,
//! nearly all of it the six hundred milliseconds of opening the game's storage; the five weapon
//! types together answer 15,366 looks whose subclasses spread across axes, swords, staves and
//! the rest, with the shields and off-hands among them filed as armour rather than as weapons.
//! A kind that comes back empty, or a column of subclasses that is all zeroes, means `Item` has
//! moved and `items::column` is what to check with `dump_item_facts`.

use std::collections::BTreeMap;
use std::time::Instant;

use chronie_desktop_lib::{casc, wardrobe};

/// Every display type the game files an appearance under, which is what "all of them" means.
const EVERY_KIND: [u32; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/// How many of a kind's rows to print before the census takes over.
const A_FEW: usize = 6;

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_wardrobe <wow install> | --fixtures <dir> [display type...]");
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

    let wanted: Vec<u32> = args.filter_map(|kind| kind.parse().ok()).collect();
    if wanted.is_empty() {
        for kind in EVERY_KIND {
            report(files.as_ref(), &[kind], false);
        }
        return;
    }
    report(files.as_ref(), &wanted, true);
}

/// One read, timed, counted, and — when it was asked for by hand — shown.
fn report(files: &dyn casc::GameFiles, display_types: &[u32], listed: bool) {
    let started = Instant::now();
    let payload = match wardrobe::appearances(files, display_types) {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("display types {display_types:?}: {error}");
            std::process::exit(1);
        }
    };
    let rows = payload["appearances"].as_array().cloned().unwrap_or_default();
    println!(
        "display types {display_types:?}: {} looks, {} the install cannot reach, in {:?}",
        payload["readCount"], payload["withheldCount"], started.elapsed()
    );
    if !listed {
        return;
    }

    // What kind of thing gives each look, which is the whole reason `Item` is read.
    let mut kinds: BTreeMap<(u64, u64), usize> = BTreeMap::new();
    for row in &rows {
        let class = row["classId"].as_u64().unwrap_or_default();
        let subclass = row["subclassId"].as_u64().unwrap_or_default();
        *kinds.entry((class, subclass)).or_default() += 1;
    }
    for ((class, subclass), count) in kinds {
        println!("  class {class} subclass {subclass}: {count}");
    }
    for row in rows.iter().take(A_FEW) {
        println!(
            "  {} — item {}, {} items give it, display {}",
            row["name"], row["itemId"], row["itemCount"], row["displayInfoId"]
        );
    }
}
