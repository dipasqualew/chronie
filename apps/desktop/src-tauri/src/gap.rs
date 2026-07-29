//! Whether a session was played that Chronie has no record of.
//!
//! The addon's whole history lives in one in-memory Lua table that the client serialises at UI
//! teardown and at no other time — see `docs/saved-variables.md`. A crash, a force-quit or a
//! power cut therefore loses the entire session, and the SavedVariables file left on disk still
//! holds the *previous* one. The collector skips a file whose size and modification time have
//! not moved, so nothing about the loss is visible from the file: an evening that never
//! happened, as far as the window is concerned, looks exactly like an evening nobody played.
//!
//! What tells them apart is the client's other file. The combat log is written as it goes,
//! line by line, and its last stamped line is the last moment the client can be proved to have
//! been alive. If that moment is meaningfully later than the newest segment in the history,
//! there was play the history does not contain.
//!
//! This module is the rule and nothing else: no filesystem, no database, no clock. What it is
//! given has already been read by [`crate::combatlog`] and [`crate::logfile`], which is what
//! makes every case below a test rather than an install somebody has to reproduce.
//!
//! **This detects a gap. It does not fill one.** Recovering the segments themselves needs a
//! journal the addon writes as it goes, and whether the one channel that could carry it —
//! `C_Log`, which reaches `Logs\General.log` — survives a killed process is still unanswered.
//! See issue #209.

use serde::Serialize;
use specta::Type;

/// How long the combat log must have been quiet before its silence means the client is gone.
///
/// Two things have to fit inside this window and it is sized for the longer of them. A player
/// who fights nothing for an hour — standing in a city, running old content, sorting bags —
/// writes no combat log lines while remaining perfectly alive, and calling that a crash while
/// they are still logged in would be a false alarm every evening. Against that, a clean logout
/// writes SavedVariables within a second and the collector reads it within thirty, so the
/// honest case never needs anything like an hour to resolve itself.
///
/// It is the same hour [`crate::combatlog::FRESH_SECONDS`] uses to call a log stale, and for
/// the same reason: it is how long this client's own files take to say anything at all.
pub const QUIET_SECONDS: i64 = crate::combatlog::FRESH_SECONDS;

/// How far past the newest segment the combat log may run before the difference is real.
///
/// A clean logout closes the running segment from the `PLAYER_LOGOUT` handler, so its
/// `endedAt` is the moment the session ended and every line of the log precedes it. The slack
/// is therefore not for ordinary play — it is for a machine whose filesystem, whose game and
/// whose database round a second differently, and five minutes is far more than any of them
/// need. A lost session is measured in tens of minutes, so nothing real hides underneath it.
pub const SLACK_SECONDS: i64 = 300;

/// A session the combat log proves was played and the history does not contain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    /// The newest segment Chronie holds, in epoch seconds. Where the hole starts.
    pub recorded_to: i64,
    /// The last line of the combat log, in epoch seconds. Where the hole ends.
    pub played_to: i64,
    /// The log that proved it, so a reader can go and look at the file rather than take this
    /// on trust.
    pub log: String,
}

impl Gap {
    /// How long the missing session ran for, in seconds. Never negative: the only way to be a
    /// [`Gap`] at all is for `played_to` to be the later of the two.
    pub fn seconds(&self) -> i64 {
        (self.played_to - self.recorded_to).max(0)
    }
}

/// What can be said about whether the history is complete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "gap")]
pub enum Verdict {
    /// Nothing was comparable, so nothing is claimed. No combat log, no readable line in the
    /// one there is, or no segments to hold it against. Kept apart from [`Verdict::Complete`]
    /// on purpose: "there is no hole" and "nobody looked" are not the same sentence, and a
    /// window that draws them the same way is lying about the second one.
    Unknown,
    /// The client was writing to its log recently enough that it may still be running. Nothing
    /// is missing until a session has ended, and a session that has not ended cannot have been
    /// lost.
    Live,
    /// Everything the combat log proves was played is in the history.
    Complete,
    /// Play the history does not contain.
    Missing(Gap),
}

/// Which of the four is true, from what the install's files say.
///
/// - `log` is the newest combat log, or `None` when the folder holds none.
/// - `played_to` is that file's last stamped line in epoch seconds, or `None` when it holds no
///   line this build can read. Kept separate from `log` because the file existing and the file
///   saying anything are two different failures.
/// - `recorded_to` is the newest `endedAt` in the database, or `None` for an empty history.
/// - `now` is epoch seconds.
///
/// The order of the tests is the argument. Liveness comes before completeness because a
/// session in progress is *expected* to be absent from a file the client only writes at
/// logout — reporting a hole for it would mean an alarm every time somebody plays.
pub fn verdict(
    log: Option<&crate::combatlog::LogFile>,
    played_to: Option<i64>,
    recorded_to: Option<i64>,
    now: i64,
) -> Verdict {
    let (Some(log), Some(played_to)) = (log, played_to) else {
        return Verdict::Unknown;
    };
    // The file's own date as well as its last line, because they answer slightly different
    // questions and the client can fail either one: a log still being appended to whose last
    // complete line is old, and a log finished long ago that something has since touched. The
    // later of the two is the last evidence of life, and while there is recent evidence of
    // life there is nothing to report.
    let last_seen = log.modified.map_or(played_to, |at| at.max(played_to));
    if (now - last_seen).abs() <= QUIET_SECONDS {
        return Verdict::Live;
    }
    // An empty history has no hole in it. There is a real case underneath this — a first
    // install whose very first session crashed — but it is indistinguishable from the ordinary
    // one, where the folder holds logs from years of playing without Chronie, and calling
    // those a loss would greet every new user with an alarm about data they never had.
    let Some(recorded_to) = recorded_to else {
        return Verdict::Unknown;
    };
    if played_to - recorded_to <= SLACK_SECONDS {
        return Verdict::Complete;
    }
    Verdict::Missing(Gap {
        recorded_to,
        played_to,
        log: log.name.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::combatlog::LogFile;

    const NOW: i64 = 1_800_000_000;

    fn log(modified: Option<i64>) -> LogFile {
        LogFile {
            name: "WoWCombatLog-072926_180000.txt".to_string(),
            bytes: 4096,
            modified,
        }
    }

    #[test]
    fn says_nothing_when_the_folder_holds_no_log() {
        assert_eq!(
            verdict(None, None, Some(NOW - 86_400), NOW),
            Verdict::Unknown
        );
    }

    #[test]
    fn says_nothing_when_the_log_holds_no_readable_line() {
        let quiet = log(Some(NOW - 86_400));
        assert_eq!(verdict(Some(&quiet), None, Some(NOW - 86_400), NOW), Verdict::Unknown);
    }

    #[test]
    fn says_nothing_when_there_is_no_history_to_compare_against() {
        let quiet = log(Some(NOW - 86_400));
        assert_eq!(verdict(Some(&quiet), Some(NOW - 86_400), None, NOW), Verdict::Unknown);
    }

    #[test]
    fn a_session_still_being_played_is_not_a_loss() {
        // The shape of every evening: hours of new combat log, and a SavedVariables file that
        // will not be written until logout. Nothing is missing yet.
        let live = log(Some(NOW - 30));
        assert_eq!(
            verdict(Some(&live), Some(NOW - 30), Some(NOW - 86_400), NOW),
            Verdict::Live
        );
    }

    #[test]
    fn a_quiet_log_whose_file_was_just_touched_is_still_live() {
        // An hour in a city writes no lines. The file is untouched by the game and its last
        // line is old, but something dated it just now — a backup, an editor, the player
        // copying it somewhere — and that is not evidence the client died an hour ago.
        let touched = log(Some(NOW - 60));
        assert_eq!(
            verdict(Some(&touched), Some(NOW - QUIET_SECONDS - 600), Some(NOW - 86_400), NOW),
            Verdict::Live
        );
    }

    #[test]
    fn a_clock_ahead_of_this_machine_does_not_read_as_a_dead_client() {
        let ahead = log(Some(NOW + 120));
        assert_eq!(
            verdict(Some(&ahead), Some(NOW + 120), Some(NOW - 86_400), NOW),
            Verdict::Live
        );
    }

    #[test]
    fn a_clean_logout_leaves_the_history_complete() {
        // Logout closes the running segment, so the newest `endedAt` is at or after the last
        // line of the log.
        let done = log(Some(NOW - 7200));
        assert_eq!(
            verdict(Some(&done), Some(NOW - 7300), Some(NOW - 7200), NOW),
            Verdict::Complete
        );
    }

    #[test]
    fn a_few_seconds_between_the_last_line_and_the_last_segment_is_not_a_hole() {
        let done = log(Some(NOW - 7200));
        assert_eq!(
            verdict(Some(&done), Some(NOW - 7200), Some(NOW - 7200 - SLACK_SECONDS), NOW),
            Verdict::Complete
        );
    }

    #[test]
    fn play_after_the_newest_segment_is_a_gap() {
        // The crash: the log ran until 18:00 and the newest segment is yesterday's logout.
        let crashed = log(Some(NOW - 7200));
        let recorded_to = NOW - 90_000;
        assert_eq!(
            verdict(Some(&crashed), Some(NOW - 7200), Some(recorded_to), NOW),
            Verdict::Missing(Gap {
                recorded_to,
                played_to: NOW - 7200,
                log: "WoWCombatLog-072926_180000.txt".to_string(),
            })
        );
    }

    #[test]
    fn a_gap_is_as_long_as_the_play_it_swallowed() {
        let gap = Gap {
            recorded_to: NOW - 90_000,
            played_to: NOW - 7200,
            log: "WoWCombatLog-072926_180000.txt".to_string(),
        };
        assert_eq!(gap.seconds(), 82_800);
    }

    #[test]
    fn a_log_this_machine_will_not_date_is_judged_on_its_last_line_alone() {
        // No `modified` at all. The last line still says when the client was writing, which is
        // enough for both halves of the rule.
        let undated = log(None);
        assert_eq!(
            verdict(Some(&undated), Some(NOW - 60), Some(NOW - 86_400), NOW),
            Verdict::Live
        );
        assert_eq!(
            verdict(Some(&undated), Some(NOW - 7200), Some(NOW - 90_000), NOW),
            Verdict::Missing(Gap {
                recorded_to: NOW - 90_000,
                played_to: NOW - 7200,
                log: "WoWCombatLog-072926_180000.txt".to_string(),
            })
        );
    }
}
