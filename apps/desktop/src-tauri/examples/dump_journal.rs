//! Prints the two tables that hold a picture for a place, against a real install.
//!
//! The timeline draws the place a segment happened in with the picture the game draws it with, and
//! that picture is one column of `JournalInstance` and one column of `LFGDungeons`. This is what
//! settled which columns, and what to run again after a patch.
//!
//! ```sh
//! cargo run --example dump_journal -- "/Applications/World of Warcraft"
//! cargo run --example dump_journal -- "/Applications/World of Warcraft" Deadmines Earthcrawl
//! cargo run --example dump_journal -- --fixtures apps/desktop/fixtures/journal
//! ```
//!
//! With no names it prints the first rows each table holds, which is where the classic dungeons
//! are. Pass names to reach a modern one, or a delve.
//!
//! What right looks like:
//!
//! - **Names that are places.** Both tables open with a name and a description, and a run whose
//!   first column reads "Deadmines", "Shadowfang Keep", "Earthcrawl Mines" is the table this is
//!   meant to be reading. Anything else and the FileDataID has moved.
//! - **One column of FileDataIDs that decode small.** `JournalInstance` holds four files side by
//!   side and only one of them is an icon; the rest are a background, a wide banner and a lore
//!   illustration, each several hundred pixels. The sweep under each table decodes every icon the
//!   column names and prints the sizes they came out at — one size, and a small one, is the
//!   answer. Anything 512 a side is the wrong column.
//! - **The two tables agreeing.** The last block counts how often they name the same picture for
//!   the same place. They agreed 581 times out of 619 on 12.0.5.67823; a run where they hardly
//!   ever agree is a column read wrong in one of them.

use std::collections::HashMap;

use chronie_desktop_lib::casc::{self, GameFiles};
use chronie_desktop_lib::db2::{Db2, Row};
use chronie_desktop_lib::icons;
use chronie_desktop_lib::journal;

/// How many rows to print in full, which is enough to see the shape of a table.
const SHOWN: usize = 8;

/// The columns to print beside each name: the run the files have to be somewhere inside.
const FIRST_COLUMN: usize = 1;
const LAST_COLUMN: usize = 9;

/// What a texture is at most, a side at a time. Far above what an icon is, on purpose: the point
/// of the sweep is to see the banners come out large rather than to have them refused.
const LARGEST_TEXTURE: u32 = 4096;

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_journal <wow install> | --fixtures <dir>");
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

    let wanted: Vec<String> = args.map(|name| name.to_lowercase()).collect();
    let journal = report(
        files.as_ref(),
        "JournalInstance",
        journal::JOURNAL_INSTANCE,
        journal::journal_column::NAME,
        journal::journal_column::BUTTON_SMALL_FILE_DATA_ID,
        &wanted,
    );
    let finder = report(
        files.as_ref(),
        "LFGDungeons",
        journal::LFG_DUNGEONS,
        journal::lfg_column::NAME,
        journal::lfg_column::ICON_TEXTURE_FILE_ID,
        &wanted,
    );

    // What the two of them make of the same place. The journal is read first and the finder fills
    // in behind it, so what matters is how far apart they are where both have an opinion.
    let (mut agree, mut differ) = (0usize, 0usize);
    for (name, icon) in &finder {
        match journal.get(name) {
            Some(theirs) if theirs == icon => agree += 1,
            Some(_) => differ += 1,
            None => {}
        }
    }
    println!(
        "\nplaces: {} in the journal, {} in the finder, {} in both — of those {agree} agree on \
         the picture and {differ} do not.\n{} places altogether once the finder fills in behind \
         the journal.",
        journal.len(),
        finder.len(),
        agree + differ,
        journal.len() + finder.len() - agree - differ,
    );
}

/// One table read through: what its columns hold, what its icons decode to, and a few rows in
/// full. Answers the icon each name it holds is drawn with, for the comparison above.
fn report(
    files: &dyn GameFiles,
    what: &str,
    file: u32,
    name_column: usize,
    icon_column: usize,
    wanted: &[String],
) -> HashMap<String, u32> {
    let table = match files.read(file).and_then(Db2::parse) {
        Ok(table) => table,
        Err(error) => {
            eprintln!("Could not read {what}: {error}");
            std::process::exit(1);
        }
    };
    println!(
        "\n=== {what}: {} columns, {} rows readable of {} declared ===\n",
        table.column_count(),
        table.rows().count(),
        table.declared_rows()
    );

    // Every row at once, which is the check no handful of names can give: a column that holds
    // FileDataIDs holds them on nearly every row, and a column that holds a map id or a flag holds
    // a small number on nearly every row.
    let named: Vec<Row<'_>> = table
        .rows()
        .filter(|row| !row.text(name_column).is_empty())
        .collect();
    println!(
        "of the {} named rows, how many hold something in each column, and how many of those\n\
         hold a FileDataID (100000 upwards):",
        named.len()
    );
    for column in FIRST_COLUMN..=LAST_COLUMN.min(table.column_count().saturating_sub(1)) {
        let held: Vec<u32> = named
            .iter()
            .map(|row| row.number(column))
            .filter(|value| *value != 0)
            .collect();
        let plausible = held.iter().filter(|value| **value >= 100_000).count();
        println!(
            "  col{column:<3} {:>6} held, {plausible:>6} of them a FileDataID ({:.1}%)",
            held.len(),
            100.0 * plausible as f64 / held.len().max(1) as f64
        );
    }

    // Every icon the column names, decoded, so the size the window will be handed is measured
    // rather than assumed. A column of banners decodes wide; a column of icons decodes square.
    let mut found: HashMap<String, u32> = HashMap::new();
    let mut sizes: HashMap<(u32, u32), usize> = HashMap::new();
    let mut unreadable = 0usize;
    for row in &named {
        let icon = row.number(icon_column);
        if icon == 0 {
            continue;
        }
        found
            .entry(row.text(name_column).trim().to_lowercase())
            .or_insert(icon);
        match files
            .read(icon)
            .and_then(|bytes| icons::pixels_of(&bytes, LARGEST_TEXTURE))
        {
            Ok(image) => *sizes.entry((image.width(), image.height())).or_default() += 1,
            Err(_) => unreadable += 1,
        }
    }
    let mut sizes: Vec<_> = sizes.into_iter().collect();
    sizes.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    println!("\nevery icon col{icon_column} names, by the size it decodes to:");
    for ((width, height), count) in sizes {
        println!("  {width}×{height}  {count}");
    }
    println!("  unreadable  {unreadable}");

    println!(
        "\n{}:",
        if wanted.is_empty() {
            format!("the first {SHOWN} rows the table names")
        } else {
            format!("rows named after {}", wanted.join(", "))
        }
    );
    let mut shown = 0usize;
    for row in &named {
        let name = row.text(name_column);
        if !wanted.is_empty()
            && !wanted
                .iter()
                .any(|asked| name.to_lowercase().contains(asked))
        {
            continue;
        }
        if shown >= SHOWN {
            break;
        }
        shown += 1;
        let values: Vec<String> = (FIRST_COLUMN..=LAST_COLUMN.min(table.column_count() - 1))
            .map(|column| format!("col{column}={}", row.number(column)))
            .collect();
        println!("  {:>6} {name} — {}", row.id(), values.join(" "));
        // Every column that could be a file, decoded: what tells the icon from the banner beside
        // it is the size it comes back as, not the number.
        for column in FIRST_COLUMN..=LAST_COLUMN.min(table.column_count() - 1) {
            let file = row.number(column);
            if file < 100_000 {
                continue;
            }
            match files
                .read(file)
                .and_then(|bytes| icons::pixels_of(&bytes, LARGEST_TEXTURE))
            {
                Ok(image) => println!(
                    "         col{column}: {file} decodes, {}×{}",
                    image.width(),
                    image.height()
                ),
                Err(error) => println!("         col{column}: {file} {error}"),
            }
        }
    }
    found
}
