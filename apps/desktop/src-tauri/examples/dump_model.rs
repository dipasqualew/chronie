//! Writes one appearance's model out as a `.glb`, either from a real install or the fixtures.
//!
//! Two jobs. Against an install it is how a model is checked against the real thing, which
//! the test suite deliberately never touches. Against the fixtures it regenerates
//! `apps/desktop/fixtures/transmog/helm.glb`, which is the file the browser tests load into
//! three.js — so what the window is shown to render is what this converter actually writes,
//! rather than a hand-made stand-in for it.
//!
//! ```sh
//! cargo run --example dump_model -- "/Applications/World of Warcraft" 900001 helm.glb
//! cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog 900001 \
//!     apps/desktop/fixtures/transmog/helm.glb
//! ```

use chronie_desktop_lib::{casc, models};

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

    let display: u32 = args
        .next()
        .and_then(|id| id.parse().ok())
        .unwrap_or_else(|| usage());
    let out = args.next().unwrap_or_else(|| usage());

    let glb = match models::glb_of(files.as_ref(), display) {
        Ok(Some(glb)) => glb,
        Ok(None) => {
            eprintln!("Display {display} has no model to show.");
            std::process::exit(1);
        }
        Err(error) => {
            eprintln!("Could not read display {display}: {error}");
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
    eprintln!("usage: dump_model <wow install> | --fixtures <dir>  <displayInfoID>  <out.glb>");
    std::process::exit(2)
}
