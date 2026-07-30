//! What went wrong, kept whole until something has to be said about it.
//!
//! Before this module every failure in the backend was a `String`, made at the point the failure
//! happened. Three things came out of that, and all three are what this module is for.
//!
//! - **The cause was thrown away.** `error.to_string()` on a `rusqlite::Error` is the last link
//!   of a chain and the chain is gone; a locked file, a missing column and a corrupt page all
//!   arrive as one flat sentence with no operation attached to it. A log that says
//!   `database is locked` cannot say what was being written.
//! - **Infrastructure wording became the user interface.** The webview drew whatever string came
//!   back, so `unable to open database file` — SQLite's own words, about a path a player has no
//!   business seeing — was a message this app showed on purpose.
//! - **Nothing could be branched on.** A missing game folder, an install being patched, a busy
//!   database and a typo in a query are four different things to do next, and the frontend could
//!   only tell them apart by matching on English.
//!
//! So there are two types here rather than one.
//!
//! [`Failure`] is the internal one. It carries a [`FailureCode`] — the domain condition — a
//! sentence written deliberately for whoever reads it, the operations it passed through on its
//! way up, and the error it started as. It converts from the error types the backend actually
//! meets, so ordinary code is `?` rather than a `map_err` adapter, and [`Context`] is how a `?`
//! says what it was doing without inventing a variant for it.
//!
//! [`CommandError`] is what crosses to the webview: the code, the deliberate sentence, and
//! whether trying again would be honest. Nothing else. The projection happens once, at the Tauri
//! boundary, and [`Failure::report`] — the full account, causes and operations included — goes to
//! the log on the way past. That is the whole point of two types: the log gets everything and the
//! window gets what it can act on.

use std::error::Error;
use std::fmt::{self, Display};
use std::sync::OnceLock;

use serde::Serialize;
use specta::Type;

/// The domain conditions this app distinguishes, and the contract the webview branches on.
///
/// A code exists when something downstream would genuinely do a different thing about it — point
/// the reader at Setup, offer to try again, put the message beside the query editor. A condition
/// nobody would act on differently is [`FailureCode::Internal`] and stays there; adding a variant
/// nothing branches on is how an error enum grows into a second copy of the log.
///
/// Serialized as `camelCase`, like every other name crossing this boundary, and generated into
/// `bindings.ts` as a union — so a code the frontend no longer handles, or one it invents, is a
/// type error rather than a comparison that quietly never matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FailureCode {
    /// Nothing has said where the game is yet. The reader has to go to Setup, and until they do
    /// this is not a fault to report — it is the state a fresh install is in.
    NotConfigured,
    /// A folder was chosen and it is not a World of Warcraft install, or the install has moved
    /// out from under a path that was right when it was saved.
    InstallNotFound,
    /// The game's own storage would not answer. Ordinarily temporary and ordinarily nobody's
    /// mistake: the client rewrites `.build.info` and the index files while it patches, and a
    /// read landing in that window sees a half-written build. Worth trying again.
    GameFilesUnreadable,
    /// Something else holds the history right now — a sync writing while the window reads, or a
    /// second copy of the app. Also worth trying again.
    HistoryBusy,
    /// The history was written by a newer Chronie than this one. Trying again will not help and
    /// neither will anything else this build can do; the app has to be updated.
    HistoryTooNew,
    /// What was asked for cannot be run as asked — a query that writes, two statements where one
    /// was allowed, a value out of range. The reader's own input is what has to change, which is
    /// why the message belongs beside the thing they typed rather than in an alert.
    InvalidInput,
    /// What was asked for is not there. Distinct from a fault, because an id that has gone is an
    /// ordinary thing for a window holding a list from a minute ago.
    NotFound,
    /// Everything nobody has given a name yet. Reported, logged, and not branched on.
    Internal,
}

impl FailureCode {
    /// Every code, so a test can walk them and nothing can be added without being considered.
    pub const ALL: [FailureCode; 8] = [
        FailureCode::NotConfigured,
        FailureCode::InstallNotFound,
        FailureCode::GameFilesUnreadable,
        FailureCode::HistoryBusy,
        FailureCode::HistoryTooNew,
        FailureCode::InvalidInput,
        FailureCode::NotFound,
        FailureCode::Internal,
    ];

    /// The wire name, for the log line. Serde produces the same string for the webview, and
    /// `the_wire_name_matches_what_serde_writes` is what keeps the two from drifting.
    pub const fn name(self) -> &'static str {
        match self {
            FailureCode::NotConfigured => "notConfigured",
            FailureCode::InstallNotFound => "installNotFound",
            FailureCode::GameFilesUnreadable => "gameFilesUnreadable",
            FailureCode::HistoryBusy => "historyBusy",
            FailureCode::HistoryTooNew => "historyTooNew",
            FailureCode::InvalidInput => "invalidInput",
            FailureCode::NotFound => "notFound",
            FailureCode::Internal => "internal",
        }
    }

    /// Whether doing exactly the same thing again could reasonably work.
    ///
    /// Two of these are races against something else holding what was wanted, and the answer to a
    /// race is to ask again. The rest need somebody to change something first, and a window
    /// offering "try again" for those is a window lying to whoever clicks it.
    pub const fn retryable(self) -> bool {
        matches!(
            self,
            FailureCode::GameFilesUnreadable | FailureCode::HistoryBusy
        )
    }

    /// What to say when the failure site had nothing better.
    ///
    /// A caller that knows more says more — [`Failure::new`] is the way to write the sentence that
    /// belongs to one particular condition. These are the fallbacks, and they are written rather
    /// than generated so that the worst case is still a sentence somebody chose.
    pub const fn sentence(self) -> &'static str {
        match self {
            FailureCode::NotConfigured => "Choose the game folder in Setup first.",
            FailureCode::InstallNotFound => {
                "Chronie could not find World of Warcraft where Setup says it is."
            }
            FailureCode::GameFilesUnreadable => {
                "Chronie could not read the game's files. If the game is updating, try again \
                 once it has finished."
            }
            FailureCode::HistoryBusy => "Chronie's history is busy. Try again in a moment.",
            FailureCode::HistoryTooNew => {
                "This history was written by a newer version of Chronie. Update Chronie to \
                 open it."
            }
            FailureCode::InvalidInput => "Chronie could not use that.",
            FailureCode::NotFound => "Chronie could not find that.",
            FailureCode::Internal => "Chronie hit a problem it did not expect.",
        }
    }
}

/// One failure, with everything known about it still attached.
///
/// Not an enum whose variants each carry their own fields, which is the shape this would take
/// with `thiserror`, and deliberately so: the interesting axis here is not "which of eleven
/// errors" but "what was being done when it happened", and that is a list which grows on the way
/// up rather than a variant chosen at the bottom. A struct lets [`Context::context`] add to a
/// failure it did not create without every layer having to know a variant to re-wrap it in.
#[derive(Debug)]
pub struct Failure {
    code: FailureCode,
    message: String,
    /// Everything known about this that the window is not being told: what was being attempted,
    /// innermost first, and any message a reclassification replaced. Log-only — this is where the
    /// path, the file id and the statement live, and none of them are the window's business.
    notes: Vec<String>,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl Failure {
    /// A failure of `code`, saying `message` to whoever ends up reading it.
    pub fn new(code: FailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            notes: Vec::new(),
            source: None,
        }
    }

    /// A failure of `code` saying the sentence that code was given.
    pub fn of(code: FailureCode) -> Self {
        Self::new(code, code.sentence())
    }

    /// The same failure, carrying `error` as what it started as.
    pub fn caused_by(mut self, error: impl Error + Send + Sync + 'static) -> Self {
        self.source = Some(Box::new(error));
        self
    }

    /// The same failure, knowing one more thing about what was going on.
    ///
    /// Called on the way up, so the operations read innermost first — `reading file 1376213`,
    /// then `opening the game's storage`, then `drawing the character`. Nothing is deduplicated
    /// and nothing is truncated: a chain that is repetitive is telling you the call graph is.
    pub fn context(mut self, operation: impl Into<String>) -> Self {
        self.notes.push(format!("while {}", operation.into()));
        self
    }

    /// Names the condition, if nothing below has already named it.
    ///
    /// For the layer that can recognise something the layer beneath it could not: a `String` from
    /// somewhere not yet migrated arrives as [`FailureCode::Internal`], and the caller that knows
    /// it was opening the game's storage knows what that means. A failure that already has a code
    /// keeps it, so a specific answer found deep down is never coarsened by something above.
    ///
    /// The sentence being replaced is not thrown away. It was the most specific thing anybody knew
    /// about this failure, and it goes to the front of the notes — which is how
    /// `No Data folder under /Applications/World of Warcraft` stays in the log while the window is
    /// told something it can act on. Unless it was only [`FailureCode::Internal`]'s own fallback,
    /// which nobody wrote about anything and which would be a line of noise in every report.
    pub fn or_code(mut self, code: FailureCode) -> Self {
        if self.code == FailureCode::Internal {
            self.code = code;
            let replaced = std::mem::replace(&mut self.message, code.sentence().to_string());
            if replaced != FailureCode::Internal.sentence() {
                self.notes.insert(0, replaced);
            }
        }
        self
    }

    /// The condition, for whoever has to decide what to do next.
    pub const fn code(&self) -> FailureCode {
        self.code
    }

    /// The sentence written for whoever reads it.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The whole account, for the log: the message, what was being done, and every cause under it.
    ///
    /// One line, because the log this goes to is one stamped line per entry, and separated by
    /// `: ` in the order a reader wants them — what failed, then what it was doing, then why.
    pub fn report(&self) -> String {
        let mut parts = vec![format!("[{}] {}", self.code.name(), self.message)];
        parts.extend(self.notes.iter().cloned());
        let mut cause = self.source.as_deref().map(|error| error as &dyn Error);
        while let Some(error) = cause {
            parts.push(error.to_string());
            cause = error.source();
        }
        parts.join(": ")
    }
}

/// The message, and only the message. [`Failure::report`] is the one that says everything.
///
/// Which matters more than it looks: `to_string()` on a failure is what a caller reaches for by
/// habit, and every one of those in the old code was how implementation wording reached the
/// screen. Here it can only ever produce the sentence somebody wrote.
impl Display for Failure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.message)
    }
}

impl Error for Failure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source.as_deref().map(|error| error as &dyn Error)
    }
}

/// A string that was already a failure's whole story.
///
/// The bridge for everything not yet migrated. It keeps the sentence exactly as it was — several
/// of those sentences carry the only recovery instruction the app gives anywhere — and files it
/// under [`FailureCode::Internal`], which is the truth: nobody has said what kind of thing it is
/// yet.
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::new(FailureCode::Internal, message)
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Self::new(FailureCode::Internal, message)
    }
}

/// SQLite's own errors, kept as causes rather than flattened into messages.
///
/// The code is read off the error code where SQLite is specific enough to be worth trusting —
/// `SQLITE_BUSY` and `SQLITE_LOCKED` are the two that mean "somebody else has it, ask again" —
/// and everything else stays [`FailureCode::Internal`] with the driver's wording safely in the
/// source chain instead of on screen.
impl From<rusqlite::Error> for Failure {
    fn from(error: rusqlite::Error) -> Self {
        let code = match error.sqlite_error_code() {
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
                FailureCode::HistoryBusy
            }
            _ => FailureCode::Internal,
        };
        Self::of(code).caused_by(error)
    }
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self::of(FailureCode::Internal).caused_by(error)
    }
}

/// Tauri's own, which is what a `spawn_blocking` that never came back answers with.
///
/// Always [`FailureCode::Internal`]: a blocking task failing to join means it panicked or the
/// runtime went away, and neither is a condition a reader can be told anything useful about beyond
/// that something went wrong. The panic's own message is in the source chain, where the log gets it.
impl From<tauri::Error> for Failure {
    fn from(error: tauri::Error) -> Self {
        Self::of(FailureCode::Internal).caused_by(error)
    }
}

impl From<serde_json::Error> for Failure {
    fn from(error: serde_json::Error) -> Self {
        Self::of(FailureCode::Internal).caused_by(error)
    }
}

/// Saying what a `?` was doing, at the call rather than at the failure site.
///
/// This is the half that makes typed errors worth having. `open_database(path)?` knows the
/// operation and not the cause; `Connection::open` knows the cause and not the operation. The
/// trait lets the caller add its half without unwrapping, rewrapping or naming a variant.
pub trait Context<T> {
    /// Attaches what was being attempted.
    fn context(self, operation: impl Into<String>) -> Result<T, Failure>;

    /// Attaches what was being attempted, computing the description only if it is needed.
    ///
    /// For the ones that would otherwise format a path or a file id on every successful call —
    /// which, in the loop that reads a few hundred game files to draw one character, is a few
    /// hundred allocations nobody reads.
    fn with_context<S: Into<String>>(self, operation: impl FnOnce() -> S) -> Result<T, Failure>;

    /// Names the condition, if nothing below has already named it.
    fn or_code(self, code: FailureCode) -> Result<T, Failure>;
}

impl<T, E: Into<Failure>> Context<T> for Result<T, E> {
    fn context(self, operation: impl Into<String>) -> Result<T, Failure> {
        self.map_err(|error| error.into().context(operation))
    }

    fn with_context<S: Into<String>>(self, operation: impl FnOnce() -> S) -> Result<T, Failure> {
        self.map_err(|error| error.into().context(operation().into()))
    }

    fn or_code(self, code: FailureCode) -> Result<T, Failure> {
        self.map_err(|error| error.into().or_code(code))
    }
}

/// What a command hands back to the webview when it could not do what was asked.
///
/// Three fields, all meant to be read: a code to branch on, a sentence to show, and whether
/// offering to try again would be honest. No path, no SQLite wording, no operation list — those
/// went to the log, which is where the person diagnosing it is looking and where a screenshot of
/// an alert cannot leak them from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    /// The condition. Stable, and the only part of this the frontend may switch on.
    pub code: FailureCode,
    /// The sentence to put in front of whoever is looking at the window.
    pub message: String,
    /// Whether offering to try the same thing again would be honest.
    pub retryable: bool,
}

/// The boundary itself: a failure becomes a code and a sentence, and its full account is logged.
///
/// Every `?` in a command goes through here, which is why the logging lives here rather than in
/// each command — there is exactly one place a failure can leave the backend, and it is this one.
impl From<Failure> for CommandError {
    fn from(failure: Failure) -> Self {
        report(&failure.report());
        Self {
            code: failure.code,
            message: failure.message,
            retryable: failure.code.retryable(),
        }
    }
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Failure::from(message).into()
    }
}

impl From<&str> for CommandError {
    fn from(message: &str) -> Self {
        Failure::from(message).into()
    }
}

impl Display for CommandError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.message)
    }
}

/// Where the full account of a failure goes as it crosses the boundary.
///
/// A function pointer set once at startup rather than only a `tracing` event, because nothing
/// installs a subscriber in the shipped app — `tracing` is here for spans that
/// `examples/trace_render` collects, and an `error!` in a release build is a branch on a global
/// and then nothing. `run()` points this at the same `chronie.log` the startup lines go to, which
/// is the file somebody is asked for when the window says something went wrong.
///
/// A `OnceLock`, so there is no window in which two threads disagree about the sink and no test
/// can change it out from under another one. Unset in the test binary and in every example, where
/// the report is a return value and a file would only be litter.
static SINK: OnceLock<fn(&str)> = OnceLock::new();

/// Points every future report at `sink`. The first call wins; later ones are ignored.
pub fn report_failures_to(sink: fn(&str)) {
    let _ = SINK.set(sink);
}

fn report(account: &str) {
    tracing::error!(account, "command failed");
    if let Some(sink) = SINK.get() {
        sink(account);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The claim the webview depends on: a code it can compare against and a sentence it can
    /// show, and nothing from underneath either of them.
    #[test]
    fn a_command_error_carries_the_code_the_sentence_and_nothing_else() {
        let failure = Failure::new(
            FailureCode::HistoryTooNew,
            "Update Chronie to open this history.",
        )
        .caused_by(rusqlite::Error::ExecuteReturnedResults)
        .context("migrating /Users/someone/history.sqlite3");

        let crossed = CommandError::from(failure);

        assert_eq!(
            crossed,
            CommandError {
                code: FailureCode::HistoryTooNew,
                message: "Update Chronie to open this history.".to_string(),
                retryable: false,
            }
        );
    }

    /// Serialized, because it is the serialized form the frontend reads and `camelCase` is the
    /// contract the rest of this boundary keeps.
    #[test]
    fn a_command_error_serializes_to_a_code_a_message_and_a_retry_flag() {
        let crossed = CommandError::from(Failure::of(FailureCode::GameFilesUnreadable));

        assert_eq!(
            serde_json::to_value(&crossed).unwrap(),
            serde_json::json!({
                "code": "gameFilesUnreadable",
                "message": "Chronie could not read the game's files. If the game is updating, \
                            try again once it has finished.",
                "retryable": true,
            })
        );
    }

    /// The log line names the code with [`FailureCode::name`] and the webview gets whatever serde
    /// writes. Two spellings of one contract, so they are held against each other here.
    #[test]
    fn the_wire_name_matches_what_serde_writes() {
        for code in FailureCode::ALL {
            assert_eq!(
                serde_json::to_value(code).unwrap(),
                serde_json::Value::String(code.name().to_string()),
                "{code:?}"
            );
        }
    }

    /// Every code says something a person could read, and none of them leaks the enum's own
    /// spelling into a window.
    #[test]
    fn every_code_has_a_sentence_written_for_a_person() {
        for code in FailureCode::ALL {
            let sentence = code.sentence();
            assert!(sentence.ends_with('.'), "{code:?}: {sentence}");
            assert!(!sentence.contains(code.name()), "{code:?}: {sentence}");
        }
    }

    /// What the old `error.to_string()` threw away: three layers of "what was being done" and the
    /// driver's own words underneath them, all in one line.
    #[test]
    fn a_report_keeps_every_operation_and_every_cause() {
        let inner = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let failure = Failure::of(FailureCode::GameFilesUnreadable)
            .caused_by(inner)
            .context("reading file 1376213")
            .context("opening the game's storage")
            .context("drawing a character");

        assert_eq!(
            failure.report(),
            "[gameFilesUnreadable] Chronie could not read the game's files. If the game is \
             updating, try again once it has finished.: while reading file 1376213: while \
             opening the game's storage: while drawing a character: access denied"
        );
    }

    /// `?` through three functions, each adding its own half, with no `map_err` anywhere.
    #[test]
    fn context_accumulates_through_the_question_marks() {
        fn innermost() -> Result<(), std::io::Error> {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no such file",
            ))
        }
        fn middle() -> Result<(), Failure> {
            innermost().context("reading `.build.info`")?;
            Ok(())
        }
        fn outermost() -> Result<(), Failure> {
            middle()
                .or_code(FailureCode::GameFilesUnreadable)
                .context("opening the install")?;
            Ok(())
        }

        let failure = outermost().unwrap_err();

        assert_eq!(failure.code(), FailureCode::GameFilesUnreadable);
        assert_eq!(
            failure.report(),
            "[gameFilesUnreadable] Chronie could not read the game's files. If the game is \
             updating, try again once it has finished.: while reading `.build.info`: while \
             opening the install: no such file"
        );
    }

    /// A code found deep down survives a caller that guesses at a coarser one, because the deeper
    /// answer is the better one.
    #[test]
    fn or_code_does_not_overwrite_a_code_something_already_knew() {
        let known = Failure::of(FailureCode::HistoryTooNew).or_code(FailureCode::HistoryBusy);

        assert_eq!(known.code(), FailureCode::HistoryTooNew);
        assert_eq!(known.message(), FailureCode::HistoryTooNew.sentence());
    }

    /// Reclassifying replaces the sentence the window sees and keeps the one it replaced, which is
    /// the difference between giving somebody advice they can act on and losing the only line that
    /// said which folder was actually looked in.
    #[test]
    fn or_code_keeps_the_sentence_it_replaced_for_the_log() {
        let opening = Failure::from(
            "No Data folder under /Applications/World of Warcraft; that is where the game keeps \
             its files."
                .to_string(),
        )
        .or_code(FailureCode::GameFilesUnreadable)
        .context("drawing a character");

        assert_eq!(
            opening.message(),
            FailureCode::GameFilesUnreadable.sentence()
        );
        assert_eq!(
            opening.report(),
            "[gameFilesUnreadable] Chronie could not read the game's files. If the game is \
             updating, try again once it has finished.: No Data folder under /Applications/World \
             of Warcraft; that is where the game keeps its files.: while drawing a character"
        );
    }

    /// The sentences that already carried recovery instructions have to arrive unchanged, which is
    /// the whole reason a `String` converts rather than being refused.
    #[test]
    fn a_string_failure_keeps_its_sentence_word_for_word() {
        let crossed = CommandError::from("Choose the game folder in Setup first.".to_string());

        assert_eq!(crossed.code, FailureCode::Internal);
        assert_eq!(crossed.message, "Choose the game folder in Setup first.");
    }

    /// SQLite says "somebody else has this" with an error code, and that is the one place its own
    /// classification is worth reading. Its wording still never leaves the log.
    #[test]
    fn a_busy_database_is_recognised_from_sqlites_own_code() {
        let busy = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::DatabaseBusy,
                extended_code: 5,
            },
            Some("database is locked".to_string()),
        );

        let failure = Failure::from(busy);

        assert_eq!(failure.code(), FailureCode::HistoryBusy);
        assert_eq!(failure.message(), FailureCode::HistoryBusy.sentence());
        assert!(failure.report().contains("database is locked"));
    }
}
