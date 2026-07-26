//! Prints the transmog sets read straight out of a World of Warcraft install.
//!
//! This is the tool for checking the reader against real game files, which the test suite
//! deliberately never touches — it runs on fixtures so it can run anywhere.
//!
//! ```sh
//! cargo run --example dump_transmog -- "/Applications/World of Warcraft"
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files.

use chronie_desktop_lib::{casc, transmog};

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_transmog <wow install> | --fixtures <dir>");
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

    let payload = match transmog::sets(files.as_ref()) {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("Could not read the transmog sets: {error}");
            std::process::exit(1);
        }
    };

    let sets = payload["sets"].as_array().cloned().unwrap_or_default();
    println!(
        "read {} of {} sets ({} withheld)",
        payload["readCount"], payload["declaredCount"], payload["withheldCount"]
    );
    for set in sets.iter().take(30) {
        println!(
            "  {:>5}  exp {:>2}  classes {:#06x}  items {:>2}  {:<44} {}",
            set["id"],
            set["expansionId"],
            set["classMask"].as_u64().unwrap_or(0),
            set["itemCount"],
            set["name"].as_str().unwrap_or(""),
            set["group"].as_str().unwrap_or(""),
        );
    }
    if sets.len() > 30 {
        println!("  … and {} more", sets.len() - 30);
    }
}
