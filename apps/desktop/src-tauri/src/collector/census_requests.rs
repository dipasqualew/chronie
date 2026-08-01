//! The walks this app has asked the game to take, and what came of each.
//!
//! `census.rs` beside this receives what a walk *found*. This is the ask: a row recorded here, a
//! Lua file written into the addon's folder by the caller, and an answer that arrives at the next
//! logout like everything else. `censusrequests.rs` is the shape and the file;
//! `0026_census_requests.sql` is the argument for why the row outlives the file.

use super::database::open_database;
use crate::censusrequests::CensusRequest;
use rusqlite::{params, Connection, Transaction};
use std::path::Path;

use crate::failure::Failure;

/// Records a walk for the game to take, and answers with everything asked for so far.
///
/// An ask is *recorded* and not performed. Nothing here touches the game: the caller writes the
/// waiting requests into the addon's folder afterwards, and the addon carries them out the next
/// time the player logs in. That is the whole shape of this direction and the reason the row
/// outlives the file.
///
/// An empty `domains` is the ordinary case rather than a mistake — it is what the Resync button
/// sends, and it asks for every domain the addon can walk.
pub fn request_census(
    database_path: &Path,
    domains: &[String],
    now: i64,
) -> Result<Vec<CensusRequest>, Failure> {
    let mut connection = open_database(database_path)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction.execute(
        "INSERT INTO census_requests (created_at) VALUES (?1)",
        params![now],
    )?;
    let request_id = transaction.last_insert_rowid();
    for domain in domains {
        transaction.execute(
            "INSERT OR IGNORE INTO census_request_domains (request_id, domain) VALUES (?1, ?2)",
            params![request_id, domain],
        )?;
    }
    transaction.commit()?;
    read_requests(&connection, false)
}

/// Every walk this app has asked for, newest first.
pub fn census_requests(database_path: &Path) -> Result<Vec<CensusRequest>, Failure> {
    let connection = open_database(database_path)?;
    read_requests(&connection, false)
}

/// The ones still waiting to be seen, which is what gets written into the addon's folder.
pub fn waiting_census_requests(database_path: &Path) -> Result<Vec<CensusRequest>, Failure> {
    let connection = open_database(database_path)?;
    read_requests(&connection, true)
}

/// Marks the walks the addon has now taken, so the app stops asking for them.
///
/// The first write is the last one: `applied_at IS NULL` is the guard, so an addon that keeps
/// reporting the same outcome — which it does, because its own record outlives the request —
/// leaves the first answer standing rather than moving the moment forward on every login.
///
/// Nothing is checked about *which* account answered, the same as the set requests next door. A
/// census is a reading of one account, but a request names none, and having both rosters of a
/// two-account install walk every domain for one button press would be a minute of somebody's
/// evening spent twice.
pub(super) fn sync_census_request_outcomes(
    transaction: &Transaction<'_>,
    outcomes: &[(i64, String, Option<i64>, Vec<String>)],
    now: i64,
) -> Result<(), Failure> {
    for (id, outcome, at, walked) in outcomes {
        let changed = transaction.execute(
            "UPDATE census_requests
                 SET outcome = ?2, applied_at = COALESCE(?3, ?4)
                 WHERE id = ?1 AND applied_at IS NULL",
            // The addon's own moment where it gave one, and this sync's where it did not: a
            // request that has been answered has to carry a moment, or the guard above would let
            // the next sync answer it again.
            params![id, outcome, at, now],
        )?;
        // Only alongside the first answer. A second sync of the same file changes nothing above,
        // and rewriting what was walked would be writing the same rows over themselves forever.
        if changed == 0 {
            continue;
        }
        for domain in walked {
            transaction.execute(
                "INSERT OR IGNORE INTO census_request_walked (request_id, domain) VALUES (?1, ?2)",
                params![id, domain],
            )?;
        }
    }
    Ok(())
}

/// Reads requests, optionally only the unanswered ones, with their domains attached.
fn read_requests(
    connection: &Connection,
    waiting_only: bool,
) -> Result<Vec<CensusRequest>, Failure> {
    let sql = if waiting_only {
        "SELECT id, created_at, outcome, applied_at
         FROM census_requests WHERE applied_at IS NULL ORDER BY id"
    } else {
        "SELECT id, created_at, outcome, applied_at FROM census_requests ORDER BY id DESC"
    };
    let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| {
        Ok(CensusRequest {
            id: row.get(0)?,
            domains: Vec::new(),
            created_at: row.get(1)?,
            outcome: row.get(2)?,
            applied_at: row.get(3)?,
            walked: Vec::new(),
        })
    })?;
    let mut requests: Vec<CensusRequest> =
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;

    attach(
        connection,
        &mut requests,
        "SELECT request_id, domain FROM census_request_domains ORDER BY request_id, domain",
        |request| &mut request.domains,
    )?;
    attach(
        connection,
        &mut requests,
        "SELECT request_id, domain FROM census_request_walked ORDER BY request_id, domain",
        |request| &mut request.walked,
    )?;
    Ok(requests)
}

/// Hangs one table of domain names onto the requests they belong to.
///
/// The two lists are the same query against different tables and land on different fields, which
/// is exactly the shape a closure picking the field is for — two near-identical loops would be
/// two places to fix the next time a request grows a third list.
fn attach(
    connection: &Connection,
    requests: &mut [CensusRequest],
    sql: &str,
    field: impl Fn(&mut CensusRequest) -> &mut Vec<String>,
) -> Result<(), Failure> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (request_id, domain) = row?;
        if let Some(found) = requests.iter_mut().find(|request| request.id == request_id) {
            field(found).push(domain);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::collector::testing::*;

    /// An install whose database is standing and which nothing has ever synced into — which is
    /// what a request is made against on the day somebody installs the app, before the game has
    /// been played once.
    fn asked() -> Install {
        Install::initialized()
    }

    /// The whole of what an ask is: a row, the domains it named, and nothing said yet about what
    /// became of it. The answer comes back at the next logout, so a request that carried an
    /// outcome the moment it was made would be the app inventing a walk nobody took.
    #[test]
    fn records_a_walk_for_the_game_to_take() {
        let install = asked();

        let requests = request_census(
            &install.database,
            &["mounts".into(), "appearances".into()],
            10,
        )
        .unwrap();

        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].created_at, 10);
        // Alphabetical, which is the order the domains come back attached in and the only order
        // the storage promises — the ask is a set rather than a sequence.
        assert_eq!(
            requests[0].domains,
            vec!["appearances".to_string(), "mounts".to_string()]
        );
        assert_eq!(requests[0].outcome, None);
        assert_eq!(requests[0].applied_at, None);
        assert!(requests[0].walked.is_empty());
    }

    /// What the Resync button sends, and the ordinary case rather than a mistake: an ask that
    /// names no domain asks for every domain the addon can walk. A reader who pressed the button
    /// twice would otherwise see a request that looked like it had lost its subject.
    #[test]
    fn records_an_ask_that_names_no_domain() {
        let install = asked();

        let requests = request_census(&install.database, &[], 10).unwrap();

        assert_eq!(requests.len(), 1);
        assert!(requests[0].domains.is_empty());
        assert_eq!(requests[0].applied_at, None);
    }

    /// Newest first, because the one somebody just pressed the button for is the one the screen
    /// speaks about — `resyncOf` reads the head of this list and nothing else.
    #[test]
    fn hands_back_every_ask_newest_first() {
        let install = asked();
        request_census(&install.database, &["mounts".into()], 10).unwrap();
        let requests = request_census(&install.database, &["appearances".into()], 11).unwrap();

        assert_eq!(
            requests
                .iter()
                .map(|one| one.created_at)
                .collect::<Vec<_>>(),
            vec![11, 10]
        );
        assert_eq!(requests[0].domains, vec!["appearances".to_string()]);
        // The id crosses into the game's folder and comes back again, so two asks must never
        // share one: the addon remembers what it has already walked by exactly this number.
        assert_ne!(requests[0].id, requests[1].id);
        assert_eq!(census_requests(&install.database).unwrap(), requests);
    }

    /// Only the unanswered ones are written into the addon's folder. A walk the addon has
    /// already taken would otherwise be provoked again at every install, and a census is a
    /// minute of somebody's evening rather than a moment.
    #[test]
    fn writes_only_the_asks_still_waiting() {
        let install = asked();
        request_census(&install.database, &["mounts".into()], 10).unwrap();
        request_census(&install.database, &["appearances".into()], 11).unwrap();

        install.write(&SavedVariables::new().answered_census_requests(
            r#"[1] = { ["id"] = 1, ["outcome"] = "walked", ["at"] = 20,
                      ["domains"] = { "mounts" } },"#,
        ));
        install.collect(30);

        let waiting = waiting_census_requests(&install.database).unwrap();
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].created_at, 11);
        assert_eq!(waiting[0].domains, vec!["appearances".to_string()]);
    }

    /// The round trip, which is the only thing this pair of directions is for: an ask goes into
    /// the game's folder, the addon walks it, and what it says at logout lands on the row that
    /// asked.
    ///
    /// `applied_at` is the addon's own moment and not the sync's — the walk ended in the game,
    /// hours before the app noticed, and a screen saying "walked just now" because a file was
    /// read just now would be describing the collector rather than the census.
    #[test]
    fn files_what_the_addon_said_it_walked() {
        let install = asked();
        request_census(&install.database, &[], 10).unwrap();

        install.write(&SavedVariables::new().answered_census_requests(
            r#"[1] = { ["id"] = 1, ["outcome"] = "walked", ["at"] = 20,
                      ["domains"] = { "mounts", "appearances" } },"#,
        ));
        install.collect(2_000_000_000);

        let all = census_requests(&install.database).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].outcome.as_deref(), Some("walked"));
        assert_eq!(all[0].applied_at, Some(20));
        // What was actually walked, which is not always what was asked for: this ask named
        // nothing at all, and the addon answered with the domains its build could manage.
        assert_eq!(
            all[0].walked,
            vec!["appearances".to_string(), "mounts".to_string()]
        );
    }

    /// The addon's own record outlives the request, so it keeps reporting the same outcome at
    /// every logout for the rest of the year. The first answer is the one that stands —
    /// otherwise the moment the walk ended would creep forward every time the player logged in,
    /// and the walked list would be rewritten over itself forever.
    #[test]
    fn keeps_the_first_answer_an_ask_was_given() {
        let install = asked();
        request_census(&install.database, &[], 10).unwrap();
        let answered = SavedVariables::new().answered_census_requests(
            r#"[1] = { ["id"] = 1, ["outcome"] = "walked", ["at"] = 20,
                      ["domains"] = { "mounts", "appearances" } },"#,
        );

        install.write(&answered);
        install.collect(30);
        install.rewrite(&answered);
        install.collect(40);

        let all = census_requests(&install.database).unwrap();
        assert_eq!(all[0].applied_at, Some(20));
        assert_eq!(count_of(&install.database, "census_request_walked"), 2);
    }

    /// An addon that answered without saying when still has to leave a moment behind, because
    /// `applied_at IS NULL` is the whole of the guard above: a request answered with nothing in
    /// that column would be written back into the game's folder and walked again at the next
    /// login, forever.
    #[test]
    fn stamps_an_answer_that_carries_no_moment_with_the_syncs_own() {
        let install = asked();
        request_census(&install.database, &[], 10).unwrap();

        install.write(&SavedVariables::new().answered_census_requests(
            r#"[1] = { ["id"] = 1, ["outcome"] = "unknown", ["domains"] = { } },"#,
        ));
        install.collect(30);

        let all = census_requests(&install.database).unwrap();
        assert_eq!(all[0].outcome.as_deref(), Some("unknown"));
        assert_eq!(all[0].applied_at, Some(30));
        assert!(waiting_census_requests(&install.database)
            .unwrap()
            .is_empty());
    }

    /// A request this database has never heard of is what an addon carried over from another
    /// machine, or from a database somebody replaced, would report. It changes nothing rather
    /// than answering whichever row happens to hold that id here.
    #[test]
    fn ignores_an_answer_for_an_ask_it_never_made() {
        let install = asked();
        request_census(&install.database, &["mounts".into()], 10).unwrap();

        install.write(&SavedVariables::new().answered_census_requests(
            r#"[1] = { ["id"] = 99, ["outcome"] = "walked", ["at"] = 20,
                      ["domains"] = { "mounts" } },"#,
        ));
        install.collect(30);

        let all = census_requests(&install.database).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].applied_at, None);
        assert_eq!(all[0].outcome, None);
        assert_eq!(count_of(&install.database, "census_request_walked"), 0);
    }
}
