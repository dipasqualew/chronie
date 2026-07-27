//! Finds `ItemSparse.InventoryType` in a real install, and prints what the weapon slots hold.
//!
//! `ItemAppearance.DisplayType` files every weapon and shield in the game under four numbers
//! and says nothing about which hand any of them goes in. `InventoryType` is the game's own
//! answer to "where does this go", and this is what settles which column of `ItemSparse` it is
//! — that table's positions are the community's rather than this repository's, so the column
//! is found rather than trusted.
//!
//! ```sh
//! cargo run --example dump_inventory_types -- "/Applications/World of Warcraft"
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files.
//!
//! How the column is found: every armour slot's `DisplayType` has exactly one `InventoryType`
//! it can be — a helm is 1, a pair of shoulders 3, a cloak 16 — so the right column is the one
//! that agrees with all eleven of them at once. The scan prints the best few, and a column that
//! agrees on 99% of the armour in the game is not a coincidence in a table this wide.
//!
//! What right looks like: one column near the top of the list at ~100%, the rest far below it,
//! and the cross-tab under it reading 11 → one-hand, two-hand, main hand, off hand; 12 → the
//! ranged weapons; 13 → shields and the things held in an off hand; 15 → held in off hand.
//!
//! If the column has moved, the detail view names weapon slots wrongly and `worn.rs` puts a
//! sword in the wrong hand: `transmog::item_column::INVENTORY_TYPE` is what to change.

use std::collections::HashMap;

use chronie_desktop_lib::db2::Db2;
use chronie_desktop_lib::{casc, transmog};

/// `ItemModifiedAppearance` and `ItemAppearance`, the two hops from an item to its slot.
const ITEM_MODIFIED_APPEARANCE: u32 = 982457;
const ITEM_APPEARANCE: u32 = 982462;

/// Columns of those two, as `transmog` reads them.
const MODIFIED_ITEM_ID: usize = 1;
const MODIFIED_APPEARANCE_ID: usize = 3;
const APPEARANCE_DISPLAY_TYPE: usize = 0;

/// What every armour `DisplayType` has to say in `InventoryType`, which is what identifies the
/// column. The chest slot is the one with two answers: a robe is 20 and a breastplate 5.
const ARMOUR: [(u32, &[u32]); 11] = [
    (0, &[1]),      // head
    (1, &[3]),      // shoulder
    (2, &[4]),      // shirt
    (3, &[5, 20]),  // chest, and a robe
    (4, &[6]),      // waist
    (5, &[7]),      // legs
    (6, &[8]),      // feet
    (7, &[9]),      // wrist
    (8, &[10]),     // hands
    (9, &[16]),     // back
    (10, &[19]),    // tabard
];

/// How many columns to print, best agreement first.
const SHORTLIST: usize = 6;

/// What the game calls each `InventoryType` this app has a use for.
fn named(inventory_type: u32) -> &'static str {
    match inventory_type {
        0 => "not equipped",
        1 => "head",
        2 => "neck",
        3 => "shoulder",
        4 => "shirt",
        5 => "chest",
        6 => "waist",
        7 => "legs",
        8 => "feet",
        9 => "wrist",
        10 => "hands",
        11 => "finger",
        12 => "trinket",
        13 => "one-hand",
        14 => "shield",
        15 => "ranged",
        16 => "back",
        17 => "two-hand",
        18 => "bag",
        19 => "tabard",
        20 => "robe",
        21 => "main hand",
        22 => "off hand",
        23 => "held in off hand",
        24 => "ammo",
        25 => "thrown",
        26 => "ranged right",
        27 => "quiver",
        28 => "relic",
        29 => "profession tool",
        30 => "profession accessory",
        _ => "?",
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_inventory_types <wow install> | --fixtures <dir>");
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

    let read = |fdid: u32| -> Vec<u8> {
        files.read(fdid).unwrap_or_else(|error| {
            eprintln!("Could not read {fdid}: {error}");
            std::process::exit(1);
        })
    };
    let parse = |fdid: u32| -> Db2 {
        Db2::parse(read(fdid)).unwrap_or_else(|error| {
            eprintln!("Could not parse {fdid}: {error}");
            std::process::exit(1);
        })
    };

    // Which slot the game files each item under, two hops out of the appearance chain.
    let appearances = parse(ITEM_APPEARANCE);
    let slots: HashMap<u32, u32> = appearances
        .rows()
        .map(|row| (row.id(), row.number(APPEARANCE_DISPLAY_TYPE)))
        .collect();
    let modified = parse(ITEM_MODIFIED_APPEARANCE);
    let mut display_type: HashMap<u32, u32> = HashMap::new();
    for row in modified.rows() {
        let item = row.number(MODIFIED_ITEM_ID);
        if let Some(slot) = slots.get(&row.number(MODIFIED_APPEARANCE_ID)) {
            display_type.insert(item, *slot);
        }
    }
    println!("{} items have a slot the appearance tables name", display_type.len());

    let items = Db2::parse_with_text_columns(read(transmog::ITEM_SPARSE), &transmog::item_column::TEXT)
        .unwrap_or_else(|error| {
            eprintln!("Could not parse ItemSparse: {error}");
            std::process::exit(1);
        });
    println!("ItemSparse: {} columns, {} rows readable\n", items.column_count(), items.rows().count());

    // Every column against every armour item, which is the whole of the identification.
    let mut agreed = vec![0usize; items.column_count()];
    let mut armour = 0usize;
    let mut weapons: Vec<(u32, u32, Vec<u32>)> = Vec::new();
    for row in items.rows() {
        let Some(slot) = display_type.get(&row.id()).copied() else {
            continue;
        };
        match ARMOUR.iter().find(|(display, _)| *display == slot) {
            Some((_, expected)) => {
                armour += 1;
                for column in 0..items.column_count() {
                    if expected.contains(&row.number(column)) {
                        agreed[column] += 1;
                    }
                }
            }
            None => weapons.push((
                row.id(),
                slot,
                (0..items.column_count()).map(|column| row.number(column)).collect(),
            )),
        }
    }

    let mut ranked: Vec<(usize, usize)> = agreed.iter().copied().enumerate().collect();
    ranked.sort_by(|left, right| right.1.cmp(&left.1));
    println!("{armour} armour items, and how well each column agrees with the slot they are in:");
    for (column, hits) in ranked.iter().take(SHORTLIST) {
        let shape = items.column_shape(*column);
        println!(
            "    col{column:<3} {:>6.2}%   {}",
            *hits as f64 * 100.0 / armour.max(1) as f64,
            shape.map_or(String::new(), |shape| format!(
                "{}, {} bits",
                shape.storage, shape.size_bits
            ))
        );
    }

    let Some((chosen, _)) = ranked.first().copied() else {
        return;
    };
    println!("\nreading col{chosen} as InventoryType.\n");

    // And the answer the whole tool exists for: which hand each weapon display type is.
    let mut cross: HashMap<(u32, u32), usize> = HashMap::new();
    let mut sample: HashMap<(u32, u32), u32> = HashMap::new();
    for (item, slot, values) in &weapons {
        *cross.entry((*slot, values[chosen])).or_default() += 1;
        sample.entry((*slot, values[chosen])).or_insert(*item);
    }
    let displays: HashMap<u32, u32> = appearances
        .rows()
        .map(|row| (row.id(), row.number(1)))
        .collect();
    let mut item_display: HashMap<u32, u32> = HashMap::new();
    for row in modified.rows() {
        if let Some(display) = displays.get(&row.number(MODIFIED_APPEARANCE_ID)) {
            item_display.insert(row.number(MODIFIED_ITEM_ID), *display);
        }
    }
    println!("one item of each, as item / display info id:");
    let mut samples: Vec<((u32, u32), u32)> = sample.into_iter().collect();
    samples.sort();
    for ((slot, inventory_type), item) in samples {
        println!(
            "    DisplayType {slot:>2} {inventory_type:>3} {:<20} item {item} display {}",
            named(inventory_type),
            item_display.get(&item).copied().unwrap_or(0)
        );
    }
    println!();
    let mut pairs: Vec<((u32, u32), usize)> = cross.into_iter().collect();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    println!("{} weapons and shields, by the slot and what they say:", weapons.len());
    let mut last = u32::MAX;
    for ((slot, inventory_type), count) in pairs {
        if slot != last {
            println!("  DisplayType {slot}");
            last = slot;
        }
        println!("      {inventory_type:>3} {:<20} {count:>6}", named(inventory_type));
    }
}
