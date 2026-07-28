//! The pictures the game draws an appearance with, decoded into something a window can show.
//!
//! `ItemAppearance` gives every appearance a `DefaultIconFileDataID`, which addresses a BLP
//! texture in the same storage the tables come out of. BLP is Blizzard's own format and no
//! browser has heard of it, so the bytes are decoded here and handed over as PNG.
//!
//! This is the first thing in the app to decode a texture, and it is not the last: the model
//! work needs the same decoder for the textures armour is painted with. What is BLP-specific
//! lives in [`png_of`], which knows about one texture and nothing about icons.
//!
//! The traps are written down in `docs/character-rendering.md`. Two of them are dodged
//! rather than handled: only mipmap level 0 is ever asked for, which is the level whose size
//! the header states correctly, and BC5 normal maps are not something an icon can be.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde_json::{json, Value};
use wow_blp::convert::blp_to_image;
use wow_blp::parser::parse_blp;

use crate::casc::GameFiles;

/// Icons are shown at a few dozen pixels a side and stored at 64. Anything the game hands
/// over that is wildly larger than that is not an icon, and re-encoding it as a PNG to sit
/// in a list row would cost far more than the row is worth.
const LARGEST_ICON: u32 = 512;

/// Anything the window is handed, as a `data:` URL.
///
/// A data URL rather than a file or a served route because the window has no origin to
/// serve from: the frontend is loaded from the bundle and every byte it shows comes across
/// the command bridge. An icon is a couple of kilobytes and an item's model a few hundred,
/// which is small enough for that.
#[tracing::instrument(name = "data_url", skip_all, fields(bytes = bytes.len()))]
pub fn data_url(kind: &str, bytes: &[u8]) -> String {
    format!("data:{kind};base64,{}", STANDARD.encode(bytes))
}

/// Decodes one BLP texture's level 0 into PNG bytes.
///
/// `largest` is what the caller expects the texture to be at most, a side at a time. It is a
/// sanity check rather than a rule of the format: an icon is 64 pixels and a texture painted
/// on a model a few hundred, so anything far beyond that is a lookup that landed somewhere
/// unintended, and re-encoding it would cost more than everything around it put together.
#[tracing::instrument(name = "blp.png_of", skip_all, fields(bytes = blp.len()))]
pub fn png_of(blp: &[u8], largest: u32) -> Result<Vec<u8>, String> {
    let decoded = pixels_of(blp, largest)?;
    let mut png = Vec::new();
    DynamicImage::ImageRgba8(decoded)
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .map_err(|error| format!("would not re-encode: {error}"))?;
    Ok(png)
}

/// The same texture as pixels rather than as a picture, for whoever is going to composite it.
///
/// Everything BLP-specific is here rather than in [`png_of`], because the model work needs the
/// pixels themselves — a texture blitted into the character's body atlas is never encoded on
/// its own — and the palette trap below has to be dodged exactly once.
#[tracing::instrument(name = "blp.pixels_of", skip_all, fields(bytes = blp.len()))]
pub fn pixels_of(blp: &[u8], largest: u32) -> Result<RgbaImage, String> {
    let parsed = parse_blp(blp).map_err(|error| format!("not a texture this build can read: {error}"))?;
    let decoded = blp_to_image(&parsed, 0).map_err(|error| format!("would not decode: {error}"))?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Err("has no pixels".into());
    }
    if width > largest || height > largest {
        return Err(format!("is {width}×{height}, far larger than it should be"));
    }

    // A palettized BLP stores its colours blue first, and the decoder reads them red first —
    // so red and blue arrive swapped for that one encoding, and only that one. The fixtures
    // paint each quadrant a colour whose channels all differ, which is what holds this to
    // account rather than leaving it to be noticed by eye.
    let mut rgba = decoded.into_rgba8();
    if is_palettized(blp) {
        for pixel in rgba.pixels_mut() {
            pixel.0.swap(0, 2);
        }
    }
    Ok(rgba)
}

/// Whether a texture keeps its colours in a palette, which is the encoding whose entries are
/// stored blue first. Byte 8 of a BLP2 header is the encoding, and 1 is the palettized one.
fn is_palettized(blp: &[u8]) -> bool {
    blp.get(8) == Some(&1)
}

/// The icons named, decoded, one entry per id asked for.
///
/// `None` is an answer rather than a failure: the game withholds the content it has not
/// shipped, an appearance can name an icon this install never downloaded, and a texture in
/// an encoding this build cannot read is the same story from the row's point of view. Each
/// of those leaves the row to draw its placeholder, and none of them is worth failing the
/// other nineteen icons of a set over.
pub fn decode(files: &dyn GameFiles, wanted: &[u32]) -> Vec<(u32, Option<String>)> {
    wanted
        .iter()
        .map(|fdid| {
            let decoded = files
                .read(*fdid)
                .and_then(|bytes| png_of(&bytes, LARGEST_ICON))
                .map(|png| data_url("image/png", &png));
            (*fdid, decoded.ok())
        })
        .collect()
}

/// The icons decoded so far, kept for as long as the app runs.
///
/// A set holds twenty-odd appearances and neighbouring sets share their icons — the tier
/// variants of one armour type are the same pictures throughout — so a reader browsing a
/// collection asks for the same texture over and over. Decoding is the cheap half of that;
/// what it saves is opening the game's storage again, which costs a couple of hundred
/// megabytes of transient memory each time.
///
/// An icon that could not be decoded is remembered as such, because the reasons are all
/// permanent for a given install and retrying it on every set would be the one case where
/// the cache does nothing at all.
#[derive(Default)]
pub struct IconCache {
    known: Mutex<HashMap<u32, Option<String>>>,
}

impl IconCache {
    /// Which of the icons asked for are not in the cache yet, without repeats.
    pub fn missing(&self, wanted: &[u32]) -> Vec<u32> {
        let known = self.known.lock().expect("the icon cache is not poisoned");
        let mut missing: Vec<u32> = Vec::new();
        for fdid in wanted {
            if *fdid != 0 && !known.contains_key(fdid) && !missing.contains(fdid) {
                missing.push(*fdid);
            }
        }
        missing
    }

    pub fn store(&self, decoded: Vec<(u32, Option<String>)>) {
        let mut known = self.known.lock().expect("the icon cache is not poisoned");
        known.extend(decoded);
    }

    /// The answer to a request: the icons among those asked for that this install could
    /// decode, keyed by the FileDataID the appearance named them by.
    ///
    /// The ones that could not are left out rather than sent as null, because a row that has
    /// no icon and a row whose icon has not arrived yet draw the same placeholder.
    pub fn answer(&self, wanted: &[u32]) -> Value {
        let known = self.known.lock().expect("the icon cache is not poisoned");
        let mut icons = serde_json::Map::new();
        for fdid in wanted {
            if let Some(Some(url)) = known.get(fdid) {
                icons.insert(fdid.to_string(), json!(url));
            }
        }
        json!({ "icons": Value::Object(icons) })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// The invented icons, by the FileDataID `ItemAppearance` names each of them under.
    const PALETTE: u32 = 130001;
    const PALETTE_WITH_ALPHA: u32 = 130002;
    const DXT1: u32 = 130003;
    const DXT3: u32 = 130004;
    const DXT5: u32 = 130005;
    const UNCOMPRESSED: u32 = 130006;
    /// An icon whose chunk the game encrypts, so its bytes arrive as zeroes.
    const WITHHELD: u32 = 130007;
    /// An icon an appearance names and no install holds.
    const ABSENT: u32 = 130008;

    /// The colour each quadrant of a fixture icon is painted, as the generator wrote them.
    const TOP_LEFT: [u8; 3] = [66, 130, 198];
    const TOP_RIGHT: [u8; 3] = [198, 65, 66];
    const BOTTOM_LEFT: [u8; 3] = [255, 0, 132];
    const BOTTOM_RIGHT: [u8; 3] = [0, 195, 255];

    /// One icon decoded back out of the PNG the module produced, so what is checked is what
    /// the window would actually be handed.
    fn decoded(fdid: u32) -> image::RgbaImage {
        let bytes = fixture_files().read(fdid).unwrap();
        let png = png_of(&bytes, LARGEST_ICON).unwrap_or_else(|error| panic!("icon {fdid}: {error}"));
        image::load_from_memory_with_format(&png, ImageFormat::Png)
            .unwrap()
            .into_rgba8()
    }

    /// The four corners of an icon, which is one pixel out of each quadrant.
    fn corners(image: &image::RgbaImage) -> [[u8; 4]; 4] {
        let last = image.width() - 1;
        [
            image.get_pixel(0, 0).0,
            image.get_pixel(last, 0).0,
            image.get_pixel(0, last).0,
            image.get_pixel(last, last).0,
        ]
    }

    /// A colour with the alpha it is expected to carry.
    fn with_alpha(colour: [u8; 3], alpha: u8) -> [u8; 4] {
        [colour[0], colour[1], colour[2], alpha]
    }

    /// Game files that remember what was asked of them, for the cache's sake.
    struct Noted {
        files: DirFiles,
        asked: RefCell<Vec<u32>>,
    }

    impl Noted {
        fn new() -> Self {
            Self {
                files: fixture_files(),
                asked: RefCell::new(Vec::new()),
            }
        }
    }

    impl GameFiles for Noted {
        fn read(&self, fdid: u32) -> Result<std::sync::Arc<Vec<u8>>, String> {
            self.asked.borrow_mut().push(fdid);
            self.files.read(fdid)
        }
    }

    // Every encoding the client ships, decoded to the same four colours. A decoder that
    // handled only the common one would leave a third of a wardrobe blank.
    #[test]
    fn decodes_a_texture_in_each_encoding_the_game_uses() {
        for (fdid, what) in [
            (PALETTE, "palettized"),
            (DXT1, "DXT1"),
            (UNCOMPRESSED, "uncompressed"),
        ] {
            let image = decoded(fdid);
            assert_eq!((image.width(), image.height()), (8, 8), "{what}");
            assert_eq!(
                corners(&image),
                [
                    with_alpha(TOP_LEFT, 255),
                    with_alpha(TOP_RIGHT, 255),
                    with_alpha(BOTTOM_LEFT, 255),
                    // Only the encodings that carry alpha have a transparent corner; DXT1
                    // and a palette with no alpha plane are opaque throughout.
                    with_alpha(BOTTOM_RIGHT, if fdid == UNCOMPRESSED { 0 } else { 255 }),
                ],
                "{what}"
            );
        }
    }

    // The three encodings that carry alpha, each of which stores it differently: a plane of
    // bytes beside the palette indices, four explicit bits per pixel, and a pair of endpoints
    // interpolated between. An icon with no alpha is a square tile rather than a shape.
    #[test]
    fn keeps_the_alpha_channel_of_every_encoding_that_has_one() {
        for (fdid, what) in [
            (PALETTE_WITH_ALPHA, "palettized with an alpha plane"),
            (DXT3, "DXT3"),
            (DXT5, "DXT5"),
        ] {
            let image = decoded(fdid);
            assert_eq!(
                corners(&image),
                [
                    with_alpha(TOP_LEFT, 255),
                    with_alpha(TOP_RIGHT, 255),
                    with_alpha(BOTTOM_LEFT, 255),
                    with_alpha(BOTTOM_RIGHT, 0),
                ],
                "{what}"
            );
        }
    }

    // A palette stores its entries blue first while the decoder reads them red first, so this
    // encoding and no other needs its channels put back. Blue-first read as red-first turns
    // the top left quadrant from `[66, 130, 198]` into `[198, 130, 66]`, which is a plausible
    // enough colour to pass unnoticed by eye.
    #[test]
    fn reads_a_palette_entry_blue_first_the_way_the_game_stores_it() {
        assert_eq!(corners(&decoded(PALETTE))[0], with_alpha(TOP_LEFT, 255));
        // The same colours through an encoding that needs no correction, which is what says
        // the swap above is the format's and not this module's.
        assert_eq!(corners(&decoded(UNCOMPRESSED))[0], with_alpha(TOP_LEFT, 255));
    }

    #[test]
    fn hands_over_a_picture_the_window_can_show_without_knowing_the_format() {
        let bytes = fixture_files().read(DXT5).unwrap();
        let url = data_url("image/png", &png_of(&bytes, LARGEST_ICON).unwrap());
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        let encoded = url.trim_start_matches("data:image/png;base64,");
        assert_eq!(&STANDARD.decode(encoded).unwrap()[1..4], b"PNG");
    }

    // The two ways an install answers with no icon at all, and the reason the decoder never
    // reports one of them upward: a set holding either still has to draw its other rows.
    #[test]
    fn answers_with_nothing_for_an_icon_this_install_cannot_show() {
        let decoded = decode(&fixture_files(), &[PALETTE, WITHHELD, ABSENT, DXT1]);
        let missing: Vec<u32> = decoded
            .iter()
            .filter(|(_, url)| url.is_none())
            .map(|(fdid, _)| *fdid)
            .collect();
        assert_eq!(missing, vec![WITHHELD, ABSENT]);
        assert_eq!(decoded.len(), 4);
    }

    #[test]
    fn says_what_was_wrong_with_a_texture_it_could_not_read() {
        assert!(png_of(&[0u8; 1172], LARGEST_ICON).unwrap_err().contains("not a texture"));
        assert!(png_of(&[], LARGEST_ICON).unwrap_err().contains("not a texture"));
    }

    /* ---------- the cache ---------- */

    // The sets of a collection share their icons, so the second set a reader opens is mostly
    // pictures already in hand — and what the cache saves is opening the game's storage.
    #[test]
    fn reads_a_texture_the_first_time_it_is_asked_for_and_not_again() {
        let files = Noted::new();
        let cache = IconCache::default();

        let first = cache.missing(&[PALETTE, DXT1]);
        assert_eq!(first, vec![PALETTE, DXT1]);
        cache.store(decode(&files, &first));

        // A second set naming one of the same icons, plus one of its own.
        let second = cache.missing(&[PALETTE, UNCOMPRESSED]);
        assert_eq!(second, vec![UNCOMPRESSED]);
        cache.store(decode(&files, &second));

        assert_eq!(files.asked.into_inner(), vec![PALETTE, DXT1, UNCOMPRESSED]);
        let answer = cache.answer(&[PALETTE, DXT1, UNCOMPRESSED]);
        assert_eq!(answer["icons"].as_object().unwrap().len(), 3);
    }

    // The reasons an icon cannot be shown are all facts about the install rather than about
    // the moment, so asking again would cost a storage open per set to arrive back here.
    #[test]
    fn does_not_go_looking_again_for_an_icon_it_already_failed_to_read() {
        let files = Noted::new();
        let cache = IconCache::default();
        cache.store(decode(&files, &cache.missing(&[WITHHELD, ABSENT])));

        assert_eq!(cache.missing(&[WITHHELD, ABSENT]), Vec::<u32>::new());
        assert_eq!(files.asked.into_inner(), vec![WITHHELD, ABSENT]);
        assert_eq!(cache.answer(&[WITHHELD, ABSENT])["icons"], json!({}));
    }

    // A set names the same appearance twice and neighbouring slots share an icon, so the list
    // arriving from the window is not a set in the mathematical sense. Zero is what an
    // appearance the table gives no icon comes across as, and there is no file behind it.
    #[test]
    fn asks_for_one_texture_however_many_rows_name_it() {
        let cache = IconCache::default();
        assert_eq!(cache.missing(&[PALETTE, PALETTE, 0, DXT1, PALETTE]), vec![PALETTE, DXT1]);
    }

    // The window keys what it draws by the id the row carries, so the answer is keyed the
    // same way rather than positionally — half of a request can be missing.
    #[test]
    fn keys_what_it_answers_with_by_the_id_the_row_named() {
        let cache = IconCache::default();
        cache.store(decode(&fixture_files(), &[PALETTE, WITHHELD]));
        let answer = cache.answer(&[PALETTE, WITHHELD]);
        assert!(answer["icons"][PALETTE.to_string()]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(answer["icons"][WITHHELD.to_string()], Value::Null);
    }
}
