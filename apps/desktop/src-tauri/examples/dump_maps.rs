//! Prints the seven tables a zone map is assembled out of, against a real install.
//!
//! A map is the one picture this app draws that the game does not store as a file: it is a grid of
//! 256-pixel fragments, four tables saying which fragment goes where, and two more holding the
//! towns, roads and labels that only appear on a map once somebody has walked there. `maps.rs` puts
//! one together for the header a segment's modal opens with, and this is what settled the columns it
//! reads — and what to run again after a patch.
//!
//! ```sh
//! cargo run --example dump_maps -- "/Applications/World of Warcraft"
//! cargo run --example dump_maps -- "/Applications/World of Warcraft" Durotar Dornogal
//! cargo run --example dump_maps -- "/Applications/World of Warcraft" --write /tmp Durotar
//! cargo run --example dump_maps -- --fixtures apps/desktop/fixtures/maps "Emberfall Marches"
//! ```
//!
//! With no names it walks a handful of places that cover the shapes: a classic zone, a modern one,
//! a city and a raid. `--write <dir>` puts each assembled map in that directory, as whichever of
//! JPEG and PNG the app would hand the window — which is the only way to see that a map came out as
//! a map rather than as a plausible set of numbers.
//!
//! What right looks like, and each of these rules out something the others do not:
//!
//! - **Names that are places.** `UiMap` opens with a name, and a run whose first rows read
//!   "Durotar", "Burning Blade Coven", "Tiragarde Keep" is the table this is meant to be reading.
//!   Anything else and the FileDataID has moved.
//! - **Nine style layers, and four sizes among them.** 1,002×668 for the classic zones, 3,665×2,440
//!   and 3,840×2,560 for the modern ones, 512×512 for the cosmic map — every one of them out of
//!   256-pixel fragments but the last. A layer whose fragment size reads 1,065,353,216 is a column
//!   counted one past the end: that is the bits of the float 1.0, which is what `MinScale` holds.
//! - **A grid that is bigger than its picture, and only just.** The line under each place says how
//!   many fragments the grid holds and how much of the last of them is picture. 4×3 fragments
//!   holding 1,002×668 is right; a grid that would need a fifth column, or one with a whole column
//!   to spare, is a fragment size read wrong.
//! - **Fragments that all decode, and all to one size.** Every fragment of a layer is the size the
//!   style says. One that decodes larger is a texture read that landed somewhere else.
//! - **A picture that is nearly all opaque.** The percentage beside each map is how much of it has
//!   paint on it. A classic zone map comes out 100%; anything under about 90% means fragments are
//!   landing outside the picture — which is what reading the row and column indices the wrong way
//!   round does.
//! - **A map with towns on it.** This is the check the others cannot make, and it needs `--write`
//!   and a pair of eyes: the `UiMapArtTile` grid on its own is the map *nobody has walked* — terrain,
//!   a few mountains, and the neighbouring zones' names. Orgrimmar, Razor Hill, the roads and every
//!   label inside the zone are `WorldMapOverlay` patches pasted on top. So a Durotar with no
//!   Orgrimmar on it is an overlay chain that read nothing, and a Durotar with Orgrimmar somewhere
//!   in the Great Sea is one whose offsets were read as something else.

use std::collections::HashMap;

use chronie_desktop_lib::casc::{self, GameFiles};
use chronie_desktop_lib::db2::Db2;
use chronie_desktop_lib::{icons, maps, tables};

/// How many rows to print in full, which is enough to see the shape of a table.
const SHOWN: usize = 6;

/// The places to walk when nobody said: a classic zone, a modern zone, a capital and a raid.
const PLACES: [&str; 4] = ["Durotar", "Dornogal", "Stormwind City", "Nerub-ar Palace"];

/// What a fragment is at most, a side at a time. Far above what one is, on purpose: the point of
/// the sweep is to see a wrong read come out large rather than to have it refused.
const LARGEST_TEXTURE: u32 = 4096;

/// How opaque a pixel has to be to count as paint rather than as the edge of a fragment.
const PAINTED: u8 = 8;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: dump_maps <wow install> | --fixtures <dir>  [--write <dir>] [names...]");
        std::process::exit(2);
    }

    let mut write_to: Option<String> = None;
    if let Some(at) = args.iter().position(|arg| arg == "--write") {
        if at + 1 >= args.len() {
            eprintln!("--write needs a directory");
            std::process::exit(2);
        }
        write_to = Some(args.remove(at + 1));
        args.remove(at);
    }

    let mut rest = args.into_iter();
    let first = rest.next().expect("checked above");
    let files: Box<dyn GameFiles> = if first == "--fixtures" {
        let dir = rest.next().unwrap_or_else(|| {
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

    let mut wanted: Vec<String> = rest.collect();
    if wanted.is_empty() {
        wanted = PLACES.iter().map(|place| (*place).to_string()).collect();
    }

    tables_of(files.as_ref());
    styles_of(files.as_ref());
    census_of(files.as_ref());
    for place in &wanted {
        assemble(files.as_ref(), place, write_to.as_deref());
    }
}

/// The front of each of the seven tables, which is where a moved FileDataID shows up first.
fn tables_of(files: &dyn GameFiles) {
    for (what, fdid, columns) in [
        ("UiMap", tables::UI_MAP, 8),
        ("UiMapXMapArt", tables::UI_MAP_X_MAP_ART, 2),
        ("UiMapArt", tables::UI_MAP_ART, 3),
        ("UiMapArtStyleLayer", tables::UI_MAP_ART_STYLE_LAYER, 8),
        ("UiMapArtTile", tables::UI_MAP_ART_TILE, 4),
        ("WorldMapOverlay", tables::WORLD_MAP_OVERLAY, 6),
        ("WorldMapOverlayTile", tables::WORLD_MAP_OVERLAY_TILE, 4),
    ] {
        let table = match files.read(fdid).and_then(Db2::parse) {
            Ok(table) => table,
            Err(error) => {
                println!("\n=== {what} ({fdid}) would not read: {error}");
                continue;
            }
        };
        println!(
            "\n=== {what} ({fdid}) — {} rows, {} columns",
            table.declared_rows(),
            table.column_count()
        );
        for row in table.rows().take(SHOWN) {
            let printed: Vec<String> = (0..columns.min(table.column_count()))
                .map(|column| row.number(column).to_string())
                .collect();
            let name = row.text(0);
            let name = if name.is_empty() {
                String::new()
            } else {
                format!("  {name:?}")
            };
            println!(
                "  id {:<6} belongs to {:<6} cols {}{name}",
                row.id(),
                row.foreign_id(),
                printed.join(" ")
            );
        }
    }
}

/// Every style layer the game has, which is nine rows and the whole of how a map is laid out.
fn styles_of(files: &dyn GameFiles) {
    let table = match files
        .read(tables::UI_MAP_ART_STYLE_LAYER)
        .and_then(Db2::parse)
    {
        Ok(table) => table,
        Err(error) => {
            println!("\n=== the styles would not read: {error}");
            return;
        }
    };
    println!("\n=== every style layer");
    for row in table.rows() {
        let (width, height) = (
            row.number(tables::ui_map_art_style_layer::WIDTH),
            row.number(tables::ui_map_art_style_layer::HEIGHT),
        );
        let (tile_width, tile_height) = (
            row.number(tables::ui_map_art_style_layer::TILE_WIDTH),
            row.number(tables::ui_map_art_style_layer::TILE_HEIGHT),
        );
        println!(
            "  style {:<4} layer {}  {width}×{height} out of {tile_width}×{tile_height} fragments \
             — a grid of {}×{}",
            row.foreign_id(),
            row.number(tables::ui_map_art_style_layer::LAYER_INDEX),
            grid(width, tile_width),
            grid(height, tile_height),
        );
    }
}

/// The census the two choices in the chain rest on: how much of `UiMapXMapArt` is phased and whether
/// a map with phased art always has art for the rest of the time as well, then how many overlays
/// state no size and how many the game shows only under a condition.
///
/// It is the one thing in the chain that cannot be settled by looking at a place. `maps.rs` takes
/// the unphased row because a phase is a fact about a player's own progress, and that is only safe
/// while every map with phased art has an unphased row to fall back on — a map with nothing but
/// phased art would come back with no picture at all.
fn census_of(files: &dyn GameFiles) {
    let table = match files.read(tables::UI_MAP_X_MAP_ART).and_then(Db2::parse) {
        Ok(table) => table,
        Err(error) => {
            println!("\n=== the arts would not read: {error}");
            return;
        }
    };
    let mut phased: HashMap<u32, usize> = HashMap::new();
    let mut unphased: HashMap<u32, usize> = HashMap::new();
    for row in table.rows() {
        let counted = if row.number(tables::ui_map_x_map_art::PHASE) == 0 {
            &mut unphased
        } else {
            &mut phased
        };
        *counted.entry(row.foreign_id()).or_default() += 1;
    }
    let stranded = phased
        .keys()
        .filter(|map| !unphased.contains_key(map))
        .count();
    println!(
        "\n=== the arts: {} unphased rows over {} maps, {} phased rows over {} maps — {stranded} of \
         those have no unphased art to fall back on",
        unphased.values().sum::<usize>(),
        unphased.len(),
        phased.values().sum::<usize>(),
        phased.len(),
    );

    // And how many fragment rows name no texture, which is the guard `maps.rs` keeps for the same
    // reason `journal.rs` keeps one: nothing decodes FileDataID zero, and a plan that carried one
    // would have a window asking for a picture that cannot exist.
    let Ok(tiles) = files.read(tables::UI_MAP_ART_TILE).and_then(Db2::parse) else {
        return;
    };
    let (mut named, mut blank) = (0usize, 0usize);
    for row in tiles.rows() {
        if row.number(tables::ui_map_art_tile::FILE_DATA_ID) == 0 {
            blank += 1;
        } else {
            named += 1;
        }
    }
    println!("    the fragments: {named} name a texture and {blank} name none");

    // And what the overlays come to, which is the other thing `maps.rs` decides rather than reads:
    // every overlay of an art is painted, including the ones the game only shows a player who has
    // met a condition, because most arts that have such an overlay have nothing else covering that
    // ground and the alternative is a hole of bare terrain in the middle of a zone.
    let Ok(overlays) = files.read(tables::WORLD_MAP_OVERLAY).and_then(Db2::parse) else {
        return;
    };
    let (mut sized, mut empty) = (0usize, 0usize);
    // Every sized overlay as `(art, conditional, left, top, width, height)`, which is what the
    // overlap count below needs.
    let mut rects: Vec<(u32, bool, u32, u32, u32, u32)> = Vec::new();
    for row in overlays.rows() {
        let (width, height) = (
            row.number(tables::world_map_overlay::WIDTH),
            row.number(tables::world_map_overlay::HEIGHT),
        );
        if width == 0 || height == 0 {
            empty += 1;
            continue;
        }
        sized += 1;
        rects.push((
            row.number(tables::world_map_overlay::ART),
            // The player condition is deliberately not one of the columns `maps.rs` reads, so it
            // is read here by position: two past the offsets and the four hit-rectangle columns.
            row.number(10) != 0,
            row.number(tables::world_map_overlay::LEFT),
            row.number(tables::world_map_overlay::TOP),
            width,
            height,
        ));
    }
    let conditional = rects.iter().filter(|entry| entry.1).count();

    // How many of the conditional ones cover ground an unconditional one already covers, which is
    // the whole cost of painting every overlay rather than picking among them: those are the rows
    // that put two versions of one area on a map. Everywhere else, leaving a conditional overlay
    // out would leave bare terrain instead.
    let overlapping = rects
        .iter()
        .filter(|(art, conditional, left, top, width, height)| {
            *conditional
                && rects.iter().any(|(other, theirs, at_x, at_y, wide, tall)| {
                    other == art
                        && !theirs
                        && at_x < &(left + width)
                        && left < &(at_x + wide)
                        && at_y < &(top + height)
                        && top < &(at_y + tall)
                })
        })
        .count();
    println!(
        "    the overlays: {sized} state a size and {empty} state none. {conditional} are shown \
         only to a player who has met some condition, and {overlapping} of those cover ground an \
         unconditional overlay already covers"
    );
}

/// One place walked the whole way: the plan, every fragment read, and what the picture came out as.
fn assemble(files: &dyn GameFiles, place: &str, write_to: Option<&str>) {
    let asked = [place.to_string()];
    let plans = match maps::plans_of(files, &asked) {
        Ok(plans) => plans,
        Err(error) => {
            println!("\n--- {place}: the tables would not read: {error}");
            return;
        }
    };
    let Some(plan) = plans.get(place) else {
        println!("\n--- {place}: no map — nothing in UiMap names it, or its art has no fragments");
        return;
    };
    println!(
        "\n--- {place}: {}×{} out of {}×{} fragments — a grid of {}×{}, {} fragments named",
        plan.width,
        plan.height,
        plan.tile_width,
        plan.tile_height,
        grid(plan.width, plan.tile_width),
        grid(plan.height, plan.tile_height),
        plan.fragments.len(),
    );
    println!(
        "    {} areas exploring reveals, {} fragments between them",
        plan.patches.len(),
        plan.patches
            .iter()
            .map(|patch| patch.fragments.len())
            .sum::<usize>(),
    );
    for patch in plan.patches.iter().take(SHOWN) {
        println!(
            "      at ({},{}) {}×{} out of {} fragments",
            patch.left,
            patch.top,
            patch.width,
            patch.height,
            patch.fragments.len(),
        );
    }

    // Every fragment on its own, which is what says they are all the size the style claims. A
    // decode that comes out larger is a texture read that landed somewhere unintended.
    let mut sizes: HashMap<(u32, u32), usize> = HashMap::new();
    let mut unreadable = 0usize;
    for fragment in &plan.fragments {
        match files
            .read(fragment.file)
            .and_then(|bytes| icons::pixels_of(&bytes, LARGEST_TEXTURE))
        {
            Ok(pixels) => *sizes.entry((pixels.width(), pixels.height())).or_default() += 1,
            Err(error) => {
                unreadable += 1;
                println!("    fragment {} would not read: {error}", fragment.file);
            }
        }
    }
    let mut shapes: Vec<((u32, u32), usize)> = sizes.into_iter().collect();
    shapes.sort_by_key(|((width, height), _)| (*width, *height));
    for ((width, height), count) in shapes {
        println!("    {count} fragments decoded at {width}×{height}");
    }
    if unreadable > 0 {
        println!("    {unreadable} would not read at all, so the whole map is left undrawn");
    }

    match maps::draw(files, plan) {
        Ok(drawing) => {
            let picture = image::load_from_memory(&drawing.bytes)
                .expect("what this module just encoded")
                .to_rgba8();
            let painted = picture
                .pixels()
                .filter(|pixel| pixel.0[3] > PAINTED)
                .count();
            println!(
                "    drawn {}×{} as {} KiB of {}, {:.1}% of it painted",
                picture.width(),
                picture.height(),
                drawing.bytes.len() / 1024,
                drawing.kind,
                100.0 * painted as f64 / (picture.width() * picture.height()) as f64,
            );
            if let Some(dir) = write_to {
                let path = std::path::Path::new(dir).join(format!(
                    "{}.{}",
                    place.replace(|character: char| !character.is_alphanumeric(), "-"),
                    if drawing.kind == "image/jpeg" {
                        "jpg"
                    } else {
                        "png"
                    },
                ));
                match std::fs::write(&path, &drawing.bytes) {
                    Ok(()) => println!("    → {}", path.display()),
                    Err(error) => println!("    would not write {}: {error}", path.display()),
                }
            }
        }
        Err(error) => println!("    not drawn: {error}"),
    }
}

/// How many fragments of a size it takes to hold a picture of a size, which is what the game lays
/// out and what a wrong fragment size shows up in.
fn grid(picture: u32, fragment: u32) -> u32 {
    if fragment == 0 {
        return 0;
    }
    picture.div_ceil(fragment)
}
