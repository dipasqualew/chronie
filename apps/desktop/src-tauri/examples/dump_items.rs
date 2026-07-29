//! Prints every string `ItemSparse` holds for a list of items, read straight out of an install.
//!
//! This is the one table in the transmog chain whose column positions were never read off a
//! real install — they are the community's, and `docs/game-files.md` says so. This is how
//! that gets settled, and what to run again after a patch: the five text columns are printed
//! side by side, so which of them holds the name is something to see rather than to assume.
//!
//! ```sh
//! cargo run --example dump_items -- "/Applications/World of Warcraft" 19019 6948
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files. With no ids at
//! all it prints the first few rows the table holds, whatever they turn out to be.
//!
//! What right looks like: column 5 holds a name a player would recognise — "Thunderfury,
//! Blessed Blade of the Windseeker" for 19019, "Hearthstone" for 6948 — and columns 2 to 4
//! are empty for almost everything. If the name has moved, the detail view shows item ids
//! instead of names, and `item_column::NAME` is what to change.

use chronie_desktop_lib::db2::Db2;
use chronie_desktop_lib::{casc, tables};

/// How many rows to print when nothing in particular was asked for.
const A_FEW: usize = 8;

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_items <wow install> | --fixtures <dir> [item id...]");
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

    let wanted: Vec<u32> = args.filter_map(|id| id.parse().ok()).collect();

    let bytes = match files.read(tables::ITEM_SPARSE) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("Could not read ItemSparse: {error}");
            std::process::exit(1);
        }
    };
    println!("ItemSparse: {} bytes", bytes.len());

    let table = match Db2::parse_with_text_columns(bytes, &tables::item_sparse::TEXT) {
        Ok(table) => table,
        Err(error) => {
            eprintln!("Could not parse ItemSparse: {error}");
            std::process::exit(1);
        }
    };
    println!(
        "{} rows readable of {} declared\n",
        table.rows().count(),
        table.declared_rows()
    );

    let mut printed = 0usize;
    for row in table.rows() {
        let id = row.id();
        if wanted.is_empty() {
            if printed >= A_FEW {
                break;
            }
        } else if !wanted.contains(&id) {
            continue;
        }
        printed += 1;
        println!("{id}:");
        for column in tables::item_sparse::TEXT {
            let text = row.text(column);
            let mark = if column == tables::item_sparse::NAME {
                " ← read as the name"
            } else {
                ""
            };
            println!("    col{column} {:?}{mark}", text);
        }
    }

    if printed == 0 {
        println!("This install says nothing about any of those items.");
    }
}
