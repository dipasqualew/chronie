//! Taking custody of the images the addon can only leave markers for.
//!
//! The addon cannot see the filesystem. It presses the client's own `Screenshot()` and
//! writes down what it knew at that moment — including the local time, formatted exactly the
//! way the client names its files. Everything after that happens here: find the file that
//! marker is talking about, copy it into a directory Chronie owns, and prove the copy is
//! byte for byte what was found.
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

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
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
        .and_then(Value::as_array)
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
/// Two rules, and the second exists because `Screenshot()` is asynchronous: the addon reads
/// the clock when the key is pressed, and the client names the file when it finally writes
/// it, which can be the far side of a second boundary. So an exact stamp wins outright, and
/// only a marker left without one will look one second forward — never backward, because a
/// file cannot be written before the key that asked for it was pressed.
///
/// No file is ever handed to two markers, and every exact match is settled before any
/// widened one is considered, so a widened match can never steal the file that another
/// marker names exactly. Ties are broken on the ids, so the same folder and the same markers
/// always pair the same way.
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
    for pass in [Pass::Exact, Pass::NextSecond] {
        for want in &ordered {
            if paired.contains_key(&want.source_id) {
                continue;
            }
            let stamp = match pass {
                Pass::Exact => want.stamp.clone(),
                Pass::NextSecond => match next_second(&want.stamp) {
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
}

/// The stamp one second later, computed on the stamp itself rather than on the epoch beside
/// it. The stamp is local time as the machine that took the shot understood it, and stepping
/// through it directly is the only arithmetic that cannot be wrong about which local time
/// the file was named in.
fn next_second(stamp: &str) -> Option<String> {
    chrono::NaiveDateTime::parse_from_str(stamp, STAMP_FORMAT)
        .ok()?
        .checked_add_signed(chrono::TimeDelta::seconds(1))
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

/// Copies one image into the store and proves the copy.
///
/// Copy, verify, and only then — much later, and by the caller, once the row naming the file
/// has actually been committed — delete the original. Never a move: a move that dies halfway
/// has destroyed the only copy of something the player deliberately kept, and there is no
/// version of this worth that risk.
///
/// The name in the store is the content hash, which makes the store self-verifying and makes
/// re-ingesting an identical image a no-op rather than a second copy of the same bytes.
pub fn store(source: &Path, root: &Path) -> Result<Stored, String> {
    let bytes =
        fs::read(source).map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    let content_hash = digest(&bytes);
    // Sharded on the first byte of the hash, because a store nobody prunes ends up holding
    // every screenshot somebody ever took and a single directory of those is a slow one.
    let shard = &content_hash[..2];
    let name = format!("{content_hash}{}", extension(source));
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

/// Whether the store already holds exactly these bytes at this path.
fn holds(path: &Path, content_hash: &str) -> bool {
    fs::read(path).is_ok_and(|bytes| digest(&bytes) == content_hash)
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
        assert_eq!(markers[0].trigger.as_deref(), Some("accountFirstAchievement"));
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

    #[test]
    fn takes_the_next_second_when_the_client_named_the_file_late() {
        let shots = [shot("WoWScrnShot_111423_120001.jpg")];
        let paired = pair(&[wanted("a", "111423_120000")], &shots);
        assert_eq!(
            paired.get("a"),
            Some(&PathBuf::from("WoWScrnShot_111423_120001.jpg"))
        );
    }

    #[test]
    fn never_reaches_backwards_for_a_file_written_before_the_key_was_pressed() {
        let shots = [shot("WoWScrnShot_111423_115959.jpg")];
        assert!(pair(&[wanted("a", "111423_120000")], &shots).is_empty());
    }

    #[test]
    fn steps_a_second_across_a_minute_and_an_hour() {
        assert_eq!(next_second("111423_115959").as_deref(), Some("111423_120000"));
        assert_eq!(next_second("111423_235959").as_deref(), Some("111523_000000"));
        assert_eq!(next_second("nonsense"), None);
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
        assert_eq!(stamp_of("WoWScrnShot_111423_120000.jpg").as_deref(), Some("111423_120000"));
        assert_eq!(stamp_of("WoWScrnShot_111423_120000.tga").as_deref(), Some("111423_120000"));
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

        let stored = store(&source, &root).unwrap();

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

        let one = store(&first, &root).unwrap();
        let two = store(&second, &root).unwrap();

        assert_eq!(one, two);
    }

    #[test]
    fn replaces_a_stored_file_that_is_not_what_its_name_claims() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        let source = temp.path().join("WoWScrnShot_111423_120000.jpg");
        fs::write(&source, b"a picture").unwrap();
        let stored = store(&source, &root).unwrap();

        fs::write(root.join(&stored.file_path), b"something else").unwrap();
        let again = store(&source, &root).unwrap();

        assert_eq!(again, stored);
        assert_eq!(
            fs::read(root.join(&stored.file_path)).unwrap(),
            b"a picture"
        );
    }

    #[test]
    fn refuses_an_image_that_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = store(&temp.path().join("gone.jpg"), &temp.path().join("store")).unwrap_err();
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
}
