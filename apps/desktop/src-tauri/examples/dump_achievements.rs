//! Prints what the game says about a list of achievements, read straight out of an install.
//!
//! This is the tool for checking the reader against real game files, which the test suite
//! deliberately never touches — it runs on fixtures so it can run anywhere. The column
//! numbers `achievements.rs` uses were established with this, and it is what to run again
//! after a patch: a table that has been reordered shows wrong values rather than failing, so
//! what it prints has to be read rather than merely produced.
//!
//! ```sh
//! cargo run --example dump_achievements -- "/Applications/World of Warcraft" 6 892 4826
//! cargo run --example dump_achievements -- "/Applications/World of Warcraft" --factions
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files. With no ids at
//! all it prints a spread of them: the first few, and one from each corner worth checking.
//!
//! `--factions` prints the other half of this table's work: the walk from a faction's name back
//! to the achievement for reaching Exalted with it, which is where a reputation line gets its
//! picture. See `reputations.rs`. What right looks like there:
//!
//! - **Three more tables that census as they should.** `Faction`'s column 0 is 256 bits of race
//!   mask and its name is in column 1; `Criteria`'s type column holds a hundred-odd small numbers
//!   and its asset column runs to five digits; `CriteriaTree` names a parent that exists on every
//!   row that names one at all. A run where any of those reads differently is a moved column.
//! - **386 criteria of type 46, over 223 factions.** That is the count on 12.0.5.67823, and the
//!   assets are what say the type is right: 529, 576, 609, 749 and 910 come out as Argent Dawn,
//!   Timbermaw Hold, the Cenarion Circle, the Hydraxian Waterlords and the Brood of Nozdormu.
//! - **138 factions with an achievement of their own, and 73 aggregates left behind.** The gap
//!   between 216 reachable and 138 answerable is the whole point of the rule: an aggregate's icon
//!   would go on every reputation line at once.
//! - **Four spot checks.** Faction 729 draws `133287` from "Hero of the Frostwolf Clan", 730
//!   `133433`, 509 `132351` from "Knight of Arathor", 510 `237568` from "The Defiler".

use std::collections::{HashMap, HashSet};

use chronie_desktop_lib::db2::Db2;
use chronie_desktop_lib::{achievements, casc, icons, reputations, tables};

/// Achievements worth looking at when no particular one was asked for: the first two levels,
/// a dungeon achievement tied to an instance, a feat of strength, and one from the legacy
/// tree — which between them cover a category path, a reward, and being worth nothing.
const A_SPREAD: [u32; 6] = [6, 7, 490, 892, 4826, 5372];

/// How many columns of each table `--factions` censuses. Past what any of them reads, on purpose:
/// what says a column has not moved is the shape of the ones around it.
const CENSUS_COLUMNS: usize = 8;

/// What an icon is at most, a side at a time — well above the 64 these come out at, so that a
/// column holding something other than an icon is seen to be large rather than refused.
const LARGEST_TEXTURE: u32 = 512;

/// The five factions whose type-46 criteria settle what type 46 means. Nothing they have in
/// common but being reputations a player grinds: Argent Dawn, Timbermaw Hold, the Cenarion Circle,
/// the Hydraxian Waterlords, the Brood of Nozdormu.
const SETTLES_THE_TYPE: [u32; 5] = [529, 576, 609, 749, 910];

/// Four factions and the icon each should draw, off build 12.0.5.67823 — the Frostwolf Clan and
/// the Stormpike Guard from Alterac Valley, and the two Arathi Basin sides.
const SPOT_CHECKS: [(u32, u32); 4] = [(729, 133287), (730, 133433), (509, 132351), (510, 237568)];

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_achievements <wow install> | --fixtures <dir> [id...]");
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

    let rest: Vec<String> = args.collect();
    if rest.iter().any(|arg| arg == "--factions") {
        factions(files.as_ref());
        return;
    }

    let mut wanted: Vec<u32> = rest.iter().filter_map(|id| id.parse().ok()).collect();
    if wanted.is_empty() {
        wanted = A_SPREAD.to_vec();
    }

    let found = match achievements::read(files.as_ref(), &wanted) {
        Ok(found) => found,
        Err(error) => {
            eprintln!("Could not read the achievements: {error}");
            std::process::exit(1);
        }
    };

    for (id, achievement) in found {
        let Some(achievement) = achievement else {
            println!("{id}: this install says nothing about it");
            continue;
        };
        let side = match achievement.faction {
            achievements::HORDE => "Horde",
            achievements::ALLIANCE => "Alliance",
            _ => "both sides",
        };
        println!(
            "{id}: {}\n    {}\n    {} · {} points · {side} · icon {}{}",
            achievement.title,
            achievement.description,
            if achievement.category.is_empty() {
                format!("category {}", achievement.category_id)
            } else {
                achievement.category.join(" › ")
            },
            achievement.points,
            achievement.icon_file_data_id,
            if achievement.reward.is_empty() {
                String::new()
            } else {
                format!("\n    {}", achievement.reward)
            },
        );
    }
}

/// The reputation half: three more tables, and the walk from a faction's name to an icon.
///
/// `achievements.rs` is read by id and would show a moved column as an obviously wrong string.
/// This walk is read entirely by number and would not — a wrong column here gives a plausible
/// icon for the wrong reason — so what holds it to account is the counts and the spot checks
/// rather than anything the reader itself reports.
fn factions(files: &dyn casc::GameFiles) {
    for (what, file) in [
        ("Faction", tables::FACTION),
        ("Criteria", tables::CRITERIA),
        ("CriteriaTree", tables::CRITERIA_TREE),
        ("Achievement", tables::ACHIEVEMENT),
    ] {
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
        let rows: Vec<_> = table.rows().collect();
        for column in 0..table.column_count().min(CENSUS_COLUMNS) {
            let held: Vec<u32> = rows
                .iter()
                .map(|row| row.number(column))
                .filter(|value| *value != 0)
                .collect();
            let texty = rows
                .iter()
                .filter(|row| !row.text(column).is_empty())
                .count();
            println!(
                "  col{column:<3} {:>7} held, largest {:>10}, {texty:>7} a string  {}",
                held.len(),
                held.iter().copied().max().unwrap_or(0),
                table
                    .column_shape(column)
                    .map(|shape| format!("{} bits, {}", shape.size_bits, shape.storage))
                    .unwrap_or_default(),
            );
        }
    }

    let factions = files
        .read(tables::FACTION)
        .and_then(Db2::parse)
        .expect("Faction reads");
    let criteria = files
        .read(tables::CRITERIA)
        .and_then(Db2::parse)
        .expect("Criteria reads");

    // What every faction is called, so that the walk can be read as names rather than numbers.
    let named: HashMap<u32, String> = factions
        .rows()
        .map(|row| (row.id(), row.text(tables::faction::NAME)))
        .filter(|(_, name)| !name.is_empty())
        .collect();
    let mut spellings: HashMap<String, usize> = HashMap::new();
    for name in named.values() {
        *spellings.entry(name.to_lowercase()).or_default() += 1;
    }
    let repeated = spellings.values().filter(|count| **count > 1).count();
    println!(
        "\n{} of {} Faction rows name a faction, under {} distinct names — {repeated} of those \
         {} on more than one row, which is why every row bearing an asked-for name is followed.",
        named.len(),
        factions.rows().count(),
        spellings.len(),
        if repeated == 1 { "is" } else { "are" },
    );

    // The type-46 criteria, and the five assets that say the type is the right one.
    let about: HashMap<u32, u32> = criteria
        .rows()
        .filter(|row| row.number(tables::criteria::TYPE) == reputations::REPUTATION_CRITERIA)
        .map(|row| (row.id(), row.number(tables::criteria::ASSET)))
        .collect();
    let mentioned: HashSet<u32> = about.values().copied().collect();
    println!(
        "\n{} criteria are of type {} (\"reach reputation with faction\"), over {} distinct \
         factions.\nthe assets that settle the type:",
        about.len(),
        reputations::REPUTATION_CRITERIA,
        mentioned.len(),
    );
    for faction in SETTLES_THE_TYPE {
        println!(
            "  {faction:<5} {}",
            named
                .get(&faction)
                .cloned()
                .unwrap_or_else(|| "— not in the table —".into())
        );
    }

    // And the reader itself, over every faction the criteria mention: how many come back, and
    // whether what comes back decodes and is icon-shaped. Asked by id, which is what the addon
    // sends — the names above are only so the output can be read.
    let asked: Vec<i64> = mentioned
        .iter()
        .map(|faction| i64::from(*faction))
        .collect();
    let answered = match reputations::icons_of(files, &asked) {
        Ok(answered) => answered,
        Err(error) => {
            eprintln!("Could not walk the factions: {error}");
            std::process::exit(1);
        }
    };
    println!(
        "\n{} of those factions have an achievement of their very own and answer with its icon; \
         the other {} reach only an aggregate and answer with nothing.",
        answered.len(),
        asked.len() - answered.len(),
    );

    let mut sizes: HashMap<(u32, u32), usize> = HashMap::new();
    let mut unreadable = 0usize;
    let mut shared: HashMap<u32, usize> = HashMap::new();
    for icon in answered.values() {
        *shared.entry(*icon).or_default() += 1;
        match files
            .read(*icon)
            .and_then(|bytes| icons::pixels_of(&bytes, LARGEST_TEXTURE))
        {
            Ok(image) => *sizes.entry((image.width(), image.height())).or_default() += 1,
            Err(_) => unreadable += 1,
        }
    }
    println!("\nevery icon answered with, by the size it decodes to:");
    let mut sizes: Vec<_> = sizes.into_iter().collect();
    sizes.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    for ((width, height), count) in sizes {
        println!("  {width}×{height}  {count}");
    }
    println!("  unreadable  {unreadable}");
    println!(
        "  {} distinct icons, {} of them drawn for more than one faction",
        shared.len(),
        shared.values().filter(|count| **count > 1).count()
    );

    println!("\nthe four spot checks:");
    for (faction, expected) in SPOT_CHECKS {
        let name = named.get(&faction).cloned().unwrap_or_default();
        let icon = answered.get(&i64::from(faction)).copied().unwrap_or(0);
        println!(
            "  {faction:<5} {name:<26} icon {icon:<9} {}",
            if icon == expected {
                "as expected".to_string()
            } else {
                format!("EXPECTED {expected}")
            }
        );
    }
}
