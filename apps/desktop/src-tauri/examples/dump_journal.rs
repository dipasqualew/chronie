//! Prints the four tables the journal work reads, against a real install.
//!
//! Two of them hold a picture for a *place* — the timeline draws the place a segment happened in
//! with the picture the game draws it with, and that picture is one column of `JournalInstance` and
//! one column of `LFGDungeons`. Two more turn a *fight* into the portrait the Adventure Guide draws
//! beside that boss: `JournalEncounter` and `JournalEncounterCreature`. This is what settled which
//! columns, and what to run again after a patch.
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
//! - **Names that are places.** Both place tables open with a name and a description, and a run
//!   whose first column reads "Deadmines", "Shadowfang Keep", "Earthcrawl Mines" is the table this
//!   is meant to be reading. Anything else and the FileDataID has moved.
//! - **One column of FileDataIDs that decode small.** `JournalInstance` holds four files side by
//!   side and only one of them is an icon; the rest are a background, a wide banner and a lore
//!   illustration, each several hundred pixels. The sweep under each table decodes every icon the
//!   column names and prints the sizes they came out at — one size, and a small one, is the
//!   answer. Anything 512 a side is the wrong column.
//! - **The two place tables agreeing.** The block after them counts how often they name the same
//!   picture for the same place. They agreed 581 times out of 619 on 12.0.5.67823; a run where they
//!   hardly ever agree is a column read wrong in one of them.
//! - **Portraits that are all one shape, and it is not a square.** Every one of the 1,172 files
//!   `JournalEncounterCreature` names decoded at 128×64 on 12.0.5.67823. That is the check that
//!   says the column is the portrait: a square would be an icon and a 512 would be a background,
//!   and both of those live in neighbouring tables this chain could have landed on.
//! - **Bosses that belong to the instances they should.** The last block walks the whole chain the
//!   app walks — `DungeonEncounterID` to `JournalEncounter` to `JournalEncounterCreature` — and
//!   prints the instance each fight was filed under, by the same `JournalInstance` id the place
//!   icons above are keyed by. Glubtok under Deadmines is the row to look for.

use std::collections::HashMap;

use chronie_desktop_lib::casc::{self, GameFiles};
use chronie_desktop_lib::db2::{Db2, Row};
use chronie_desktop_lib::icons;
use chronie_desktop_lib::tables;

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
        tables::JOURNAL_INSTANCE,
        tables::journal_instance::NAME,
        tables::journal_instance::BUTTON_SMALL_FILE_DATA_ID,
        &wanted,
    );
    let finder = report(
        files.as_ref(),
        "LFGDungeons",
        tables::LFG_DUNGEONS,
        tables::lfg_dungeons::NAME,
        tables::lfg_dungeons::ICON_TEXTURE_FILE_ID,
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

    bosses(files.as_ref(), &wanted);
}

/// The boss half: the two tables, and the chain the app walks between them.
///
/// The place tables above are read by name, so a run that landed on the wrong table shows it
/// immediately in the first column. These two are read by number and would not, which is why the
/// census and the decode sweep matter more here: what says `JournalEncounterCreature` col5 is the
/// portrait is that every file it names comes back the same shape, and what says
/// `JournalEncounter` col5 is the `DungeonEncounterID` is that the fight it reaches sits in the
/// instance the fight is actually in.
fn bosses(files: &dyn GameFiles, wanted: &[String]) {
    let encounters = match files.read(tables::JOURNAL_ENCOUNTER).and_then(Db2::parse) {
        Ok(table) => table,
        Err(error) => {
            eprintln!("Could not read JournalEncounter: {error}");
            std::process::exit(1);
        }
    };
    let creatures = match files
        .read(tables::JOURNAL_ENCOUNTER_CREATURE)
        .and_then(Db2::parse)
    {
        Ok(table) => table,
        Err(error) => {
            eprintln!("Could not read JournalEncounterCreature: {error}");
            std::process::exit(1);
        }
    };

    for (what, table) in [
        ("JournalEncounter", &encounters),
        ("JournalEncounterCreature", &creatures),
    ] {
        println!(
            "\n=== {what}: {} columns, {} rows readable of {} declared ===\n",
            table.column_count(),
            table.rows().count(),
            table.declared_rows()
        );
        // Every column of both, because neither is read by name and a shifted column would
        // otherwise show up only as a portrait that happens not to decode. What each column holds
        // and how wide it is is the fingerprint: an id column counts to a couple of thousand, a
        // FileDataID runs to seven digits, and an order index never leaves single figures.
        let rows: Vec<Row<'_>> = table.rows().collect();
        for column in 0..table.column_count() {
            let held: Vec<u32> = rows
                .iter()
                .map(|row| row.number(column))
                .filter(|value| *value != 0)
                .collect();
            let files_like = held.iter().filter(|value| **value >= 100_000).count();
            let texty = rows
                .iter()
                .filter(|row| !row.text(column).is_empty())
                .count();
            println!(
                "  col{column:<3} {:>6} held, largest {:>9}, {files_like:>6} a FileDataID, \
                 {texty:>6} a string",
                held.len(),
                held.iter().copied().max().unwrap_or(0),
            );
        }
    }

    // Every portrait the column names, decoded. One shape throughout is the answer; a spread of
    // sizes is a column holding something other than portraits.
    let mut sizes: HashMap<(u32, u32), usize> = HashMap::new();
    let mut unreadable = 0usize;
    let mut portraits: HashMap<u32, (u32, u32)> = HashMap::new();
    for row in creatures.rows() {
        let portrait = row.number(tables::journal_encounter_creature::PORTRAIT_FILE_DATA_ID);
        if portrait == 0 {
            continue;
        }
        let order = row.number(tables::journal_encounter_creature::ORDER_INDEX);
        let encounter = row.number(tables::journal_encounter_creature::JOURNAL_ENCOUNTER_ID);
        if portraits
            .get(&encounter)
            .is_none_or(|(had, _)| order < *had)
        {
            portraits.insert(encounter, (order, portrait));
        }
        match files
            .read(portrait)
            .and_then(|bytes| icons::pixels_of(&bytes, LARGEST_TEXTURE))
        {
            Ok(image) => *sizes.entry((image.width(), image.height())).or_default() += 1,
            Err(_) => unreadable += 1,
        }
    }
    let mut sizes: Vec<_> = sizes.into_iter().collect();
    sizes.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    println!(
        "\nevery portrait col{} names, by the size it decodes to:",
        tables::journal_encounter_creature::PORTRAIT_FILE_DATA_ID
    );
    for ((width, height), count) in sizes {
        println!("  {width}×{height}  {count}");
    }
    println!("  unreadable  {unreadable}");

    // The rows the guide shows several creatures for, which is where the order index earns its
    // keep: the rows are not stored in that order, so a reader taking the first row it meets shows
    // the wrong member of a council fight.
    let mut per_encounter: HashMap<u32, Vec<(u32, u32, String)>> = HashMap::new();
    for row in creatures.rows() {
        if row.number(tables::journal_encounter_creature::PORTRAIT_FILE_DATA_ID) == 0 {
            continue;
        }
        per_encounter
            .entry(row.number(tables::journal_encounter_creature::JOURNAL_ENCOUNTER_ID))
            .or_default()
            .push((
                row.number(tables::journal_encounter_creature::ORDER_INDEX),
                row.number(tables::journal_encounter_creature::PORTRAIT_FILE_DATA_ID),
                row.text(tables::journal_encounter_creature::NAME),
            ));
    }
    let mut several: Vec<_> = per_encounter
        .iter()
        .filter(|(_, rows)| rows.len() > 1)
        .collect();
    several.sort_by_key(|(encounter, _)| **encounter);
    let out_of_order = several
        .iter()
        .filter(|(_, rows)| {
            let orders: Vec<u32> = rows.iter().map(|(order, _, _)| *order).collect();
            let mut sorted = orders.clone();
            sorted.sort_unstable();
            orders != sorted
        })
        .count();
    println!(
        "\n{} fights show more than one creature, and {out_of_order} of them store the rows out \
         of col{} order — which is what the reader has to sort by:",
        several.len(),
        tables::journal_encounter_creature::ORDER_INDEX
    );
    for (encounter, rows) in several.iter().take(SHOWN) {
        let fight = encounters
            .rows()
            .find(|row| row.id() == **encounter)
            .map(|row| row.text(tables::journal_encounter::NAME))
            .unwrap_or_default();
        let listed: Vec<String> = rows
            .iter()
            .map(|(order, portrait, name)| format!("{order}:{name} ({portrait})"))
            .collect();
        println!("  {fight} — {}", listed.join(", "));
    }

    // And the chain end to end, from the id a segment carries. The instance column is what holds
    // this to account: a fight reached through the wrong column lands in the wrong dungeon.
    let instances = files
        .read(tables::JOURNAL_INSTANCE)
        .and_then(Db2::parse)
        .ok();
    let mut shown = 0usize;
    let mut with_portrait = 0usize;
    let mut fights = 0usize;
    println!(
        "\nthe chain from the id a segment carries, {}:",
        if wanted.is_empty() {
            format!("for the first {SHOWN} fights")
        } else {
            format!("for fights named after {}", wanted.join(", "))
        }
    );
    for row in encounters.rows() {
        let dungeon = row.number(tables::journal_encounter::DUNGEON_ENCOUNTER_ID);
        if dungeon == 0 {
            continue;
        }
        fights += 1;
        let portrait = portraits.get(&row.id()).map(|(_, portrait)| *portrait);
        if portrait.is_some() {
            with_portrait += 1;
        }
        let name = row.text(tables::journal_encounter::NAME);
        if !wanted.is_empty()
            && !wanted
                .iter()
                .any(|asked| name.to_lowercase().contains(asked))
        {
            continue;
        }
        if shown >= SHOWN {
            continue;
        }
        shown += 1;
        let instance_id = row.number(tables::journal_encounter::JOURNAL_INSTANCE_ID);
        let instance = instances
            .as_ref()
            .and_then(|table| {
                table
                    .rows()
                    .find(|instance| instance.id() == instance_id)
                    .map(|instance| instance.text(tables::journal_instance::NAME))
            })
            .unwrap_or_default();
        println!(
            "  DungeonEncounterID {dungeon} → journal row {} \"{name}\" in {instance_id} \
             \"{instance}\" → portrait {}",
            row.id(),
            portrait.map_or_else(|| "none".to_string(), |portrait| portrait.to_string()),
        );
    }
    println!("\n{with_portrait} of {fights} fights the journal gives an id reach a portrait.");
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
