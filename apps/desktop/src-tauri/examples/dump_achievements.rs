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
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files. With no ids at
//! all it prints a spread of them: the first few, and one from each corner worth checking.

use chronie_desktop_lib::{achievements, casc};

/// Achievements worth looking at when no particular one was asked for: the first two levels,
/// a dungeon achievement tied to an instance, a feat of strength, and one from the legacy
/// tree — which between them cover a category path, a reward, and being worth nothing.
const A_SPREAD: [u32; 6] = [6, 7, 490, 892, 4826, 5372];

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

    let mut wanted: Vec<u32> = args.filter_map(|id| id.parse().ok()).collect();
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
