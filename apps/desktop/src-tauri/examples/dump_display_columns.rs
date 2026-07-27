//! Prints the columns around `ItemDisplayInfo.GeosetGroup` for named items in a real install.
//!
//! `ModelResourcesID` at 10 and `ModelMaterialResourcesID` at 11 were read off an install;
//! `GeosetGroup` at 12 and `ModelType` at 13 were taken from the community's definitions and
//! never checked. This is how that gets settled, and what to run again after a patch.
//!
//! ```sh
//! cargo run --example dump_display_columns -- "/Applications/World of Warcraft"
//! cargo run --example dump_display_columns -- "/Applications/World of Warcraft" Robe Sabatons
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files. With no names it
//! looks for one item of each of the four shapes that tell the columns apart.
//!
//! What right looks like, per row printed:
//!
//! - **Small numbers.** A geoset value is 0 to 98, and the game writes -1 where a row drives
//!   no geoset at all. A column of five- and six-digit numbers is a resource id, not this.
//! - **Six of them.** The column is 192 bits wide where the two above it are 64: an array of
//!   six 32-bit values against their two.
//! - **A robe that is not a chestpiece.** Both are worn in the chest slot, and the chest
//!   slot's six values drive sleeves, chest, robe, torso and arm upper in that order. A robe
//!   leaves the chest group at 0 and puts something in the robe group; a breastplate does the
//!   opposite. No other column in the table looks like that.
//!
//! If the numbers are wrong, the column moved: `transmog::display_column::GEOSET_GROUP` is
//! what to change, and the symptom in the app is armour that swaps no geometry — a robe
//! painted over legs that stay bare.

use std::collections::HashMap;

use chronie_desktop_lib::db2::Db2;
use chronie_desktop_lib::{casc, transmog};

/// `ItemModifiedAppearance` and `ItemAppearance`, the two hops from an item to its display.
const ITEM_MODIFIED_APPEARANCE: u32 = 982457;
const ITEM_APPEARANCE: u32 = 982462;

/// Columns of those two, as `transmog` reads them. They are not public there, and copying
/// four indices into the tool that checks a fifth is better than opening the module up.
const MODIFIED_ITEM_ID: usize = 1;
const MODIFIED_APPEARANCE_ID: usize = 3;
const APPEARANCE_DISPLAY_TYPE: usize = 0;
const APPEARANCE_DISPLAY_INFO_ID: usize = 1;

/// The columns to print: every array column the table ends with, which is the run they have
/// to be told apart within. Stopping at 14 would leave the last of them unaccounted for, and
/// an unaccounted column is how the wrong one gets picked in the first place.
const FIRST_COLUMN: usize = 10;
const LAST_COLUMN: usize = 15;

/// How many elements to read out of each, and how wide one is taken to be. Six because that
/// is what `GeosetGroup` is said to hold; a column that has fewer answers 0 past its end.
const ELEMENTS: usize = 6;
const ELEMENT_BITS: u32 = 32;

/// How many items to print per name asked for. Enough to see past one encrypted display.
const PER_NAME: usize = 3;

/// The largest number a geoset value can be: `group × 100 + value`, so 99 is the next group.
const LARGEST_VALUE: i32 = 98;

/// The shapes worth looking at when nobody said, and the slot each is worn in.
///
/// A robe and a breastplate are the pair that settles it, and both have to be things the game
/// has shipped: Blizzard encrypts the displays of content it has not, and those read as
/// zeroes in every column at once, which says nothing about any of them.
const SHAPES: [(&str, u32); 4] = [
    ("Robe", CHEST),
    ("Breastplate", CHEST),
    ("Boots", FEET),
    ("Helm", HEAD),
];

/// Slots, as `ItemAppearance` numbers them: 0 head, 1 shoulder, 2 shirt, 3 chest, 4 waist,
/// 5 legs, 6 feet, 7 wrist, 8 hands, 9 back, 10 tabard, and 11 upward the weapons.
const HEAD: u32 = 0;
const CHEST: u32 = 3;
const FEET: u32 = 6;
/// The one slot given as "any", for a name the caller asked for rather than a shape here.
const ANY_SLOT: u32 = u32::MAX;

/// Which geoset group each of the six values drives, for the slots this prints. From
/// `docs/character-rendering.md`, and only so that the printout can name them.
fn groups_of(display_type: u32) -> &'static [&'static str] {
    match display_type {
        HEAD => &["helm", "skull"],
        CHEST => &["sleeves", "chest", "robe", "torso", "arm upper"],
        FEET => &["boot", "feet"],
        _ => &[],
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_display_columns <wow install> | --fixtures <dir> [item name...]");
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

    let asked: Vec<(String, u32)> = args.map(|name| (name, ANY_SLOT)).collect();
    let wanted: Vec<(String, u32)> = if asked.is_empty() {
        SHAPES
            .iter()
            .map(|(name, slot)| ((*name).to_string(), *slot))
            .collect()
    } else {
        asked
    };

    let displays = match files.read(transmog::ITEM_DISPLAY_INFO).and_then(Db2::parse) {
        Ok(table) => table,
        Err(error) => {
            eprintln!("Could not read ItemDisplayInfo: {error}");
            std::process::exit(1);
        }
    };
    println!(
        "ItemDisplayInfo: {} columns, {} rows readable of {} declared\n",
        displays.column_count(),
        displays.rows().count(),
        displays.declared_rows()
    );
    for column in FIRST_COLUMN..=LAST_COLUMN {
        match displays.column_shape(column) {
            Some(shape) => println!(
                "  col{column:<3} {:<16} {:>4} bits{}",
                shape.storage,
                shape.size_bits,
                if shape.array_count > 0 {
                    format!(", runs of {}", shape.array_count)
                } else {
                    String::new()
                }
            ),
            None => println!("  col{column:<3} — the table has no such column"),
        }
    }

    // The named displays below are what settles which column means what; this is the check
    // that no cherry-picked handful could give — every row of the table at once. A geoset
    // value is 0 to 98 or -1, so a column that holds them holds nothing else, and a column of
    // resource ids fails it on almost every row.
    println!("\nrows whose every element could be a geoset value (0..=98, or -1):");
    for column in FIRST_COLUMN..=LAST_COLUMN {
        let total = displays.rows().count();
        let plausible = displays
            .rows()
            .filter(|row| {
                (0..ELEMENTS).all(|index| {
                    let value = row.element(column, index, ELEMENT_BITS) as i32;
                    (-1..=LARGEST_VALUE).contains(&value)
                })
            })
            .count();
        println!(
            "  col{column:<3} {plausible:>7} of {total} ({:.1}%)",
            100.0 * plausible as f64 / total.max(1) as f64
        );
    }

    let named = match names(files.as_ref(), &wanted) {
        Ok(named) => named,
        Err(error) => {
            eprintln!("Could not read ItemSparse: {error}");
            std::process::exit(1);
        }
    };
    let by_item = match slots(files.as_ref()) {
        Ok(by_item) => by_item,
        Err(error) => {
            eprintln!("Could not follow items to their displays: {error}");
            std::process::exit(1);
        }
    };
    let rows: HashMap<u32, usize> = displays
        .rows()
        .enumerate()
        .map(|(index, row)| (row.id(), index))
        .collect();
    let all: Vec<_> = displays.rows().collect();

    let mut printed = 0usize;
    for (wanted_name, wanted_slot) in &wanted {
        let mut shown = 0usize;
        println!("\n{wanted_name}:");
        for (item_id, name) in &named {
            if shown >= PER_NAME {
                break;
            }
            if !name.to_lowercase().contains(&wanted_name.to_lowercase()) {
                continue;
            }
            let Some((display_type, display_info_id)) = by_item.get(item_id).copied() else {
                continue;
            };
            if *wanted_slot != ANY_SLOT && display_type != *wanted_slot {
                continue;
            }
            let Some(row) = rows.get(&display_info_id).and_then(|at| all.get(*at)) else {
                continue;
            };
            shown += 1;
            printed += 1;

            println!("  {name} (item {item_id}, slot {display_type}, display {display_info_id})");
            for column in FIRST_COLUMN..=LAST_COLUMN {
                let values: Vec<String> = (0..ELEMENTS)
                    .map(|index| (row.element(column, index, ELEMENT_BITS) as i32).to_string())
                    .collect();
                println!("    col{column:<3} [{}]", values.join(", "));
            }
            let groups = groups_of(display_type);
            if !groups.is_empty() {
                println!("           a geoset column would read: {}", groups.join(", "));
            }
        }
        if shown == 0 {
            println!("  nothing this install can follow to a display");
        }
    }

    if printed == 0 {
        println!("\nNo item matched. Pass names this client would use.");
    }
}

/// Every item whose name contains one of the words asked for, as `(item id, name)`.
fn names(files: &dyn casc::GameFiles, wanted: &[(String, u32)]) -> Result<Vec<(u32, String)>, String> {
    let table = Db2::parse_with_text_columns(files.read(transmog::ITEM_SPARSE)?, &transmog::item_column::TEXT)?;
    let lowered: Vec<String> = wanted.iter().map(|(name, _)| name.to_lowercase()).collect();
    Ok(table
        .rows()
        .filter_map(|row| {
            let name = row.text(transmog::item_column::NAME);
            let matches = lowered
                .iter()
                .any(|wanted| name.to_lowercase().contains(wanted));
            matches.then(|| (row.id(), name))
        })
        .collect())
}

/// Which slot and which display each item ends up at, through its appearance.
fn slots(files: &dyn casc::GameFiles) -> Result<HashMap<u32, (u32, u32)>, String> {
    let appearances = Db2::parse(files.read(ITEM_APPEARANCE)?)?;
    let by_appearance: HashMap<u32, (u32, u32)> = appearances
        .rows()
        .map(|row| {
            (
                row.id(),
                (
                    row.number(APPEARANCE_DISPLAY_TYPE),
                    row.number(APPEARANCE_DISPLAY_INFO_ID),
                ),
            )
        })
        .collect();

    let modified = Db2::parse(files.read(ITEM_MODIFIED_APPEARANCE)?)?;
    Ok(modified
        .rows()
        .filter_map(|row| {
            let item = row.number(MODIFIED_ITEM_ID);
            let appearance = by_appearance.get(&row.number(MODIFIED_APPEARANCE_ID))?;
            Some((item, *appearance))
        })
        .collect())
}
