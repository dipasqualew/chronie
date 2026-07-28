//! Prints the chain from a customization choice to the BLP a character's skin is.
//!
//! Four hops stand between "Human Female, first swatch" and a picture, and none of their
//! column positions were this repository's until this was run:
//!
//! ```text
//! ChrCustomizationChoice ──▶ ChrCustomizationElement ──▶ ChrCustomizationMaterial
//!                                                          └──▶ TextureFileData ──▶ BLP2
//! ```
//!
//! ```sh
//! cargo run --example dump_customization -- "/Applications/World of Warcraft"
//! cargo run --example dump_customization -- "/Applications/World of Warcraft" 86 87
//! cargo run --example dump_customization -- "/Applications/World of Warcraft" --questions
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.db2` files. With no choice
//! ids it prints the one the app draws.
//!
//! `--questions` prints the other half: everything the reader may be asked about this body and
//! every swatch of each, through [`chronie_desktop_lib::customization::questions`] itself rather
//! than through a second reading of the same tables. That is what says whether a build still
//! answers the way `docs/game-files.md` records — thirteen questions whose names read as a
//! Human's, most of whose swatches have no name at all.
//!
//! What right looks like, and each of these rules out something the others do not:
//!
//! - **The column count.** Every table on this chain keeps its id beside the rows rather than
//!   in them, so `ID` is not a column and everything is one place earlier than the community's
//!   field list reads. Two columns in `ChrCustomizationMaterial` rather than three is what says
//!   so, and it is the difference between reading a target and reading an id.
//! - **A choice with several elements.** The default skin has three, and only one of them is
//!   the skin — the others are painted *over* it. A column that gave one material per choice,
//!   or the same material for every choice, is not the material column.
//! - **The layer table agreeing.** `ChrModelTextureLayer` says which target the base layer of
//!   layout 104 is, out of tables nothing else here reads. The material filed under that
//!   target is the skin; if the printout's `base layer` and the chosen material disagree about
//!   which target that is, one of the two columns moved.
//! - **A file that decodes, at the size a skin is.** The last hop lands on a FileDataID, and a
//!   BLP2 a thousand pixels a side is a skin. An icon-sized one is a wrong turn several hops
//!   back that still resolved.

use chronie_desktop_lib::db2::Db2;
use chronie_desktop_lib::{casc, icons};

/// The tables this walks, from the community listfile.
const CHR_CUSTOMIZATION_CHOICE: u32 = 3450554;
const CHR_CUSTOMIZATION_ELEMENT: u32 = 3512765;
const CHR_CUSTOMIZATION_MATERIAL: u32 = 3459652;
const CHR_MODEL_TEXTURE_LAYER: u32 = 3548976;
const TEXTURE_FILE_DATA: u32 = 982459;
/// `ChrCustomizationOption`, which is only read so that a choice can be named in the printout.
const CHR_CUSTOMIZATION_OPTION: u32 = 3384247;

/// The choice the app draws, when the caller names none: Human Female's first skin swatch.
const DEFAULT_SKIN: u32 = 85;

/// The layout this app composites, and the M2 texture type its atlas is bound as.
const LAYOUT: u32 = 104;
const BODY_TEXTURE: u32 = 1;
/// The blend mode wow.export calls "blit": a straight copy, and the base layer's alone.
const BLIT: u32 = 1;

/// Columns, as this run is what settles them. `skin.rs` carries the same four.
const ELEMENT_CHOICE: usize = 0;
const ELEMENT_RELATED: usize = 1;
const ELEMENT_MATERIAL: usize = 4;
const MATERIAL_TARGET: usize = 0;
const MATERIAL_RESOURCE: usize = 1;
const LAYER_TEXTURE_TYPE: usize = 0;
const LAYER_LAYER: usize = 1;
const LAYER_BLEND_MODE: usize = 3;
const LAYER_TARGET: usize = 7;
const TEXTURE_RESOURCE: usize = 2;
/// `ChrCustomizationChoice` keeps its id *inside* the row, unlike the rest of the chain — so
/// its option is column 2 where a table with the id beside the rows would put it at 1.
const CHOICE_OPTION: usize = 2;
const CHOICE_ORDER: usize = 5;
/// And `ChrCustomizationOption`, whose id is inline as well.
const OPTION_NAME: usize = 0;
const OPTION_MODEL: usize = 4;

/// How wide one element of `ChrModelTextureTargetID[2]` is.
const TARGET_BITS: u32 = 32;

/// The smallest a base skin can plausibly be. Item textures are authored from 128 × 64 up and
/// a body's is the largest thing the game paints a character with, so anything icon-sized here
/// is a hop that resolved and was wrong.
const SMALLEST_SKIN: u32 = 256;

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_customization <wow install> | --fixtures <dir> [choice id...]");
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
    let files = files.as_ref();

    let rest: Vec<String> = args.collect();
    if rest.iter().any(|arg| arg == "--questions") {
        // Which body's questions, defaulting to the one the app opens on. Another `ChrModel`
        // is another set of questions entirely — that is the filter this whole chain turns on.
        let body = rest
            .iter()
            .filter_map(|arg| arg.parse().ok())
            .next()
            .unwrap_or(chronie_desktop_lib::body::DEFAULT);
        questions(files, body);
        return;
    }

    let wanted: Vec<u32> = rest.iter().filter_map(|arg| arg.parse().ok()).collect();
    let wanted = if wanted.is_empty() { vec![DEFAULT_SKIN] } else { wanted };

    shapes(files);
    let target = layers(files);
    for choice in wanted {
        follow(files, choice, target);
    }
}

/// Everything a reader may be asked about this body, and every answer to each.
///
/// Through the app's own reader, so what this prints is what the window offers: a question left
/// out here is one whose swatches drive nothing, and a swatch with no name beside it is one the
/// game itself does not name — the character creation screen draws those as squares of colour,
/// and a window over this has to number them.
fn questions(files: &dyn casc::GameFiles, body: u32) {
    println!("ChrModel {body}:");
    let asked = match chronie_desktop_lib::customization::questions(files, body) {
        Ok(asked) => asked,
        Err(error) => {
            println!("what she may be asked could not be read: {error}");
            return;
        }
    };
    println!("{} questions about this body:", asked.len());
    for question in &asked {
        let named = question.swatches.iter().filter(|swatch| !swatch.name.is_empty()).count();
        println!(
            "\n  {:<6} {:?} — {} swatches, {named} of them named",
            question.id,
            question.name,
            question.swatches.len(),
        );
        for swatch in &question.swatches {
            println!("    {:<8} {:?}", swatch.id, swatch.name);
        }
    }
}

/// How each table stores itself, which is the first thing that says whether the ids are in the
/// rows or beside them — and therefore whether every column is where it is thought to be.
fn shapes(files: &dyn casc::GameFiles) {
    for (name, fdid, expected) in [
        ("ChrCustomizationChoice", CHR_CUSTOMIZATION_CHOICE, 11),
        ("ChrCustomizationElement", CHR_CUSTOMIZATION_ELEMENT, 13),
        ("ChrCustomizationMaterial", CHR_CUSTOMIZATION_MATERIAL, 2),
        ("ChrModelTextureLayer", CHR_MODEL_TEXTURE_LAYER, 8),
    ] {
        let Ok(table) = files.read(fdid).and_then(Db2::parse) else {
            println!("{name} ({fdid}): could not be read");
            continue;
        };
        let columns = table.column_count();
        println!(
            "{name} ({fdid}): {columns} columns{}, {} rows readable of {} declared",
            if columns == expected {
                String::new()
            } else {
                format!(" — expected {expected}")
            },
            table.rows().count(),
            table.declared_rows()
        );
        for column in 0..columns {
            if let Some(shape) = table.column_shape(column) {
                println!(
                    "  col{column:<3} {:<16} {:>4} bits{}",
                    shape.storage,
                    shape.size_bits,
                    if shape.array_count > 0 {
                        format!(", runs of {}", shape.array_count)
                    } else {
                        String::new()
                    }
                );
            }
        }
    }
}

/// Every layer of the layout this app composites, and which of them the skin goes into.
///
/// The one that is a straight copy is the base. Everything else on the atlas is painted over
/// it and blends, which is why the mode is what picks it out rather than the layer number.
fn layers(files: &dyn casc::GameFiles) -> u32 {
    let Ok(table) = files.read(CHR_MODEL_TEXTURE_LAYER).and_then(Db2::parse) else {
        println!("\nChrModelTextureLayer could not be read");
        return 0;
    };
    println!("\nChrModelTextureLayer, layout {LAYOUT}:");
    let mut base = 0;
    let mut rows: Vec<_> = table.rows().filter(|row| row.foreign_id() == LAYOUT).collect();
    rows.sort_by_key(|row| row.number(LAYER_LAYER));
    for row in &rows {
        let (texture_type, layer, blend) = (
            row.number(LAYER_TEXTURE_TYPE),
            row.number(LAYER_LAYER),
            row.number(LAYER_BLEND_MODE),
        );
        let target = row.element(LAYER_TARGET, 0, TARGET_BITS);
        let copied = texture_type == BODY_TEXTURE && blend == BLIT;
        if copied && base == 0 {
            base = target;
        }
        println!(
            "  layer {layer:<3} texture type {texture_type:<3} blend {blend:<3} target {target:<3}{}",
            if copied { "  ← a copy: the base skin" } else { "" }
        );
    }
    if rows.is_empty() {
        println!("  no layer belongs to this layout");
    }
    println!("  base layer paints texture target {base}");
    base
}

/// One choice, from its own row down to the bytes of a picture.
fn follow(files: &dyn casc::GameFiles, choice: u32, base_target: u32) {
    println!("\nchoice {choice}:");
    name_of(files, choice);

    let Ok(elements) = files.read(CHR_CUSTOMIZATION_ELEMENT).and_then(Db2::parse) else {
        println!("  ChrCustomizationElement could not be read");
        return;
    };
    let materials: Vec<(u32, u32)> = elements
        .rows()
        .filter(|row| row.number(ELEMENT_CHOICE) == choice)
        .map(|row| (row.id(), row.number(ELEMENT_MATERIAL)))
        .collect();
    // And what some *other* swatch does only when this one is chosen too, which is where a
    // character's face is and is the answer to "why did that layer stop being painted": an
    // element is authored per skin, so a layer can belong to a choice and reach only one.
    let conditional: Vec<(u32, u32, u32)> = elements
        .rows()
        .filter(|row| row.number(ELEMENT_RELATED) == choice)
        .map(|row| {
            (
                row.id(),
                row.number(ELEMENT_CHOICE),
                row.number(ELEMENT_MATERIAL),
            )
        })
        .collect();
    for (element, from, material) in &conditional {
        println!("  element {element:<8} of choice {from:<8} applies only with this one, material {material}");
    }
    if materials.is_empty() {
        println!("  no element belongs to this choice");
        return;
    }

    let Ok(table) = files.read(CHR_CUSTOMIZATION_MATERIAL).and_then(Db2::parse) else {
        println!("  ChrCustomizationMaterial could not be read");
        return;
    };
    for (element, material) in materials {
        if material == 0 {
            println!("  element {element:<8} does something other than paint");
            continue;
        }
        let Some(row) = table.rows().find(|row| row.id() == material) else {
            println!("  element {element:<8} material {material:<8} is in no readable row");
            continue;
        };
        let (target, resource) = (row.number(MATERIAL_TARGET), row.number(MATERIAL_RESOURCE));
        println!(
            "  element {element:<8} material {material:<8} target {target:<3} resource {resource}{}",
            if target == base_target { "  ← the skin" } else { "" }
        );
        picture(files, resource);
    }
}

/// Which option a choice belongs to, so that the printout can say whose skin this is.
///
/// A wrong choice id is otherwise the quietest way to be wrong here: it resolves, it decodes,
/// and it paints somebody else's body onto this one.
fn name_of(files: &dyn casc::GameFiles, choice: u32) {
    let (Ok(choices), Ok(options)) = (
        files.read(CHR_CUSTOMIZATION_CHOICE).and_then(Db2::parse),
        files.read(CHR_CUSTOMIZATION_OPTION).and_then(Db2::parse),
    ) else {
        println!("  the option this choice belongs to could not be read");
        return;
    };
    let Some(row) = choices.rows().find(|row| row.id() == choice) else {
        println!("  no readable row in ChrCustomizationChoice");
        return;
    };
    let (option, order) = (row.number(CHOICE_OPTION), row.number(CHOICE_ORDER));
    match options.rows().find(|row| row.id() == option) {
        Some(row) => println!(
            "  {:?}, swatch {order}, of ChrModel {}",
            row.text(OPTION_NAME),
            row.number(OPTION_MODEL)
        ),
        None => println!("  option {option}, swatch {order}"),
    };
}

/// The last hop, and the only one whose answer can be looked at rather than believed.
fn picture(files: &dyn casc::GameFiles, resource: u32) {
    let Ok(textures) = files.read(TEXTURE_FILE_DATA).and_then(Db2::parse) else {
        println!("    TextureFileData could not be read");
        return;
    };
    let found: Vec<u32> = textures
        .rows()
        .filter(|row| row.number(TEXTURE_RESOURCE) == resource)
        .map(|row| row.id())
        .collect();
    if found.is_empty() {
        println!("    no file names material resource {resource}");
        return;
    }
    for file in found {
        match files.read(file) {
            Ok(blp) => {
                let magic = String::from_utf8_lossy(&blp[..blp.len().min(4)]).to_string();
                match icons::pixels_of(&blp, u32::MAX) {
                    Ok(pixels) => println!(
                        "    file {file} — {magic}, {} × {}{}",
                        pixels.width(),
                        pixels.height(),
                        if pixels.width() >= SMALLEST_SKIN && pixels.height() >= SMALLEST_SKIN {
                            ""
                        } else {
                            "  ← too small to be a skin"
                        }
                    ),
                    Err(error) => println!("    file {file} — {magic}, will not decode: {error}"),
                }
            }
            Err(error) => println!("    file {file} — {error}"),
        }
    }
}
