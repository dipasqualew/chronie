//! Whether the game is really writing an advanced combat log.
//!
//! The addon can ask the client to log, and the desktop app can ask the addon to ask. None of
//! that is evidence. What this module reports comes from the install itself: the CVar as the
//! game last wrote it into its own config, and a file in `Logs/` whose size is going up.
//!
//! The second signal is the honest one. A setting that claims logging is on while no file has
//! been written in a week is a problem to surface, not a tick — so "on" is never reported
//! from the setting alone, and the age and size of the newest log travel with the answer so
//! the window can say what it is actually looking at.
//!
//! Nothing here watches the filesystem or holds a handle. The app already polls every 30
//! seconds; this is called on that beat and compares what it sees with what it saw last time.

use chrono::{DateTime, Datelike, Local};
use serde::Serialize;
use specta::Type;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

/// The CVar behind the Advanced Combat Logging box in the Network options. Ordinary combat
/// logging produces a file; this is what adds positions, map ids and facing to the lines of
/// it, which is the entire reason anything downstream wants a log at all.
pub const ADVANCED_CVAR: &str = "advancedCombatLogging";

/// How recently the newest log must have been written for logging to count as confirmed.
///
/// An hour rather than a minute, because a log that is genuinely being written still goes
/// quiet while its owner is standing in a city — and because the failure worth catching is
/// the one measured in days, where the setting says yes and nothing has grown since Tuesday.
pub const FRESH_SECONDS: i64 = 3600;

/// Files in `Logs/` whose names start with this, whatever case, are combat logs. Modern
/// clients split them per session — `WoWCombatLog-070926_182310.txt` — rather than appending
/// to one file forever, so the folder is read and the newest taken instead of a name being
/// assumed.
const LOG_PREFIX: &str = "wowcombatlog";

/// The newest combat log found, as the window describes it to a reader.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub bytes: u64,
    /// Epoch seconds, or `None` on a filesystem that will not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<i64>,
}

/// Which of the four things is true of this install.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// Chronie is not asking for logging, which is the default and costs nothing.
    Off,
    /// Logging was asked for, but advanced logging is not confirmed on — so whatever is being
    /// written has no positions in it.
    Basic,
    /// Asked for, advanced confirmed, and a log that is actually growing.
    Advanced,
    /// Asked for and advanced confirmed, but nothing has been written lately. Expected while
    /// the game is closed; a problem if it has been days and the player has been raiding.
    Stale,
}

/// Everything the Setup panel draws its combat-logging section from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Whether Chronie's own setting is on. Everything else is about what the game is doing.
    pub requested: bool,
    /// The CVar as the game's config last recorded it. `None` means no config could be read
    /// at all, which is not the same as off and is never reported as if it were.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced: Option<bool>,
    /// Which file that answer came from, relative to the game folder, so a reader can go and
    /// look. `None` when nothing was found to read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The newest file in `Logs/` that looks like a combat log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log: Option<LogFile>,
    /// Whether that file is actually being written: it grew since the last look, or it is
    /// new, or it was touched inside the last hour.
    pub growing: bool,
    pub state: State,
}

/// All that can honestly be said before a game folder has been chosen: what Chronie was asked
/// to do, and nothing about what any install is doing. `advanced` is unknown rather than off,
/// because nothing was read — the two are never allowed to look the same.
pub fn without_install(requested: bool) -> Status {
    Status {
        requested,
        advanced: None,
        source: None,
        log: None,
        growing: false,
        state: if requested { State::Basic } else { State::Off },
    }
}

/// Reads the value of one CVar out of a `.wtf` config file.
///
/// The format is one `SET name "value"` per line. `None` means the file does not mention the
/// setting, which for a CVar the player has never touched is the ordinary case and means the
/// client's own default — off, for this one.
pub fn cvar_in(text: &str, name: &str) -> Option<bool> {
    for line in text.lines() {
        let mut words = line.split_whitespace();
        if !words.next().is_some_and(|word| word.eq_ignore_ascii_case("SET")) {
            continue;
        }
        if !words.next().is_some_and(|word| word.eq_ignore_ascii_case(name)) {
            continue;
        }
        let value = words.next().unwrap_or("").trim_matches('"');
        return Some(value == "1" || value.eq_ignore_ascii_case("true"));
    }
    None
}

/// Every config file that could carry a CVar, newest first.
///
/// `Config.wtf` is the whole install's; each account keeps its own `config-cache.wtf` beside
/// its SavedVariables, and that is where a box ticked in the options ends up. Which of them
/// answers is decided by which the game wrote most recently — that is the account somebody is
/// actually playing, and preferring it is why an old second account cannot answer for them.
fn config_files(wow_path: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let wtf = wow_path.join("WTF");
    let global = wtf.join("Config.wtf");
    if global.is_file() {
        found.push(global);
    }
    if let Ok(entries) = fs::read_dir(wtf.join("Account")) {
        for entry in entries.flatten() {
            let cache = entry.path().join("config-cache.wtf");
            if cache.is_file() {
                found.push(cache);
            }
        }
    }
    found.sort_by_key(|path| std::cmp::Reverse(modified_at(path)));
    found
}

/// A file's modification time in epoch seconds, or `None` when the filesystem will not say.
fn modified_at(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .and_then(|data| data.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_secs() as i64)
}

/// The advanced logging CVar as this install last recorded it, and the file that said so.
///
/// A config that mentions the setting wins over one that does not, whatever their ages: an
/// account that has never been near the Network options has nothing to say about it, and
/// letting its silence outvote the account that ticked the box would report off for a client
/// that is logging perfectly well.
fn read_advanced(wow_path: &Path) -> (Option<bool>, Option<PathBuf>) {
    let mut fallback = None;
    for path in config_files(wow_path) {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if let Some(value) = cvar_in(&text, ADVANCED_CVAR) {
            return (Some(value), Some(path));
        }
        fallback.get_or_insert(path);
    }
    // Every config read, none of them mentions it: the client is running its default, which
    // for this CVar is off. That is a real answer, unlike having read nothing at all.
    match fallback {
        Some(path) => (Some(false), Some(path)),
        None => (None, None),
    }
}

/// A combat log on disk, and where it is.
///
/// The path is kept apart from [`LogFile`] rather than added to it, because `LogFile` is what
/// the window is told about an install and an absolute path on somebody's machine is not
/// something a window has any use for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub path: PathBuf,
    pub file: LogFile,
}

/// Every combat log in the install's `Logs/` folder, oldest first.
///
/// Modern clients split logs per session — `WoWCombatLog-070926_182310.txt` — rather than
/// appending to one file forever, so a night can be several files and the folder is read
/// rather than a name being assumed. Oldest first, because anything catching up on a backlog
/// wants to read them in the order they were written.
pub fn logs(wow_path: &Path) -> Vec<Found> {
    let Ok(entries) = fs::read_dir(wow_path.join("Logs")) else {
        return Vec::new();
    };
    let mut found: Vec<Found> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.to_ascii_lowercase().starts_with(LOG_PREFIX) {
                return None;
            }
            let data = entry.metadata().ok()?;
            if !data.is_file() {
                return None;
            }
            Some(Found {
                file: LogFile {
                    modified: modified_at(&entry.path()),
                    name,
                    bytes: data.len(),
                },
                path: entry.path(),
            })
        })
        .collect();
    // A filesystem that will not date a file sorts oldest, so a dated one always wins. The
    // name settles the rest, so that two logs written in the same second are always read in
    // the same order.
    found.sort_by(|left, right| {
        (left.file.modified.unwrap_or(i64::MIN), &left.file.name)
            .cmp(&(right.file.modified.unwrap_or(i64::MIN), &right.file.name))
    });
    found
}

/// The newest thing in `Logs/` that looks like a combat log.
pub fn newest_log(wow_path: &Path) -> Option<LogFile> {
    logs(wow_path).pop().map(|found| found.file)
}

/// The newest combat log, and where it is.
///
/// [`newest_log`] answers what the window is told; this answers what a reader of the file
/// needs, which is the path as well.
pub fn newest_found(wow_path: &Path) -> Option<Found> {
    logs(wow_path).pop()
}

/// The year to read a log's stamps with when its lines do not carry one.
///
/// The client names its files with the day it opened them — `WoWCombatLog-070926_182310.txt`
/// — which is the best answer available and is the file's own claim rather than a guess. When
/// the name does not say, the filesystem's date does, and after that there is only now.
pub fn year_of(found: &Found) -> i32 {
    stamped_year(&found.file.name)
        .or_else(|| {
            found
                .file
                .modified
                .and_then(|at| DateTime::from_timestamp(at, 0))
                .map(|moment| moment.with_timezone(&Local).year())
        })
        .unwrap_or_else(|| Local::now().year())
}

/// The `MMDDYY_HHMMSS` in a log's name, as a year.
fn stamped_year(name: &str) -> Option<i32> {
    let stamp = name.split(['-', '.', '_']).collect::<Vec<_>>().join("_");
    let stamp = stamp.split('_').find(|part| {
        part.len() == 6 && part.bytes().all(|byte| byte.is_ascii_digit())
    })?;
    stamp[4..6].parse::<i32>().ok().map(|year| 2000 + year)
}

/// Whether the newest log is one somebody is writing to right now.
///
/// Three ways to be sure, and one look is not always enough for any of them: it is bigger
/// than it was the last time this ran, or it is a different file from the one that was
/// newest then — a fresh session started — or the filesystem dates it inside the last hour,
/// which is the only signal available on the very first look after the app starts.
fn is_growing(current: &LogFile, previous: Option<&LogFile>, now: i64) -> bool {
    if let Some(before) = previous {
        if before.name != current.name || current.bytes > before.bytes {
            return true;
        }
    }
    // Absolute, so a machine whose clock disagrees with the game's does not read a file
    // written seconds ago as one written next week.
    current
        .modified
        .is_some_and(|at| (now - at).abs() <= FRESH_SECONDS)
}

/// What this install is really doing about combat logs.
///
/// `previous` is the log seen on the last poll, which is what makes a file that is growing
/// distinguishable from one that merely exists. `requested` is Chronie's own setting; it
/// decides whether anything was asked for, never whether it happened.
pub fn status(wow_path: &Path, requested: bool, previous: Option<&LogFile>, now: i64) -> Status {
    let (advanced, source) = read_advanced(wow_path);
    let log = newest_log(wow_path);
    let growing = log
        .as_ref()
        .is_some_and(|file| is_growing(file, previous, now));
    let state = if !requested {
        State::Off
    } else if advanced != Some(true) {
        // Includes the case where no config could be read at all. Reporting that as advanced
        // would be a guess, and this is the state whose copy tells the player what to tick.
        State::Basic
    } else if growing {
        State::Advanced
    } else {
        State::Stale
    };
    Status {
        requested,
        advanced,
        source: source.map(|path| {
            path.strip_prefix(wow_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/")
        }),
        log,
        growing,
        state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::File, time::{Duration, SystemTime}};

    const NOW: i64 = 1_800_000_000;

    /// A file with contents and a modification time, which is most of what this module reads.
    fn write(path: &Path, contents: &str, modified: i64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
        let when = SystemTime::UNIX_EPOCH + Duration::from_secs(modified as u64);
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    /// The name the client gives a file is the only thing that says which year its stamps are
    /// in, for a log old enough not to state one.
    #[test]
    fn reads_the_year_out_of_the_name_the_client_gave_the_file() {
        assert_eq!(stamped_year("WoWCombatLog-070926_182310.txt"), Some(2026));
        assert_eq!(stamped_year("WoWCombatLog-111423_201500.txt"), Some(2023));
        assert_eq!(stamped_year("WoWCombatLog.txt"), None);
        assert_eq!(stamped_year("WoWCombatLog-notadate.txt"), None);
    }

    #[test]
    fn reads_a_cvar_out_of_a_config_file() {
        let text = "SET gxWindow \"1\"\nSET advancedCombatLogging \"1\"\nSET readTOS \"1\"\n";

        assert_eq!(cvar_in(text, ADVANCED_CVAR), Some(true));
    }

    #[test]
    fn reads_a_cvar_the_player_has_turned_off() {
        assert_eq!(cvar_in("SET advancedCombatLogging \"0\"", ADVANCED_CVAR), Some(false));
    }

    #[test]
    fn says_nothing_about_a_cvar_the_file_does_not_mention() {
        assert_eq!(cvar_in("SET gxWindow \"1\"", ADVANCED_CVAR), None);
    }

    /// A CVar whose name merely contains the one being asked for is a different setting.
    #[test]
    fn does_not_match_a_longer_cvar_name() {
        assert_eq!(cvar_in("SET advancedCombatLoggingXYZ \"1\"", ADVANCED_CVAR), None);
    }

    #[test]
    fn prefers_the_account_config_that_actually_mentions_the_setting() {
        let wow = tempfile::tempdir().unwrap();
        // The newest config is an account that has never been near the Network options; the
        // older one ticked the box. Silence must not outvote an answer.
        write(&wow.path().join("WTF/Account/QUIET/config-cache.wtf"), "SET gxWindow \"1\"", NOW);
        write(
            &wow.path().join("WTF/Account/MAIN/config-cache.wtf"),
            "SET advancedCombatLogging \"1\"",
            NOW - 5_000,
        );

        let status = status(wow.path(), true, None, NOW);

        assert_eq!(status.advanced, Some(true));
        assert_eq!(status.source.as_deref(), Some("WTF/Account/MAIN/config-cache.wtf"));
    }

    #[test]
    fn reads_a_config_that_says_the_setting_is_off() {
        let wow = tempfile::tempdir().unwrap();
        write(
            &wow.path().join("WTF/Account/MAIN/config-cache.wtf"),
            "SET advancedCombatLogging \"0\"",
            NOW,
        );

        assert_eq!(status(wow.path(), true, None, NOW).advanced, Some(false));
    }

    /// A config the player has never touched is running the client's default, which is off —
    /// a real answer, and a different one from having found no config to read.
    #[test]
    fn treats_a_config_that_never_mentions_it_as_off() {
        let wow = tempfile::tempdir().unwrap();
        write(&wow.path().join("WTF/Config.wtf"), "SET gxWindow \"1\"", NOW);

        let status = status(wow.path(), true, None, NOW);

        assert_eq!(status.advanced, Some(false));
        assert_eq!(status.source.as_deref(), Some("WTF/Config.wtf"));
    }

    #[test]
    fn admits_when_there_is_no_config_to_read() {
        let wow = tempfile::tempdir().unwrap();

        let status = status(wow.path(), true, None, NOW);

        assert_eq!(status.advanced, None);
        assert_eq!(status.source, None);
        assert_eq!(status.state, State::Basic);
    }

    /// Before a game folder has been chosen there is nothing to look at, and saying so is
    /// different from saying the advanced setting is off.
    #[test]
    fn says_only_what_was_asked_for_when_there_is_no_install_to_read() {
        assert_eq!(
            without_install(true),
            Status {
                requested: true,
                advanced: None,
                source: None,
                log: None,
                growing: false,
                state: State::Basic,
            }
        );
        assert_eq!(without_install(false).state, State::Off);
    }

    #[test]
    fn finds_the_newest_of_the_session_logs() {
        let wow = tempfile::tempdir().unwrap();
        write(&wow.path().join("Logs/WoWCombatLog-070926_182310.txt"), "old", NOW - 90_000);
        write(&wow.path().join("Logs/WoWCombatLog-071026_201500.txt"), "newer", NOW - 60);
        write(&wow.path().join("Logs/Client.log"), "not a combat log at all", NOW);

        let log = newest_log(wow.path()).unwrap();

        assert_eq!(log.name, "WoWCombatLog-071026_201500.txt");
        assert_eq!(log.bytes, 5);
        assert_eq!(log.modified, Some(NOW - 60));
    }

    #[test]
    fn has_no_log_when_the_folder_does_not_exist() {
        let wow = tempfile::tempdir().unwrap();

        assert_eq!(newest_log(wow.path()), None);
    }

    /// The whole point of the module: the setting says yes, the file agrees.
    #[test]
    fn confirms_advanced_logging_from_a_log_that_was_just_written() {
        let wow = tempfile::tempdir().unwrap();
        write(
            &wow.path().join("WTF/Account/MAIN/config-cache.wtf"),
            "SET advancedCombatLogging \"1\"",
            NOW,
        );
        write(&wow.path().join("Logs/WoWCombatLog-071026_201500.txt"), "lines", NOW - 30);

        assert_eq!(status(wow.path(), true, None, NOW).state, State::Advanced);
    }

    #[test]
    fn calls_it_stale_when_nothing_has_been_written_for_days() {
        let wow = tempfile::tempdir().unwrap();
        write(
            &wow.path().join("WTF/Account/MAIN/config-cache.wtf"),
            "SET advancedCombatLogging \"1\"",
            NOW,
        );
        write(&wow.path().join("Logs/WoWCombatLog-070126_201500.txt"), "lines", NOW - 600_000);

        let status = status(wow.path(), true, None, NOW);

        assert_eq!(status.state, State::Stale);
        assert!(!status.growing);
        assert_eq!(status.log.unwrap().modified, Some(NOW - 600_000));
    }

    /// A stale-looking file that is bigger than it was 30 seconds ago is being written to,
    /// whatever its timestamp claims.
    #[test]
    fn believes_a_file_that_grew_since_the_last_look() {
        let wow = tempfile::tempdir().unwrap();
        write(
            &wow.path().join("WTF/Account/MAIN/config-cache.wtf"),
            "SET advancedCombatLogging \"1\"",
            NOW,
        );
        write(&wow.path().join("Logs/WoWCombatLog-071026_201500.txt"), "more lines", NOW - 90_000);
        let before = LogFile {
            name: "WoWCombatLog-071026_201500.txt".into(),
            bytes: 4,
            modified: Some(NOW - 90_000),
        };

        let status = status(wow.path(), true, Some(&before), NOW);

        assert!(status.growing);
        assert_eq!(status.state, State::Advanced);
    }

    /// A new session writes a new file, which is growth even though nothing got bigger.
    #[test]
    fn believes_a_log_that_was_not_there_last_time() {
        let wow = tempfile::tempdir().unwrap();
        write(
            &wow.path().join("WTF/Account/MAIN/config-cache.wtf"),
            "SET advancedCombatLogging \"1\"",
            NOW,
        );
        write(&wow.path().join("Logs/WoWCombatLog-071126_090000.txt"), "x", NOW - 90_000);
        let before = LogFile {
            name: "WoWCombatLog-071026_201500.txt".into(),
            bytes: 900,
            modified: Some(NOW - 90_000),
        };

        assert!(status(wow.path(), true, Some(&before), NOW).growing);
    }

    /// Logging on without the advanced box ticked is its own state, because the log it
    /// produces has none of what anything downstream wants out of it.
    #[test]
    fn separates_logging_from_advanced_logging() {
        let wow = tempfile::tempdir().unwrap();
        write(
            &wow.path().join("WTF/Account/MAIN/config-cache.wtf"),
            "SET advancedCombatLogging \"0\"",
            NOW,
        );
        write(&wow.path().join("Logs/WoWCombatLog-071026_201500.txt"), "lines", NOW - 30);

        let status = status(wow.path(), true, None, NOW);

        assert_eq!(status.state, State::Basic);
        // Still reported as growing: the file is real, it just has nothing useful in it.
        assert!(status.growing);
    }

    /// With the setting off, nothing about the install can make the state anything else —
    /// but what was found is still reported, because a player who has logging on for their
    /// own reasons should see that said out loud rather than hidden.
    #[test]
    fn reports_off_whatever_the_install_is_doing() {
        let wow = tempfile::tempdir().unwrap();
        write(
            &wow.path().join("WTF/Account/MAIN/config-cache.wtf"),
            "SET advancedCombatLogging \"1\"",
            NOW,
        );
        write(&wow.path().join("Logs/WoWCombatLog-071026_201500.txt"), "lines", NOW - 30);

        let status = status(wow.path(), false, None, NOW);

        assert_eq!(status.state, State::Off);
        assert_eq!(status.advanced, Some(true));
        assert!(status.growing);
    }
}
