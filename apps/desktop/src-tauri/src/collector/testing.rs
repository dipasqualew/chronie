//! What a test needs in order to have an install to sync from.
//!
//! Every domain under [`super`] is tested the way the app meets it: a folder laid out like a
//! real install, an account file written the way the addon writes one, and a sync run over
//! them. That is three lines of set-up repeated a hundred times if each test builds it, and
//! the repetition is not harmless — it is where the `["segments"]` a test actually cares
//! about disappears into the `fs::create_dir_all` around it.
//!
//! So the folder is [`Install`] and the file is [`SavedVariables`], and a test says only what
//! it is about: which tables the addon wrote, and when the sync ran.

use super::database::open_database;
use super::read_model::dashboard;
use super::{collect, Options, SyncResult};
use crate::marks;
use chrono::TimeZone;
use rusqlite::Connection;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// A day, in seconds. What "old" means in tests about retention, and what a segment is moved
/// by when a test wants one from before something.
pub(super) const DAY_SECONDS: i64 = 86_400;

/// A synthetic install: the `_retail_` folder the collector reads, the account folder and the
/// game's screenshot folder under it, and a database path beside them that nothing has
/// created yet. The temporary directory lives as long as this does, so a test holds the whole
/// install in one binding rather than in a tuple it has to keep the first element of alive.
pub(super) struct Install {
    _temp: tempfile::TempDir,
    pub(super) wow: PathBuf,
    pub(super) database: PathBuf,
}

impl Install {
    /// An install whose account file has not been written yet.
    pub(super) fn empty() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let wow = temp.path().join("_retail_");
        fs::create_dir_all(wow.join("WTF/Account/TEST/SavedVariables")).unwrap();
        fs::create_dir_all(wow.join(crate::captures::GAME_FOLDER)).unwrap();
        let database = temp.path().join("data/chronie.sqlite3");
        Self {
            _temp: temp,
            wow,
            database,
        }
    }

    /// An install whose one account file already says this.
    pub(super) fn of(saved: &SavedVariables) -> Self {
        let install = Self::empty();
        install.write(saved);
        install
    }

    /// An install whose database exists and has been migrated, but which nothing has synced
    /// into. What a test about marks or saved sets needs: neither of those comes out of a
    /// sync, and both have to work on a database that has never seen one.
    pub(super) fn initialized() -> Self {
        let install = Self::empty();
        super::database::initialize(&install.database).unwrap();
        install
    }

    pub(super) fn account_file(&self) -> PathBuf {
        self.wow.join("WTF/Account/TEST/SavedVariables/chronie.lua")
    }

    /// Writes the account file for the first time.
    pub(super) fn write(&self, saved: &SavedVariables) {
        fs::write(self.account_file(), saved.lua()).unwrap();
    }

    /// The same file written again, with a trailing comment. The comment is the point: the
    /// collector skips a source whose size and timestamp are unchanged, so a test that wants a
    /// second pass has to make the file look different.
    pub(super) fn rewrite(&self, saved: &SavedVariables) {
        fs::write(self.account_file(), format!("{} -- touched", saved.lua())).unwrap();
    }

    pub(super) fn collect(&self, now: i64) -> SyncResult {
        collect(&self.wow, &self.database, now, Options::default()).unwrap()
    }

    pub(super) fn collect_with(&self, options: Options, now: i64) -> SyncResult {
        collect(&self.wow, &self.database, now, options).unwrap()
    }

    /// The database this install syncs into, opened and migrated.
    pub(super) fn open(&self) -> Connection {
        open_database(&self.database).unwrap()
    }

    /// Everything the window would draw of what has been synced so far.
    pub(super) fn dashboard(&self) -> Value {
        super::read_model::dashboard(&self.database).unwrap()
    }

    /// A file in the game's screenshot folder, under the name the client would give it.
    pub(super) fn screenshot(&self, stamp: &str, bytes: &[u8]) -> PathBuf {
        let path = self
            .wow
            .join(crate::captures::GAME_FOLDER)
            .join(format!("WoWScrnShot_{stamp}.jpg"));
        fs::write(&path, bytes).unwrap();
        path
    }

    /// One of the checked-in synthetic logs, laid down in the game's log folder under the name
    /// the client would have given it. No real log and no real install: everything the
    /// collector does with a combat log is driven by the same files `logfile` is tested
    /// against.
    pub(super) fn plant_log(&self, fixture: &str, name: &str) {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/combatlog")
            .join(fixture);
        let logs = self.wow.join("Logs");
        fs::create_dir_all(&logs).unwrap();
        fs::copy(source, logs.join(name)).unwrap();
    }

    /// A log the filesystem says was last written at `at`, which is the only thing the sweep
    /// judges a file's age by.
    pub(super) fn backdate(&self, name: &str, at: i64) {
        fs::File::options()
            .write(true)
            .open(self.wow.join("Logs").join(name))
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(at as u64))
            .unwrap();
    }

    pub(super) fn has_log(&self, name: &str) -> bool {
        self.wow.join("Logs").join(name).is_file()
    }
}

/// The addon's own file, built a table at a time.
///
/// The addon writes one Lua global holding one table per kind of thing it recorded, and a test
/// is nearly always about one of them. Naming only that table is what keeps the file in the
/// test as short as the claim it is making.
#[derive(Default)]
pub(super) struct SavedVariables {
    tables: Vec<String>,
}

impl SavedVariables {
    pub(super) fn new() -> Self {
        Self::default()
    }

    /// The visits the addon filed, as the list it writes them in.
    pub(super) fn segments(self, lua: &str) -> Self {
        self.braced("segments", lua)
    }

    /// The captures — screenshots and remembered moments — the addon recorded.
    pub(super) fn entries(self, lua: &str) -> Self {
        self.braced("entries", lua)
    }

    /// What each character was last seen carrying, keyed by character.
    pub(super) fn holdings(self, lua: &str) -> Self {
        self.braced("holdings", lua)
    }

    /// What the shared bank holds, which belongs to no character. Written as a value rather
    /// than a list, because that is how the addon writes it.
    pub(super) fn warband(self, lua: &str) -> Self {
        self.table("warband", lua)
    }

    /// The wardrobe the addon read out of the game itself. `customSets` is the addon's word
    /// for it, because the addon is talking to the game — see [`super::ingame_sets`].
    pub(super) fn in_game_sets(self, lua: &str) -> Self {
        self.braced("customSets", lua)
    }

    /// What the addon did about the outfits this app asked the game to save, keyed by the id
    /// of the request that asked. See [`super::ingame_sets`].
    pub(super) fn answered_set_requests(self, lua: &str) -> Self {
        self.table(
            "customSetRequests",
            &format!("{{ [\"done\"] = {{ {lua} }} }}"),
        )
    }

    /// Who each character is and what they are made of.
    pub(super) fn character_look(self, lua: &str) -> Self {
        self.braced("characterLook", lua)
    }

    /// Tables written out verbatim, for a test whose subject is the shape of the file itself
    /// or a group of tables that only mean anything read together.
    pub(super) fn raw(mut self, lua: &str) -> Self {
        self.tables
            .push(lua.trim().trim_end_matches(',').to_string());
        self
    }

    /// One table, whose value is written as it stands.
    pub(super) fn table(mut self, key: &str, lua: &str) -> Self {
        self.tables.push(format!("[\"{key}\"] = {lua}"));
        self
    }

    /// One table, whose value is the list `lua` belongs in.
    fn braced(self, key: &str, lua: &str) -> Self {
        self.table(key, &format!("{{ {lua} }}"))
    }

    pub(super) fn lua(&self) -> String {
        format!("ChronieDB = {{ {} }}", self.tables.join(", "))
    }
}

/// What the window would show against the newest segment: the reading every test about a
/// guess, and about surviving a correction of one, ends on.
pub(super) fn activities_of(database: &Path) -> Vec<Value> {
    dashboard(database).unwrap()["segments"][0]["activities"]
        .as_array()
        .expect("an activities array")
        .clone()
}

pub(super) const RAID_SEGMENT: &str = r#"
  { ["id"] = "raid-1", ["character"] = "Aster-Vale", ["instance"] = "Ulduar",
    ["instanceType"] = "raid", ["difficulty"] = "25 Player",
    ["expansionTier"] = 3, ["latestExpansionTier"] = 11,
    ["endedAt"] = 2000000000, ["startedAt"] = 1999990000, ["seconds"] = 10000,
    ["encounters"] = {
      { ["id"] = 745, ["name"] = "Flame Leviathan", ["success"] = true },
      { ["id"] = 746, ["name"] = "Ignis", ["success"] = false }
    } }
"#;

/// Two segments, each carrying one change to the same equipment set, written the way
/// the addon writes them. The pair is the point: what the second change replaced can
/// only come from the first, because nothing ever stores a "before".
pub(super) const EQUIPSET_SEGMENTS: &str = r#"
  { ["id"] = "set-1", ["character"] = "Aster-Vale", ["instance"] = "Valdrakken",
    ["instanceType"] = "none", ["endedAt"] = 2000000000, ["startedAt"] = 1999990000,
    ["equipsetChanges"] = {
      { ["setId"] = 3, ["name"] = "Raid", ["kind"] = "created", ["at"] = 1999990500,
        ["items"] = {
          { ["slot"] = 1, ["itemId"] = 100, ["itemLevel"] = 623,
            ["itemName"] = "Tideglass Crown" },
          { ["slot"] = 5, ["itemId"] = 200, ["itemLevel"] = 619,
            ["itemName"] = "Tideglass Robe" }
        } }
    } },
  { ["id"] = "set-2", ["character"] = "Aster-Vale", ["instance"] = "Valdrakken",
    ["instanceType"] = "none", ["endedAt"] = 2000100000, ["startedAt"] = 2000090000,
    ["equipsetChanges"] = {
      { ["setId"] = 3, ["name"] = "Raid", ["kind"] = "updated", ["at"] = 2000090500,
        ["items"] = {
          { ["slot"] = 1, ["itemId"] = 101, ["itemLevel"] = 639,
            ["itemName"] = "Deepwater Crown" }
        } }
    } }
"#;

/// The instant a line of `raid-night.txt` names, in epoch seconds. The fixture states its
/// own offset on every line, so this is the same instant wherever the tests run.
pub(super) fn raid_second(hour: u32, minute: u32, second: u32) -> i64 {
    chrono::FixedOffset::east_opt(-5 * 3600)
        .unwrap()
        .with_ymd_and_hms(2023, 11, 14, hour, minute, second)
        .unwrap()
        .timestamp()
}

/// A sync run a moment after that night ended, which is when one really runs: the client
/// writes SavedVariables at logout and the app syncs seconds later.
///
/// It matters to any test that reads the track back. `compact_positions` deletes points older
/// than the retention window that nothing remembered, so a `now` set years past the fixture —
/// which says nothing about the sync and everything about the number somebody typed — would
/// correctly find a whole night's track expired before the test looked at it.
pub(super) fn raid_night_sync() -> i64 {
    raid_second(20, 30, 0) + 100
}

/// A segment covering part of that night, written the way the addon writes one.
pub(super) fn night_segment(id: &str, character: &str, from: i64, to: i64) -> String {
    format!(
        r#"
  {{ ["id"] = "{id}", ["character"] = "{character}", ["instance"] = "Amirdrassil",
    ["instanceType"] = "raid", ["difficulty"] = "Mythic",
    ["endedAt"] = {to}, ["startedAt"] = {from}, ["seconds"] = {} }}
"#,
        to - from
    )
}

pub(super) const MARKED_AT: i64 = 2_000_000_000;

pub(super) fn mark_of<'a>(
    payload: &'a marks::MarksPayload,
    kind: &str,
    id: i64,
) -> Option<&'a marks::Mark> {
    payload
        .marks
        .iter()
        .find(|mark| mark.kind == kind && mark.id == id)
}

/// How many rows a table holds, for the tests whose whole claim is that something was — or
/// was not — written a second time.
pub(super) fn count_of(database: &Path, table: &str) -> i64 {
    open_database(database)
        .unwrap()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}
