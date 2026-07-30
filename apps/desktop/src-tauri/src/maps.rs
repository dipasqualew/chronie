//! The map the game draws a place with, put together out of the fragments it stores it in — and
//! with the places on it a player has been.
//!
//! Nearly every place a segment is filed under is an open-world zone, and the game ships no
//! banner, no icon and no picture of any kind for one: `journal.rs` answers for 805 places out of
//! the two tables the Encounter Journal and the group finder keep, and Durotar is not among them.
//! What the game *does* have for Durotar is the map a player opens with M — and it does not have
//! it as a picture either. **A map is not stored as a file.** It is stored as a grid of 256-pixel
//! fragments, one texture each, with four tables saying which fragment goes where and how large
//! the finished picture is. The client assembles it every time somebody opens the map, and this is
//! the same assembly.
//!
//! **And that grid on its own is the map nobody has walked.** It is terrain, a few mountains and
//! the neighbouring zones' names: no Orgrimmar, no Razor Hill, no roads. Everything a player would
//! recognise is in a *second* set of fragments — one per named area of the zone, each pasted at a
//! stated place over the art — which the game adds as the area is discovered. So a map assembled
//! from the base art alone comes out an empty sheet of parchment, and the assembly is only done
//! once the overlays are on. What this hands over is the map as somebody who has been everywhere
//! sees it, which is the only version of it there is one right answer for.
//!
//! The chain from a name to a grid, which is a hop longer than the journal's:
//!
//! ```text
//! "Durotar" ─▶ UiMap ─▶ UiMapXMapArt ─▶ UiMapArt ─▶ UiMapArtStyleLayer   how large, and of what
//!               1,922      1,928           188            9              fragments
//!                                             ├─▶ UiMapArtTile ────────  the unexplored map
//!                                             │      66,704
//!                                             └─▶ WorldMapOverlay ─────  what exploring reveals
//!                                                    2,909
//!                                                      └─▶ WorldMapOverlayTile
//!                                                             20,867
//! ```
//!
//! `UiMap` is keyed by the same localised name the journal tables are, which is the same string
//! the client reports a player's position under — so the join is the one this app already makes
//! everywhere else, and it lands: every zone, city, continent and dungeon floor the game has is
//! in there.
//!
//! Three of the turns of that chain are a choice rather than a lookup, and each is a wrong
//! map rather than a missing one if it is skipped.
//!
//! - **A name is on several `UiMap` rows more often than not.** "Durotar" is a zone, an orphan and
//!   a copy of itself for the Adventure Guide; "Karazhan" is thirty-five floors; "Dalaran" is
//!   twelve. So the rows are ranked — see [`rank`] — and the first of them that has fragments
//!   wins, because a row can name art that this install has no tiles for.
//! - **A map can have art for a phase of a campaign**, which fourteen of them do, and nothing here
//!   can tell whether a player has reached that phase. Every one of the fourteen also has an
//!   unphased row, and that is the one taken.
//! - **A style can have two layers**, which two of the nine do. Layer 0 is the one drawn at the
//!   scale a map opens at, and the fragments of the other layer are a second copy of the same
//!   picture — mixing the two would draw a map twice over.
//!
//! And the last turn is the one that has to be read rather than counted: **the finished picture
//! is smaller than the grid holding it.** A classic zone is 1,002×668 painted into a 4×3 grid of
//! 256-pixel fragments, which is 1,024×768 — so the last column and the last row overhang, and a
//! reader that took the grid's size would hand over 22 pixels of nothing down one side and 100
//! along the bottom. `UiMapArtStyleLayer` states both sizes, and every overlay states its own the
//! same way; `docs/game-files.md` records what each column was held against.
//!
//! The column numbers were read off a real install with `examples/dump_maps`, which is what to run
//! again after a patch.

use std::collections::{HashMap, HashSet};

use image::imageops::FilterType;
use image::RgbaImage;

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::icons;
use crate::tables::{
    ui_map, ui_map_art, ui_map_art_style_layer, ui_map_art_tile, ui_map_x_map_art,
    world_map_overlay, world_map_overlay_tile, UI_MAP, UI_MAP_ART, UI_MAP_ART_STYLE_LAYER,
    UI_MAP_ART_TILE, UI_MAP_X_MAP_ART, WORLD_MAP_OVERLAY, WORLD_MAP_OVERLAY_TILE,
};

/// What a fragment of a map is at most, a side at a time. Every style but the cosmic map's is
/// laid out in 256-pixel fragments and that one is 512, so anything past 1,024 is a texture read
/// that landed somewhere unintended rather than a map fragment.
const LARGEST_FRAGMENT: u32 = 1024;

/// How wide a finished map is handed to a window, at most.
///
/// The modern zones are assembled at 3,840 across, which is four times what the widest window can
/// show of one and around fifteen times the size the game's own place banners are stored at. The
/// header a map ends up in is 680 pixels wide at the modal's full width, so 1,024 is still more
/// picture than the band can draw on an ordinary screen — and it is what a classic zone map is
/// natively, so those go over untouched.
const WIDEST_MAP: u32 = 1024;

/// Which kind of place to believe first when several rows share a name, as `UiMap.Type` numbers
/// them: 0 cosmic, 1 world, 2 continent, 3 zone, 4 dungeon, 5 micro, 6 orphan.
///
/// Most specific first, because a segment is filed under the place a player was standing in. A
/// zone leads, then a dungeon, then a micro map — the cave inside a zone — and the continent it is
/// all part of comes after them: "The Maelstrom" is a zone and a continent at once, and an evening
/// spent there was spent in the zone. The world and the cosmos are last because nobody stands in
/// them, and an orphan — a map the game keeps and no longer shows — is next to last.
const KINDS: [u32; 7] = [3, 4, 5, 2, 6, 1, 0];

/// Where one fragment of a map goes, and which texture it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fragment {
    /// Which row of the grid it sits in, counting from the top.
    pub row: u32,
    /// And which column, counting from the left.
    pub column: u32,
    pub file: u32,
}

/// The shape one style's layer makes: how large the finished picture is and how large a fragment
/// of it is, which is what turns a grid of textures into a picture with no margin of nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Layer {
    index: u32,
    width: u32,
    height: u32,
    tile_width: u32,
    tile_height: u32,
}

/// One area of a map, as it looks once somebody has been there: a picture of its own, in its own
/// little grid of fragments, pasted at a stated place over the art underneath.
///
/// This is where everything on a map that a reader would recognise lives. Orgrimmar is a patch,
/// Razor Hill is a patch, and the roads between them are parts of both.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Patch {
    /// Where its left edge goes, in the pixels of the finished map.
    pub left: u32,
    pub top: u32,
    /// How wide its own picture is — less than the grid of fragments holding it, the same way the
    /// map itself is.
    pub width: u32,
    pub height: u32,
    pub fragments: Vec<Fragment>,
}

/// One place's map before any of it has been read: how large the finished picture is, how large a
/// fragment of it is, which fragment goes where, and which areas of it exploring reveals.
///
/// Split from the drawing because the two halves fail differently and cost differently. Working
/// out the plan is seven table reads however many places are asked about; drawing one is a texture
/// read and a decode per fragment, which for a modern zone is a hundred and fifty for the art and
/// another few dozen for the areas on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// How wide the finished picture is, which is less than `tile_width` times the columns.
    pub width: u32,
    pub height: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    /// The unexplored map: terrain and nothing that was built on it.
    pub fragments: Vec<Fragment>,
    /// And what exploring it reveals, in the order the game stores them.
    pub patches: Vec<Patch>,
}

/// One assembled map, encoded as something a window can show.
///
/// The kind is carried beside the bytes rather than assumed, because a map is the one picture in
/// this app that is not always a PNG — see [`draw`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Drawing {
    /// The media type, for the `data:` URL the window is handed.
    pub kind: &'static str,
    pub bytes: Vec<u8>,
}

/// The map each of the places asked for is drawn with, keyed by the name it was asked for under.
///
/// A place with no map comes back with nothing rather than with an empty picture, and so does a
/// place whose map this install holds only part of — see [`draw`] for why a partly-read map is not
/// worth handing over. [`crate::heroes`] is what turns either into the stand-in banner.
pub fn drawings_of(
    files: &dyn GameFiles,
    wanted: &[String],
) -> Result<HashMap<String, Drawing>, String> {
    let mut drawn = HashMap::new();
    for (place, plan) in plans_of(files, wanted)? {
        if let Ok(drawing) = draw(files, &plan) {
            drawn.insert(place, drawing);
        }
    }
    Ok(drawn)
}

/// How the map of each of the places asked for is put together, keyed by the name it was asked
/// for under.
///
/// Every name at once, because what costs here is opening the game's storage and reading five
/// tables, and neither is any dearer for forty names than for one. A name the game has no map of
/// is left out rather than answered with an empty plan.
#[tracing::instrument(name = "maps.plans_of", skip_all, fields(places = wanted.len()))]
pub fn plans_of(files: &dyn GameFiles, wanted: &[String]) -> Result<HashMap<String, Plan>, String> {
    let keys: Vec<(String, &String)> = wanted
        .iter()
        .map(|name| (key_of(name), name))
        .filter(|(key, _)| !key.is_empty())
        .collect();
    if keys.is_empty() {
        return Ok(HashMap::new());
    }

    // Every row that names one of the places asked about, ranked. The best row is not always the
    // one that answers: a row can name art whose fragments this install has none of, so the
    // ranking is walked in order at the end rather than resolved here.
    let mut ranked: HashMap<&String, Vec<(u32, usize, u32)>> = HashMap::new();
    let table = Db2::parse(files.read(UI_MAP)?)?;
    for row in table.rows() {
        let name = key_of(&row.text(ui_map::NAME));
        for (key, asked) in &keys {
            if *key == name {
                ranked.entry(asked).or_default().push((
                    row.number(ui_map::SYSTEM),
                    rank(row.number(ui_map::TYPE)),
                    row.id(),
                ));
            }
        }
    }
    if ranked.is_empty() {
        return Ok(HashMap::new());
    }
    let maps: HashSet<u32> = ranked.values().flatten().map(|(_, _, id)| *id).collect();
    for rows in ranked.values_mut() {
        rows.sort_unstable();
    }

    let art_of_map = arts_of(files, &maps)?;
    let arts: HashSet<u32> = art_of_map.values().copied().collect();
    let layer_of_art = layers_of(files, styles_of(files, &arts)?)?;
    let fragments_of_art = fragments_of(files, &layer_of_art)?;
    let patches_of_art = patches_of(files, &layer_of_art)?;

    let mut plans = HashMap::new();
    for (asked, rows) in ranked {
        for (_, _, map) in rows {
            let Some(art) = art_of_map.get(&map) else {
                continue;
            };
            let Some(layer) = layer_of_art.get(art) else {
                continue;
            };
            let Some(fragments) = fragments_of_art.get(&(*art, layer.index)) else {
                continue;
            };
            plans.insert(
                asked.clone(),
                Plan {
                    width: layer.width,
                    height: layer.height,
                    tile_width: layer.tile_width,
                    tile_height: layer.tile_height,
                    fragments: fragments.clone(),
                    patches: patches_of_art.get(art).cloned().unwrap_or_default(),
                },
            );
            break;
        }
    }
    Ok(plans)
}

/// One plan drawn: every fragment read, decoded and put where it goes, the areas exploring reveals
/// painted over the top of it, the overhang of each grid cropped off, and the whole scaled down to
/// something a window can hold.
///
/// **A map is all of its fragments or none of them.** A fragment the game withheld or this install
/// never downloaded — a player can play while the rest of the game is still arriving — leaves a
/// 256-pixel hole in the middle of the picture, and a header with a hole in it reads as a broken
/// window rather than as a map. The place is better off with the stand-in banner, which is what
/// failing here gets it.
///
/// **An area is not**, and the difference is what each absence looks like rather than a change of
/// heart. A patch that cannot be read whole is left off, and what shows through where it would have
/// gone is the terrain underneath — which is exactly what that ground looks like to a player who
/// has not been there. So a torn overlay costs a map one town, and a torn base costs it the header.
///
/// **And a map that came out opaque goes over as a JPEG**, which the rest of the app's pictures
/// never do. What decides it is the picture rather than the format: an icon is a shape on
/// transparency and has to keep its alpha, and a map is a painting of a whole rectangle — the ones
/// measured on 12.0.5.67823 are opaque to the last pixel. PNG cannot compress a painting, so the
/// same Durotar is 1.4 MB of PNG or 213 KB of JPEG, and it crosses the command bridge as base64 in
/// a JSON string. The few maps with a see-through edge stay PNG, because JPEG would draw those
/// black.
#[tracing::instrument(name = "maps.draw", skip_all, fields(
    width = plan.width, height = plan.height,
    fragments = plan.fragments.len(), patches = plan.patches.len()
))]
pub fn draw(files: &dyn GameFiles, plan: &Plan) -> Result<Drawing, String> {
    if plan.fragments.is_empty() || plan.width == 0 || plan.height == 0 {
        return Err("has no fragments to draw".into());
    }
    let mut canvas = RgbaImage::new(plan.width, plan.height);
    for fragment in &plan.fragments {
        let bytes = files.read(fragment.file)?;
        let pixels = icons::pixels_of(&bytes, LARGEST_FRAGMENT)?;
        laid_over(
            &mut canvas,
            &pixels,
            fragment,
            plan.tile_width,
            plan.tile_height,
        );
    }

    // Whether the finished map will have a see-through pixel in it, decided here rather than at the
    // end: a patch only ever adds paint, so what settles it is the terrain underneath. Asking the
    // finished picture instead would answer wrongly: blending an area onto opaque ground comes
    // back 254 rather than 255 wherever the arithmetic rounds down, and that is not transparency
    // anybody can see.
    let opaque = canvas.pixels().all(|pixel| pixel.0[3] == u8::MAX);

    for patch in &plan.patches {
        // Assembled on a canvas of its own so that the overhang of its grid is cropped the same
        // way the map's is, and so that a patch that cannot be read whole can be dropped after
        // the reading rather than half-painted over the terrain.
        if let Ok(picture) = drawn_patch(files, patch, plan) {
            // `overlay` blends where `replace` copies, which is the whole point of a patch: an
            // area's picture is a shape with soft edges on transparency, and copying it would
            // stamp a rectangle of nothing around every town.
            image::imageops::overlay(
                &mut canvas,
                &picture,
                i64::from(patch.left),
                i64::from(patch.top),
            );
        }
    }
    let picture = shrunk(canvas);
    if opaque {
        return Ok(Drawing {
            kind: "image/jpeg",
            bytes: icons::jpeg_bytes(picture)?,
        });
    }
    Ok(Drawing {
        kind: "image/png",
        bytes: icons::png_bytes(picture)?,
    })
}

/// One fragment put where its row and column say, clipped to whatever it is being laid on.
///
/// `replace` copies rather than blends, which is right for both grids: the fragments of one grid
/// never overlap each other, and blending an area's soft edge against the canvas it is being
/// assembled on would darken it before it ever reaches the map. What the clipping does is the crop
/// — the last column and the last row of a grid overhang the picture it makes, and the canvas is
/// the size of the picture.
fn laid_over(
    canvas: &mut RgbaImage,
    fragment_pixels: &RgbaImage,
    fragment: &Fragment,
    tile_width: u32,
    tile_height: u32,
) {
    image::imageops::replace(
        canvas,
        fragment_pixels,
        i64::from(fragment.column * tile_width),
        i64::from(fragment.row * tile_height),
    );
}

/// One area's picture, assembled out of its own fragments — or nothing, if this install is missing
/// any of them.
///
/// All of it or none of it, the same rule the map itself keeps and for the same reason: half a town
/// is a shape nobody would recognise, where no town at all is ground a player has not walked.
fn drawn_patch(files: &dyn GameFiles, patch: &Patch, plan: &Plan) -> Result<RgbaImage, String> {
    if patch.fragments.is_empty() || patch.width == 0 || patch.height == 0 {
        return Err("has no fragments to draw".into());
    }
    let mut canvas = RgbaImage::new(patch.width, patch.height);
    for fragment in &patch.fragments {
        let bytes = files.read(fragment.file)?;
        let pixels = icons::pixels_of(&bytes, LARGEST_FRAGMENT)?;
        laid_over(
            &mut canvas,
            &pixels,
            fragment,
            plan.tile_width,
            plan.tile_height,
        );
    }
    Ok(canvas)
}

/// The picture at the size it is handed over at, which for a classic zone map is the size it was
/// assembled at.
fn shrunk(map: RgbaImage) -> RgbaImage {
    if map.width() <= WIDEST_MAP {
        return map;
    }
    let height = (map.height() * WIDEST_MAP / map.width()).max(1);
    image::imageops::resize(&map, WIDEST_MAP, height, FilterType::CatmullRom)
}

/// Which art each of the maps asked about is drawn with.
///
/// The unphased row wins. Fourteen maps have art for a phase of a campaign as well, and whether a
/// phase is active is a fact about a player's own progress that nothing on this side of the game
/// can answer — so the art the map is drawn with the rest of the time is the one taken.
fn arts_of(files: &dyn GameFiles, maps: &HashSet<u32>) -> Result<HashMap<u32, u32>, String> {
    let mut best: HashMap<u32, ((u32, u32), u32)> = HashMap::new();
    let table = Db2::parse(files.read(UI_MAP_X_MAP_ART)?)?;
    for row in table.rows() {
        let map = row.foreign_id();
        if !maps.contains(&map) {
            continue;
        }
        let art = row.number(ui_map_x_map_art::ART);
        if art == 0 {
            continue;
        }
        // Unphased first, and the earliest row after that, so the answer does not depend on the
        // order a table happens to be stored in.
        let phase = row.number(ui_map_x_map_art::PHASE);
        let ranked = (u32::from(phase != 0), row.id());
        if best.get(&map).is_none_or(|had| ranked < had.0) {
            best.insert(map, (ranked, art));
        }
    }
    Ok(best.into_iter().map(|(map, (_, art))| (map, art)).collect())
}

/// Which style each of the arts asked about is drawn in.
fn styles_of(files: &dyn GameFiles, arts: &HashSet<u32>) -> Result<HashMap<u32, u32>, String> {
    let mut styles = HashMap::new();
    let table = Db2::parse(files.read(UI_MAP_ART)?)?;
    for row in table.rows() {
        if arts.contains(&row.id()) {
            styles.insert(row.id(), row.number(ui_map_art::STYLE));
        }
    }
    Ok(styles)
}

/// The layer each art is assembled from, and the shape of the picture it makes.
///
/// Layer 0 is the one the game draws at the scale a map opens at. Two of the nine styles have a
/// second layer of their own, the same size as the first — a second copy of the same picture for a
/// different zoom — so taking the lowest index is what keeps one map from being drawn twice over.
fn layers_of(
    files: &dyn GameFiles,
    style_of_art: HashMap<u32, u32>,
) -> Result<HashMap<u32, Layer>, String> {
    let wanted: HashSet<u32> = style_of_art.values().copied().collect();
    let mut base: HashMap<u32, Layer> = HashMap::new();
    let table = Db2::parse(files.read(UI_MAP_ART_STYLE_LAYER)?)?;
    for row in table.rows() {
        let style = row.foreign_id();
        if !wanted.contains(&style) {
            continue;
        }
        let index = row.number(ui_map_art_style_layer::LAYER_INDEX);
        if base.get(&style).is_some_and(|had| had.index <= index) {
            continue;
        }
        base.insert(
            style,
            Layer {
                index,
                width: row.number(ui_map_art_style_layer::WIDTH),
                height: row.number(ui_map_art_style_layer::HEIGHT),
                tile_width: row.number(ui_map_art_style_layer::TILE_WIDTH),
                tile_height: row.number(ui_map_art_style_layer::TILE_HEIGHT),
            },
        );
    }
    Ok(style_of_art
        .into_iter()
        .filter_map(|(art, style)| base.get(&style).map(|layer| (art, *layer)))
        // A layer that states no fragment size says nothing about how to lay a grid out, and
        // dividing a picture into fragments of no width is the one arrangement that cannot draw.
        .filter(|(_, layer)| layer.tile_width != 0 && layer.tile_height != 0)
        .collect())
}

/// The fragments of each art, as `(art, layer)`, and only the layer that art is assembled from.
///
/// The table is 66,704 rows — the whole game's maps — so what it is asked is which of them belong
/// to the handful of arts a window is showing.
fn fragments_of(
    files: &dyn GameFiles,
    layer_of_art: &HashMap<u32, Layer>,
) -> Result<HashMap<(u32, u32), Vec<Fragment>>, String> {
    let mut found: HashMap<(u32, u32), Vec<Fragment>> = HashMap::new();
    if layer_of_art.is_empty() {
        return Ok(found);
    }
    let table = Db2::parse(files.read(UI_MAP_ART_TILE)?)?;
    for row in table.rows() {
        let art = row.foreign_id();
        let layer = row.number(ui_map_art_tile::LAYER_INDEX);
        if layer_of_art
            .get(&art)
            .is_none_or(|base| base.index != layer)
        {
            continue;
        }
        let file = row.number(ui_map_art_tile::FILE_DATA_ID);
        if file == 0 {
            continue;
        }
        found.entry((art, layer)).or_default().push(Fragment {
            row: row.number(ui_map_art_tile::ROW_INDEX),
            column: row.number(ui_map_art_tile::COL_INDEX),
            file,
        });
    }
    Ok(found)
}

/// The areas exploring reveals on each art, in the order the game stores them.
///
/// Two more tables, read the same way as the two above and for the same reason: what is asked of
/// 2,909 overlays and their 20,867 fragments is which of them belong to the handful of arts a
/// window is showing.
///
/// **Every overlay of the art is taken, including the hundred that name a player condition.** What
/// a condition says is that the game only shows that area's picture once something is true of the
/// player — a campaign reached, a war effort finished — and nothing on this side of the game can
/// evaluate one. 78 of those hundred cover ground no other overlay covers, so leaving them out
/// would leave a hole of bare terrain in the middle of a map somebody spent a season in. What it
/// costs is the other 22: two versions of one area, painted in the order the table stores them,
/// which reads as the later one having happened.
///
/// A patch is dropped where it says it is no size or has no fragments — the real table has three
/// such rows for Durotar alone — because a picture no pixels wide is nothing to paste anywhere.
fn patches_of(
    files: &dyn GameFiles,
    layer_of_art: &HashMap<u32, Layer>,
) -> Result<HashMap<u32, Vec<Patch>>, String> {
    let mut found: HashMap<u32, Vec<Patch>> = HashMap::new();
    if layer_of_art.is_empty() {
        return Ok(found);
    }

    // Which overlays belong to an art a window is showing, and where each goes. Kept by overlay id
    // so that the fragments can be hung off them, and in id order so that two overlays painting the
    // same ground do it the same way round every time.
    let mut wanted: Vec<(u32, u32, Patch)> = Vec::new();
    let table = Db2::parse(files.read(WORLD_MAP_OVERLAY)?)?;
    for row in table.rows() {
        let art = row.number(world_map_overlay::ART);
        if !layer_of_art.contains_key(&art) {
            continue;
        }
        let (width, height) = (
            row.number(world_map_overlay::WIDTH),
            row.number(world_map_overlay::HEIGHT),
        );
        if width == 0 || height == 0 {
            continue;
        }
        wanted.push((
            row.id(),
            art,
            Patch {
                left: row.number(world_map_overlay::LEFT),
                top: row.number(world_map_overlay::TOP),
                width,
                height,
                fragments: Vec::new(),
            },
        ));
    }
    if wanted.is_empty() {
        return Ok(found);
    }
    wanted.sort_unstable_by_key(|(id, _, _)| *id);

    // Which layer each overlay's fragments have to be on, which is the layer the art underneath is
    // assembled from. Read for the same reason the base art's is: an overlay drawn from another
    // layer is the same ground a second time at another scale. Every one of the real table's
    // 20,867 rows is layer 0 on 12.0.5.67823, so nothing has ever been dropped here.
    let layer_of_overlay: HashMap<u32, u32> = wanted
        .iter()
        .filter_map(|(id, art, _)| layer_of_art.get(art).map(|layer| (*id, layer.index)))
        .collect();

    let mut fragments: HashMap<u32, Vec<Fragment>> = HashMap::new();
    let table = Db2::parse(files.read(WORLD_MAP_OVERLAY_TILE)?)?;
    for row in table.rows() {
        let overlay = row.foreign_id();
        let layer = row.number(world_map_overlay_tile::LAYER_INDEX);
        if layer_of_overlay
            .get(&overlay)
            .is_none_or(|base| *base != layer)
        {
            continue;
        }
        let file = row.number(world_map_overlay_tile::FILE_DATA_ID);
        if file == 0 {
            continue;
        }
        fragments.entry(overlay).or_default().push(Fragment {
            row: row.number(world_map_overlay_tile::ROW_INDEX),
            column: row.number(world_map_overlay_tile::COL_INDEX),
            file,
        });
    }

    for (id, art, patch) in wanted {
        let Some(mine) = fragments.remove(&id) else {
            continue;
        };
        if mine.is_empty() {
            continue;
        }
        found.entry(art).or_default().push(Patch {
            fragments: mine,
            ..patch
        });
    }
    Ok(found)
}

/// Where a kind of place sits in [`KINDS`], and past the end of it for a kind this build has never
/// heard of — which ranks a `UiMap.Type` the game adds later behind every kind that is known
/// rather than ahead of them.
fn rank(kind: u32) -> usize {
    KINDS
        .iter()
        .position(|known| *known == kind)
        .unwrap_or(KINDS.len())
}

/// One place name reduced to what two spellings of it have in common, the same way `journal.rs`
/// does it: these two are keyed by the same string out of the same client.
fn key_of(name: &str) -> String {
    name.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::map_fixture_files;

    /// The fixtures' places and what each is there to say. See `scripts/make-map-fixtures.ts`.
    ///
    /// A classic zone: one row, one art, a 4×3 grid of 8-pixel fragments making a picture of
    /// 30×20 — the same overhang the real 1,002×668 has in its 1,024×768 of tiles.
    const ZONE: &str = "Emberfall Marches";
    /// A name on four rows: a zone, a dungeon, a continent and an Adventure Guide copy of the
    /// zone. The world's zone is the one to draw.
    const DISPUTED: &str = "Tideglass Hollow";
    /// A name whose only row is a continent, which is the kind ranked behind the others.
    const CONTINENT: &str = "Sunder Reach";
    /// A map with art for a phase of a campaign beside its unphased art.
    const PHASED: &str = "Ashvault";
    /// A map whose style has two layers, the second a copy of the first at another scale.
    const LAYERED: &str = "Glass Caverns";
    /// A map whose art this install has no fragments for at all.
    const UNTILED: &str = "Zekvir's Lair";
    /// A map one of whose fragments is a file this install does not hold.
    const TORN: &str = "Grubwarden's Burrow";
    /// A map assembled wider than a window is handed one.
    const HUGE: &str = "Nerub-ar Palace";
    /// A name whose best-ranked row names art with no fragments at all, and whose next-ranked row
    /// shares the classic zone's grid.
    const SECOND_BEST: &str = "Hollowmere";
    /// A name whose one row names art zero, which is a row of nothing rather than a missing row.
    const ARTLESS: &str = "Blank Hollow";

    /// The flat colours the one-fragment places are painted, each of which names the row, the art
    /// or the layer that answered. See `scripts/make-map-fixtures.ts`.
    const DISPUTED_ZONE_PAINT: [u8; 4] = [20, 200, 20, 255];
    const DISPUTED_DUNGEON_PAINT: [u8; 4] = [200, 20, 20, 255];
    const DISPUTED_GUIDE_PAINT: [u8; 4] = [20, 20, 200, 255];
    const CONTINENT_PAINT: [u8; 4] = [200, 200, 20, 255];
    const UNPHASED_PAINT: [u8; 4] = [20, 200, 200, 255];
    const PHASED_PAINT: [u8; 4] = [200, 20, 200, 255];
    const BASE_LAYER_PAINT: [u8; 4] = [120, 200, 40, 255];
    const HUGE_PAINT: [u8; 4] = [200, 90, 90, 255];
    /// Canvas nobody painted, which is what an unfilled corner of a picture reads as.
    const UNPAINTED: [u8; 4] = [0, 0, 0, 0];

    /// The two areas the fixture paints over one piece of the classic zone's ground, which is what
    /// a place with a conditional overlay beside an unconditional one has. The later row is the one
    /// the game paints last, so it is the one that shows.
    const EARLIER_AREA_PAINT: [u8; 4] = [200, 60, 200, 255];
    const LATER_AREA_PAINT: [u8; 4] = [60, 200, 200, 255];

    fn names(of: &[&str]) -> Vec<String> {
        of.iter().map(|name| (*name).to_string()).collect()
    }

    fn plan(place: &str) -> Plan {
        plans_of(&map_fixture_files(), &names(&[place]))
            .unwrap()
            .remove(place)
            .unwrap_or_else(|| panic!("no plan for {place}"))
    }

    fn drawing(place: &str) -> Drawing {
        drawings_of(&map_fixture_files(), &names(&[place]))
            .unwrap()
            .remove(place)
            .unwrap_or_else(|| panic!("nothing drawn for {place}"))
    }

    /// One drawn map, decoded back out of whatever the module encoded it as, so what is checked is
    /// what a window would actually be handed.
    ///
    /// The format is sniffed rather than named, because which of two the module picks is the thing
    /// under test — a helper that insisted on PNG could only ever see half the maps here.
    fn drawn(place: &str) -> RgbaImage {
        image::load_from_memory(&drawing(place).bytes)
            .unwrap()
            .into_rgba8()
    }

    /// The colour one pixel of a drawn map came back as.
    fn paint_at(picture: &RgbaImage, (x, y): (u32, u32)) -> [u8; 4] {
        picture.get_pixel(x, y).0
    }

    /// One pixel of a drawn map held against the colour that was painted there, allowing every
    /// channel a few counts of slack.
    ///
    /// A map whose terrain fills it is handed over as a JPEG, so nothing comes back out of one
    /// exactly as it went in: a flat colour lands a count or two either side of itself and a pixel
    /// a couple across from a colour edge as much as fourteen. The fixture's colours are more than
    /// a hundred apart, so sixteen counts of slack cannot mistake one of them for another — what it
    /// buys is a test of where the paint landed rather than of how the encoder rounds.
    fn paint_near(picture: &RgbaImage, at: (u32, u32), expected: [u8; 4]) {
        let found = paint_at(picture, at);
        assert!(
            nears(found, expected),
            "at {at:?}: {found:?} is not near {expected:?}"
        );
    }

    /// Whether two colours are the same colour once the encoder has had its way with one of them,
    /// which is what lets a test say a pixel is *not* one of the fixture's colours as well as that
    /// it is.
    fn nears(found: [u8; 4], expected: [u8; 4]) -> bool {
        found
            .iter()
            .zip(expected.iter())
            .all(|(had, want)| had.abs_diff(*want) <= 16)
    }

    /// Which fragment of the classic grid landed at one pixel, as the `(row, column)` the fixture
    /// painted it for.
    ///
    /// Read off the red channel, which the fixture counts the twelve fragments in, and read as the
    /// nearest of the twelve rather than as exactly one of them: a grid that fills its picture is
    /// handed over as a JPEG, and a flat colour comes back out of one a count or two either side of
    /// what went in. Comparing all four channels would be a test of the encoder's rounding instead
    /// of a test of where the fragment landed, and ten apart is far enough that the nearest of the
    /// twelve is always the right one.
    fn fragment_at(picture: &RgbaImage, (x, y): (u32, u32)) -> (u32, u32) {
        let counted = (u32::from(paint_at(picture, (x, y))[0]) + 5) / 10;
        assert!(
            (1..=12).contains(&counted),
            "no grid fragment at ({x},{y}): {counted}"
        );
        ((counted - 1) / 4, (counted - 1) % 4)
    }

    /* ---------- the grid a map is assembled out of ---------- */

    /// The finished picture is smaller than the fragments holding it — 30×20 inside a 4×3 grid of
    /// 8-pixel tiles, the proportion the real 1,002×668 sits inside its 1,024×768. A reader that
    /// multiplied the grid out instead of reading both sizes off the style would hand a window a
    /// margin of nothing down one side and along the bottom, which at the real sizes is 22 pixels
    /// and 100.
    #[test]
    fn states_a_picture_smaller_than_the_grid_of_fragments_holding_it() {
        let plan = plan(ZONE);
        assert_eq!((plan.width, plan.height), (30, 20));
        assert_eq!((plan.tile_width, plan.tile_height), (8, 8));
        assert!(plan.width < plan.tile_width * 4 && plan.height < plan.tile_height * 3);
    }

    /// Every fragment of the grid, once each, and nothing else. `UiMapArtTile` is 66,704 rows for
    /// the whole game's maps, so the claim worth making is not that twelve came back but that they
    /// are the twelve belonging to this art — a filter one column out would gather another place's
    /// fragments in beside them and lay them over this picture.
    #[test]
    fn names_every_fragment_of_the_grid_once_and_nothing_else() {
        let mut fragments = plan(ZONE).fragments;
        fragments.sort_unstable_by_key(|at| (at.row, at.column));
        let places: Vec<(u32, u32)> = fragments.iter().map(|at| (at.row, at.column)).collect();
        let expected = [
            (0, 0),
            (0, 1),
            (0, 2),
            (0, 3),
            (1, 0),
            (1, 1),
            (1, 2),
            (1, 3),
            (2, 0),
            (2, 1),
            (2, 2),
            (2, 3),
        ];
        assert_eq!(places, expected);
        let files: Vec<u32> = fragments.iter().map(|at| at.file).collect();
        assert_eq!(files, (190001..=190012).collect::<Vec<u32>>());
    }

    /// Row and column are two 8-bit columns side by side in the table, and reading them the other
    /// way round is a map turned on its diagonal rather than a map that failed to read. The corners
    /// settle it, because each of the twelve fragments is a colour of its own: the top right has to
    /// be the last fragment of the first row and the bottom left the first of the third, and a
    /// transposed read would put neither there.
    #[test]
    fn puts_every_fragment_of_the_grid_where_the_table_says_it_goes() {
        let picture = drawn(ZONE);
        assert_eq!(fragment_at(&picture, (0, 0)), (0, 0));
        assert_eq!(fragment_at(&picture, (29, 0)), (0, 3));
        assert_eq!(fragment_at(&picture, (0, 19)), (2, 0));
        assert_eq!(fragment_at(&picture, (29, 19)), (2, 3));
        assert_eq!(fragment_at(&picture, (8, 8)), (1, 1));
    }

    /* ---------- which row, which art and which layer answered ---------- */

    /// One name on three rows, and the ranking has to beat all three the right way round. The
    /// dungeon is stored first and outranks nothing here; the Adventure Guide's copy has the same
    /// best kind as the zone *and* the lowest id of the three, so it wins on either tiebreak a
    /// reader might reach for. Only ranking the map system ahead of both puts the world's own zone
    /// on the screen, which is the place the evening was actually spent in.
    #[test]
    fn draws_the_zone_rather_than_the_dungeon_or_the_guides_copy_of_the_same_name() {
        let picture = drawn(DISPUTED);
        assert_eq!(paint_at(&picture, (0, 0)), DISPUTED_ZONE_PAINT);
        assert_ne!(paint_at(&picture, (0, 0)), DISPUTED_DUNGEON_PAINT);
        assert_ne!(paint_at(&picture, (0, 0)), DISPUTED_GUIDE_PAINT);
    }

    /// A continent is the kind ranked behind zones, dungeons and the caves inside them — and behind
    /// is not out. Nothing else names this place, so a reader that answered only for the kinds it
    /// prefers would leave every segment filed under a continent with no header at all.
    #[test]
    fn draws_a_place_whose_only_row_is_a_kind_ranked_behind_the_others() {
        assert_eq!(paint_at(&drawn(CONTINENT), (0, 0)), CONTINENT_PAINT);
    }

    /// The best-ranked row is not always the row that answers. Hollowmere's zone row names art with
    /// no fragments whatsoever and the dungeon row behind it names the classic grid, so a reader
    /// that resolved the ranking once and looked the winner up would draw nothing for a place it
    /// holds a perfectly good map of. Twelve fragments is the second row having been reached.
    #[test]
    fn walks_the_ranking_past_a_row_that_reaches_no_fragments() {
        assert_eq!(plan(SECOND_BEST).fragments.len(), 12);
    }

    /// Fourteen maps have art for a phase of a campaign beside the art they are drawn with the rest
    /// of the time, and whether a phase has been reached is a fact about one player's own progress
    /// that nothing on this side of the game can ask about. The fixture stores the phased row first
    /// and on the lower row id, so taking either the first row met or the lowest id would show a
    /// reader a version of a place they may never have seen.
    #[test]
    fn draws_the_art_a_map_has_the_rest_of_the_time_rather_than_a_campaigns() {
        let picture = drawn(PHASED);
        assert_eq!(paint_at(&picture, (0, 0)), UNPHASED_PAINT);
        assert_ne!(paint_at(&picture, (0, 0)), PHASED_PAINT);
    }

    /// Two of the nine styles keep a second layer, which is the same picture again for another zoom
    /// level rather than more of the picture. The fixture's other layer paints the base layer's own
    /// corner a different colour and paints a corner the base layer leaves alone — so a reader that
    /// mixed the two shows the wrong colour on the left, and one that took the wrong layer paints a
    /// right-hand half this map has nothing in.
    #[test]
    fn draws_only_the_layer_a_map_opens_at_rather_than_both_copies_of_it() {
        let picture = drawn(LAYERED);
        assert_eq!((picture.width(), picture.height()), (16, 8));
        assert_eq!(paint_at(&picture, (0, 0)), BASE_LAYER_PAINT);
        assert_eq!(paint_at(&picture, (15, 0)), UNPAINTED);
    }

    /* ---------- what exploring a place reveals ---------- */

    /// The areas of a map come back in the order the table keeps them, each with the rectangle it
    /// states and the fragments it is assembled from. The order is not presentation: two overlays
    /// can cover one piece of ground — one of them conditional on a campaign this side of the game
    /// cannot ask about — and both are painted, so which of the two a reader ends up looking at is
    /// decided by which was painted last. Gathering them by whatever order a hash map or the tile
    /// table happened to hand back would show one player's Orgrimmar and another's at random.
    #[test]
    fn carries_the_areas_of_a_map_in_the_order_the_table_stores_them() {
        let patches = plan(ZONE).patches;
        let places: Vec<(u32, u32, u32, u32)> = patches
            .iter()
            .map(|patch| (patch.left, patch.top, patch.width, patch.height))
            .collect();
        let expected = [
            (12, 4, 12, 8),
            (24, 8, 8, 8),
            (0, 12, 12, 8),
            (0, 4, 8, 8),
            (0, 4, 8, 8),
        ];
        assert_eq!(places, expected);
        let counts: Vec<usize> = patches.iter().map(|patch| patch.fragments.len()).collect();
        assert_eq!(counts, [2, 1, 2, 1, 1]);
    }

    /// An area is a picture of its own, in a little grid of its own, pasted at the offset its row
    /// states — and it is the offset rather than the grid that says where it goes. The first area
    /// starts twelve pixels into the map and is two fragments across, each a colour of its own, so
    /// a reader that laid the area's fragments out in the map's coordinates rather than the area's
    /// would paint the town at the top left corner of the zone instead of over the ground it was
    /// built on.
    #[test]
    fn paints_an_area_over_the_terrain_where_it_says_out_of_its_own_fragments() {
        let picture = drawn(ZONE);
        paint_near(&picture, (15, 8), [250, 40, 40, 255]);
        paint_near(&picture, (22, 8), [40, 250, 40, 255]);
    }

    /// An area overhangs its own grid the same way the map overhangs its own, and states both sizes
    /// the same way. The first area is two 8-pixel fragments across and declares a picture of 12,
    /// so the four pixels past that are ground the area says nothing about: a reader that pasted
    /// the whole grid would push somebody else's coastline four pixels over the terrain along the
    /// right edge of every town on the map.
    #[test]
    fn crops_an_areas_own_grid_to_the_size_the_area_declares() {
        // Base fragment (0,3) — red 40 on the fixture's green 64 and blue 128 — where the area's
        // second fragment would reach if its grid were pasted whole.
        paint_near(&drawn(ZONE), (26, 5), [40, 64, 128, 255]);
    }

    /// An area's picture is a shape with soft edges on transparency rather than a rectangle, so it
    /// has to be blended over the terrain rather than copied onto it. This area is transparent to
    /// the last pixel over ground whose colour is known, which is what the wrong choice looks like
    /// at its worst: `replace` instead of `overlay` would stamp a fragment-sized rectangle of
    /// nothing into the middle of the map, and at the real sizes that is a 256-pixel hole punched
    /// out of the terrain around every town on it.
    #[test]
    fn leaves_the_terrain_showing_where_an_area_is_painted_on_nothing() {
        // Base fragment (1,3), red 80, with the transparent area pasted over exactly it.
        assert_eq!(fragment_at(&drawn(ZONE), (26, 11)), (1, 3));
    }

    /// An area this install holds only part of is left off and the map is still drawn, which is the
    /// opposite of what a missing base fragment does — that one fails the whole picture. The
    /// difference is what each absence looks like: bare terrain is exactly how ground a player has
    /// not walked is drawn, so a town that never appears is a map of somewhere unexplored, while a
    /// hole in the terrain is a broken window. So the area is dropped after the reading rather than
    /// half-painted, and the place still answers.
    #[test]
    fn drops_an_area_this_install_holds_only_part_of_and_still_draws_the_map() {
        let drawings = drawings_of(&map_fixture_files(), &names(&[ZONE])).unwrap();
        assert!(drawings.contains_key(ZONE), "{:?}", drawings.keys());
        // Base fragment (1,0), red 50, under the half-held area's own first fragment.
        assert_eq!(fragment_at(&drawn(ZONE), (5, 14)), (1, 0));
    }

    /// Two of the fixture's seven overlay rows are nothing to paste anywhere, and each is one of
    /// the two shapes the real table holds: 506 of its 2,909 rows state no size at all, and a
    /// fragment on the layer the map is not assembled from is the same ground again at another
    /// scale. Carried through, the first would have the drawing ask for a canvas of no pixels and
    /// the second would paste a second zoom level's paint over the map at the first's coordinates.
    #[test]
    fn leaves_out_an_area_with_no_size_and_one_whose_fragments_are_on_another_layer() {
        assert_eq!(plan(ZONE).patches.len(), 5);
        // Base fragment (1,2), red 70, where the other layer's area states its rectangle.
        assert_eq!(fragment_at(&drawn(ZONE), (18, 14)), (1, 2));
    }

    /// Where two areas cover one piece of ground the later row is the one that shows, which is what
    /// the game does with the hundred overlays that name a player condition: nothing here can
    /// evaluate one, both are painted, and painting them in the table's own order reads as the
    /// later thing having happened. A reader that sorted them any other way — or gathered them out
    /// of a hash map — would show the earlier state of the place, and would not show the same one
    /// twice from one run to the next.
    /// The two are painted 140 counts apart on every channel, which is far enough that the slack
    /// [`paint_near`] allows for the encoder cannot mistake either of them for the other.
    #[test]
    fn paints_the_later_of_two_areas_over_one_piece_of_ground_last() {
        let picture = drawn(ZONE);
        paint_near(&picture, (4, 8), LATER_AREA_PAINT);
        let found = paint_at(&picture, (4, 8));
        assert!(!nears(found, EARLIER_AREA_PAINT), "{found:?}");
    }

    /// An area belongs to one art, and the row says which. The fixture's classic art has seven
    /// overlay rows and the disputed zone's art has none of them, so a reader whose filter missed
    /// the art column would paste Emberfall's towns over Tideglass — every map in the game wearing
    /// every other map's roads and labels.
    #[test]
    fn keeps_each_arts_areas_to_the_art_they_belong_to() {
        let patches = plan(DISPUTED).patches;
        assert!(patches.is_empty(), "{patches:?}");
        assert_eq!(plan(ZONE).patches.len(), 5);
    }

    /* ---------- the size a window is handed ---------- */

    /// The modern zones are assembled at 3,840 across, four times what the widest window can show
    /// of one, and every pixel of that crosses the command bridge as base64 inside a JSON string.
    /// So an oversized picture is shrunk in proportion rather than cropped — the reader still sees
    /// the whole map, and the corner it was painted in is still the colour it was painted.
    #[test]
    fn shrinks_a_map_assembled_wider_than_a_window_can_hold() {
        let plan = plan(HUGE);
        assert_eq!((plan.width, plan.height), (2048, 1024));
        let picture = drawn(HUGE);
        assert_eq!((picture.width(), picture.height()), (1024, 512));
        assert_eq!(paint_at(&picture, (0, 0)), HUGE_PAINT);
    }

    /// And a map a window can already hold goes over at the size it was assembled at. A classic
    /// zone is natively narrower than the limit, so resampling one would cost time and detail to
    /// arrive at the picture that was already there.
    #[test]
    fn leaves_a_map_a_window_can_hold_at_the_size_it_was_assembled() {
        let picture = drawn(ZONE);
        assert_eq!((picture.width(), picture.height()), (30, 20));
    }

    /* ---------- the places that come back with nothing ---------- */

    /// A style this install's layer table describes nothing for, which is content the game shipped
    /// and these tables predate. Without a layer there is neither a picture size nor a fragment
    /// size, and a grid of fragments no pixels wide is the one arrangement that cannot be laid out
    /// at all — so no plan is made rather than one that divides by zero.
    #[test]
    fn plans_nothing_for_art_drawn_in_a_style_no_layer_describes() {
        let asked = names(&[UNTILED]);
        assert!(plans_of(&map_fixture_files(), &asked).unwrap().is_empty());
        assert!(drawings_of(&map_fixture_files(), &asked)
            .unwrap()
            .is_empty());
    }

    /// A row that names art zero names no art: nothing is stored under id zero, so following one
    /// would send the next read looking for art that cannot exist and the one after it for a style
    /// that cannot either.
    #[test]
    fn plans_nothing_for_a_row_that_names_no_art_at_all() {
        let plans = plans_of(&map_fixture_files(), &names(&[ARTLESS])).unwrap();
        assert!(plans.is_empty(), "{plans:?}");
    }

    /// A fragment row that names no texture is the same story one table down, and it is a place in
    /// the grid to leave alone rather than a map to give up on: the disputed zone's art holds one
    /// painted fragment and one row of nothing, and the map is drawn from the one. Carrying the
    /// zero into the plan would have the drawing ask the storage for a file that cannot exist and
    /// fail the whole picture over a place the game never meant to paint. Every one of the real
    /// table's 66,704 rows names a texture on 12.0.5.67823, so this is the guard held to account
    /// rather than a case the game has been seen to hold.
    #[test]
    fn leaves_out_a_fragment_row_that_names_no_texture() {
        let plan = plan(DISPUTED);
        assert_eq!(plan.fragments.len(), 1);
        assert_eq!(paint_at(&drawn(DISPUTED), (0, 0)), DISPUTED_ZONE_PAINT);
    }

    /// A name no `UiMap` row holds — a place from a build newer than these tables, or a string the
    /// client has since respelled. It is left out rather than answered with an empty picture,
    /// because absence is the only thing [`crate::heroes`] can read as "draw the stand-in".
    #[test]
    fn plans_nothing_for_a_name_no_row_holds() {
        let asked = names(&[ZONE, "Durotar"]);
        let plans = plans_of(&map_fixture_files(), &asked).unwrap();
        assert_eq!(plans.len(), 1);
        assert!(!plans.contains_key("Durotar"));
        let drawings = drawings_of(&map_fixture_files(), &asked).unwrap();
        assert!(!drawings.contains_key("Durotar"));
    }

    /// A map is all of its fragments or none of them. A fragment this install never downloaded — a
    /// player can play while the rest of the game is still arriving — or one inside a section the
    /// game encrypts, which decodes to no pixels rather than to an error, leaves a fragment-sized
    /// hole in the band of art a modal opens with, and a header with a hole in it reads as a broken
    /// window. So the plan is still made, the drawing is what fails, and the place falls through.
    #[test]
    fn plans_a_torn_map_and_still_refuses_to_draw_it() {
        assert_eq!(plan(TORN).fragments.len(), 2);
        let drawings = drawings_of(&map_fixture_files(), &names(&[TORN])).unwrap();
        assert!(drawings.is_empty(), "{:?}", drawings.keys());
    }

    /// The name comes back spelled the way it was asked for, whatever case and spacing the table
    /// holds it in: the window keys what it draws by the string sitting on the segment and has
    /// nothing else to look a picture up under.
    #[test]
    fn answers_under_the_name_it_was_asked_under() {
        let asked = "  emberfall marches ";
        let plans = plans_of(&map_fixture_files(), &names(&[asked])).unwrap();
        assert_eq!(plans.get(asked).map(|plan| plan.fragments.len()), Some(12));
    }

    /// Nothing asked about reads no tables at all. Five is what one map costs and one of the five
    /// is 66,704 rows, while a segment the addon filed with no place is nothing to draw a map of —
    /// so the empty question is worth answering before the game's storage is opened.
    #[test]
    fn answers_nothing_at_all_when_no_place_was_named() {
        assert!(plans_of(&map_fixture_files(), &[]).unwrap().is_empty());
        assert!(plans_of(&map_fixture_files(), &names(&["", "  "]))
            .unwrap()
            .is_empty());
    }

    /* ---------- how the finished picture is encoded ---------- */

    /// A map that came out opaque goes over as a JPEG, which nothing else this app draws does. PNG
    /// cannot compress a painting — the real Durotar is 1.4 MB of PNG against 213 KB of JPEG, and
    /// every byte of it crosses the command bridge as base64 inside a JSON string. The classic grid
    /// fills its picture to the last pixel, so it is one of those, and the bytes have to decode as
    /// what the kind beside them claims or the window's `data:` URL is a lie.
    #[test]
    fn encodes_a_map_with_no_transparency_left_in_it_as_a_jpeg() {
        let drawing = drawing(ZONE);
        assert_eq!(drawing.kind, "image/jpeg");
        let picture = image::load_from_memory_with_format(&drawing.bytes, image::ImageFormat::Jpeg)
            .expect("not a jpeg");
        assert_eq!((picture.width(), picture.height()), (30, 20));
    }

    /// And a map with any transparency in it stays a PNG, because JPEG carries no alpha and would
    /// draw every see-through pixel black: a black border around a picture of somewhere reads far
    /// worse than the larger file does. This place has one fragment in a 30×20 picture, so most of
    /// it is nothing at all.
    #[test]
    fn encodes_a_map_with_transparency_left_in_it_as_a_png() {
        let drawing = drawing(DISPUTED);
        assert_eq!(drawing.kind, "image/png");
        let picture = image::load_from_memory_with_format(&drawing.bytes, image::ImageFormat::Png)
            .expect("not a png");
        assert_eq!((picture.width(), picture.height()), (30, 20));
    }
}
