//! Prints `Mount` against a real install: the names, the source lines, and what is not in it.
//!
//! The Collection view subtracts what the census walked from what this table holds, so a wrong
//! column here does not fail — it puts the description where the source belongs, or names a
//! player's mounts after somebody else's. This is what settled the two columns it reads, and
//! what to run again after a patch.
//!
//! ```sh
//! cargo run --example dump_mounts -- "/Applications/World of Warcraft"
//! cargo run --example dump_mounts -- "/Applications/World of Warcraft" drake horse
//! cargo run --example dump_mounts -- --fixtures apps/desktop/fixtures/mounts
//! ```
//!
//! What right looks like, on 12.0.5.67823:
//!
//! - **1,634 rows declared and 1,616 named.** A run whose first column reads "Brown Horse",
//!   "Gray Wolf", "White Stallion" is the table this is meant to be reading; the eighteen that
//!   do not arrive are sections the client encrypts, and the catalogue counts them as withheld
//!   rather than dropping them silently.
//! - **A source line that reads like a sentence.** `plain:` under each row is what the app makes
//!   of the column, and it has to come out as "Vendor: Unger Statforth. Zone: Wetlands" — no
//!   pipes, no stray `r` where a colour was closed, and not the flavour text, which is the
//!   column *after* it and is the one thing a reader could mistake for it.
//! - **No icon anywhere.** The column census below is the evidence for the claim in
//!   `docs/game-tables.json` that this table has none: no column of it holds six- and
//!   seven-digit numbers on most rows, which is what a column of FileDataIDs looks like.
//!   `SourceSpellID` is the five- and six-digit one, and the icon is a hop past it through
//!   `SpellMisc` that nothing in this app makes.

use chronie_desktop_lib::casc::{self, GameFiles};
use chronie_desktop_lib::db2::Db2;
use chronie_desktop_lib::{mounts, tables};

/// How many rows to print in full, which is enough to see the shape of the table.
const SHOWN: usize = 20;

/// The columns to census. Past every one the reader consumes, on purpose: what says a column
/// has not moved is the shape of the ones around it.
const COLUMNS: usize = 13;

/// What a FileDataID starts at, for the census that says this table holds none.
const FILE_DATA_ID: u32 = 100_000;

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_mounts <wow install> | --fixtures <dir>");
        std::process::exit(2);
    });

    let files: Box<dyn GameFiles> = if first == "--fixtures" {
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

    let table = match files.read(tables::MOUNT).and_then(Db2::parse) {
        Ok(table) => table,
        Err(error) => {
            eprintln!("Could not read Mount: {error}");
            std::process::exit(1);
        }
    };

    let catalogue = match mounts::catalogue(files.as_ref()) {
        Ok(catalogue) => catalogue,
        Err(error) => {
            eprintln!("Could not read the catalogue: {error}");
            std::process::exit(1);
        }
    };

    println!(
        "Mount: {} columns, {} rows readable of {} declared, {} of them named, {} withheld\n",
        table.column_count(),
        table.rows().count(),
        table.declared_rows(),
        catalogue.found.len(),
        catalogue.withheld
    );

    // The whole table at once, which is the check no handful of names can give — and here it is
    // a check on a negative: the claim that no column of this table is an icon.
    let named: Vec<_> = table
        .rows()
        .filter(|row| !row.text(tables::mount::NAME).is_empty())
        .collect();
    println!(
        "of the {} named rows, how many hold something in each column, how many of those look \n\
         like a FileDataID ({FILE_DATA_ID} upwards), and how many hold text:",
        named.len()
    );
    for column in 0..COLUMNS {
        let held: Vec<u32> = named
            .iter()
            .map(|row| row.number(column))
            .filter(|value| *value != 0)
            .collect();
        let large = held.iter().filter(|value| **value >= FILE_DATA_ID).count();
        let words = named
            .iter()
            .filter(|row| !row.text(column).is_empty())
            .count();
        println!(
            "  col{column:<3} {:>6} held, {large:>6} of them large ({:.1}%), {words:>6} with text",
            held.len(),
            100.0 * large as f64 / held.len().max(1) as f64
        );
    }

    let wanted: Vec<String> = args.map(|name| name.to_lowercase()).collect();
    println!(
        "\n{}:",
        if wanted.is_empty() {
            format!("the first {SHOWN} mounts the catalogue holds")
        } else {
            format!("mounts named after {}", wanted.join(", "))
        }
    );
    for mount in catalogue
        .found
        .iter()
        .filter(|mount| {
            wanted.is_empty()
                || wanted
                    .iter()
                    .any(|asked| mount.name.to_lowercase().contains(asked))
        })
        .take(SHOWN)
    {
        println!("  {:>6} {}", mount.id, mount.name);
        println!("         plain: {}", mount.source);
        // The column beside the source, printed so that the two can be told apart by eye. It is
        // the flavour text, and a reader that had them the wrong way round would show it here
        // reading like a source line — which it never does.
        if let Some(row) = table.rows().find(|row| row.id() == mount.id) {
            println!(
                "         next:  {}",
                row.text(tables::mount::SOURCE_TEXT + 1)
            );
        }
    }
}
