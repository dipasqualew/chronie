//! Writes a model out as a `.glb`, either from a real install or the fixtures.
//!
//! Two jobs. Against an install it is how a model is checked against the real thing, which
//! the test suite deliberately never touches. Against the fixtures it regenerates the `.glb`s
//! the browser tests load into three.js — so what the window is shown to render is what these
//! converters actually write, rather than a hand-made stand-in for it.
//!
//! The model to write is either an `ItemDisplayInfo` id or the word `character`, which is the
//! bare body every appearance is worn on.
//!
//! ```sh
//! cargo run --example dump_model -- "/Applications/World of Warcraft" 900001 helm.glb
//! cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog 900001 \
//!     apps/desktop/fixtures/transmog/helm.glb
//! cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog character \
//!     apps/desktop/fixtures/transmog/character.glb
//! ```

use chronie_desktop_lib::{casc, character, models};

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| usage());

    let files: Box<dyn casc::GameFiles> = if first == "--fixtures" {
        Box::new(casc::DirFiles::new(args.next().unwrap_or_else(|| usage())))
    } else {
        match casc::CascFiles::open(std::path::Path::new(&first)) {
            Ok(storage) => Box::new(storage),
            Err(error) => {
                eprintln!("Could not open {first}: {error}");
                std::process::exit(1);
            }
        }
    };

    let what = args.next().unwrap_or_else(|| usage());
    let out = args.next().unwrap_or_else(|| usage());

    // No base skin: see `character::Atlas::base` for what is missing and why.
    let written = if what == "character" {
        character::glb_of(files.as_ref(), None).map(Some)
    } else {
        let display: u32 = what.parse().unwrap_or_else(|_| usage());
        models::glb_of(files.as_ref(), display)
    };

    let glb = match written {
        Ok(Some(glb)) => glb,
        Ok(None) => {
            eprintln!("{what} has no model to show.");
            std::process::exit(1);
        }
        Err(error) => {
            eprintln!("Could not read {what}: {error}");
            std::process::exit(1);
        }
    };
    std::fs::write(&out, &glb).unwrap_or_else(|error| {
        eprintln!("Could not write {out}: {error}");
        std::process::exit(1);
    });
    println!("{out}  {} bytes", glb.len());
}

fn usage() -> ! {
    eprintln!(
        "usage: dump_model <wow install> | --fixtures <dir>  <displayInfoID> | character  <out.glb>"
    );
    std::process::exit(2)
}
