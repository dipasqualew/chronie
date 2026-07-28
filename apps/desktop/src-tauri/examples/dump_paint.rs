//! Prints what the character body is painted with, hop by hop, against a real install.
//!
//! A body that renders **white** and a body that renders in the flat tone `character.rs` fills
//! its atlas with are two different faults, and on screen they are one symptom. White is a
//! glTF material with no `baseColorTexture` at all, falling back to the format's default
//! colour; the tone means the atlas arrived and nothing was composited into it. Which of them
//! is happening decides whether the fault is in the model, in the appearance's textures, or in
//! neither — and none of it can be settled from the fixtures, because the fixtures are written
//! by this repository and agree with it by construction.
//!
//! ```sh
//! cargo run --example dump_paint -- "/Applications/World of Warcraft"
//! cargo run --example dump_paint -- "/Applications/World of Warcraft" 76885 6
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>` files, which is what the
//! tests use and is here so the tool itself is exercised by `cargo test` rather than only by a
//! machine with the game on it. The optional pair is an `ItemDisplayInfo` id and the slot
//! `ItemAppearance` gives it — `dump_display_columns` prints both for a named item.
//!
//! Four things get printed, in the order they can go wrong:
//!
//! 1. **The textures the body model declares.** Type 1 is the composited atlas, and the app
//!    supplies a picture for that type and no other. A body whose parts ask for some other
//!    type, or for a file of their own, is a body the app hands nothing to.
//! 2. **What each part asks to be painted with**, counted. This is the line that says whether
//!    the atlas is ever asked for at all.
//! 3. **The appearance's own textures**: which section, which material, which file, and
//!    whether that file reads and decodes. A row that resolves to nothing is a part of the
//!    body left in whatever was underneath.
//! 4. **The `.glb` the window is actually handed**, taken apart the way three.js takes it
//!    apart: how many materials carry a picture and how many do not. That is the one number
//!    that corresponds directly to what is on screen.

use std::collections::BTreeMap;

use chronie_desktop_lib::casc::{self, GameFiles};
use chronie_desktop_lib::body::{self, Body};
use chronie_desktop_lib::character;
use chronie_desktop_lib::icons::pixels_of;
use chronie_desktop_lib::m2::{Model, Paint};
use chronie_desktop_lib::worn::{self, Worn};

/// The M2 texture type the app composites the body atlas for, as `character.rs` binds it.
/// Every other type a body declares — 6 hair, 19 eyes, 20 jewellery — is handed nothing.
const BODY_TEXTURE: u32 = 1;

/// The largest a texture is expected to be, a side at a time, matching what the app allows
/// itself when it decodes one for the atlas.
const LARGEST: u32 = 2048;

/// Where the atlas is written, so that a reader can open it and see whether the appearance
/// landed in the right rectangles.
const ATLAS_OUT: &str = "atlas.png";

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| usage());

    let files: Box<dyn GameFiles> = if first == "--fixtures" {
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
    let files = files.as_ref();

    // Which body, before anything else: the mesh, the atlas size and the rectangles all come
    // out of it, and a `--body` nobody passed is the one the app opens on.
    let rest: Vec<String> = args.collect();
    let wanted = rest
        .iter()
        .position(|arg| arg == "--body")
        .and_then(|at| rest.get(at + 1))
        .and_then(|id| id.parse().ok())
        .unwrap_or(body::DEFAULT);
    let hers = match body::of(files, wanted) {
        Ok(hers) => hers,
        Err(error) => {
            eprintln!("Could not read the body to draw: {error}");
            std::process::exit(1);
        }
    };
    println!("drawing on {} — ChrModel {}, layout {}\n", hers.name, hers.id, hers.layout);

    let mut args = rest.iter().filter(|arg| !arg.starts_with("--")).filter(|arg| {
        arg.parse::<u32>().is_ok()
    });
    let appearance: Option<(u32, u32)> = match (args.next(), args.next()) {
        (Some(display), Some(slot)) => Some((
            display.parse().unwrap_or_else(|_| usage()),
            slot.parse().unwrap_or_else(|_| usage()),
        )),
        (Some(_), None) => usage(),
        _ => None,
    };

    body(files, &hers);
    let worn = appearance.map(|(display, slot)| wearing(files, &hers, display, slot));
    atlas(files, &hers, worn.as_ref());
    handed_over(files, &hers, worn.as_ref());
}

/// The body model itself: the textures it declares, and what every part of it asks for.
fn body(files: &dyn GameFiles, hers: &Body) {
    println!("== the body ==\n");
    let bytes = match files.read(hers.model) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("Could not read {} ({}): {error}", hers.model, hers.name);
            std::process::exit(1);
        }
    };
    println!("{} ({}): {} bytes", hers.model, hers.name, bytes.len());

    let model = match Model::parse(&bytes) {
        Ok(model) => model,
        Err(error) => {
            eprintln!("Could not parse the body: {error}");
            std::process::exit(1);
        }
    };
    let own = model.texture_file_data_ids();
    println!(
        "  skin profile: {:?}\n  textures of its own (type 0): {own:?}",
        model.skin_file_data_id()
    );

    let Some(skin) = model.skin_file_data_id() else {
        eprintln!("The body names no skin profile, so nothing says how to draw it.");
        std::process::exit(1);
    };
    let mesh = match files.read(skin).and_then(|bytes| model.with_skin(&bytes)) {
        Ok(mesh) => mesh,
        Err(error) => {
            eprintln!("Could not read the body's skin profile: {error}");
            std::process::exit(1);
        }
    };

    // The line the whole tool exists for. A part whose paint the app supplies nothing for is
    // a part with no picture, and a glTF material with no picture is white.
    println!("\n  what each of its {} parts asks to be painted with:", mesh.parts.len());
    let mut asked: BTreeMap<String, usize> = BTreeMap::new();
    for part in &mesh.parts {
        *asked.entry(describe(part.paint)).or_default() += 1;
    }
    for (paint, count) in &asked {
        println!("    {count:>4} × {paint}");
    }
    if !asked.keys().any(|paint| paint.contains("the body atlas")) {
        println!(
            "\n  Nothing on this body asks for texture type {BODY_TEXTURE}, which is the only \
             type\n  character.rs composites an atlas for. Every part of it renders untextured."
        );
    }
}

/// What one paint means to the app: a picture it supplies, or nothing at all.
fn describe(paint: Paint) -> String {
    match paint {
        Paint::Supplied(BODY_TEXTURE) => {
            format!("texture type {BODY_TEXTURE} — the body atlas, which the app supplies")
        }
        Paint::Supplied(kind) => {
            format!("texture type {kind} — nothing is supplied for it, so the part is untextured")
        }
        Paint::File(fdid) => format!("its own file {fdid}"),
    }
}

/// The appearance: the geosets it switches on, and every texture it paints, resolved and read.
fn wearing(files: &dyn GameFiles, hers: &Body, display: u32, slot: u32) -> Worn {
    println!("\n== display {display}, worn in slot {slot} ==\n");
    // Nothing is worn in a hand here: what this tool prints is what a body is painted with, and
    // the inventory type only says which hand a weapon goes in.
    let worn = match worn::of(files, hers, display, slot, 0) {
        Ok(worn) => worn,
        Err(error) => {
            eprintln!("Could not read what display {display} wears: {error}");
            std::process::exit(1);
        }
    };
    if worn.is_empty() {
        println!("  nothing — this install can say nothing about that display");
        return worn;
    }

    println!("  geosets: {:?}", worn.geosets);
    println!("  textures, section by section:");
    for texture in &worn.textures {
        // Read and decode it here rather than trusting that it would: `Atlas::wear` drops a
        // texture it cannot use without a word, which is one of the ways a body stays bare.
        let read = match files.read(texture.file) {
            Ok(bytes) => bytes,
            Err(error) => {
                println!("    section {:<2} file {:<9} unreadable: {error}", texture.section, texture.file);
                continue;
            }
        };
        match pixels_of(&read, LARGEST) {
            Ok(pixels) => println!(
                "    section {:<2} file {:<9} {} × {}, {} bytes",
                texture.section,
                texture.file,
                pixels.width(),
                pixels.height(),
                read.len()
            ),
            Err(error) => println!(
                "    section {:<2} file {:<9} will not decode: {error}",
                texture.section, texture.file
            ),
        }
    }
    worn
}

/// The composited atlas, written out and counted.
///
/// One distinct colour is an atlas nothing was painted into — which is what a bare body is
/// meant to look like, and is worth stating rather than leaving to the eye.
fn atlas(files: &dyn GameFiles, hers: &Body, worn: Option<&Worn>) {
    println!("\n== the atlas ==\n");
    let mut atlas = character::Atlas::unpainted(hers);
    if let Some(worn) = worn {
        atlas.wear(hers, files, &worn.textures);
    }
    let png = match atlas.png() {
        Ok(png) => png,
        Err(error) => {
            eprintln!("The atlas would not encode: {error}");
            return;
        }
    };
    match image::load_from_memory(&png) {
        Ok(decoded) => {
            let pixels = decoded.into_rgba8();
            let mut colours: Vec<[u8; 4]> = pixels.pixels().map(|pixel| pixel.0).collect();
            colours.sort_unstable();
            colours.dedup();
            println!(
                "  {} × {}, {} distinct colour{}",
                pixels.width(),
                pixels.height(),
                colours.len(),
                if colours.len() == 1 { "" } else { "s" }
            );
            if colours.len() == 1 {
                println!("  nothing has been composited into it: every pixel is {:?}", colours[0]);
            }
        }
        Err(error) => println!("  the atlas would not read back: {error}"),
    }
    match std::fs::write(ATLAS_OUT, &png) {
        Ok(()) => println!("  written to {ATLAS_OUT} ({} bytes)", png.len()),
        Err(error) => println!("  could not write {ATLAS_OUT}: {error}"),
    }
}

/// The `.glb` the window is handed, counted the way a renderer reads it.
///
/// A material with no `baseColorTexture` is drawn in glTF's default colour, which is white.
/// Every other line above explains *why*; this is the one that matches what is on screen.
fn handed_over(files: &dyn GameFiles, hers: &Body, worn: Option<&Worn>) {
    println!("\n== the glb the window gets ==\n");
    let who = character::Who { body: hers.id, picked: Vec::new() };
    let glb = match character::glb_of(files, worn, &who) {
        Ok(glb) => glb,
        Err(error) => {
            eprintln!("Could not write the character: {error}");
            std::process::exit(1);
        }
    };
    let Some(scene) = json_of(&glb) else {
        println!("  the glb holds no readable JSON chunk");
        return;
    };

    let materials = scene["materials"].as_array().map_or(0, Vec::len);
    let painted = scene["materials"]
        .as_array()
        .map_or(0, |all| {
            all.iter()
                .filter(|material| !material["pbrMetallicRoughness"]["baseColorTexture"].is_null())
                .count()
        });
    let images = scene["images"].as_array().map_or(0, Vec::len);
    println!("  {} bytes", glb.len());
    println!("  {} primitives", scene["meshes"][0]["primitives"].as_array().map_or(0, Vec::len));
    println!("  {images} image{}", if images == 1 { "" } else { "s" });
    println!("  {painted} of {materials} materials carry a picture");
    if painted < materials {
        println!(
            "  the other {} are drawn in glTF's default colour, which is white",
            materials - painted
        );
    }
}

/// The JSON chunk of a `.glb`, which is the half worth looking at.
fn json_of(glb: &[u8]) -> Option<serde_json::Value> {
    let length = u32::from_le_bytes(glb.get(12..16)?.try_into().ok()?) as usize;
    serde_json::from_slice(glb.get(20..20 + length)?).ok()
}

fn usage() -> ! {
    eprintln!(
        "usage: dump_paint <wow install> | --fixtures <dir> [<displayInfoID> <displayType>]"
    );
    std::process::exit(2)
}
