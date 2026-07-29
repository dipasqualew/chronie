//! Taking custody of the images the addon can only leave markers for.
//!
//! The addon cannot see the filesystem. It presses the client's own `Screenshot()` and
//! writes down what it knew at that moment — including the local time, formatted exactly the
//! way the client names its files. Everything after that happens here: find the file that
//! marker is talking about, put a copy of it into a directory Chronie owns — at whatever
//! [`Quality`] the player asked for — and prove the copy is byte for byte what was written.
//!
//! **The file and the marker do not arrive together.** The image lands the instant the key
//! is pressed; the marker sits in SavedVariables until the client writes it at logout or
//! `/reload`, minutes or hours later. So nothing here is triggered by a file appearing.
//! Ingestion is marker-driven: markers arrive, and then their files are looked for. A file
//! with no marker is not an orphan — it is a file whose marker has not been written yet, and
//! it is left exactly where it is.
//!
//! The pairing is pure and the file handling is not, deliberately: which file belongs to
//! which marker is the part with rules worth testing on their own, and it is decided over a
//! plain list of names before anything touches a byte.

use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageFormat, ImageReader, Limits,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use specta::Type;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

/// What the client calls every screenshot it writes, before the timestamp.
const PREFIX: &str = "WoWScrnShot_";

/// `MMDDYY_HHMMSS` — the client's own filename stamp, in local time and to the second.
const STAMP_FORMAT: &str = "%m%d%y_%H%M%S";

/// How the folder Chronie owns is named, beside the database.
pub const STORE_FOLDER: &str = "screenshots";

/// Where the client leaves its screenshots, under the resolved game folder.
pub const GAME_FOLDER: &str = "Screenshots";

/// One entry as the addon wrote it: a moment, everything Chronie knew about it, and whether
/// a picture was asked for. Mirrors `EntryRecord` in `apps/addon/src/EntryLog.lua`; a field
/// the addon deliberately left absent — the point inside an instance that will not give one
/// — stays absent here rather than becoming a zero.
#[derive(Debug, Clone, PartialEq)]
pub struct Marker {
    pub source_id: String,
    pub schema: Option<i64>,
    pub captured_at: i64,
    pub stamp: Option<String>,
    pub character: Option<String>,
    pub author: Option<String>,
    pub segment: Option<String>,
    pub ui_map_id: Option<i64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// Whether the addon fired a screenshot alongside this entry. A statement about what was
    /// asked for, never about what landed on disk — the addon has no way to know the latter.
    pub wants_image: bool,
    /// What the player said about it in the moment, cleaned by the same rules the app's own
    /// field is cleaned by. Absent on the overwhelming majority of entries, which carry no
    /// note at all — and absent rather than empty, so that a note nobody wrote and a note
    /// somebody cleared are one state.
    pub note: Option<String>,
    /// The rule that fired this capture without being asked, absent when a person pressed the
    /// key. Its presence is the whole difference between the two.
    pub trigger: Option<String>,
    /// The achievement this capture is of, as the game numbers it. Resolved to a row of its
    /// own later — see `link_capture_achievements` — because the achievement may not have
    /// been filed yet when the marker arrives.
    pub achievement: Option<i64>,
}

impl Marker {
    fn read(value: &Value) -> Option<Self> {
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .filter(|found| !found.is_empty())
                .map(str::to_owned)
        };
        Some(Self {
            source_id: text("id")?,
            schema: value.get("schema").and_then(Value::as_i64),
            captured_at: value.get("at").and_then(Value::as_i64)?,
            stamp: text("stamp"),
            character: text("character"),
            author: text("author"),
            segment: text("segment"),
            ui_map_id: value.get("uiMapID").and_then(Value::as_i64),
            x: value.get("x").and_then(Value::as_f64),
            y: value.get("y").and_then(Value::as_f64),
            wants_image: value
                .get("hasImage")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            trigger: text("trigger"),
            achievement: value.get("achievement").and_then(Value::as_i64),
            // Cleaned again on the way in even though the addon cleaned it on the way out. It
            // costs nothing, and it is what makes the invariant hold for a row written by an
            // addon build older than the rules — or by anything else that can write that file.
            note: text("note").as_deref().and_then(note_text),
        })
    }
}

/// The entries of one SavedVariables file.
///
/// `db.entries` is a top-level table beside `db.segments` rather than something inside a
/// segment, because segments are pruned to a rolling week and an entry is kept forever. An
/// entry missing an id or a moment is not readable as a record at all and is skipped; every
/// other field is allowed to be absent.
pub fn markers(saved: &Value) -> Vec<Marker> {
    saved
        .get("entries")
        .map(markers_from_entries)
        .unwrap_or_default()
}

/// The typed SavedVariables root hands the entry feed over directly, so the collector does not
/// have to recover it by indexing the root again.
pub fn markers_from_entries(entries: &Value) -> Vec<Marker> {
    entries
        .as_array()
        .map(|entries| entries.iter().filter_map(Marker::read).collect())
        .unwrap_or_default()
}

/// One file in the game's screenshot folder, with the moment its name claims.
#[derive(Debug, Clone, PartialEq)]
pub struct Shot {
    pub stamp: String,
    pub path: PathBuf,
}

/// Everything in the game's screenshot folder that is named like a screenshot.
///
/// A folder that cannot be read is no shots rather than an error: an install that has never
/// had a screenshot taken in it has no such folder, and that is not a failure of the sync.
pub fn folder(directory: &Path) -> Vec<Shot> {
    let Ok(listing) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut shots: Vec<Shot> = listing
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let stamp = stamp_of(&path.file_name()?.to_string_lossy())?;
            Some(Shot { stamp, path })
        })
        .collect();
    // Two files can carry one stamp — the same shot written as both a .jpg and a .tga — so
    // the order they came out of the filesystem in must not decide which one is kept.
    shots.sort_by(|left, right| left.path.cmp(&right.path));
    shots
}

/// The stamp a screenshot filename claims, if it is one.
///
/// Shape-checked rather than merely prefix-checked, so that anything else living in that
/// folder cannot enter the pairing as a stamp nothing will ever match.
fn stamp_of(name: &str) -> Option<String> {
    let rest = name.strip_prefix(PREFIX)?;
    let stamp = rest.split('.').next()?;
    let bytes = stamp.as_bytes();
    if bytes.len() != 13 || bytes[6] != b'_' {
        return None;
    }
    let digits = bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 6 || byte.is_ascii_digit());
    digits.then(|| stamp.to_owned())
}

/// A marker that still wants a file: the fresh ones from this sync, and the ones an earlier
/// sync could not find a file for and is willing to look for again.
#[derive(Debug, Clone, PartialEq)]
pub struct Wanted {
    pub source_id: String,
    pub stamp: String,
}

/// Which file belongs to which marker.
///
/// An exact stamp wins outright, and a marker left without one is widened by a second in
/// either direction. Both directions are real, because the addon writes markers at two
/// different moments relative to the file:
///
/// * It asks for a shot of its own — an achievement, a level up — and stamps the marker
///   before calling the client's asynchronous `Screenshot()`, which names the file when it
///   eventually writes it. The file can land on the **next** second.
/// * The player takes a screenshot themselves and the addon hears `SCREENSHOT_SUCCEEDED`,
///   which arrives once the file has already been named. The marker can be stamped a second
///   **after** the file it belongs to.
///
/// No file is ever handed to two markers, and every exact match is settled before any
/// widened one is considered, so a widened match can never steal the file that another
/// marker names exactly. Forward is tried before backward for no deeper reason than that
/// the passes have to be ordered somehow, and both are settled the same way. Ties are
/// broken on the ids, so the same folder and the same markers always pair the same way.
pub fn pair(wanted: &[Wanted], shots: &[Shot]) -> HashMap<String, PathBuf> {
    let mut by_stamp: BTreeMap<&str, Vec<&Path>> = BTreeMap::new();
    for shot in shots {
        by_stamp
            .entry(shot.stamp.as_str())
            .or_default()
            .push(&shot.path);
    }

    let mut ordered: Vec<&Wanted> = wanted.iter().collect();
    ordered.sort_by(|left, right| {
        (&left.stamp, &left.source_id).cmp(&(&right.stamp, &right.source_id))
    });

    let mut claimed: HashSet<&Path> = HashSet::new();
    let mut paired: HashMap<String, PathBuf> = HashMap::new();
    for pass in [Pass::Exact, Pass::NextSecond, Pass::PreviousSecond] {
        for want in &ordered {
            if paired.contains_key(&want.source_id) {
                continue;
            }
            let stamp = match pass {
                Pass::Exact => want.stamp.clone(),
                Pass::NextSecond => match shifted(&want.stamp, 1) {
                    Some(stamp) => stamp,
                    None => continue,
                },
                Pass::PreviousSecond => match shifted(&want.stamp, -1) {
                    Some(stamp) => stamp,
                    None => continue,
                },
            };
            let Some(candidates) = by_stamp.get(stamp.as_str()) else {
                continue;
            };
            let Some(path) = candidates.iter().find(|path| !claimed.contains(**path)) else {
                continue;
            };
            claimed.insert(path);
            paired.insert(want.source_id.clone(), path.to_path_buf());
        }
    }
    paired
}

#[derive(Clone, Copy)]
enum Pass {
    Exact,
    NextSecond,
    PreviousSecond,
}

/// The stamp `seconds` away, computed on the stamp itself rather than on the epoch beside
/// it. The stamp is local time as the machine that took the shot understood it, and stepping
/// through it directly is the only arithmetic that cannot be wrong about which local time
/// the file was named in.
fn shifted(stamp: &str, seconds: i64) -> Option<String> {
    chrono::NaiveDateTime::parse_from_str(stamp, STAMP_FORMAT)
        .ok()?
        .checked_add_signed(chrono::TimeDelta::seconds(seconds))
        .map(|moment| moment.format(STAMP_FORMAT).to_string())
}

/// An image now in Chronie's own store.
#[derive(Debug, Clone, PartialEq)]
pub struct Stored {
    /// Where it sits under the store root, relative and with forward slashes, so that the
    /// row survives the store being moved or restored onto another machine.
    pub file_path: String,
    pub content_hash: String,
    pub byte_size: i64,
}

/// How much of a screenshot Chronie keeps once it has taken custody of it.
///
/// The game writes a 4K PNG on a lot of installs, which is ten megabytes of a corridor. A
/// player who photographs an evening's worth of achievements every week is handing Chronie a
/// folder that only ever grows, and the pictures are looked at in a grid and in a modal — not
/// printed. So the default is a re-encode rather than the file itself, and `Original` is there
/// for somebody who disagrees, because "keep exactly what the game wrote" is a legitimate
/// thing to want and is what every install did before this setting existed.
///
/// Named rather than numbered: a quality slider is a number nobody can predict the effect of,
/// and each of these says what it does to a screenshot in one sentence.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    /// The file the game wrote, byte for byte. The only setting that keeps a PNG a PNG.
    Original,
    /// Every pixel, re-encoded. A 4K screenshot stays 4K and loses most of its bytes.
    High,
    /// Fits a retina display, which is what these are looked at on.
    #[default]
    Balanced,
    /// Fits a laptop screen. For somebody keeping years of them.
    Small,
}

/// What re-encoding at a given quality does: how long the longest side may be, and how hard
/// the JPEG encoder is allowed to push.
struct Recode {
    edge: u32,
    quality: u8,
}

impl Quality {
    /// The re-encode this level asks for, or `None` for the file exactly as it was found.
    fn recode(self) -> Option<Recode> {
        match self {
            Self::Original => None,
            // No bound worth writing: `shrink` never upscales, so an edge nothing can exceed
            // means "leave the size alone" without a second code path saying so.
            Self::High => Some(Recode {
                edge: u32::MAX,
                quality: 90,
            }),
            Self::Balanced => Some(Recode {
                edge: 2560,
                quality: 80,
            }),
            Self::Small => Some(Recode {
                edge: 1600,
                quality: 70,
            }),
        }
    }
}

/// Copies one image into the store and proves the copy.
///
/// Copy, verify, and only then — much later, and by the caller, once the row naming the file
/// has actually been committed — delete the original. Never a move: a move that dies halfway
/// has destroyed the only copy of something the player deliberately kept, and there is no
/// version of this worth that risk.
///
/// The name in the store is the content hash, which makes the store self-verifying and makes
/// re-ingesting an identical image a no-op rather than a second copy of the same bytes. The
/// hash is of what is *stored*, not of what was read, which is what keeps that true at every
/// quality: the store answers for the bytes it holds.
///
/// Two rules govern the re-encode, and both are about never being worse than doing nothing.
/// A file the encoder cannot read — a TGA the decoder chokes on, something that is not an
/// image at all — is stored exactly as found rather than refused, because the picture matters
/// more than the setting. And a re-encode that came out *larger* than the original is thrown
/// away, which is the ordinary outcome for a small PNG and for a JPEG the client already
/// compressed harder than this would.
pub fn store(source: &Path, root: &Path, quality: Quality) -> Result<Stored, String> {
    let found = fs::read(source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    let (bytes, suffix) = match recoded(&found, source, quality) {
        Some(smaller) => (smaller, ".jpg".to_string()),
        None => (found, extension(source)),
    };
    let content_hash = digest(&bytes);
    // Sharded on the first byte of the hash, because a store nobody prunes ends up holding
    // every screenshot somebody ever took and a single directory of those is a slow one.
    let shard = &content_hash[..2];
    let name = format!("{content_hash}{suffix}");
    let file_path = format!("{shard}/{name}");
    let destination = root.join(shard).join(&name);

    if !holds(&destination, &content_hash) {
        let directory = destination.parent().expect("a sharded destination");
        fs::create_dir_all(directory)
            .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;
        // Written under a name nothing will ever look for and put in place with a rename, so
        // that a half-written file cannot be found at the path a row is about to name.
        let staged = tempfile::NamedTempFile::new_in(directory)
            .map_err(|error| format!("Could not stage into {}: {error}", directory.display()))?;
        fs::write(staged.path(), &bytes)
            .map_err(|error| format!("Could not write {}: {error}", destination.display()))?;
        staged
            .persist(&destination)
            .map_err(|error| format!("Could not place {}: {error}", destination.display()))?;
    }

    // Read back rather than trusted. The point of the hash is that it says something about
    // the bytes on disk, and it only says it if the bytes on disk are what was hashed.
    if !holds(&destination, &content_hash) {
        let _ = fs::remove_file(&destination);
        return Err(format!(
            "The copy of {} did not match what was read.",
            source.display()
        ));
    }

    Ok(Stored {
        file_path,
        content_hash,
        byte_size: i64::try_from(bytes.len()).unwrap_or(0),
    })
}

/// The bytes to store instead of the ones that were found, when there are any.
///
/// `None` covers all three ways there is nothing better to store than the original: the level
/// asked for the file untouched, the encoder could not read it, or what came back was bigger
/// than what went in. The caller stores what it read in every one of those cases, which is why
/// this is the only place the re-encode can go wrong and nothing downstream has to know.
fn recoded(bytes: &[u8], source: &Path, quality: Quality) -> Option<Vec<u8>> {
    let recode = quality.recode()?;
    let smaller = encode(
        bytes,
        ImageFormat::from_path(source).ok(),
        recode.edge,
        recode.quality,
    )
    .ok()?;
    (smaller.len() < bytes.len()).then_some(smaller)
}

/// Whether the store already holds exactly these bytes at this path.
fn holds(path: &Path, content_hash: &str) -> bool {
    fs::read(path).is_ok_and(|bytes| digest(&bytes) == content_hash)
}

/// Takes one image, and everything Chronie generated from it, out of the store.
///
/// The caller has to have established that no other row names this path — the store is
/// content-addressed, so two captures of the same bytes are one file, and removing it for one
/// of them would blank the other. That check needs the database and this module does not have
/// one, which is why it is the caller's and why this is not public beyond the crate.
///
/// A file that is not there is not a failure. The whole point of deleting is that the file is
/// gone afterwards, and it already is.
pub fn discard(root: &Path, file_path: &str, content_hash: Option<&str>) -> Result<(), String> {
    let image = root.join(file_path);
    if let Err(error) = fs::remove_file(&image) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("Could not delete {}: {error}", image.display()));
        }
    }
    // The thumbnails are derived from the image and mean nothing without it, so they go with
    // it — and quietly, because a thumbnail nobody could delete is a stale cache entry keyed
    // by a hash no row names any more, which nothing will ever read.
    if let Some(hash) = content_hash {
        let _ = fs::remove_file(
            root.join(THUMBNAIL_FOLDER)
                .join(thumbnail_path(hash, THUMBNAIL_EDGE)),
        );
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// The original's extension, lowercased and stripped of anything that is not a letter or a
/// digit, because it is about to become part of a filename Chronie writes.
fn extension(source: &Path) -> String {
    let Some(found) = source.extension() else {
        return String::new();
    };
    let cleaned: String = found
        .to_string_lossy()
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect();
    if cleaned.is_empty() {
        String::new()
    } else {
        format!(".{cleaned}")
    }
}

/* ---------- what somebody said about a capture ---------- */

/// As many bytes as a note may occupy, matching `ns.ENTRY_TEXT_MAX_BYTES` in the addon.
pub const NOTE_MAX_BYTES: usize = 512;

/// One piece of typed text, made safe to write down — the twin of `ns.entryText`.
///
/// A note reaches this from two directions: out of SavedVariables, where the addon has
/// already applied these rules, and out of the app's own field, where nothing has. Both go
/// through here, so that "a stored note holds no control character and no pipe" is one
/// invariant with one implementation on each side of the boundary rather than a convention.
/// The addon's own copy carries the reasoning in full; the short version is that a pipe opens
/// every escape the client has, a newline ends the string as far as anything reading a line
/// at a time is concerned, and there is no natural bound on what somebody will paste.
///
/// `None` for a note that is nothing but whitespace and escapes, because "they submitted
/// nothing" and "they submitted spaces and a colour code" are the same thing, and the column
/// has one way of saying it.
pub fn note_text(raw: &str) -> Option<String> {
    let stripped = without_escapes(raw);
    // Control characters become spaces and then collapse with everything around them, which
    // is one pass here rather than the addon's three: a note is one line by the time it is
    // stored, whatever shape it was pasted in.
    let flattened: String = stripped
        .chars()
        .map(|found| if found.is_control() { ' ' } else { found })
        .collect();
    let mut text = flattened.split_whitespace().collect::<Vec<_>>().join(" ");

    if text.len() > NOTE_MAX_BYTES {
        // Cut on a character boundary rather than on a byte count: half of a multi-byte
        // character is invalid UTF-8, and that spoils the row for every reader of it.
        let cut = (0..=NOTE_MAX_BYTES)
            .rev()
            .find(|at| text.is_char_boundary(*at))
            .unwrap_or(0);
        text.truncate(cut);
        text = text.trim_end().to_owned();
    }

    (!text.is_empty()).then_some(text)
}

/// The same text with every one of the client's escape sequences taken out of it.
///
/// A hyperlink keeps the part a person can read — `[Thunderfury]` out of the whole mechanism
/// — because that is what somebody pasting an item into a note meant by it. Everything else
/// goes, including a pipe somebody typed themselves, and including the opening half of a
/// sequence whose closing half never arrived.
fn without_escapes(raw: &str) -> String {
    let mut kept = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(pipe) = rest.find('|') {
        kept.push_str(&rest[..pipe]);
        rest = &rest[pipe..];
        let after = &rest[1..];
        // Every sequence below is ASCII, so slicing on these byte offsets can only land on a
        // character boundary.
        rest = match after.as_bytes().first() {
            // `|Hitem:19019|h[Thunderfury]|h` — the link, then the words, then the end of it.
            Some(b'H') => match after[1..].find("|h").and_then(|opens| {
                let words = &after[1 + opens + 2..];
                words.find("|h").map(|closes| (words, closes))
            }) {
                Some((words, closes)) => {
                    kept.push_str(&words[..closes]);
                    &words[closes + 2..]
                }
                None => after,
            },
            // `|cffff0000`, a colour, and only when the eight digits it needs are there.
            Some(b'c') if is_hex(&after[1..], 8) => &after[9..],
            Some(b'T') => skip_to(after, "|t"),
            Some(b'A') => skip_to(after, "|a"),
            // `|r`, `|n`, and a pipe somebody typed: the pipe goes, what follows it stays.
            _ => after,
        };
    }
    kept.push_str(rest);
    kept
}

/// Everything up to and including the closing half of a sequence, or the opening half alone
/// when it never closes — in which case only its pipe has been dropped and the rest is text.
fn skip_to<'a>(after: &'a str, closer: &str) -> &'a str {
    match after.find(closer) {
        Some(at) => &after[at + closer.len()..],
        None => after,
    }
}

fn is_hex(text: &str, digits: usize) -> bool {
    text.len() >= digits && text.as_bytes()[..digits].iter().all(u8::is_ascii_hexdigit)
}

/* ---------- the pictures small enough to draw a grid of ---------- */

/// Where the thumbnails sit inside the store, beside the images they were made from.
pub const THUMBNAIL_FOLDER: &str = "thumbnails";

/// The longest side of a thumbnail, in pixels.
///
/// One size rather than a set of them: the grid draws them at a couple of hundred CSS pixels
/// and the modal shows the original, so a second size would be a second cache to invalidate
/// for no picture anybody sees. Generous enough to stay sharp on a display that draws two
/// device pixels per CSS pixel.
pub const THUMBNAIL_EDGE: u32 = 480;

/// How hard the thumbnails are compressed. A screenshot at 480 pixels is being looked at as a
/// tile in a grid, and the difference between this and lossless is a factor of thirty in what
/// crosses the bridge to the window.
const THUMBNAIL_QUALITY: u8 = 78;

/// What a thumbnail of these bytes is called, under [`THUMBNAIL_FOLDER`].
///
/// Keyed by the content hash, and sharded the same way the store itself is, so a thumbnail is
/// dedup'd exactly as far as the image behind it is: two captures of the same bytes are one
/// file here too.
fn thumbnail_path(content_hash: &str, edge: u32) -> String {
    format!("{}/{content_hash}-{edge}.jpg", &content_hash[..2])
}

/// A small JPEG of one stored image, generated the first time it is asked for and kept.
///
/// Generated rather than served whole, because a grid of full-size screenshots is tens of
/// megabytes of decoded pixels in a webview, and it would be paid again on every repaint.
/// Cached on disk rather than in memory for the same reason the store is on disk: somebody
/// scrolling a year of history would otherwise carry all of it.
pub fn thumbnail(root: &Path, file_path: &str, content_hash: &str) -> Result<Vec<u8>, String> {
    if content_hash.len() < 2 {
        return Err("A stored image with no content hash cannot be thumbnailed.".into());
    }
    let cached = root
        .join(THUMBNAIL_FOLDER)
        .join(thumbnail_path(content_hash, THUMBNAIL_EDGE));
    if let Ok(bytes) = fs::read(&cached) {
        return Ok(bytes);
    }

    let image = root.join(file_path);
    let bytes =
        fs::read(&image).map_err(|error| format!("Could not read {}: {error}", image.display()))?;
    let small = shrink(&bytes, format_of(file_path), THUMBNAIL_EDGE)?;

    // A thumbnail that could not be written is not worth failing over: it is a cache, and the
    // picture in hand is what was asked for. So the write is attempted and its outcome
    // ignored, the same way the rest of the store treats a directory it cannot create.
    if let Some(directory) = cached.parent() {
        if fs::create_dir_all(directory).is_ok() {
            if let Ok(staged) = tempfile::NamedTempFile::new_in(directory) {
                if fs::write(staged.path(), &small).is_ok() {
                    let _ = staged.persist(&cached);
                }
            }
        }
    }
    Ok(small)
}

/// One image, decoded and re-encoded as a JPEG no larger than `edge` on its longest side.
///
/// The format is a hint rather than a decision: `screenshotFormat` is a CVar the player sets,
/// so the same install can hold JPEGs and PNGs side by side, and a TGA — which the client will
/// still write and which carries no magic number to recognise it by — is why the hint exists
/// at all. What is in the bytes wins where the bytes say; the name decides only where they do
/// not.
///
/// Never upscaled. A capture smaller than a thumbnail is re-encoded at its own size, because
/// the point of this is the number of bytes crossing the bridge and not a uniform grid.
pub fn shrink(bytes: &[u8], hint: Option<ImageFormat>, edge: u32) -> Result<Vec<u8>, String> {
    encode(bytes, hint, edge, THUMBNAIL_QUALITY)
}

/// The same, at a stated encoder quality — which is what makes one function serve both the
/// thumbnails, where the size is the whole point, and the store, where it is a setting.
fn encode(
    bytes: &[u8],
    hint: Option<ImageFormat>,
    edge: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let guessed = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|found| found.format());
    let format = guessed
        .or(hint)
        .ok_or_else(|| "Chronie does not recognise this image's format.".to_string())?;
    let mut reader = ImageReader::new(Cursor::new(bytes));
    reader.set_format(format);
    // A screenshot is a few megapixels. Anything claiming to be hundreds is a header that has
    // been damaged or written to be believed, and decoding it would ask for the memory the
    // header asked for before finding out.
    reader.limits(decode_limits());
    let decoded = reader
        .decode()
        .map_err(|error| format!("Chronie could not read this image: {error}"))?;

    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Err("This image has no pixels.".into());
    }
    let scaled = if width > edge || height > edge {
        decoded.resize(edge, edge, FilterType::Triangle)
    } else {
        decoded
    };

    // JPEG carries no alpha channel, so the pixels are flattened to RGB first rather than
    // handed to an encoder that would refuse them. A screenshot has no transparency to lose.
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut Cursor::new(&mut jpeg), quality)
        .encode_image(&DynamicImage::ImageRgb8(scaled.to_rgb8()))
        .map_err(|error| format!("Chronie could not shrink this image: {error}"))?;
    Ok(jpeg)
}

/// What a stored image's own name claims it is.
pub fn format_of(file_path: &str) -> Option<ImageFormat> {
    ImageFormat::from_path(file_path).ok()
}

/// What the window is told an image is, for the `data:` URL it has to be handed as.
///
/// Read off the stored name rather than assumed, which is what makes it right at every
/// [`Quality`]: a file kept as the game wrote it is still a PNG and says so, and one Chronie
/// re-encoded was named `.jpg` at the moment it was written.
pub fn mime_of(file_path: &str) -> &'static str {
    match format_of(file_path) {
        Some(ImageFormat::Png) => "image/png",
        Some(ImageFormat::Tga) => "image/x-tga",
        Some(ImageFormat::WebP) => "image/webp",
        // Including the case where the name says nothing. The client writes JPEG unless it has
        // been told otherwise, and a browser sniffs the bytes anyway.
        _ => "image/jpeg",
    }
}

/// What a decoder is allowed to allocate before it is told to stop.
fn decode_limits() -> Limits {
    let mut limits = Limits::no_limits();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(512 * 1024 * 1024);
    limits
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shot(name: &str) -> Shot {
        Shot {
            stamp: stamp_of(name).expect("a screenshot name"),
            path: PathBuf::from(name),
        }
    }

    fn wanted(source_id: &str, stamp: &str) -> Wanted {
        Wanted {
            source_id: source_id.into(),
            stamp: stamp.into(),
        }
    }

    #[test]
    fn reads_an_entry_the_addon_wrote() {
        let markers = markers(&json!({
            "entries": [{
                "id": "account|1700000000|1",
                "schema": 1,
                "at": 1_700_000_000,
                "stamp": "111423_120000",
                "character": "Alice-Ravencrest",
                "author": "account",
                "segment": "Alice-Ravencrest|1699999000|Karazhan",
                "uiMapID": 350,
                "x": 0.25,
                "y": 0.5,
                "hasImage": true,
            }],
        }));
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].source_id, "account|1700000000|1");
        assert_eq!(markers[0].stamp.as_deref(), Some("111423_120000"));
        assert_eq!(markers[0].ui_map_id, Some(350));
        assert_eq!(markers[0].x, Some(0.25));
        assert!(markers[0].wants_image);
    }

    #[test]
    fn keeps_an_absent_point_absent_rather_than_zero() {
        let markers = markers(&json!({
            "entries": [{
                "id": "account|1|1",
                "at": 1,
                "stamp": "111423_120000",
                "uiMapID": 2649,
                "hasImage": true,
            }],
        }));
        assert_eq!(markers[0].ui_map_id, Some(2649));
        assert_eq!(markers[0].x, None);
        assert_eq!(markers[0].y, None);
    }

    #[test]
    fn reads_what_an_automatic_capture_says_it_is_of() {
        let markers = markers(&json!({
            "entries": [{
                "id": "account|1|1",
                "at": 1,
                "stamp": "111423_120000",
                "hasImage": true,
                "trigger": "accountFirstAchievement",
                "achievement": 4001,
            }],
        }));
        assert_eq!(
            markers[0].trigger.as_deref(),
            Some("accountFirstAchievement")
        );
        assert_eq!(markers[0].achievement, Some(4001));
    }

    /// The absence of a trigger is what says a person pressed the key, so it has to stay an
    /// absence rather than becoming an empty string.
    #[test]
    fn reads_a_pressed_capture_as_being_of_nothing() {
        let markers = markers(&json!({
            "entries": [{
                "id": "account|1|1", "at": 1, "stamp": "111423_120000", "hasImage": true,
            }],
        }));
        assert_eq!(markers[0].trigger, None);
        assert_eq!(markers[0].achievement, None);
    }

    /// A trigger with no subject: level ups, mounts and the rest hang off the segment and the
    /// rule that fired them, because there is no row downstream to point a link at.
    #[test]
    fn reads_a_trigger_that_names_no_achievement() {
        let markers = markers(&json!({
            "entries": [{
                "id": "account|1|1", "at": 1, "stamp": "111423_120000",
                "hasImage": true, "trigger": "levelUp",
            }],
        }));
        assert_eq!(markers[0].trigger.as_deref(), Some("levelUp"));
        assert_eq!(markers[0].achievement, None);
    }

    #[test]
    fn reads_a_note_that_asked_for_no_picture() {
        let markers = markers(&json!({
            "entries": [{ "id": "account|1|1", "at": 1, "stamp": "111423_120000" }],
        }));
        assert!(!markers[0].wants_image);
    }

    #[test]
    fn skips_an_entry_with_nothing_to_identify_it_by() {
        let markers = markers(&json!({
            "entries": [
                { "at": 1, "stamp": "111423_120000" },
                { "id": "account|1|1" },
                { "id": "account|1|2", "at": 2 },
            ],
        }));
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].source_id, "account|1|2");
    }

    #[test]
    fn reads_no_entries_out_of_a_file_that_has_none() {
        assert!(markers(&json!({ "segments": [] })).is_empty());
        assert!(markers(&json!({ "entries": [] })).is_empty());
    }

    #[test]
    fn pairs_a_marker_with_the_file_named_for_its_second() {
        let shots = [
            shot("WoWScrnShot_111423_115959.jpg"),
            shot("WoWScrnShot_111423_120000.jpg"),
            shot("WoWScrnShot_111423_120005.jpg"),
        ];
        let paired = pair(&[wanted("a", "111423_120000")], &shots);
        assert_eq!(
            paired.get("a"),
            Some(&PathBuf::from("WoWScrnShot_111423_120000.jpg"))
        );
    }

    /// A capture Chronie asked for: the marker is stamped when the addon reaches for the
    /// shutter, and the asynchronous `Screenshot()` names the file whenever it gets round to
    /// writing it — which can be the far side of a second boundary.
    #[test]
    fn takes_the_next_second_when_the_client_named_the_file_late() {
        let shots = [shot("WoWScrnShot_111423_120001.jpg")];
        let paired = pair(&[wanted("a", "111423_120000")], &shots);
        assert_eq!(
            paired.get("a"),
            Some(&PathBuf::from("WoWScrnShot_111423_120001.jpg"))
        );
    }

    /// And a capture the player asked for, which is the other direction and just as real:
    /// the client names the file, then fires SCREENSHOT_SUCCEEDED, and only then does the
    /// addon read the clock and write the marker. The file is the older of the two.
    #[test]
    fn takes_the_previous_second_when_the_marker_was_written_after_the_file() {
        let shots = [shot("WoWScrnShot_111423_115959.jpg")];
        let paired = pair(&[wanted("a", "111423_120000")], &shots);
        assert_eq!(
            paired.get("a"),
            Some(&PathBuf::from("WoWScrnShot_111423_115959.jpg"))
        );
    }

    /// Two seconds either way is not a coincidence worth trusting: at that distance the file
    /// is somebody else's screenshot far more often than it is this marker's.
    #[test]
    fn reaches_no_further_than_a_second_in_either_direction() {
        for name in [
            "WoWScrnShot_111423_115958.jpg",
            "WoWScrnShot_111423_120002.jpg",
        ] {
            let shots = [shot(name)];
            assert!(
                pair(&[wanted("a", "111423_120000")], &shots).is_empty(),
                "{name} was paired with a marker two seconds away"
            );
        }
    }

    #[test]
    fn steps_a_second_across_a_minute_and_an_hour_in_both_directions() {
        assert_eq!(
            shifted("111423_115959", 1).as_deref(),
            Some("111423_120000")
        );
        assert_eq!(
            shifted("111423_235959", 1).as_deref(),
            Some("111523_000000")
        );
        assert_eq!(
            shifted("111423_120000", -1).as_deref(),
            Some("111423_115959")
        );
        assert_eq!(
            shifted("111523_000000", -1).as_deref(),
            Some("111423_235959")
        );
        assert_eq!(shifted("nonsense", 1), None);
        assert_eq!(shifted("nonsense", -1), None);
    }

    #[test]
    fn leaves_the_late_marker_the_file_the_early_one_did_not_take() {
        // The cooldown allows two captures a second apart, and the second one names its file
        // exactly. The first must not widen onto it and leave the second with nothing.
        let shots = [
            shot("WoWScrnShot_111423_120000.jpg"),
            shot("WoWScrnShot_111423_120001.jpg"),
        ];
        let paired = pair(
            &[wanted("a", "111423_120000"), wanted("b", "111423_120001")],
            &shots,
        );
        assert_eq!(
            paired.get("a"),
            Some(&PathBuf::from("WoWScrnShot_111423_120000.jpg"))
        );
        assert_eq!(
            paired.get("b"),
            Some(&PathBuf::from("WoWScrnShot_111423_120001.jpg"))
        );
    }

    /// The same rule the other way round. The marker that names this file exactly is the one
    /// that gets it, and the marker a second later — which would reach back onto it — is
    /// left with nothing rather than taking a picture that is demonstrably not its own.
    #[test]
    fn leaves_the_early_marker_the_file_the_late_one_would_have_reached_back_for() {
        let shots = [shot("WoWScrnShot_111423_120000.jpg")];
        let paired = pair(
            &[wanted("a", "111423_120001"), wanted("b", "111423_120000")],
            &shots,
        );
        assert_eq!(
            paired.get("b"),
            Some(&PathBuf::from("WoWScrnShot_111423_120000.jpg"))
        );
        assert_eq!(paired.get("a"), None);
    }

    /// Two markers reaching for the same file from opposite sides. Whichever of them takes
    /// it, the other must be left unpaired: one file, one marker, always.
    #[test]
    fn hands_a_widened_file_to_only_one_of_the_two_markers_reaching_for_it() {
        let shots = [shot("WoWScrnShot_111423_120000.jpg")];
        let paired = pair(
            &[wanted("a", "111423_115959"), wanted("b", "111423_120001")],
            &shots,
        );
        assert_eq!(paired.len(), 1);
        assert_eq!(
            paired.values().next(),
            Some(&PathBuf::from("WoWScrnShot_111423_120000.jpg"))
        );
    }

    #[test]
    fn hands_one_file_to_only_one_marker() {
        let shots = [shot("WoWScrnShot_111423_120000.jpg")];
        let paired = pair(
            &[wanted("a", "111423_120000"), wanted("b", "111423_120000")],
            &shots,
        );
        assert_eq!(paired.len(), 1);
        assert_eq!(
            paired.get("a"),
            Some(&PathBuf::from("WoWScrnShot_111423_120000.jpg"))
        );
    }

    #[test]
    fn gives_two_files_of_one_second_to_the_two_markers_that_want_them() {
        let shots = [
            shot("WoWScrnShot_111423_120000.jpg"),
            shot("WoWScrnShot_111423_120000.tga"),
        ];
        let paired = pair(
            &[wanted("a", "111423_120000"), wanted("b", "111423_120000")],
            &shots,
        );
        assert_eq!(paired.len(), 2);
        assert_ne!(paired["a"], paired["b"]);
    }

    #[test]
    fn leaves_a_marker_whose_file_is_not_there_unpaired() {
        let shots = [shot("WoWScrnShot_111423_130000.jpg")];
        assert!(pair(&[wanted("a", "111423_120000")], &shots).is_empty());
    }

    #[test]
    fn ignores_everything_in_the_folder_that_is_not_a_screenshot() {
        assert_eq!(
            stamp_of("WoWScrnShot_111423_120000.jpg").as_deref(),
            Some("111423_120000")
        );
        assert_eq!(
            stamp_of("WoWScrnShot_111423_120000.tga").as_deref(),
            Some("111423_120000")
        );
        assert_eq!(stamp_of("holiday.jpg"), None);
        assert_eq!(stamp_of("WoWScrnShot_notatime.jpg"), None);
        assert_eq!(stamp_of("WoWScrnShot_111423_12000.jpg"), None);
        assert_eq!(stamp_of("WoWScrnShot_111423-120000.jpg"), None);
        assert_eq!(stamp_of("WoWScrnShot_111423_1200aa.jpg"), None);
    }

    #[test]
    fn reads_a_folder_of_shots_and_leaves_the_rest_of_it_alone() {
        let temp = tempfile::tempdir().unwrap();
        for name in [
            "WoWScrnShot_111423_120000.jpg",
            "WoWScrnShot_111423_120001.tga",
            "notes.txt",
        ] {
            fs::write(temp.path().join(name), b"bytes").unwrap();
        }
        fs::create_dir(temp.path().join("WoWScrnShot_111423_130000.jpg")).unwrap();

        let mut stamps: Vec<String> = folder(temp.path())
            .into_iter()
            .map(|shot| shot.stamp)
            .collect();
        stamps.sort();
        assert_eq!(stamps, ["111423_120000", "111423_120001"]);
    }

    #[test]
    fn reads_a_folder_that_is_not_there_as_no_shots() {
        assert!(folder(Path::new("/no/such/screenshots")).is_empty());
    }

    #[test]
    fn copies_an_image_into_the_store_without_touching_the_original() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("WoWScrnShot_111423_120000.jpg");
        fs::write(&source, b"a picture").unwrap();
        let root = temp.path().join("store");

        let stored = store(&source, &root, Quality::Original).unwrap();

        assert_eq!(stored.byte_size, 9);
        assert_eq!(stored.content_hash, digest(b"a picture"));
        assert!(stored.file_path.ends_with(".jpg"));
        assert_eq!(
            fs::read(root.join(&stored.file_path)).unwrap(),
            b"a picture"
        );
        assert!(source.is_file(), "the original is the caller's to remove");
    }

    #[test]
    fn stores_the_same_image_twice_as_one_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        let first = temp.path().join("WoWScrnShot_111423_120000.jpg");
        let second = temp.path().join("WoWScrnShot_111423_120001.jpg");
        fs::write(&first, b"a picture").unwrap();
        fs::write(&second, b"a picture").unwrap();

        let one = store(&first, &root, Quality::Original).unwrap();
        let two = store(&second, &root, Quality::Original).unwrap();

        assert_eq!(one, two);
    }

    #[test]
    fn replaces_a_stored_file_that_is_not_what_its_name_claims() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        let source = temp.path().join("WoWScrnShot_111423_120000.jpg");
        fs::write(&source, b"a picture").unwrap();
        let stored = store(&source, &root, Quality::Original).unwrap();

        fs::write(root.join(&stored.file_path), b"something else").unwrap();
        let again = store(&source, &root, Quality::Original).unwrap();

        assert_eq!(again, stored);
        assert_eq!(
            fs::read(root.join(&stored.file_path)).unwrap(),
            b"a picture"
        );
    }

    #[test]
    fn refuses_an_image_that_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = store(
            &temp.path().join("gone.jpg"),
            &temp.path().join("store"),
            Quality::Original,
        )
        .unwrap_err();
        assert!(error.contains("gone.jpg"), "{error}");
    }

    #[test]
    fn keeps_a_name_out_of_an_extension_that_is_not_one() {
        assert_eq!(extension(Path::new("shot.JPG")), ".jpg");
        assert_eq!(extension(Path::new("shot.tar.gz")), ".gz");
        assert_eq!(extension(Path::new("shot.j p g")), ".jpg");
        assert_eq!(extension(Path::new("shot.../")), "");
        assert_eq!(extension(Path::new("shot")), "");
    }

    /* ---------- what somebody said about it ---------- */

    #[test]
    fn reads_the_note_an_entry_carries() {
        let markers = markers(&json!({
            "entries": [{ "id": "a|1|1", "at": 1, "note": "  first Yogg kill  " }],
        }));
        assert_eq!(markers[0].note.as_deref(), Some("first Yogg kill"));
    }

    /// A memory read the whole way in, out of the Lua the client actually writes.
    ///
    /// Every other test here starts from a `json!` literal, which is the shape after the reader
    /// has already done its work. A note is the one string in that file a person typed, and the
    /// three things a person types that the file has to carry — a quote, a line break and
    /// something that is not ASCII — are all things the client escapes or encodes on the way
    /// out. So this one starts from the text: the reader, then `markers`, then the note rules on
    /// top of both, with nothing standing in for any of them.
    ///
    /// Written the way the client writes it, tabs and trailing `-- [1]` comment included, with
    /// `"` escaped as `\"`, a line break as `\n`, and the non-ASCII as the raw UTF-8 bytes an
    /// enUS install's own files carry. A note can never leave the addon holding a line break —
    /// `ns.entryText` flattens it first — but this reader is also what reads a file written by
    /// an addon build older than that rule, so the escape has to be handled rather than assumed
    /// away.
    #[test]
    fn reads_a_memory_out_of_the_lua_the_client_writes() {
        let text = "ChronieDB = {\n\
             \t[\"entries\"] = {\n\
             \t\t{\n\
             \t\t\t[\"id\"] = \"account|1700000000|4\",\n\
             \t\t\t[\"schema\"] = 1,\n\
             \t\t\t[\"at\"] = 1700000000,\n\
             \t\t\t[\"stamp\"] = \"111423_120000\",\n\
             \t\t\t[\"character\"] = \"Sateline-ArgentDawn\",\n\
             \t\t\t[\"author\"] = \"account\",\n\
             \t\t\t[\"segment\"] = \"Sateline-ArgentDawn|1699999000|Molten Core\",\n\
             \t\t\t[\"uiMapID\"] = 232,\n\
             \t\t\t[\"note\"] = \"Ragnaros a dit \\\"非\\\" — et puis\\nune ligne de plus\",\n\
             \t\t}, -- [1]\n\
             \t},\n\
             }\n";

        let saved = crate::collector::read_saved_variable(text, "ChronieDB")
            .expect("the client's own Lua parses")
            .expect("ChronieDB is the variable it wrote");
        let markers = markers(&saved);

        assert_eq!(markers.len(), 1);
        let marker = &markers[0];
        // Byte for byte what somebody typed: the quotes are quotes again rather than the
        // backslashes the file carried them as, and the 非 and the em dash are themselves.
        assert_eq!(
            marker.note.as_deref(),
            Some("Ragnaros a dit \"非\" — et puis une ligne de plus"),
        );
        // And still valid UTF-8, which is the whole point of caring: one bad byte here spoils
        // the file for every reader of it rather than merely spoiling this note.
        assert!(std::str::from_utf8(marker.note.as_deref().unwrap().as_bytes()).is_ok());
        assert_eq!(marker.source_id, "account|1700000000|4");
        assert_eq!(marker.captured_at, 1_700_000_000);
        assert_eq!(marker.stamp.as_deref(), Some("111423_120000"));
        assert_eq!(marker.character.as_deref(), Some("Sateline-ArgentDawn"));
        assert_eq!(marker.author.as_deref(), Some("account"));
        assert_eq!(
            marker.segment.as_deref(),
            Some("Sateline-ArgentDawn|1699999000|Molten Core"),
        );
        // A memory asked for no picture, which is the whole difference between it and a
        // photograph whose file has gone astray.
        assert!(!marker.wants_image);
        // The map was named and the point was not — most of instanced content — so the point
        // stays absent rather than arriving as a fabricated 0, 0.
        assert_eq!(marker.ui_map_id, Some(232));
        assert_eq!(marker.x, None);
        assert_eq!(marker.y, None);
    }

    /// The same note again with every non-ASCII byte written as a decimal escape.
    ///
    /// Which of the two forms the client uses is not something an enUS install can be held up
    /// against — its own files carry no byte over 127 at all — so both are read here and both
    /// have to arrive at the same string. `\233\157\158` is 非 and `\195\169` is é.
    #[test]
    fn reads_a_memory_whose_non_ascii_arrived_as_decimal_escapes() {
        let text = "ChronieDB = {\n\
             \t[\"entries\"] = {\n\
             \t\t{\n\
             \t\t\t[\"id\"] = \"account|1700000000|5\",\n\
             \t\t\t[\"at\"] = 1700000000,\n\
             \t\t\t[\"note\"] = \"Ragnaros a dit \\\"\\233\\157\\158\\\" une fois d\\195\\169j\\195\\160\",\n\
             \t\t}, -- [1]\n\
             \t},\n\
             }\n";

        let saved = crate::collector::read_saved_variable(text, "ChronieDB")
            .unwrap()
            .unwrap();
        let markers = markers(&saved);

        assert_eq!(
            markers[0].note.as_deref(),
            Some("Ragnaros a dit \"非\" une fois déjà"),
        );
        assert!(!markers[0].wants_image);
    }

    /// A memory taken where the client would not name a map at all — a loading screen, or the
    /// handful of places it simply declines. The three position fields are absent from the Lua
    /// table and have to stay absent here.
    #[test]
    fn reads_a_memory_the_client_could_not_place() {
        let text = "ChronieDB = {\n\
             \t[\"entries\"] = {\n\
             \t\t{\n\
             \t\t\t[\"id\"] = \"account|1700000001|6\",\n\
             \t\t\t[\"schema\"] = 1,\n\
             \t\t\t[\"at\"] = 1700000001,\n\
             \t\t\t[\"stamp\"] = \"111423_120001\",\n\
             \t\t\t[\"character\"] = \"Sateline-ArgentDawn\",\n\
             \t\t\t[\"author\"] = \"account\",\n\
             \t\t\t[\"note\"] = \"nowhere in particular\",\n\
             \t\t}, -- [1]\n\
             \t},\n\
             }\n";

        let saved = crate::collector::read_saved_variable(text, "ChronieDB")
            .unwrap()
            .unwrap();
        let markers = markers(&saved);

        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].note.as_deref(), Some("nowhere in particular"));
        assert_eq!(markers[0].ui_map_id, None);
        assert_eq!(markers[0].x, None);
        assert_eq!(markers[0].y, None);
        assert_eq!(markers[0].segment, None);
        assert!(!markers[0].wants_image);
    }

    #[test]
    fn reads_no_note_off_an_entry_that_carries_none() {
        let markers = markers(&json!({
            "entries": [
                { "id": "a|1|1", "at": 1 },
                { "id": "a|1|2", "at": 2, "note": "" },
                { "id": "a|1|3", "at": 3, "note": "   " },
            ],
        }));
        assert!(markers.iter().all(|marker| marker.note.is_none()));
    }

    // The same rules as `ns.entryText`, which is the point of this function existing: a note
    // typed in the app and a note typed in game have to arrive in the row in the same shape.
    #[test]
    fn keeps_the_words_of_a_link_and_none_of_its_mechanism() {
        assert_eq!(
            note_text("got |cffa335ee|Hitem:19019|h[Thunderfury]|h|r").as_deref(),
            // The `r` of `|r` survives, exactly as it does in the addon: what is stripped is
            // the pipe, and what follows it is text.
            Some("got [Thunderfury]r"),
        );
        assert_eq!(
            note_text("|TInterface\\Icons\\x:16|t look").as_deref(),
            Some("look")
        );
        assert_eq!(
            note_text("|Aatlas:thing:1:1|a here").as_deref(),
            Some("here")
        );
        assert_eq!(note_text("a || b").as_deref(), Some("a b"));
    }

    // An escape somebody typed half of is text, not a licence to eat the rest of the note.
    #[test]
    fn keeps_the_rest_of_a_note_whose_escape_never_closes() {
        assert_eq!(
            note_text("|Hitem:19019|h[Thunderfury] and more").as_deref(),
            Some("Hitem:19019h[Thunderfury] and more")
        );
        assert_eq!(
            note_text("|Tno end of it").as_deref(),
            Some("Tno end of it")
        );
        assert_eq!(
            note_text("|cffzzzz nonsense").as_deref(),
            Some("cffzzzz nonsense")
        );
    }

    #[test]
    fn folds_a_pasted_note_onto_one_line() {
        assert_eq!(
            note_text("two\nlines\tapart").as_deref(),
            Some("two lines apart")
        );
        assert_eq!(note_text("  padded  out  ").as_deref(), Some("padded out"));
    }

    #[test]
    fn reads_a_note_of_nothing_at_all_as_no_note() {
        assert_eq!(note_text(""), None);
        assert_eq!(note_text("   \n  "), None);
        assert_eq!(note_text("|cffff0000|r"), Some("r".to_string()));
        assert_eq!(note_text("|"), None);
    }

    // Cut on a character boundary, because half of a multi-byte character is invalid UTF-8 and
    // that spoils the row for every reader of it rather than merely truncating this note.
    #[test]
    fn caps_a_note_without_cutting_a_character_in_half() {
        let long = "é".repeat(NOTE_MAX_BYTES);
        let capped = note_text(&long).unwrap();
        assert!(capped.len() <= NOTE_MAX_BYTES, "{} bytes", capped.len());
        assert_eq!(capped.chars().count(), NOTE_MAX_BYTES / 2);
        assert!(std::str::from_utf8(capped.as_bytes()).is_ok());
    }

    /* ---------- the pictures small enough to draw a grid of ---------- */

    /// A picture of a known size, in whichever format the player's client was set to write.
    fn painted(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let mut image = image::RgbImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let mut bytes = Vec::new();
        DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut bytes), format)
            .unwrap();
        bytes
    }

    fn sized(jpeg: &[u8]) -> (u32, u32) {
        let decoded = image::load_from_memory_with_format(jpeg, ImageFormat::Jpeg).unwrap();
        (decoded.width(), decoded.height())
    }

    // `screenshotFormat` is the player's own setting, so the same install can hold JPEGs and
    // PNGs side by side. A thumbnailer that handled one of them would leave a grid half empty.
    #[test]
    fn shrinks_a_screenshot_in_whichever_format_the_client_wrote_it() {
        for format in [ImageFormat::Jpeg, ImageFormat::Png] {
            let small = shrink(&painted(1200, 600, format), None, 240).unwrap();
            assert_eq!(sized(&small), (240, 120), "{format:?}");
            assert!(small.len() < 40_000, "{format:?}: {} bytes", small.len());
        }
    }

    // TGA carries no magic number to recognise it by, which is the whole reason the caller
    // gets to say what a file's own name claims it is.
    #[test]
    fn shrinks_a_format_that_can_only_be_known_from_its_name() {
        let small = shrink(
            &painted(800, 400, ImageFormat::Tga),
            format_of("ab/abcd.tga"),
            200,
        )
        .unwrap();
        assert_eq!(sized(&small), (200, 100));
    }

    // The point of a thumbnail is the number of bytes crossing the bridge, not a uniform grid.
    #[test]
    fn leaves_a_capture_smaller_than_a_thumbnail_at_its_own_size() {
        let small = shrink(&painted(64, 32, ImageFormat::Png), None, 480).unwrap();
        assert_eq!(sized(&small), (64, 32));
    }

    #[test]
    fn says_so_when_it_is_handed_something_that_is_not_a_picture() {
        let error = shrink(b"a note, not an image", None, 480).unwrap_err();
        assert!(error.contains("does not recognise"), "{error}");
        let error = shrink(b"a note, not an image", Some(ImageFormat::Png), 480).unwrap_err();
        assert!(error.contains("could not read"), "{error}");
    }

    #[test]
    fn makes_a_thumbnail_once_and_reads_it_back_after_that() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        let source = temp.path().join("WoWScrnShot_111423_120000.jpg");
        fs::write(&source, painted(1000, 500, ImageFormat::Jpeg)).unwrap();
        let stored = store(&source, &root, Quality::Original).unwrap();

        let first = thumbnail(&root, &stored.file_path, &stored.content_hash).unwrap();
        assert_eq!(sized(&first).0, THUMBNAIL_EDGE);

        // With the image itself taken away, a second ask can only be answered from the cache.
        fs::remove_file(root.join(&stored.file_path)).unwrap();
        assert_eq!(
            thumbnail(&root, &stored.file_path, &stored.content_hash).unwrap(),
            first,
        );
    }

    // Deleting a capture takes everything Chronie made from it, or the store fills up with
    // thumbnails of pictures nobody can see.
    #[test]
    fn discards_an_image_and_the_thumbnails_made_from_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        let source = temp.path().join("WoWScrnShot_111423_120000.jpg");
        fs::write(&source, painted(1000, 500, ImageFormat::Jpeg)).unwrap();
        let stored = store(&source, &root, Quality::Original).unwrap();
        thumbnail(&root, &stored.file_path, &stored.content_hash).unwrap();
        let cached = root
            .join(THUMBNAIL_FOLDER)
            .join(thumbnail_path(&stored.content_hash, THUMBNAIL_EDGE));
        assert!(cached.is_file());

        discard(&root, &stored.file_path, Some(&stored.content_hash)).unwrap();

        assert!(!root.join(&stored.file_path).exists());
        assert!(!cached.exists());
        // And doing it again is what was asked for rather than a failure: the file is gone.
        discard(&root, &stored.file_path, Some(&stored.content_hash)).unwrap();
    }

    /* ---------- how much of a screenshot the store keeps ---------- */

    /// A picture that does not compress, which is what a screenshot of a game actually is.
    ///
    /// `painted` draws a smooth gradient, and PNG stores one of those in almost nothing — so a
    /// gradient re-encodes *larger* as a JPEG and the store correctly keeps the original,
    /// which is the opposite of what these tests are trying to observe. Deterministic noise is
    /// the honest stand-in: a lossless encoder can do nothing with it and a lossy one can.
    fn noisy(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let mut image = image::RgbImage::new(width, height);
        let mut seed: u32 = 0x1234_5678;
        for pixel in image.pixels_mut() {
            let mut next = || {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 24) as u8
            };
            *pixel = image::Rgb([next(), next(), next()]);
        }
        let mut bytes = Vec::new();
        DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut bytes), format)
            .unwrap();
        bytes
    }

    /// One screenshot written into a fresh store at a given quality, and what came back.
    fn stored_at(
        quality: Quality,
        bytes: &[u8],
        name: &str,
    ) -> (tempfile::TempDir, Stored, Vec<u8>) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        let source = temp.path().join(name);
        fs::write(&source, bytes).unwrap();
        let stored = store(&source, &root, quality).unwrap();
        let held = fs::read(root.join(&stored.file_path)).unwrap();
        (temp, stored, held)
    }

    /// A 2800-pixel PNG is what a lot of installs actually write, and it is the case the whole
    /// setting exists for: every level below `Original` has to leave the store holding
    /// materially less than the client did, and the two that name a size have to hit it.
    #[test]
    fn keeps_as_much_of_a_screenshot_as_the_quality_asks_for() {
        let png = noisy(2800, 1400, ImageFormat::Png);
        for (quality, edge) in [
            (Quality::High, 2800),
            (Quality::Balanced, 2560),
            (Quality::Small, 1600),
        ] {
            let (_temp, stored, held) = stored_at(quality, &png, "WoWScrnShot_111423_120000.png");

            assert_eq!(sized(&held).0, edge, "{quality:?}");
            assert!(held.len() < png.len(), "{quality:?} did not save anything");
            // Re-encoded, so it is a JPEG and is named as one — which is what `mime_of` then
            // tells the window, and what stops it being handed a `.png` full of JPEG.
            assert!(stored.file_path.ends_with(".jpg"), "{quality:?}");
            assert_eq!(mime_of(&stored.file_path), "image/jpeg", "{quality:?}");
        }
    }

    /// And the level that says "the file the game wrote" means it, extension and all.
    #[test]
    fn keeps_the_client_s_own_file_untouched_at_the_original_quality() {
        let png = noisy(2800, 1400, ImageFormat::Png);

        let (_temp, stored, held) =
            stored_at(Quality::Original, &png, "WoWScrnShot_111423_120000.png");

        assert_eq!(held, png);
        assert!(stored.file_path.ends_with(".png"));
        assert_eq!(mime_of(&stored.file_path), "image/png");
    }

    /// The store is content-addressed, and it has to stay addressed by what it is holding
    /// rather than by what was read — otherwise the name is a claim about bytes nothing has.
    #[test]
    fn names_a_re_encoded_file_for_the_bytes_it_actually_holds() {
        let png = noisy(1200, 600, ImageFormat::Png);

        let (_temp, stored, held) =
            stored_at(Quality::Balanced, &png, "WoWScrnShot_111423_120000.png");

        assert_ne!(held, png, "the re-encode was expected to change the bytes");
        assert_eq!(stored.content_hash, digest(&held));
        assert_eq!(stored.byte_size, held.len() as i64);
        assert!(stored
            .file_path
            .starts_with(&format!("{}/", &stored.content_hash[..2])));
    }

    /// A picture already smaller than the encoder would make it is left alone. Compressing a
    /// 64-pixel PNG into a larger JPEG would be paying for the setting and getting nothing.
    #[test]
    fn keeps_the_original_when_re_encoding_would_only_make_it_bigger() {
        let png = painted(64, 32, ImageFormat::Png);

        let (_temp, stored, held) =
            stored_at(Quality::Small, &png, "WoWScrnShot_111423_120000.png");

        assert_eq!(held, png);
        assert!(stored.file_path.ends_with(".png"));
    }

    /// The picture matters more than the setting. A file the decoder cannot read — a damaged
    /// header, a format this build was not compiled with — is stored as found rather than
    /// dropped, because the alternative is losing a screenshot over a preference.
    #[test]
    fn keeps_a_file_it_cannot_decode_exactly_as_it_found_it() {
        let (_temp, stored, held) = stored_at(
            Quality::Balanced,
            b"not an image at all",
            "WoWScrnShot_111423_120000.jpg",
        );

        assert_eq!(held, b"not an image at all");
        assert_eq!(stored.byte_size, 19);
    }

    /// What an install that has never been told otherwise does, which is the whole of the
    /// issue's "acceptable quality, least space": a re-encode rather than the client's file.
    #[test]
    fn defaults_to_re_encoding_rather_than_to_the_client_s_own_file() {
        assert_eq!(Quality::default(), Quality::Balanced);
        assert!(Quality::default().recode().is_some());
        assert!(Quality::Original.recode().is_none());
    }

    /// The names cross into a settings file on disk and back, so they are part of the contract
    /// rather than an implementation detail of the enum.
    #[test]
    fn reads_and_writes_the_quality_by_the_name_the_settings_file_uses() {
        for (quality, name) in [
            (Quality::Original, "\"original\""),
            (Quality::High, "\"high\""),
            (Quality::Balanced, "\"balanced\""),
            (Quality::Small, "\"small\""),
        ] {
            assert_eq!(serde_json::to_string(&quality).unwrap(), name);
            assert_eq!(serde_json::from_str::<Quality>(name).unwrap(), quality);
        }
    }
}
