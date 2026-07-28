//! Finds the columns that describe an item — what it is, what it is worth, who may wear it —
//! and holds them to account against a real install.
//!
//! `Item` is the small table: what kind of thing an item is, where it is worn, and the icon
//! the game draws beside it. `ItemSparse` is the 63 MB one: the name, the quality, and the
//! two restrictions worth showing. Neither table's positions were read off an install before
//! this tool existed, so it finds them rather than trusting them — the same way
//! `dump_inventory_types` finds `ItemSparse.InventoryType`.
//!
//! ```sh
//! cargo run --release --example dump_item_facts -- "/Applications/World of Warcraft"
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files.
//!
//! What right looks like, and what each check would catch if a patch moved something:
//!
//! - **The slot agrees with the table that was already verified.** `Item.InventoryType` and
//!   `ItemSparse.InventoryType` are the same number kept twice, so the first has to agree
//!   with the second on essentially every item both hold. Anything below 99% means one of
//!   the two has moved.
//! - **Armour is filed under an armour subclass.** Every helm, breastplate and pair of boots
//!   in the game is class 4 and one of the five armour subclasses, so a column that is really
//!   the subclass agrees with that and one that is not does not.
//! - **Quality is a small number with the right shape.** Nine values at most, most of the
//!   table common or uncommon, and the items whose quality is common knowledge — Thunderfury
//!   legendary, the Hearthstone common — coming out right.
//! - **A restriction restricts.** Almost every item is for every class; the ones that are not
//!   are the class sets and the class trinkets, and their names say so.
//!
//! If any of it has moved, `items::column` and `items::sparse_column` are what to change.

use std::collections::HashMap;

use chronie_desktop_lib::db2::Db2;
use chronie_desktop_lib::items::{self, ARMOR, WEAPON};
use chronie_desktop_lib::{casc, transmog};

/// Items whose facts are common knowledge, so a wrong column is visible by eye.
const KNOWN: [u32; 4] = [
    6948,  // Hearthstone: miscellaneous, worn nowhere, common
    19019, // Thunderfury: a one-handed sword, legendary
    14834, // Tyrant's Armguards: plate wrists
    2589,  // Linen Cloth: a trade good, worn nowhere
];

/// How many armour subclasses there are: cloth, leather, mail, plate, and cosmetic.
const ARMOR_SUBCLASSES: std::ops::RangeInclusive<u32> = 1..=5;

/// How many class-restricted items to name.
const A_FEW: usize = 12;

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_item_facts <wow install> | --fixtures <dir>");
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

    let read = |fdid: u32| -> std::sync::Arc<Vec<u8>> {
        files.read(fdid).unwrap_or_else(|error| {
            eprintln!("Could not read {fdid}: {error}");
            std::process::exit(1);
        })
    };

    let item = Db2::parse(read(items::ITEM)).unwrap_or_else(|error| {
        eprintln!("Could not parse Item: {error}");
        std::process::exit(1);
    });
    println!(
        "Item: {} columns, {} rows readable",
        item.column_count(),
        item.rows().count()
    );
    let sparse =
        Db2::parse_with_text_columns(read(transmog::ITEM_SPARSE), &transmog::item_column::TEXT)
            .unwrap_or_else(|error| {
                eprintln!("Could not parse ItemSparse: {error}");
                std::process::exit(1);
            });
    println!(
        "ItemSparse: {} columns, {} rows readable",
        sparse.column_count(),
        sparse.rows().count()
    );
    // How each column this module reads is stored, which is what the fixtures have to mirror
    // for a test over them to be worth anything.
    for column in 0..item.column_count() {
        if let Some(shape) = item.column_shape(column) {
            println!("    Item col{column:<3} {}, {} bits", shape.storage, shape.size_bits);
        }
    }
    println!();

    /* ---------- the slot, against the column that was already found ---------- */

    let slots: HashMap<u32, u32> = sparse
        .rows()
        .map(|row| (row.id(), row.number(transmog::item_column::INVENTORY_TYPE)))
        .collect();
    let mut agreed = vec![0usize; item.column_count()];
    let mut both = 0usize;
    for row in item.rows() {
        let Some(slot) = slots.get(&row.id()).copied() else {
            continue;
        };
        both += 1;
        for column in 0..item.column_count() {
            if row.number(column) == slot {
                agreed[column] += 1;
            }
        }
    }
    println!("{both} items are in both tables, and how well each Item column agrees on the slot:");
    let mut ranked: Vec<(usize, usize)> = agreed.iter().copied().enumerate().collect();
    ranked.sort_by(|left, right| right.1.cmp(&left.1));
    for (column, hits) in ranked.iter().take(4) {
        println!(
            "    col{column:<3} {:>6.2}%",
            *hits as f64 * 100.0 / both.max(1) as f64
        );
    }

    /* ---------- what kind of thing it is ---------- */

    // Every piece of armour the game has is class 4 and one of the armour subclasses, which
    // is a shape no other pair of columns in this table has.
    let armour: Vec<u32> = item
        .rows()
        .filter(|row| {
            let slot = row.number(items::column::INVENTORY_TYPE);
            row.number(items::column::CLASS) == ARMOR && (1..=10).contains(&slot)
        })
        .map(|row| row.number(items::column::SUBCLASS))
        .collect();
    let filed = armour
        .iter()
        .filter(|subclass| ARMOR_SUBCLASSES.contains(subclass))
        .count();
    println!(
        "\n{} pieces of armour, {:.2}% of them filed under an armour subclass",
        armour.len(),
        filed as f64 * 100.0 / armour.len().max(1) as f64
    );
    let mut by_class: HashMap<u32, usize> = HashMap::new();
    for row in item.rows() {
        *by_class.entry(row.number(items::column::CLASS)).or_default() += 1;
    }
    let mut classes: Vec<(u32, usize)> = by_class.into_iter().collect();
    classes.sort();
    println!("items by class:");
    for (class, count) in classes {
        let note = match class {
            WEAPON => " weapon",
            ARMOR => " armour",
            _ => "",
        };
        println!("    {class:>3}{note:<8} {count:>7}");
    }

    /* ---------- quality, and how much of the table is which ---------- */

    let mut by_quality: HashMap<u32, usize> = HashMap::new();
    for row in sparse.rows() {
        *by_quality
            .entry(row.number(items::sparse_column::QUALITY))
            .or_default() += 1;
    }
    let mut qualities: Vec<(u32, usize)> = by_quality.into_iter().collect();
    qualities.sort();
    println!("\nitems by quality:");
    for (quality, count) in qualities {
        println!("    {quality:>3} {count:>7}");
    }

    /* ---------- who may wear it ---------- */

    let restricted: Vec<(u32, u32, String)> = sparse
        .rows()
        .filter(|row| {
            let allowed = row.number(items::sparse_column::ALLOWABLE_CLASS);
            allowed != items::ANY_CLASS && allowed != 0
        })
        .map(|row| {
            (
                row.id(),
                row.number(items::sparse_column::ALLOWABLE_CLASS),
                row.text(transmog::item_column::NAME),
            )
        })
        .collect();
    println!(
        "\n{} items are for some classes and not others; the first {A_FEW}:",
        restricted.len()
    );
    for (id, allowed, name) in restricted.iter().take(A_FEW) {
        println!("    {id:>7} mask {allowed:>6}  {name}");
    }

    /* ---------- and the items anybody can check by eye ---------- */

    println!("\nthe items whose facts are common knowledge:");
    for wanted in KNOWN {
        let Some(row) = item.rows().find(|row| row.id() == wanted) else {
            println!("    {wanted:>7} is not in Item at all");
            continue;
        };
        let sparse_row = sparse.rows().find(|row| row.id() == wanted);
        println!(
            "    {wanted:>7} {:<46} class {:>2} subclass {:>2} slot {:>2} quality {} \
             level {:>3} classes {:>6} icon {}",
            sparse_row
                .as_ref()
                .map(|row| row.text(transmog::item_column::NAME))
                .unwrap_or_default(),
            row.number(items::column::CLASS),
            row.number(items::column::SUBCLASS),
            row.number(items::column::INVENTORY_TYPE),
            sparse_row
                .as_ref()
                .map(|row| row.number(items::sparse_column::QUALITY))
                .unwrap_or_default(),
            sparse_row
                .as_ref()
                .map(|row| row.number(items::sparse_column::REQUIRED_LEVEL))
                .unwrap_or_default(),
            sparse_row
                .as_ref()
                .map(|row| row.number(items::sparse_column::ALLOWABLE_CLASS))
                .unwrap_or_default(),
            row.number(items::column::ICON_FILE_ID),
        );
    }
}
