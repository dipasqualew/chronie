//! Prints `CurrencyTypes` against a real install: the names, and the column that holds the icon.
//!
//! The character view draws a currency with the picture the game draws it with, and that picture
//! is one column of one table nothing else in this app reads. This is what settled which column,
//! and what to run again after a patch.
//!
//! ```sh
//! cargo run --example dump_currencies -- "/Applications/World of Warcraft"
//! cargo run --example dump_currencies -- "/Applications/World of Warcraft" Honor Valorstones
//! cargo run --example dump_currencies -- --fixtures apps/desktop/fixtures/currencies
//! ```
//!
//! With no names it prints the first rows the table holds, which is where the oldest currencies
//! are. Pass names to reach a modern one — the rows a player is actually looking at are at the
//! far end of a table that opens in Burning Crusade.
//!
//! What right looks like:
//!
//! - **Names that are currencies.** The table opens with two strings — a name and a description —
//!   and a run whose first column reads "Honor", "Conquest", "Valorstones" is the table this is
//!   meant to be reading. Anything else and the FileDataID has moved.
//! - **One column of six- and seven-digit numbers that resolve.** An icon is a FileDataID, so the
//!   column that holds them is the one where nearly every row names a file the install can read
//!   and decode as a texture. The `icon:` line under each row is that check made rather than
//!   eyeballed.

use chronie_desktop_lib::casc::{self, GameFiles};
use chronie_desktop_lib::currencies;
use chronie_desktop_lib::db2::Db2;
use chronie_desktop_lib::icons;

/// How many rows to print in full, which is enough to see the shape of the table.
const SHOWN: usize = 24;

/// The columns to print beside each name: the run the icon has to be somewhere inside.
const FIRST_COLUMN: usize = 2;
const LAST_COLUMN: usize = 9;

/// What an icon is at most, a side at a time — the same bound `icons` itself holds them to.
const LARGEST_ICON: u32 = 512;

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_currencies <wow install> | --fixtures <dir>");
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

    let table = match files.read(currencies::CURRENCY_TYPES).and_then(Db2::parse) {
        Ok(table) => table,
        Err(error) => {
            eprintln!("Could not read CurrencyTypes: {error}");
            std::process::exit(1);
        }
    };

    println!(
        "CurrencyTypes: {} columns, {} rows readable of {} declared\n",
        table.column_count(),
        table.rows().count(),
        table.declared_rows()
    );

    // Every row at once, which is the check no handful of names can give: a column that holds
    // FileDataIDs holds them on nearly every row, and a column that holds a category or a
    // quality holds a single digit on nearly every row. Only the rows the table names, because
    // the ones it does not are the encrypted and the retired, and both read as zeroes in every
    // column at once — which says nothing about any of them.
    let named: Vec<_> = table
        .rows()
        .filter(|row| !row.text(currencies::column::NAME).is_empty())
        .collect();
    println!(
        "of the {} named rows, how many hold something in each column, and how many of those \n\
         hold a FileDataID (100000 upwards):",
        named.len()
    );
    for column in FIRST_COLUMN..=LAST_COLUMN {
        let held: Vec<u32> = named
            .iter()
            .map(|row| row.number(column))
            .filter(|value| *value != 0)
            .collect();
        let plausible = held.iter().filter(|value| **value >= 100_000).count();
        println!(
            "  col{column:<3} {:>7} held, {plausible:>7} of them a FileDataID ({:.1}%)",
            held.len(),
            100.0 * plausible as f64 / held.len().max(1) as f64
        );
    }

    let wanted: Vec<String> = args.map(|name| name.to_lowercase()).collect();
    println!(
        "\n{}:",
        if wanted.is_empty() {
            format!("the first {SHOWN} rows the table names")
        } else {
            format!("rows named after {}", wanted.join(", "))
        }
    );
    let mut shown = 0usize;
    for row in table.rows() {
        let name = row.text(currencies::column::NAME);
        if name.is_empty() {
            continue;
        }
        if !wanted.is_empty() && !wanted.iter().any(|asked| name.to_lowercase().contains(asked)) {
            continue;
        }
        if shown >= SHOWN {
            break;
        }
        shown += 1;
        let values: Vec<String> = (FIRST_COLUMN..=LAST_COLUMN)
            .map(|column| format!("col{column}={}", row.number(column)))
            .collect();
        println!("  {:>6} {name} — {}", row.id(), values.join(" "));
        let icon = row.number(currencies::column::ICON_FILE_DATA_ID);
        match files
            .read(icon)
            .and_then(|bytes| icons::png_of(&bytes, LARGEST_ICON))
        {
            Ok(png) => println!("         icon: {icon} decodes, {} bytes of PNG", png.len()),
            Err(error) => println!("         icon: {icon} {error}"),
        }
    }
}
