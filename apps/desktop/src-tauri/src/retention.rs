//! Which combat logs Chronie is allowed to delete, and which it is not.
//!
//! This is the only irreversible thing in the application, so the rule it turns on is written
//! down here on its own, over plain metadata, with no filesystem and no database anywhere near
//! it. A log goes only when **all** of these are true:
//!
//! - the filesystem dates it, and dates it older than the window;
//! - it is not the newest log in the folder, whatever its date says;
//! - a read got to the end of it, and the file has not changed since that read.
//!
//! The third is the one the feature exists around. Age alone is not evidence of anything: a log
//! from three weeks ago that was never parsed — because logging was on before Chronie could
//! read it, or because a backlog is still being worked through — is precisely the file that must
//! survive. Nothing here guesses at it. Either the cursor says the file was read to its end at
//! the size it still is, or the file stays and is [`Kept`] with a reason somebody can read.
//!
//! Everything a caller has to supply is a `name`, a size, a date and a cursor, so the whole rule
//! is testable against a folder that was never written to disk.

use crate::combatlog::{Found, LogFile};
use serde::Serialize;
use specta::Type;
use std::collections::HashMap;

/// How long a log is kept when nobody has said otherwise.
///
/// Seven days, matching the addon's own `DEFAULT_RETAIN_DAYS` for segments. Two retention
/// windows in one product that disagree about how long "recent" is would be two things to
/// explain rather than one.
pub const DEFAULT_RETAIN_DAYS: u32 = 7;

/// The shortest window anybody may set.
///
/// Zero would mean "delete the log of the raid that finished ten minutes ago", and the file the
/// client is writing to right now is dated ten minutes ago. A day is the smallest window that
/// cannot be confused with the present.
pub const MIN_RETAIN_DAYS: u32 = 1;

const SECONDS_PER_DAY: i64 = 86_400;

/// How far a read got into a file, as the log's own row records it.
///
/// `size` is what the file measured when that read finished, and it is half of the test: an
/// offset at the end of a file that has since grown is not the end of the file any more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Cursor {
    pub offset: u64,
    pub size: u64,
    pub lines: i64,
}

/// Why a log that is old enough to go is still there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kept {
    /// Nothing has ever read this file. The dangerous one: months of raid nights from before
    /// Chronie could read a log look exactly like this, and deleting them by age would be
    /// silent, permanent and nobody's decision.
    Unread,
    /// Read, but not to the end — a backlog still being worked through, or a file that grew
    /// after the last sync looked at it. Another sync or two and it becomes deletable by
    /// itself; until then it is not.
    Partial,
    /// The newest log in the folder, which is the one the client writes to. Never deleted at
    /// any age: a player who has not logged in for a month has a month-old active log, and it
    /// is still the file the next session appends to.
    Active,
}

/// An old log that was not deleted, and the reason it was not.
///
/// Surfaced rather than swallowed. A sweeper that quietly skips half a folder is impossible to
/// tell from one that is not running, and the `unread` pile is the one somebody has to make a
/// decision about themselves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spared {
    #[serde(flatten)]
    pub file: LogFile,
    pub why: Kept,
}

/// What a sweep would do to a folder.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plan {
    /// Old enough, read to the end, and not the active log. The paths travel with these because
    /// the sweeper needs them; nothing hands them to a window.
    pub doomed: Vec<Found>,
    /// Old enough and kept anyway, with the reason.
    pub spared: Vec<Spared>,
}

impl Plan {
    pub fn bytes(&self) -> u64 {
        self.doomed.iter().map(|found| found.file.bytes).sum()
    }
}

/// Whether a read reached the end of the file that is on disk now.
///
/// Two questions, and both have to answer yes. The offset reaching the recorded size says the
/// read finished; the recorded size matching the file's current size says the file it finished
/// is the file still sitting there. A log that was read to its end at nine o'clock and appended
/// to at ten fails the second, which is right — the second half of it has been read by nobody.
fn fully_read(cursor: &Cursor, file: &LogFile) -> bool {
    cursor.offset >= cursor.size && cursor.size == file.bytes
}

/// What a sweep would do, given what is in the folder and how far reading each file got.
///
/// `logs` is oldest first, exactly as [`crate::combatlog::logs`] returns it, because the last
/// entry is then the newest — the file the client is writing — and skipping it is how the
/// active log is protected. A caller that sorts them some other way breaks that, which is why
/// nothing here re-sorts and hopes.
///
/// `read` is keyed on the log's name, the way `combat_logs` keys its rows.
pub fn plan(logs: &[Found], read: &HashMap<String, Cursor>, retain_days: u32, now: i64) -> Plan {
    let window = i64::from(retain_days.max(MIN_RETAIN_DAYS)) * SECONDS_PER_DAY;
    let mut plan = Plan::default();
    let newest = logs.len().saturating_sub(1);
    for (index, found) in logs.iter().enumerate() {
        // A file this machine will not date is a file whose age is not known, and an unknown
        // age is not an old one. Deleting on a guess here would be deleting on a guess.
        let Some(modified) = found.file.modified else {
            continue;
        };
        if now - modified <= window {
            continue;
        }
        let why = if index == newest {
            Kept::Active
        } else {
            match read.get(&found.file.name) {
                Some(cursor) if fully_read(cursor, &found.file) => {
                    plan.doomed.push(found.clone());
                    continue;
                }
                Some(_) => Kept::Partial,
                None => Kept::Unread,
            }
        };
        plan.spared.push(Spared {
            file: found.file.clone(),
            why,
        });
    }
    plan
}

/* ---------- what the window is told ---------- */

/// How many names travel with each pile. Enough that the number above them is a claim somebody
/// can go and check, few enough that a folder with six hundred logs in it does not become six
/// hundred rows crossing the bridge every time Setup is opened.
pub const SHOWN: usize = 10;

/// A group of logs, as a number to weigh and a few names to check it against.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Pile {
    pub count: usize,
    pub bytes: u64,
    /// The first [`SHOWN`], oldest first.
    pub files: Vec<LogFile>,
}

impl Pile {
    /// Counts every file and keeps the first few, which is what makes the total honest even
    /// when the list under it is not the whole of it.
    fn of<'a>(files: impl Iterator<Item = &'a LogFile>) -> Self {
        let mut pile = Pile::default();
        for file in files {
            pile.count += 1;
            pile.bytes += file.bytes;
            if pile.files.len() < SHOWN {
                pile.files.push(file.clone());
            }
        }
        pile
    }
}

/// One log that is gone, as the record of its going.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Gone {
    pub name: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<i64>,
    pub lines_read: i64,
    pub retain_days: u32,
    pub deleted_at: i64,
}

/// Everything the retention section of Setup draws itself from.
///
/// The preview is computed whether or not the sweeper is on, because the question somebody has
/// to answer before turning it on is "what would this delete", and the only useful answer names
/// the files. That is the dry run: it is on screen before the switch, not after the first sweep.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Whether the sweeper is actually running. Off until somebody turns it on: the first sweep
    /// on a machine that has been logging for a year would take the year with it, and that is
    /// not a thing to do to somebody who has not been asked.
    pub enabled: bool,
    /// The window in days — the one in force when `enabled`, and the one the preview below was
    /// computed at when not.
    pub days: u32,
    /// What a sweep run right now would delete.
    pub doomed: Pile,
    /// Old logs nothing has ever read. Never deleted, always shown: these are somebody's to
    /// decide about, and a tool that hid them would be deciding for them.
    pub unread: Pile,
    /// Old logs a read has started and not finished. Transient — a sync or two more and they
    /// move to `doomed` by themselves.
    pub unfinished: Pile,
    /// What sweeps have actually removed, newest first.
    pub removed: Vec<Gone>,
}

impl Report {
    /// The report for a folder, from a plan over it. The ledger is filled in by the caller,
    /// which is the only part of this that needs a database.
    pub fn of(plan: &Plan, enabled: bool, days: u32) -> Self {
        let with = |want: Kept| {
            Pile::of(
                plan.spared
                    .iter()
                    .filter(move |entry| entry.why == want)
                    .map(|entry| &entry.file),
            )
        };
        Self {
            enabled,
            days,
            doomed: Pile::of(plan.doomed.iter().map(|found| &found.file)),
            unread: with(Kept::Unread),
            unfinished: with(Kept::Partial),
            removed: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = SECONDS_PER_DAY;

    fn found(name: &str, bytes: u64, modified: Option<i64>) -> Found {
        Found {
            path: PathBuf::from("Logs").join(name),
            file: LogFile {
                name: name.to_string(),
                bytes,
                modified,
            },
        }
    }

    /// A log read to its end at the size it still is.
    fn finished(bytes: u64) -> Cursor {
        Cursor {
            offset: bytes,
            size: bytes,
            lines: 100,
        }
    }

    fn names(files: &[Found]) -> Vec<&str> {
        files.iter().map(|found| found.file.name.as_str()).collect()
    }

    fn spared(plan: &Plan) -> Vec<(&str, Kept)> {
        plan.spared
            .iter()
            .map(|entry| (entry.file.name.as_str(), entry.why))
            .collect()
    }

    /// The ordinary case: two finished logs from last month, one active file, one still fresh.
    #[test]
    fn deletes_old_logs_that_were_read_to_the_end() {
        let logs = [
            found("WoWCombatLog-060126_200000.txt", 400, Some(NOW - 30 * DAY)),
            found("WoWCombatLog-060226_200000.txt", 500, Some(NOW - 29 * DAY)),
            found("WoWCombatLog-072626_200000.txt", 600, Some(NOW - DAY)),
        ];
        let read = HashMap::from([
            ("WoWCombatLog-060126_200000.txt".to_string(), finished(400)),
            ("WoWCombatLog-060226_200000.txt".to_string(), finished(500)),
            ("WoWCombatLog-072626_200000.txt".to_string(), finished(600)),
        ]);

        let plan = plan(&logs, &read, 7, NOW);

        assert_eq!(
            names(&plan.doomed),
            [
                "WoWCombatLog-060126_200000.txt",
                "WoWCombatLog-060226_200000.txt"
            ]
        );
        assert_eq!(plan.bytes(), 900);
        assert!(plan.spared.is_empty());
    }

    /// The whole reason the rule is not "older than the window". A log from three weeks ago
    /// that nothing ever parsed is the file somebody logged before Chronie could read one, and
    /// it is surfaced rather than swept.
    #[test]
    fn never_deletes_an_old_log_nothing_has_read() {
        let logs = [
            found("WoWCombatLog-060126_200000.txt", 400, Some(NOW - 21 * DAY)),
            found("WoWCombatLog-072626_200000.txt", 600, Some(NOW - DAY)),
        ];

        let plan = plan(&logs, &HashMap::new(), 7, NOW);

        assert!(plan.doomed.is_empty());
        assert_eq!(
            spared(&plan),
            [("WoWCombatLog-060126_200000.txt", Kept::Unread)]
        );
    }

    /// A backlog part way through: the cursor exists and has not reached the end. Another sync
    /// finishes it and the next sweep may take it; this one may not.
    #[test]
    fn never_deletes_a_log_a_read_has_not_finished() {
        let logs = [
            found("WoWCombatLog-060126_200000.txt", 900, Some(NOW - 21 * DAY)),
            found("WoWCombatLog-072626_200000.txt", 600, Some(NOW - DAY)),
        ];
        let read = HashMap::from([(
            "WoWCombatLog-060126_200000.txt".to_string(),
            Cursor {
                offset: 300,
                size: 900,
                lines: 20,
            },
        )]);

        let plan = plan(&logs, &read, 7, NOW);

        assert!(plan.doomed.is_empty());
        assert_eq!(
            spared(&plan),
            [("WoWCombatLog-060126_200000.txt", Kept::Partial)]
        );
    }

    /// Read to the end of what it was, and bigger now. The bytes past the old end have been
    /// read by nobody, so the file is not finished however completely it once was.
    #[test]
    fn never_deletes_a_log_that_grew_after_it_was_read() {
        let logs = [
            found("WoWCombatLog-060126_200000.txt", 900, Some(NOW - 21 * DAY)),
            found("WoWCombatLog-072626_200000.txt", 600, Some(NOW - DAY)),
        ];
        let read = HashMap::from([(
            "WoWCombatLog-060126_200000.txt".to_string(),
            Cursor {
                offset: 400,
                size: 400,
                lines: 40,
            },
        )]);

        let plan = plan(&logs, &read, 7, NOW);

        assert!(plan.doomed.is_empty());
        assert_eq!(
            spared(&plan),
            [("WoWCombatLog-060126_200000.txt", Kept::Partial)]
        );
    }

    /// The newest file is the one the client appends to, and a player who stopped raiding in
    /// May has a May-dated active log. Age says take it; being newest says never.
    #[test]
    fn never_deletes_the_newest_log_however_old_it_is() {
        let logs = [
            found("WoWCombatLog-050126_200000.txt", 400, Some(NOW - 90 * DAY)),
            found("WoWCombatLog-050226_200000.txt", 500, Some(NOW - 89 * DAY)),
        ];
        let read = HashMap::from([
            ("WoWCombatLog-050126_200000.txt".to_string(), finished(400)),
            ("WoWCombatLog-050226_200000.txt".to_string(), finished(500)),
        ]);

        let plan = plan(&logs, &read, 7, NOW);

        assert_eq!(names(&plan.doomed), ["WoWCombatLog-050126_200000.txt"]);
        assert_eq!(
            spared(&plan),
            [("WoWCombatLog-050226_200000.txt", Kept::Active)]
        );
    }

    /// One log in the folder is the active one, and a folder with one log is a folder a sweep
    /// does nothing to.
    #[test]
    fn does_nothing_to_a_folder_with_one_log_in_it() {
        let logs = [found(
            "WoWCombatLog-050126_200000.txt",
            400,
            Some(NOW - 90 * DAY),
        )];
        let read = HashMap::from([("WoWCombatLog-050126_200000.txt".to_string(), finished(400))]);

        let plan = plan(&logs, &read, 7, NOW);

        assert!(plan.doomed.is_empty());
        assert_eq!(
            spared(&plan),
            [("WoWCombatLog-050126_200000.txt", Kept::Active)]
        );
    }

    #[test]
    fn does_nothing_to_an_empty_folder() {
        assert_eq!(plan(&[], &HashMap::new(), 7, NOW), Plan::default());
    }

    /// Inside the window is inside the window, finished or not, and a log exactly on the
    /// boundary is not yet older than it.
    #[test]
    fn keeps_everything_inside_the_window() {
        let logs = [
            found("WoWCombatLog-072026_200000.txt", 400, Some(NOW - 7 * DAY)),
            found("WoWCombatLog-072126_200000.txt", 500, Some(NOW - 6 * DAY)),
            found("WoWCombatLog-072626_200000.txt", 600, Some(NOW - DAY)),
        ];
        let read = HashMap::from([
            ("WoWCombatLog-072026_200000.txt".to_string(), finished(400)),
            ("WoWCombatLog-072126_200000.txt".to_string(), finished(500)),
            ("WoWCombatLog-072626_200000.txt".to_string(), finished(600)),
        ]);

        let plan = plan(&logs, &read, 7, NOW);

        assert_eq!(
            plan,
            Plan::default(),
            "nothing deleted and nothing to explain"
        );
    }

    /// A longer window keeps more, which is the entire point of the setting being a number.
    #[test]
    fn honours_the_window_it_is_given() {
        let logs = [
            found("WoWCombatLog-060126_200000.txt", 400, Some(NOW - 45 * DAY)),
            found("WoWCombatLog-070126_200000.txt", 500, Some(NOW - 20 * DAY)),
            found("WoWCombatLog-072626_200000.txt", 600, Some(NOW - DAY)),
        ];
        let read = HashMap::from([
            ("WoWCombatLog-060126_200000.txt".to_string(), finished(400)),
            ("WoWCombatLog-070126_200000.txt".to_string(), finished(500)),
            ("WoWCombatLog-072626_200000.txt".to_string(), finished(600)),
        ]);

        assert_eq!(
            names(&plan(&logs, &read, 30, NOW).doomed),
            ["WoWCombatLog-060126_200000.txt"]
        );
        assert_eq!(names(&plan(&logs, &read, 90, NOW).doomed), [] as [&str; 0]);
    }

    /// Zero days would sweep the file being written to right now. The floor is what stops a
    /// setting somebody typed in a hurry from meaning that.
    #[test]
    fn refuses_a_window_shorter_than_a_day() {
        let logs = [
            found("WoWCombatLog-072626_120000.txt", 400, Some(NOW - 3600)),
            found("WoWCombatLog-072626_200000.txt", 600, Some(NOW - 60)),
        ];
        let read = HashMap::from([
            ("WoWCombatLog-072626_120000.txt".to_string(), finished(400)),
            ("WoWCombatLog-072626_200000.txt".to_string(), finished(600)),
        ]);

        assert_eq!(plan(&logs, &read, 0, NOW), Plan::default());
    }

    /// A file the filesystem will not date has no age, and an unknown age is not an old one.
    #[test]
    fn leaves_a_file_this_machine_will_not_date() {
        let logs = [
            found("WoWCombatLog-060126_200000.txt", 400, None),
            found("WoWCombatLog-072626_200000.txt", 600, Some(NOW - DAY)),
        ];
        let read = HashMap::from([("WoWCombatLog-060126_200000.txt".to_string(), finished(400))]);

        assert_eq!(plan(&logs, &read, 7, NOW), Plan::default());
    }

    /// A clock that disagrees with the filesystem can date a file in the future. That is not an
    /// old file, and the subtraction must not wrap it into one.
    #[test]
    fn leaves_a_file_dated_in_the_future() {
        let logs = [
            found("WoWCombatLog-080126_200000.txt", 400, Some(NOW + 30 * DAY)),
            found("WoWCombatLog-080226_200000.txt", 600, Some(NOW + 31 * DAY)),
        ];
        let read = HashMap::from([("WoWCombatLog-080126_200000.txt".to_string(), finished(400))]);

        assert_eq!(plan(&logs, &read, 7, NOW), Plan::default());
    }

    /// An empty log that was read is still a log that was read. Nothing about it is worth
    /// keeping and the rule does not need an exception for it.
    #[test]
    fn deletes_an_old_empty_log_that_was_read() {
        let logs = [
            found("WoWCombatLog-060126_200000.txt", 0, Some(NOW - 21 * DAY)),
            found("WoWCombatLog-072626_200000.txt", 600, Some(NOW - DAY)),
        ];
        let read = HashMap::from([(
            "WoWCombatLog-060126_200000.txt".to_string(),
            Cursor {
                offset: 0,
                size: 0,
                lines: 0,
            },
        )]);

        assert_eq!(
            names(&plan(&logs, &read, 7, NOW).doomed),
            ["WoWCombatLog-060126_200000.txt"]
        );
    }

    /// The report keeps the two piles apart, because the answer to each is different: one is a
    /// number somebody can accept, the other is a decision only they can make.
    #[test]
    fn reports_what_would_go_and_what_would_not() {
        let logs = [
            found("WoWCombatLog-060126_200000.txt", 400, Some(NOW - 30 * DAY)),
            found("WoWCombatLog-060226_200000.txt", 500, Some(NOW - 29 * DAY)),
            found("WoWCombatLog-060326_200000.txt", 700, Some(NOW - 28 * DAY)),
            found("WoWCombatLog-072626_200000.txt", 600, Some(NOW - DAY)),
        ];
        let read = HashMap::from([
            ("WoWCombatLog-060126_200000.txt".to_string(), finished(400)),
            ("WoWCombatLog-060226_200000.txt".to_string(), finished(500)),
            (
                "WoWCombatLog-060326_200000.txt".to_string(),
                Cursor {
                    offset: 10,
                    size: 700,
                    lines: 2,
                },
            ),
        ]);

        let report = Report::of(&plan(&logs, &read, 7, NOW), false, 7);

        assert_eq!(report.doomed.count, 2);
        assert_eq!(report.doomed.bytes, 900);
        assert_eq!(report.unfinished.count, 1);
        assert_eq!(report.unfinished.bytes, 700);
        assert_eq!(report.unread, Pile::default());
        assert!(!report.enabled, "a preview of what turning it on would do");
    }

    /// A folder with hundreds of old logs in it is a total and a sample, not a list — but the
    /// total counts all of them, which is the number the reader is actually weighing.
    #[test]
    fn counts_every_file_while_naming_only_the_first_few() {
        let logs: Vec<Found> = (0..40)
            .map(|index| {
                found(
                    &format!("WoWCombatLog-0601{index:02}.txt"),
                    100,
                    Some(NOW - 30 * DAY),
                )
            })
            .collect();

        let report = Report::of(&plan(&logs, &HashMap::new(), 7, NOW), true, 7);

        // Every file but the newest, which is the active one and never in a pile at all.
        assert_eq!(report.unread.count, 39);
        assert_eq!(report.unread.bytes, 3_900);
        assert_eq!(report.unread.files.len(), SHOWN);
    }
}
