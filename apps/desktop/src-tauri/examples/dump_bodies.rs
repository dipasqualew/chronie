//! Prints what the game says a *body* is: the mesh, the texture layout, and the rectangles that
//! layout is composited out of.
//!
//! All of this used to be constants in `character.rs` — one model FileDataID, one layout, one
//! 2048 × 1024 atlas and ten hard-coded rectangles, every one of them a Human Female's. This is
//! the read that replaced them, and it is what to run again after a patch or when another body
//! is added:
//!
//! ```sh
//! cargo run --example dump_bodies -- "/Applications/World of Warcraft"
//! cargo run --example dump_bodies -- "/Applications/World of Warcraft" 1
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files. With no `ChrModel`
//! ids it describes every body this build can draw.
//!
//! What right looks like, and each of these rules out something the others do not:
//!
//! - **The model parses and names a skin profile.** A `ChrModel` whose mesh moved would still
//!   be a number, and most numbers are not an `.m2`.
//! - **Ten sections, and the body in the left half.** Layout 104's rectangles are written down
//!   in `docs/character-rendering.md` and were read independently by wago.tools; a layout whose
//!   sections do not tile the way that table does is a column that moved.
//! - **Every rectangle inside the atlas.** The layout states both, and a section that lands
//!   outside the buffer is the two disagreeing — which is a body painted into nowhere.
//! - **The right sex.** It decides which of an item's textures the body wears and which of
//!   `HelmetGeosetVis`'s two entries a helm hides by, and both fail as a picture.

use chronie_desktop_lib::body::{self, Named};
use chronie_desktop_lib::casc::{self, GameFiles};
use chronie_desktop_lib::m2::Model;

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_bodies <wow install> | --fixtures <dir> [ChrModel id...]");
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
    let files = files.as_ref();

    let wanted: Vec<u32> = args.filter_map(|arg| arg.parse().ok()).collect();
    let playable = body::playable(files).unwrap_or_else(|error| {
        eprintln!("Could not read what bodies this game offers: {error}");
        std::process::exit(1);
    });
    println!("{} bodies this build can draw:", playable.len());
    for body in &playable {
        println!("  ChrModel {:<4} {}", body.id, body.name);
    }

    for body in playable
        .iter()
        .filter(|body| wanted.is_empty() || wanted.contains(&body.id))
    {
        describe(files, body);
    }
}

/// One body, down to the bytes of its mesh and the rectangles of its atlas.
fn describe(files: &dyn GameFiles, named: &Named) {
    println!("\n== ChrModel {} — {} ==\n", named.id, named.name);
    let body = match body::of(files, named.id) {
        Ok(body) => body,
        Err(error) => {
            println!("  could not be read: {error}");
            return;
        }
    };
    println!(
        "  race {}  sex {}  layout {}  atlas {} × {}",
        body.race, body.sex, body.layout, body.atlas.0, body.atlas.1
    );

    match files.read(body.model) {
        Ok(bytes) => {
            let skin = Model::parse(&bytes).ok().and_then(|model| model.skin_file_data_id());
            println!(
                "  mesh {} — {} bytes, {:?}, skin profile {skin:?}",
                body.model,
                bytes.len(),
                String::from_utf8_lossy(&bytes[..bytes.len().min(4)]),
            );
        }
        Err(error) => println!("  mesh {} will not read: {error}", body.model),
    }

    println!("  {} sections:", body.sections.len());
    for (section, rect) in &body.sections {
        let outside = rect.x + rect.width > body.atlas.0 || rect.y + rect.height > body.atlas.1;
        println!(
            "    {section:<3} x {:<5} y {:<5} w {:<5} h {:<5}{}",
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            if outside { "  ← outside the atlas" } else { "" }
        );
    }
}
