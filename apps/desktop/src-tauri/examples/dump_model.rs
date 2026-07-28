//! Writes a model out as a `.glb`, either from a real install or the fixtures.
//!
//! Two jobs. Against an install it is how a model is checked against the real thing, which
//! the test suite deliberately never touches. Against the fixtures it regenerates the `.glb`s
//! the browser tests load into three.js — so what the window is shown to render is what these
//! converters actually write, rather than a hand-made stand-in for it.
//!
//! The model to write is one of four things: an `ItemDisplayInfo` id, on its own, for an
//! appearance that has geometry of its own; the word `character`, for the bare body every
//! appearance is worn on; `worn/<display>/<slot>` for that body with one appearance on it,
//! where the slot is the display type `ItemAppearance` gives it; or **`set/<id>`, for the body
//! wearing a whole `TransmogSet`**, which is the one that reaches the priority table and the
//! draw order. A weapon takes a fourth number, `worn/<display>/<slot>/<inventory type>`,
//! because its slot does not say which hand; a set reads that per piece out of `ItemSparse`,
//! the way the window does.
//!
//! ```sh
//! cargo run --example dump_model -- "/Applications/World of Warcraft" 900001 helm.glb
//! cargo run --example dump_model -- "/Applications/World of Warcraft" worn/8483/11/13 sword.glb
//! cargo run --example dump_model -- "/Applications/World of Warcraft" set/1919 outfit.glb
//! cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog 900001 \
//!     apps/desktop/fixtures/transmog/helm.glb
//! cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog character \
//!     apps/desktop/fixtures/transmog/character.glb
//! cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog worn/900012/3 \
//!     apps/desktop/fixtures/transmog/robe.glb
//! ```

use chronie_desktop_lib::{casc, character, models, transmog, worn};

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

    let written = match what.split('/').collect::<Vec<&str>>()[..] {
        ["character"] => character::glb_of(files.as_ref(), None, &[]).map(Some),
        // A whole set, walked out of the game's own tables exactly as the window walks it —
        // which is the only way to put the priority table and the draw order in front of real
        // data, since nothing in the test suite is allowed to read an install.
        ["set", set] => {
            let set: u32 = set.parse().unwrap_or_else(|_| usage());
            worn_set(files.as_ref(), set)
                .and_then(|pieces| {
                    println!("{} pieces", pieces.len());
                    worn::of_set(files.as_ref(), &pieces)
                })
                .and_then(|worn| character::glb_of(files.as_ref(), Some(&worn), &[]))
                .map(Some)
        }
        ["worn", display, slot] | ["worn", display, slot, _] => {
            let display: u32 = display.parse().unwrap_or_else(|_| usage());
            let slot: u32 = slot.parse().unwrap_or_else(|_| usage());
            // A weapon needs a fourth number that armour does not: where the item is worn,
            // which is the only thing that says which hand it goes in.
            let worn_in: u32 = match what.split('/').nth(3) {
                Some(inventory_type) => inventory_type.parse().unwrap_or_else(|_| usage()),
                None => 0,
            };
            worn::of(files.as_ref(), display, slot, worn_in)
                .and_then(|worn| character::glb_of(files.as_ref(), Some(&worn), &[]))
                .map(Some)
        }
        _ => {
            let display: u32 = what.parse().unwrap_or_else(|_| usage());
            models::glb_of(files.as_ref(), display)
        }
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

/// The pieces of one transmog set, as the window would send them.
///
/// The same payload `transmog::set_items` hands the window, read back into the three numbers
/// each row carries. Going through that rather than the tables directly is the point: what this
/// renders is what the window renders, out of the same walk.
fn worn_set(files: &dyn casc::GameFiles, set_id: u32) -> Result<Vec<worn::Piece>, String> {
    let payload = transmog::set_items(files, set_id)?;
    let appearances = payload["appearances"]
        .as_array()
        .ok_or("the set payload holds no appearances")?;
    Ok(appearances
        .iter()
        .filter_map(|appearance| {
            let number = |key: &str| appearance[key].as_u64().unwrap_or(0) as u32;
            let display_info_id = number("displayInfoId");
            // A row the game withholds names no display, and there is nothing to put on her.
            (display_info_id != 0).then_some(worn::Piece {
                display_info_id,
                display_type: number("displayType"),
                inventory_type: number("inventoryType"),
            })
        })
        .collect())
}

fn usage() -> ! {
    eprintln!(
        "usage: dump_model <wow install> | --fixtures <dir>  \
         <displayInfoID> | character | worn/<displayInfoID>/<displayType> | set/<transmogSetID>  \
         <out.glb>"
    );
    std::process::exit(2)
}
