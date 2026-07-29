//! Asking the history a question nobody wrote a screen for.
//!
//! Every other view in this app answers a question somebody anticipated: what happened on
//! Tuesday, who it happened to, what the wardrobe holds. The store underneath them is a
//! perfectly ordinary SQLite database with thirty-odd tables in it, and the questions it can
//! answer are not the five the window has tabs for — "how much gold per hour by instance",
//! "which weeks did I actually raid", "what is the median length of a keystone run" — so this
//! hands the database over and gets out of the way.
//!
//! Handing a database over is where the care goes. Three things stand between a typed query
//! and the history it reads:
//!
//! - **It has to be a read.** The opening keyword is checked against a list of four, the
//!   connection is put in `query_only`, and the prepared statement is asked whether SQLite
//!   agrees it writes nothing. Any one of those would stop an `UPDATE`; the keyword check is
//!   the one that also stops `ATTACH`, `VACUUM` and the pragmas that quietly reconfigure a
//!   file — statements SQLite itself is happy to call read-only.
//! - **It has to be one query.** SQLite prepares the first statement of a string and ignores
//!   the rest, which means a second statement after a semicolon would sit there looking like
//!   it ran. Better to say so than to silently drop it.
//! - **It has to finish.** A join somebody did not mean is a cross join, and a cross join over
//!   two of these tables is minutes of a spinning window. A progress handler interrupts
//!   anything still going after [`TIME_BUDGET`], and only a bounded number of rows is carried
//!   back however many the query matched.
//!
//! None of this is a security boundary — it is the reader's own database on the reader's own
//! machine, and they may open it with any tool they like. It is there so that a typo in a
//! `WHERE` clause cannot cost somebody their history, and so that a mistake reads as a
//! sentence rather than as a frozen window.

use rusqlite::types::ValueRef;
use rusqlite::{Connection, ErrorCode};
use serde::Serialize;
use serde_json::{Number, Value};
use std::path::Path;
use std::time::{Duration, Instant};

/// How long a query may run before it is interrupted.
///
/// Long enough that a full-table sweep over a few years of segments finishes comfortably, short
/// enough that a mistake is a sentence on screen rather than a window somebody force-quits.
pub const TIME_BUDGET: Duration = Duration::from_secs(10);

/// The most rows one answer may carry back, whatever the caller asks for.
///
/// The answer crosses the IPC bridge as JSON and is then held in the page as a table, so this
/// is a ceiling on memory in two processes at once. A reader who genuinely wants a hundred
/// thousand rows wants an aggregate, and this is the number that says so.
pub const MAX_ROWS: usize = 5_000;

/// The most characters one text cell carries.
///
/// `metadata_json` columns hold entire documents. A table cell cannot show one, the bridge
/// should not carry a megabyte of it per row, and a reader who wants the document can select
/// the one row it belongs to — so a long value is clipped, visibly, with an ellipsis.
const MAX_TEXT: usize = 2_000;

/// How often SQLite is asked whether the query has outstayed its welcome. Virtual-machine
/// steps, not rows: a query that matches nothing can still be doing an enormous amount of work.
const PROGRESS_STEPS: i32 = 10_000;

/// What a query answered, in the shape a table on screen needs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// The column names as SQLite named them — an expression nobody aliased is named after
    /// itself, which is exactly what the reader typed and is why they are passed through.
    pub columns: Vec<String>,
    /// Row-major, one JSON value per cell: numbers stay numbers so a chart can plot them
    /// without parsing text back into figures.
    pub rows: Vec<Vec<Value>>,
    /// True when the query had more to say than the limit allowed. Reported rather than
    /// hidden: a chart drawn from the first five hundred of eight thousand rows is a lie
    /// unless the page can say so.
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// What is in the database, so that somebody can write a query without reading the migrations.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    pub tables: Vec<Table>,
}

/// One table or view, with the columns a query may name.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub name: String,
    /// `true` for a view, which has columns and no rows of its own to count.
    pub view: bool,
    /// How many rows it holds. `None` for a view, where the count would mean running whatever
    /// the view is made of, and this is a list drawn beside an editor rather than a report.
    pub row_count: Option<i64>,
    pub columns: Vec<Column>,
}

/// One column, as the table declared it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// The declared type — `INTEGER`, `TEXT`, and empty for the columns that have none.
    pub kind: String,
    pub primary_key: bool,
}

/// The words a statement may start with.
///
/// `EXPLAIN` is here because `EXPLAIN QUERY PLAN` is how somebody works out why their query is
/// slow, and refusing it would make this a worse tool for the one person most likely to need
/// it. Everything else — `PRAGMA`, `ATTACH`, `VACUUM`, and every statement that obviously
/// writes — is turned away by name, before SQLite is asked to have an opinion.
const OPENERS: [&str; 4] = ["SELECT", "WITH", "VALUES", "EXPLAIN"];

/// Runs one read against the history and answers with at most `limit` rows.
pub fn run(database_path: &Path, sql: &str, limit: usize) -> Result<Answer, String> {
    run_within(database_path, sql, limit, TIME_BUDGET)
}

/// The same read, with the clock that stops it handed in rather than assumed.
///
/// [`run`] passes [`TIME_BUDGET`], which is the only budget the window ever wants. A test
/// that wants to watch a runaway query be interrupted wants it interrupted now: sitting
/// through ten real seconds of `WITH RECURSIVE` proves nothing that the same interrupt at
/// fifty milliseconds does not, and it did it in every CI run.
pub fn run_within(
    database_path: &Path,
    sql: &str,
    limit: usize,
    budget: Duration,
) -> Result<Answer, String> {
    let statement = single_statement(sql)?;
    let opener = opening_word(statement);
    if !OPENERS.contains(&opener.as_str()) {
        return Err(format!(
            "Chronie only runs queries that read. Start with SELECT or WITH — \"{opener}\" would change the history rather than ask it something."
        ));
    }
    let wanted = limit.clamp(1, MAX_ROWS);

    let connection = open_reading(database_path)?;
    let deadline = Instant::now() + budget;
    connection.progress_handler(PROGRESS_STEPS, Some(move || Instant::now() > deadline));

    let started = Instant::now();
    let mut prepared = connection
        .prepare(statement)
        .map_err(|error| explain(&error, budget))?;
    if !prepared.readonly() {
        return Err("That statement would change the history, so Chronie did not run it.".into());
    }
    // A query with a `?` in it has nothing to bind to here, and SQLite would answer it with
    // NULL rather than complain — which looks like a working query returning empty rows.
    if prepared.parameter_count() > 0 {
        return Err(
            "That query is waiting for a value to be bound to a placeholder. Write the value into the query itself.".into(),
        );
    }
    let columns: Vec<String> = prepared
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();

    let mut rows = Vec::new();
    let mut truncated = false;
    let mut cursor = prepared
        .query([])
        .map_err(|error| explain(&error, budget))?;
    // One row past the limit, so "there was more" is something that was observed rather than
    // guessed at from a full page.
    while let Some(row) = cursor.next().map_err(|error| explain(&error, budget))? {
        if rows.len() == wanted {
            truncated = true;
            break;
        }
        rows.push(
            (0..columns.len())
                .map(|at| row.get_ref(at).map(cell).map_err(|error| error.to_string()))
                .collect::<Result<Vec<Value>, String>>()?,
        );
    }

    Ok(Answer {
        columns,
        rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Every table and view in the database, with their columns and — for the tables — how much
/// is in them.
pub fn schema(database_path: &Path) -> Result<Schema, String> {
    let connection = open_reading(database_path)?;
    let mut listing = connection
        .prepare(
            "SELECT name, type FROM sqlite_schema
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .map_err(|error| error.to_string())?;
    let named: Vec<(String, String)> = listing
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    drop(listing);

    // The table-valued form of `PRAGMA table_info`, so the table's name is bound rather than
    // pasted into a statement — the pragma statement itself takes no parameters.
    let mut describing = connection
        .prepare("SELECT name, type, pk FROM pragma_table_info(?1)")
        .map_err(|error| error.to_string())?;

    let mut tables = Vec::with_capacity(named.len());
    for (name, kind) in named {
        let view = kind == "view";
        let columns = describing
            .query_map([&name], |row| {
                Ok(Column {
                    name: row.get(0)?,
                    kind: row.get::<_, String>(1)?.to_uppercase(),
                    primary_key: row.get::<_, i64>(2)? > 0,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<Column>, _>>()
            .map_err(|error| error.to_string())?;
        // Counted per table rather than in one statement, because the names are only known
        // once the listing has been read and a count has to name its table literally.
        let row_count = if view {
            None
        } else {
            connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {}", quoted(&name)),
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .ok()
        };
        tables.push(Table {
            name,
            view,
            row_count,
            columns,
        });
    }
    Ok(Schema { tables })
}

/// A connection that cannot write, whatever is asked of it.
///
/// Deliberately not opened with `SQLITE_OPEN_READ_ONLY`: the database runs in WAL mode, and a
/// read-only connection to one needs the shared-memory file to already exist and be writable,
/// so the honest-looking flag is the one that fails on a machine where the app has not yet
/// written anything. `query_only` is SQLite's own switch for the same intent and holds
/// whatever mode the file is in.
fn open_reading(database_path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(database_path)
        .map_err(|error| format!("Could not open the history: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA query_only = ON;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

/// The one statement in `sql`, with its trailing semicolon removed.
///
/// SQLite prepares the first statement of a string and ignores everything after it, so a
/// second statement would look like it ran and would not have. Finding the semicolon means
/// stepping over the places one can legitimately appear — inside a string, inside a quoted
/// identifier, inside a comment — which is why this is a scanner rather than a `split(';')`.
pub fn single_statement(sql: &str) -> Result<&str, String> {
    let trimmed = sql.trim();
    if blank(trimmed) {
        return Err("Write a query first.".into());
    }
    let bytes = trimmed.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'\'' | b'"' | b'`' => at = past_quoted(bytes, at, bytes[at])?,
            b'[' => at = past_quoted(bytes, at, b']')?,
            b'-' if bytes.get(at + 1) == Some(&b'-') => at = past_line_comment(bytes, at),
            b'/' if bytes.get(at + 1) == Some(&b'*') => at = past_block_comment(bytes, at),
            b';' => {
                let rest = &trimmed[at + 1..];
                if !blank(rest) {
                    return Err(
                        "Chronie runs one query at a time, and there is a second statement after the semicolon.".into(),
                    );
                }
                return Ok(trimmed[..at].trim_end());
            }
            _ => at += 1,
        }
    }
    Ok(trimmed)
}

/// Whether what is left is only whitespace and comments — which is what a trailing semicolon,
/// or a query somebody has commented out entirely, leaves behind.
fn blank(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'-' if bytes.get(at + 1) == Some(&b'-') => at = past_line_comment(bytes, at),
            b'/' if bytes.get(at + 1) == Some(&b'*') => at = past_block_comment(bytes, at),
            byte if byte.is_ascii_whitespace() => at += 1,
            _ => return false,
        }
    }
    true
}

/// Steps over a quoted run, doubling — `'it''s'` — being an escape rather than an end.
fn past_quoted(bytes: &[u8], opens_at: usize, closer: u8) -> Result<usize, String> {
    let mut at = opens_at + 1;
    while at < bytes.len() {
        if bytes[at] == closer {
            if bytes.get(at + 1) == Some(&closer) {
                at += 2;
                continue;
            }
            return Ok(at + 1);
        }
        at += 1;
    }
    Err("That query has a quote that is never closed.".into())
}

fn past_line_comment(bytes: &[u8], at: usize) -> usize {
    bytes[at..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(bytes.len(), |offset| at + offset + 1)
}

/// An unterminated block comment runs to the end, which is what SQLite itself does with one.
fn past_block_comment(bytes: &[u8], at: usize) -> usize {
    bytes[at + 2..]
        .windows(2)
        .position(|pair| pair == b"*/")
        .map_or(bytes.len(), |offset| at + 2 + offset + 2)
}

/// The first bare word of a statement, upper-cased, with any leading comments stepped over.
fn opening_word(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        let stripped = if rest.starts_with("--") {
            rest.find('\n').map(|at| &rest[at + 1..]).unwrap_or("")
        } else if rest.starts_with("/*") {
            rest.find("*/").map(|at| &rest[at + 2..]).unwrap_or("")
        } else {
            return rest
                .split(|c: char| !c.is_ascii_alphabetic())
                .next()
                .unwrap_or("")
                .to_uppercase();
        };
        rest = stripped.trim_start();
    }
}

/// A name put into a statement literally, quoted the way SQLite quotes identifiers.
fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// One cell as JSON.
///
/// Integers and reals stay numbers, because the whole point of the chart beside the table is
/// that a column of figures can be plotted without being parsed back out of text.
fn cell(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::from(number),
        // A NaN or an infinity has no JSON to be written as. Null is what SQLite would have
        // said about a value it could not compute, and is the only honest stand-in here.
        ValueRef::Real(number) => Number::from_f64(number).map_or(Value::Null, Value::Number),
        ValueRef::Text(bytes) => Value::String(clipped(&String::from_utf8_lossy(bytes))),
        // Nothing in this schema stores one, but a query can make one — `randomblob`, or a
        // `CAST`. Its size is the only thing about it a table cell could usefully say.
        ValueRef::Blob(bytes) => Value::String(format!("⟨{} bytes⟩", bytes.len())),
    }
}

fn clipped(text: &str) -> String {
    if text.chars().count() <= MAX_TEXT {
        return text.to_string();
    }
    text.chars().take(MAX_TEXT).collect::<String>() + "…"
}

/// What went wrong, in words a reader can act on.
///
/// SQLite's own messages are the best thing to show for a mistake in a query — "no such
/// column: charater" says exactly what to fix — so they are passed through. The interrupt is
/// the one that needs translating: it reads as "interrupted", which says nothing about who
/// interrupted it or why.
fn explain(error: &rusqlite::Error, budget: Duration) -> String {
    if error.sqlite_error_code() == Some(ErrorCode::OperationInterrupted) {
        return format!(
            "That query was still running after {} seconds, so Chronie stopped it. Narrow it down — a WHERE clause, or a LIMIT.",
            budget.as_secs()
        );
    }
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A database with the shape of the real one's segments, and nothing else in it: every
    /// question here is about the gate in front of SQLite rather than about the history.
    fn history() -> (TempDir, std::path::PathBuf) {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("chronie.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE segments (
                     id INTEGER PRIMARY KEY,
                     instance_name TEXT NOT NULL,
                     duration_seconds INTEGER NOT NULL,
                     loot_value INTEGER NOT NULL DEFAULT 0,
                     note TEXT
                 );
                 CREATE VIEW long_ones AS SELECT * FROM segments WHERE duration_seconds > 100;
                 INSERT INTO segments (instance_name, duration_seconds, loot_value, note) VALUES
                     ('Ara-Kara', 1800, 4500, 'a good one'),
                     ('Ara-Kara', 900, 100, NULL),
                     ('Dawnbreaker', 2400, 9000, NULL);",
            )
            .unwrap();
        (directory, path)
    }

    fn ask(sql: &str) -> Result<Answer, String> {
        let (_held, path) = history();
        run(&path, sql, 500)
    }

    #[test]
    fn answers_with_the_columns_and_rows_a_select_asked_for() {
        let answer =
            ask("SELECT instance_name, duration_seconds FROM segments ORDER BY id").unwrap();
        assert_eq!(answer.columns, ["instance_name", "duration_seconds"]);
        assert_eq!(
            answer.rows,
            vec![
                vec![Value::from("Ara-Kara"), Value::from(1800)],
                vec![Value::from("Ara-Kara"), Value::from(900)],
                vec![Value::from("Dawnbreaker"), Value::from(2400)],
            ]
        );
        assert!(!answer.truncated);
    }

    /// The reason numbers are not stringified on the way over: the chart plots what it is given.
    #[test]
    fn keeps_numbers_as_numbers_and_nulls_as_null() {
        let answer =
            ask("SELECT AVG(duration_seconds), note FROM segments WHERE note IS NULL").unwrap();
        assert_eq!(answer.rows[0][0], Value::from(1650.0));
        assert_eq!(answer.rows[0][1], Value::Null);
    }

    #[test]
    fn stops_at_the_limit_and_says_that_it_did() {
        let (_held, path) = history();
        let answer = run(&path, "SELECT id FROM segments", 2).unwrap();
        assert_eq!(answer.rows.len(), 2);
        assert!(answer.truncated);
    }

    #[test]
    fn a_query_that_fits_is_not_reported_as_truncated() {
        let (_held, path) = history();
        let answer = run(&path, "SELECT id FROM segments", 3).unwrap();
        assert_eq!(answer.rows.len(), 3);
        assert!(!answer.truncated);
    }

    #[test]
    fn never_carries_back_more_than_the_ceiling() {
        let (_held, path) = history();
        let answer = run(
            &path,
            "WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter) SELECT n FROM counter",
            usize::MAX,
        )
        .unwrap();
        assert_eq!(answer.rows.len(), MAX_ROWS);
        assert!(answer.truncated);
    }

    #[test]
    fn refuses_every_statement_that_would_change_the_history() {
        for sql in [
            "DELETE FROM segments",
            "UPDATE segments SET loot_value = 0",
            "INSERT INTO segments (instance_name, duration_seconds) VALUES ('x', 1)",
            "DROP TABLE segments",
            "CREATE TABLE mine (id INTEGER)",
            "ALTER TABLE segments RENAME TO gone",
        ] {
            let refused = ask(sql).expect_err(sql);
            assert!(
                refused.contains("only runs queries that read"),
                "{sql}: {refused}"
            );
        }
    }

    /// The keyword check earns its keep here: SQLite calls all three of these read-only, and
    /// two of them change the file on disk.
    #[test]
    fn refuses_the_statements_sqlite_itself_calls_read_only() {
        for sql in [
            "PRAGMA journal_mode = DELETE",
            "VACUUM",
            "ATTACH '/tmp/other.db' AS other",
        ] {
            let refused = ask(sql).expect_err(sql);
            assert!(
                refused.contains("only runs queries that read"),
                "{sql}: {refused}"
            );
        }
    }

    #[test]
    fn the_history_is_untouched_by_a_refused_write() {
        let (_held, path) = history();
        assert!(run(&path, "DELETE FROM segments", 100).is_err());
        let answer = run(&path, "SELECT COUNT(*) FROM segments", 100).unwrap();
        assert_eq!(answer.rows[0][0], Value::from(3));
    }

    #[test]
    fn runs_an_explain_because_that_is_how_a_slow_query_is_understood() {
        let answer = ask("EXPLAIN QUERY PLAN SELECT * FROM segments").unwrap();
        assert!(!answer.rows.is_empty());
    }

    #[test]
    fn refuses_a_second_statement_rather_than_silently_dropping_it() {
        let refused = ask("SELECT 1; DELETE FROM segments").unwrap_err();
        assert!(refused.contains("one query at a time"), "{refused}");
    }

    #[test]
    fn a_trailing_semicolon_is_not_a_second_statement() {
        assert_eq!(ask("SELECT 1;").unwrap().rows, vec![vec![Value::from(1)]]);
        assert_eq!(
            ask("SELECT 1;  -- done\n").unwrap().rows,
            vec![vec![Value::from(1)]]
        );
    }

    #[test]
    fn a_semicolon_inside_a_string_is_part_of_the_string() {
        let answer = ask("SELECT 'one; two' AS said").unwrap();
        assert_eq!(answer.rows[0][0], Value::from("one; two"));
    }

    #[test]
    fn a_semicolon_inside_a_comment_is_not_a_statement_either() {
        let answer = ask("SELECT 1 -- ; DROP TABLE segments\n").unwrap();
        assert_eq!(answer.rows[0][0], Value::from(1));
        let block = ask("SELECT /* ; */ 2").unwrap();
        assert_eq!(block.rows[0][0], Value::from(2));
    }

    #[test]
    fn reads_past_a_leading_comment_to_find_the_keyword() {
        assert_eq!(
            ask("-- gold per instance\nSELECT 1").unwrap().rows[0][0],
            Value::from(1)
        );
        assert_eq!(
            ask("/* gold */ SELECT 2").unwrap().rows[0][0],
            Value::from(2)
        );
    }

    #[test]
    fn an_empty_query_is_asked_for_rather_than_run() {
        for sql in ["", "   \n  ", "-- nothing but a thought\n"] {
            assert!(
                ask(sql).unwrap_err().contains("Write a query first"),
                "{sql:?}"
            );
        }
    }

    #[test]
    fn a_placeholder_is_refused_rather_than_answered_with_nulls() {
        let refused = ask("SELECT * FROM segments WHERE id = ?").unwrap_err();
        assert!(refused.contains("placeholder"), "{refused}");
    }

    /// SQLite's own words, because "no such column: charater" is the whole answer.
    #[test]
    fn passes_sqlites_complaint_through_untranslated() {
        let refused = ask("SELECT charater FROM segments").unwrap_err();
        assert!(refused.contains("no such column: charater"), "{refused}");
    }

    #[test]
    fn stops_a_query_that_will_not_finish_and_says_who_stopped_it() {
        let (_held, path) = history();
        // Recursion with nothing to stop it and nothing to return: no row ever arrives, so the
        // row limit cannot end this and only the clock can.
        let refused = run_within(
            &path,
            "WITH RECURSIVE forever(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM forever)
             SELECT COUNT(*) FROM forever",
            10,
            Duration::from_millis(50),
        )
        .unwrap_err();
        assert!(refused.contains("still running"), "{refused}");
    }

    #[test]
    fn clips_a_cell_no_table_could_show() {
        let answer = ask("SELECT printf('%.*c', 5000, 'x') AS long").unwrap();
        let text = answer.rows[0][0].as_str().unwrap();
        assert_eq!(text.chars().count(), MAX_TEXT + 1);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn a_blob_is_described_rather_than_carried() {
        let answer = ask("SELECT randomblob(64) AS bytes").unwrap();
        assert_eq!(answer.rows[0][0], Value::from("⟨64 bytes⟩"));
    }

    #[test]
    fn describes_the_tables_a_query_could_name() {
        let (_held, path) = history();
        let schema = schema(&path).unwrap();
        let segments = schema
            .tables
            .iter()
            .find(|table| table.name == "segments")
            .unwrap();
        assert!(!segments.view);
        assert_eq!(segments.row_count, Some(3));
        assert_eq!(
            segments
                .columns
                .iter()
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>(),
            [
                "id",
                "instance_name",
                "duration_seconds",
                "loot_value",
                "note"
            ]
        );
        assert_eq!(segments.columns[0].kind, "INTEGER");
        assert!(segments.columns[0].primary_key);
        assert!(!segments.columns[1].primary_key);
    }

    /// A view is listed, because a query may name one, and is not counted, because counting it
    /// would mean running it.
    #[test]
    fn lists_views_without_counting_them() {
        let (_held, path) = history();
        let schema = schema(&path).unwrap();
        let view = schema
            .tables
            .iter()
            .find(|table| table.name == "long_ones")
            .unwrap();
        assert!(view.view);
        assert_eq!(view.row_count, None);
        assert_eq!(view.columns.len(), 5);
    }

    #[test]
    fn leaves_sqlites_own_bookkeeping_out_of_the_listing() {
        let (_held, path) = history();
        let schema = schema(&path).unwrap();
        assert!(!schema
            .tables
            .iter()
            .any(|table| table.name.starts_with("sqlite_")));
    }
}
