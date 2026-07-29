pub mod achievements;
mod activity;
pub mod appearances;
pub mod body;
pub mod budget;
pub mod captures;
pub mod casc;
pub mod character;
mod collector;
pub mod combatlog;
pub mod currencies;
pub mod customization;
pub mod customsets;
pub mod db2;
mod dto;
pub mod gallery;
pub mod gap;
pub mod glb;
pub mod icons;
pub mod ingamesets;
pub mod items;
pub mod journal;
pub mod logfile;
pub mod look;
pub mod m2;
pub mod marks;
pub mod models;
pub mod placement;
pub mod qualities;
pub mod query;
pub mod retention;
mod saved_variables;
pub mod transmog;
pub mod wardrobe;
pub mod wifi;
pub mod worn;

use achievements::AchievementBook;
use chrono::Utc;
use collector::{dashboard as load_dashboard, SyncResult};
use icons::IconCache;
use items::ItemBook;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    utils::config::PluginConfig,
    AppHandle, Manager, State, WebviewWindow,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

include!(concat!(env!("OUT_DIR"), "/bundled_addon.rs"));

const UPDATER_PLUGIN: &str = "updater";

/// What Chronie photographs by itself, for a settings file that does not say.
///
/// Conservative rather than empty, because "the first time this account ever did this" is
/// rare enough to be worth a picture every time — which "an achievement fired" is not, there
/// being thirty of those in the first minute of clearing an old raid.
fn default_capture_triggers() -> Vec<String> {
    vec!["accountFirstAchievement".to_string()]
}

/// The body a settings file that says nothing is drawn on.
fn body_default() -> u32 {
    body::DEFAULT
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
struct Settings {
    wow_path: Option<String>,
    last_sync: Option<String>,
    /// Whether the addon should start combat logging at login. Off unless somebody has
    /// deliberately turned it on: a raid night is hundreds of megabytes, and Chronie only
    /// clears up after itself once `retain_log_days` says it may.
    #[serde(default)]
    combat_logging: bool,
    /// After how many days a combat log Chronie has read to its end is deleted. `None` — the
    /// default — deletes nothing, and is what every install starts as, because the first sweep
    /// on a machine that has been logging since before Chronie existed would take all of it.
    /// Turning it on is a decision somebody makes with the preview in front of them.
    #[serde(default)]
    retain_log_days: Option<u32>,
    /// Whether the game keeps its own copy of a screenshot Chronie has ingested. Off, so the
    /// game's folder stops growing — but taking files out of a folder somebody has been
    /// curating for years is not a thing to make unrecoverable by design, and turning this on
    /// leaves every original where it was while Chronie still holds a verified copy.
    #[serde(default)]
    keep_original_screenshots: bool,
    /// How much of each screenshot the store keeps once Chronie has taken custody of it. See
    /// `captures::Quality`; a settings file that predates this gets the same re-encoding
    /// default a new install does, because the store is forever and a folder of untouched 4K
    /// PNGs is the thing this exists to stop.
    #[serde(default)]
    capture_quality: captures::Quality,
    /// Which things worth remembering photograph themselves — see `ns.newCaptureTriggers` in
    /// the addon for what each name means. A settings file that does not mention it gets the
    /// conservative default rather than an empty list, so an install that predates this
    /// still photographs its account firsts; an explicit `[]` is respected and means off.
    #[serde(default = "default_capture_triggers")]
    capture_triggers: Vec<String>,
    /// Who the character every appearance is shown on is: one answer to each of the questions
    /// the game's own character creation screen asks about her body. Empty on a fresh install
    /// and on every settings file that predates this, which is the body the app drew before
    /// there was anywhere to say otherwise — the swatch the game itself opens on, each time.
    ///
    /// Kept here rather than in the database because it is a preference and not a record: there
    /// is one of it, it is what this reader wants to look at, and a machine that has never been
    /// sent a database still has one.
    ///
    /// Every body's answers at once, rather than the current body's: the questions are the
    /// game's own ids and no two bodies share one, so switching to the other body and back
    /// finds the answers still there. [`customization::of`] is what narrows them to the body
    /// being drawn, every time it draws one.
    #[serde(default)]
    character_look: Vec<customization::Picked>,
    /// Which body those answers are about: a `ChrModel`, and one this build has a mesh for. A
    /// settings file that predates this — or one naming a body a later Chronie dropped — gets
    /// [`body::DEFAULT`], which is the Human Female every reader has been shown until now.
    #[serde(default = "body_default")]
    character_body: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            wow_path: None,
            last_sync: None,
            combat_logging: false,
            retain_log_days: None,
            keep_original_screenshots: false,
            capture_quality: captures::Quality::default(),
            capture_triggers: default_capture_triggers(),
            character_look: Vec::new(),
            character_body: body::DEFAULT,
        }
    }
}

struct AppState {
    data_dir: PathBuf,
    settings: Mutex<Settings>,
    /// Held for as long as anything is rewriting the database as a whole. The collector's
    /// own writes are transactions SQLite serialises for us; replacing the file underneath
    /// them is not, so the two are kept apart here rather than raced.
    database: Arc<Mutex<()>>,
    /// The half of WiFi sync that waits. Idle until somebody asks for it, and holding no
    /// socket at all until then.
    station: wifi::Station,
    /// What this machine calls itself, which is how it is named on the other one's screen.
    device: String,
    /// The game's own storage, held open between commands rather than opened per command —
    /// and holding on to the files that have come out of it.
    ///
    /// Opening it is a quarter of a second and a couple of hundred megabytes, and one click
    /// on a set asks for the game's files twice, so opening per command was most of what a
    /// reader waited for. What was left after that was inflating the same dozen tables again
    /// for every click, which is what [`casc::Remembered`] is; between them the two are the
    /// difference between 1.1–2.4s and a tenth of a second. Shared for the same reason the
    /// caches below are: the read happens on a worker thread that outlives the command that
    /// started it.
    storage: Arc<casc::OpenStorage>,
    /// The icons decoded so far. Shared rather than owned, because reading the game's files
    /// happens on a worker thread that outlives the command that started it.
    icons: Arc<IconCache>,
    /// The achievements looked up so far, shared for the same reason.
    achievements: Arc<AchievementBook>,
    /// The items looked up so far, likewise. A separate book from the achievements because
    /// they are separate tables, and the same bargain: a history names the same item once
    /// per segment it turned up in, and the read behind it opens `ItemSparse`.
    items: Arc<ItemBook>,
    /// The newest combat log as the last poll saw it. Kept because one look at a file cannot
    /// tell "being written to" from "left there in March"; two looks thirty seconds apart can.
    combat_log_seen: Mutex<Option<combatlog::LogFile>>,
    /// False in builds shipped without signing keys, where the release pipeline strips
    /// `plugins.updater` from the config. Touching the updater then panics, so every
    /// caller has to check this first.
    updater_configured: bool,
}

impl AppState {
    fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    fn database_path(&self) -> PathBuf {
        self.data_dir.join("chronie.sqlite3")
    }

    fn save(&self, settings: &Settings) -> Result<(), String> {
        fs::create_dir_all(&self.data_dir).map_err(|error| error.to_string())?;
        fs::write(
            self.settings_path(),
            serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    version: String,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
struct AppUpdateResult {
    updated: bool,
    version: String,
}

/// The rolling release every build is published under, which the updater already points at.
///
/// One channel, because there is only one: `dev-release.yml` force-moves the `dev` tag to
/// whatever last landed on main and replaces that release's assets. When there is ever a
/// stable channel beside it, this is the thing that stops being a constant.
const RELEASE_CHANNEL: &str = "dev";

/// Which build of Chronie this is: the channel it was published under and the commit behind it.
///
/// There is no version number worth showing — `tauri.conf.json` carries a `0.1.<run number>` that
/// exists so the updater can compare two builds, and it says nothing to a person about what is in
/// front of them. The commit does, and it is also the only one of the two that can be looked up
/// afterwards, which is why both halves end up as links on screen. The whole forty characters
/// travel; how much of them a reader is shown is the window's business.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
struct Release {
    channel: &'static str,
    commit: &'static str,
}

/// Answers with the release this binary was built as. Baked in at compile time by build.rs,
/// because a running app has no repository under it to ask.
#[tauri::command]
#[specta::specta]
fn release() -> Release {
    Release {
        channel: RELEASE_CHANNEL,
        commit: env!("CHRONIE_COMMIT"),
    }
}

fn load_settings(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn configured_wow_path(settings: &Settings) -> Result<PathBuf, String> {
    let configured = settings
        .wow_path
        .as_deref()
        .ok_or_else(|| "Choose the game folder in Setup first.".to_string())?;
    collector::resolve_wow_path(Path::new(configured))
}

fn perform_sync(state: &AppState) -> Result<SyncResult, String> {
    let (wow_path, options) = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        (
            configured_wow_path(&settings)?,
            collector::Options {
                keep_originals: settings.keep_original_screenshots,
                retain_log_days: settings.retain_log_days,
                capture_quality: settings.capture_quality,
            },
        )
    };
    // Not while a database arriving over the network is being put in place, which would
    // otherwise have this writing into a file that is about to stop existing.
    let held = state.database.lock().map_err(|_| "Database lock failed.")?;
    let result = collector::collect(
        &wow_path,
        &state.database_path(),
        Utc::now().timestamp(),
        options,
    )?;
    drop(held);
    let mut settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
    settings.last_sync = Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    state.save(&settings)?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
fn dashboard(state: State<'_, AppState>) -> Result<dto::DashboardPayload, String> {
    load_dashboard(&state.database_path()).and_then(dto::convert)
}

/// One query, typed by the reader, run against their own history.
///
/// `async`, and therefore off the main thread, for a reason the other database commands do not
/// have: every one of those runs a statement this repository wrote and can vouch for, and this
/// one runs whatever somebody typed. `query::TIME_BUDGET` bounds how long that can take, but
/// ten seconds of a frozen window would still be ten seconds of a frozen window.
#[tauri::command]
#[specta::specta]
async fn run_query(
    sql: String,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<dto::QueryAnswer, String> {
    let path = state.database_path();
    tauri::async_runtime::spawn_blocking(move || query::run(&path, &sql, limit))
        .await
        .map_err(|error| format!("That query did not finish: {error}"))?
        .and_then(dto::convert)
}

/// What is in the history, so that a query can be written without reading the migrations.
#[tauri::command]
#[specta::specta]
async fn query_schema(state: State<'_, AppState>) -> Result<dto::QuerySchema, String> {
    let path = state.database_path();
    tauri::async_runtime::spawn_blocking(move || query::schema(&path))
        .await
        .map_err(|error| format!("Reading the schema did not finish: {error}"))?
        .and_then(dto::convert)
}

/// The transmog sets the installed game knows about.
#[tauri::command]
#[specta::specta]
async fn transmog_sets(state: State<'_, AppState>) -> Result<dto::TransmogPayload, String> {
    read_game_files(&state, transmog::sets)
        .await
        .and_then(dto::convert)
}

/// What one transmog set is made of, walked out of the same files.
///
/// The window already has the set from the grid, so only its id crosses over; everything a
/// row shows is resolved here rather than assembled from two halves.
#[tauri::command]
#[specta::specta]
async fn transmog_set_items(
    set_id: u32,
    state: State<'_, AppState>,
) -> Result<dto::TransmogSetItemsPayload, String> {
    read_game_files(&state, move |files| transmog::set_items(files, set_id))
        .await
        .and_then(dto::convert)
}

/// Every appearance the game holds for one kind of place, whether or not a set names it.
///
/// The display types come from the window rather than from the backend, because the kinds a
/// reader picks between do not divide the way the table does: an armour slot is one display
/// type and everything held in a hand is five. Asked for a kind at a time — the whole
/// wardrobe is fourteen megabytes and nobody browses fifty-five thousand rows at once.
#[tauri::command]
#[specta::specta]
async fn transmog_appearances(
    display_types: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<dto::WardrobePayload, String> {
    read_game_files(&state, move |files| {
        wardrobe::appearances(files, &display_types)
    })
    .await
    .and_then(dto::convert)
}

/// Everything anybody has said about the game's wardrobe with their own hands.
///
/// The one thing on the transmog screen that is not read out of the installed game: a star and
/// a set of tags, against a set or against a look. Read whole rather than per browser, because
/// it is what one person typed rather than what Blizzard shipped — see
/// `collector::transmog_marks`.
#[tauri::command]
#[specta::specta]
fn transmog_marks(state: State<'_, AppState>) -> Result<dto::TransmogMarksPayload, String> {
    collector::transmog_marks(&state.database_path()).and_then(dto::convert)
}

/// The three ways a mark changes, each answering with every mark rather than an
/// acknowledgement — the same rule the activity and capture edits follow, so what the browser
/// draws is what the database holds and never what the window hoped a write did.
#[tauri::command]
#[specta::specta]
fn set_transmog_favourite(
    kind: dto::MarkSubjectKind,
    id: i64,
    favourite: bool,
    state: State<'_, AppState>,
) -> Result<dto::TransmogMarksPayload, String> {
    collector::set_transmog_favourite(
        &state.database_path(),
        kind.as_str(),
        id,
        favourite,
        Utc::now().timestamp(),
    )
    .and_then(dto::convert)
}

#[tauri::command]
#[specta::specta]
fn set_transmog_tag(
    kind: dto::MarkSubjectKind,
    id: i64,
    key: String,
    value: Option<String>,
    state: State<'_, AppState>,
) -> Result<dto::TransmogMarksPayload, String> {
    collector::set_transmog_tag(
        &state.database_path(),
        kind.as_str(),
        id,
        &key,
        value.as_deref(),
        Utc::now().timestamp(),
    )
    .and_then(dto::convert)
}

#[tauri::command]
#[specta::specta]
fn delete_transmog_tag(
    kind: dto::MarkSubjectKind,
    id: i64,
    key: String,
    state: State<'_, AppState>,
) -> Result<dto::TransmogMarksPayload, String> {
    collector::delete_transmog_tag(&state.database_path(), kind.as_str(), id, &key)
        .and_then(dto::convert)
}

/// The sets the reader put together on the character themselves.
///
/// The other thing on the transmog screen that is not read out of the installed game, and the
/// only one of the two that has clothes in it: an outfit assembled out of several sets and the
/// game at large, saved under a name and browsed beside Blizzard's own ever after. Read whole
/// for the reason the marks are — see `collector::custom_sets`.
#[tauri::command]
#[specta::specta]
fn custom_sets(state: State<'_, AppState>) -> Result<customsets::CustomSetsPayload, String> {
    collector::custom_sets(&state.database_path())
}

/// The two ways a saved set changes, each answering with every saved set rather than an
/// acknowledgement — the same rule the marks and the activity edits follow.
#[tauri::command]
#[specta::specta]
fn save_custom_set(
    name: String,
    pieces: Vec<dto::CustomSetPiece>,
    state: State<'_, AppState>,
) -> Result<customsets::CustomSetsPayload, String> {
    let pieces = dto::convert(pieces)?;
    collector::save_custom_set(
        &state.database_path(),
        &name,
        pieces,
        Utc::now().timestamp(),
    )
}

#[tauri::command]
#[specta::specta]
fn delete_custom_set(
    id: i64,
    state: State<'_, AppState>,
) -> Result<customsets::CustomSetsPayload, String> {
    collector::delete_custom_set(&state.database_path(), id)
}

/// The sets the player saved in the game itself, per character the addon has read one on.
///
/// The third kind of set on that screen, and the only one this app neither invented nor found
/// in the game's files: Blizzard's sets are a DB2 table, the reader's own are rows this app
/// wrote, and these were saved at a transmogrifier long before Chronie existed. Read out of the
/// database rather than the install, so a machine without the game still lists them — see
/// `0018_in_game_sets.sql` for why listing is as far as that goes.
#[tauri::command]
#[specta::specta]
fn in_game_sets(state: State<'_, AppState>) -> Result<ingamesets::InGameSetsPayload, String> {
    collector::in_game_sets(&state.database_path())
}

/// What a list of appearances actually is, for a set that names them and nothing else.
///
/// An in-game set is stored as `ItemModifiedAppearance` ids because that is all the game tells
/// the addon, so opening one is this: the same four table walks a Blizzard set costs, over the
/// ids the set names rather than the ids `TransmogSetItem` names. The answer is shaped exactly
/// like `transmog_set_items`, which is what lets the window draw one with the code it already
/// has for the other.
///
/// Asked when a reader opens a set rather than when the list is drawn, for the reason every
/// other read of the game's tables here is deferred: a roster's worth of wardrobes is a lot of
/// walking for rows nobody has looked at.
#[tauri::command]
#[specta::specta]
async fn in_game_set_appearances(
    appearance_ids: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<dto::InGameSetAppearancesPayload, String> {
    read_game_files(&state, move |files| {
        let found = transmog::appearances_of(files, &appearance_ids)?;
        let named = found.iter().filter(|row| row.item_id != 0).count();
        Ok(serde_json::json!({
            "readCount": named,
            "withheldCount": found.len() - named,
            "appearances": found,
        }))
    })
    .await
    .and_then(dto::convert)
}

/// Asks the game to save an outfit into the account's own transmog sets.
///
/// The one write Chronie makes into a WoW account, and it is deliberately two steps: the request
/// is recorded here, and the *addon* carries it out the next time the player logs in. Nothing in
/// this app can reach a running game — see `docs/transmog-sets.md` — so what this does is write
/// the waiting requests into a source file of the addon's own and then wait to be told.
///
/// Answering with every request rather than an acknowledgement, the same rule the marks and the
/// saved sets follow: the window draws what was stored, including the ones still waiting.
///
/// A game folder that cannot be written to is not a failure of the *send*. The row is already
/// stored, every later install and every later send writes the file again, and telling somebody
/// their outfit was not saved when it is queued would be the wrong sentence.
#[tauri::command]
#[specta::specta]
fn send_set_to_game(
    name: String,
    icon: Option<i64>,
    slots: Vec<dto::InGameSetSlot>,
    state: State<'_, AppState>,
) -> Result<Vec<ingamesets::Request>, String> {
    let slots: Vec<ingamesets::Slot> = dto::convert(slots)?;
    let now = Utc::now().timestamp();
    let requests =
        collector::request_set_in_game(&state.database_path(), &name, icon, &slots, now)?;
    if let Ok(wow_path) = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        configured_wow_path(&settings)
    } {
        let waiting = collector::waiting_set_requests(&state.database_path())?;
        let _ = write_requests(&wow_path, &waiting, now);
    }
    Ok(requests)
}

/// Every outfit this app has asked the game for, and what became of each.
#[tauri::command]
#[specta::specta]
fn set_requests(state: State<'_, AppState>) -> Result<Vec<ingamesets::Request>, String> {
    collector::set_requests(&state.database_path())
}

/// What the game says about the achievements a window is showing.
///
/// The dashboard already carries the ids, because the addon recorded them at the moment they
/// were earned; everything a reader recognises an achievement by is in the game's own tables
/// and is looked up here. Asked for after the segment is drawn, for the same reason the
/// icons are: a list of achievements is worth reading while the tables that describe them
/// are still being opened.
#[tauri::command]
#[specta::specta]
async fn achievement_details(
    ids: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<dto::AchievementDetailsPayload, String> {
    let book = Arc::clone(&state.achievements);
    let missing = book.missing(&ids);
    if !missing.is_empty() {
        let found =
            read_game_files(&state, move |files| achievements::read(files, &missing)).await?;
        book.store(found);
    }
    dto::convert(book.answer(&ids))
}

/// What the game says about the items a window is showing.
///
/// The same arrangement as the achievements above, and for the same reason: a segment carries
/// item ids — the transmog sources a character learned, the pieces an equipment set changed to
/// hold — and everything a player recognises an item by is in the game's own tables. What it
/// answers with is numbers rather than words; which subclass of armour is "Leather" is the
/// window's business.
#[tauri::command]
#[specta::specta]
async fn item_details(
    ids: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<dto::ItemDetailsPayload, String> {
    let book = Arc::clone(&state.items);
    let missing = book.missing(&ids);
    if !missing.is_empty() {
        let found = read_game_files(&state, move |files| items::read(files, &missing)).await?;
        book.store(found);
    }
    dto::convert(book.answer(&ids))
}

/// The game's own pictures for a list of things, as PNG data URLs keyed by FileDataID.
///
/// Whatever named them — a transmog appearance, an achievement — a picture is a texture in
/// the same storage everything else comes out of, so there is one command for all of them
/// and one cache behind it. Asked for after the rows are on screen rather than with them:
/// the ids come out of the same payload the rows were drawn from, and a list reads as a list
/// long before its textures have been decoded. Icons already decoded are answered from
/// memory, which is what makes the second set of a collection cost nothing — so this only
/// reaches the game's storage when the request holds something genuinely new.
#[tauri::command]
#[specta::specta]
async fn game_icons(
    icon_file_data_ids: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<dto::IconsPayload, String> {
    let cache = Arc::clone(&state.icons);
    let missing = cache.missing(&icon_file_data_ids);
    if !missing.is_empty() {
        let decoded =
            read_game_files(&state, move |files| Ok(icons::decode(files, &missing))).await?;
        cache.store(decoded);
    }
    dto::convert(cache.answer(&icon_file_data_ids))
}

/// The character an appearance is worn on, bare, as a `.glb` in a data URL.
///
/// One fixed model for the whole app — a Human Female, because gear is authored to look right
/// on human proportions — so this is asked for once and shown for every set opened after.
///
/// Which Human Female is the reader's, out of [`character_look`]. It is read here rather than
/// sent by the window because it is the same answer for every one of the three commands that
/// draw her, and because a window that had to remember to pass it could forget in one of them —
/// which would be a wardrobe of strangers.
#[tauri::command]
#[specta::specta]
async fn character_model(state: State<'_, AppState>) -> Result<dto::CharacterModelPayload, String> {
    let who = character_look_of(&state)?;
    read_game_files(&state, move |files| character::model_of(files, &who))
        .await
        .and_then(dto::convert)
}

/// What the reader may be asked about her, what they have answered so far, and who they play.
///
/// The first two halves at once because neither is any use alone: a list of swatches with nothing
/// marked is a form that cannot say what it is showing, and a set of ids with no names behind them
/// is what the settings file already holds. See [`customization::questions`] — a question is read
/// out of the installed game, so a patch that adds a hairstyle adds it here with no code.
///
/// The third is the roster, and it travels with them for the same reason: it is a shortcut *into*
/// this form — pick a character and every control below fills in — so a window that had to ask for
/// it separately would be making two round trips to draw one panel. It is re-read whenever the
/// body changes, which costs a query against a table with one row per character.
#[tauri::command]
#[specta::specta]
async fn character_look(state: State<'_, AppState>) -> Result<dto::CharacterLookPayload, String> {
    let who = character_look_of(&state)?;
    let body = who.body;
    // Out of the database, where it is stored as the addon read it: a race and a sex, which mean
    // nothing until the installed game says which body they come to.
    let looks = collector::character_looks(&state.database_path())?;
    let (bodies, questions, characters) = read_game_files(&state, move |files| {
        Ok((
            body::playable(files)?,
            customization::questions(files, body)?,
            look::resolve(files, &looks)?,
        ))
    })
    .await?;
    dto::convert(serde_json::json!({
        "bodies": bodies,
        "body": who.body,
        "questions": questions,
        "picked": who.picked,
        "characters": characters,
    }))
}

/// Says who she is from now on, and answers with what was stored.
///
/// Nothing is drawn here: the window redraws her by asking for the bodies again, which is the
/// same errand it runs whenever what she is wearing changes. The one thing read out of the game
/// is whether the body named is one the game offers — a question only the install can answer now
/// that every playable race is on the list. What the game says about an *answer* is checked every
/// time a body is drawn rather than here, because an install can change under a settings file —
/// see [`customization::of`].
#[tauri::command]
#[specta::specta]
async fn save_character_look(
    body: u32,
    picked: Vec<dto::CharacterPick>,
    state: State<'_, AppState>,
) -> Result<dto::CharacterChosen, String> {
    let body = read_game_files(&state, move |files| body::known(files, body)).await?;
    let picked = dto::convert(picked)?;
    let cleaned = customization::clean(picked)?;
    let mut settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
    settings.character_body = body;
    settings.character_look = cleaned.clone();
    state.save(&settings)?;
    dto::convert(serde_json::json!({ "body": body, "picked": cleaned }))
}

/// The answers the settings file holds, copied out from under the lock.
///
/// A copy rather than a borrow because every caller hands it to a worker thread that outlives
/// the command — the same bargain [`read_game_files`] makes about the path.
fn character_look_of(state: &State<'_, AppState>) -> Result<character::Who, String> {
    state
        .settings
        .lock()
        .map(|settings| character::Who {
            body: settings.character_body,
            picked: settings.character_look.clone(),
        })
        .map_err(|_| "Settings lock failed.".to_string())
}

/// The same character wearing a set of clothes, as a `.glb` in a data URL, or `null`.
///
/// This is what most of a set has instead of a model: a chestpiece is textures painted into
/// the body's atlas and a few geoset switches, and neither means anything off the character.
///
/// **A list rather than one appearance**, because two of the three subsystems behind character
/// rendering exist to arbitrate between items and neither can be asked one piece at a time: the
/// priority table decides which of two pieces owns a contested geoset group, and the draw order
/// decides which of two textures painting the same rectangle the reader ends up seeing. So the
/// window sends the outfit it wants to see and gets one body back.
///
/// Each piece carries the three numbers the window already has for it. The slot comes across
/// beside the display id because `ItemAppearance` is what knows it and because it is what says
/// which geoset groups the display's six values drive, and now also where the piece sits in the
/// stack. The inventory type comes with it for the one thing the slot cannot say: which hand a
/// weapon is held in. `null` is the ordinary answer for an outfit this install can say nothing
/// about, and leaves the window showing the icons.
#[tauri::command]
#[specta::specta]
async fn worn_set(
    pieces: Vec<dto::WornPiece>,
    state: State<'_, AppState>,
) -> Result<dto::WornSetPayload, String> {
    let pieces: Vec<worn::Piece> = dto::convert(pieces)?;
    let who = character_look_of(&state)?;
    read_game_files(&state, move |files| {
        character::worn_set_of(files, &pieces, &who)
    })
    .await
    .and_then(dto::convert)
}

/// The same, on a body belonging to somebody the reader actually plays.
///
/// The one place in the app where the body is not the reader's invented one. Everywhere else a
/// picture is of a person somebody put together out of fifty-one bodies and a select per
/// question, and that is right for a wardrobe: a look is being *chosen* there, and it should be
/// shown on whoever the reader means to wear it. The character view asks a different question —
/// what does this Tauren I play look like in the set she saved — and answering it with the
/// Human Female the transmog screen happens to be set to would be answering somebody else's.
///
/// Falls back to the reader's own body for a character this install cannot draw. That is not a
/// failure worth reporting: a race the game does not have, and — far more often — a character
/// the addon has never read a race off at all, because a look is only stored once the addon has
/// seen one. A picture on the wrong body is still a picture of the clothes, which is most of
/// what the pane is for, and the alternative is an empty stage on most of a roster.
#[tauri::command]
#[specta::specta]
async fn character_worn_set(
    character: String,
    pieces: Vec<dto::WornPiece>,
    state: State<'_, AppState>,
) -> Result<dto::WornSetPayload, String> {
    let pieces: Vec<worn::Piece> = dto::convert(pieces)?;
    let fallback = character_look_of(&state)?;
    let looks = collector::character_looks(&state.database_path())?;
    read_game_files(&state, move |files| {
        let who = character::who_is(files, &looks, &character)?.unwrap_or(fallback);
        character::worn_set_of(files, &pieces, &who)
    })
    .await
    .and_then(dto::convert)
}

/// The pictures a list of currencies is drawn with, keyed by the currency rather than the file.
///
/// Keyed by the currency because that is what the caller holds: a balance arrives from the addon
/// as an id, a name and a number, and the FileDataID behind it is a hop this side of the bridge
/// has no way to make and no reason to learn. So the whole errand happens here — the table, then
/// the texture — and the window gets back what it can put in an `<img>`.
///
/// The textures themselves go through the same cache every other icon does, so a second
/// character holding the same currency costs the table read and nothing else.
#[tauri::command]
#[specta::specta]
async fn currency_icons(
    currency_ids: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<dto::IconsPayload, String> {
    let cache = Arc::clone(&state.icons);
    let named = read_game_files(&state, move |files| {
        currencies::icons_of(files, &currency_ids)
    })
    .await?;
    let wanted: Vec<u32> = named.values().copied().collect();
    let missing = cache.missing(&wanted);
    if !missing.is_empty() {
        let decoded =
            read_game_files(&state, move |files| Ok(icons::decode(files, &missing))).await?;
        cache.store(decoded);
    }
    // The icons keyed by the file they came out of, re-keyed by the currency that named it. Two
    // currencies can name one picture — bonus Valorstones are drawn as Valorstones — so this is
    // a fan-out rather than a rename, and the cache is asked once per file either way.
    let by_file = cache.answer(&wanted);
    let mut icons = serde_json::Map::new();
    for (currency, file) in named {
        if let Some(url) = by_file["icons"].get(file.to_string()) {
            icons.insert(currency.to_string(), url.clone());
        }
    }
    dto::convert(serde_json::json!({ "icons": icons }))
}

/// The pictures a list of places is drawn with, keyed by the name rather than the file.
///
/// Keyed by the name because that is what the caller holds and all it holds: a segment arrives
/// from the addon under the name the client gave the place, and the tables that draw a dungeon are
/// keyed by that same localised name. So the whole errand happens here — the two tables, then the
/// textures — and the window gets back what it can put in an `<img>`.
///
/// Most of what it is asked about is an open-world zone the game draws no picture for at all, and
/// those simply do not come back. See [`journal::icons_of`], and the same cache every other icon
/// goes through, so a second evening in the same dungeon costs the table reads and nothing else.
#[tauri::command]
#[specta::specta]
async fn place_icons(
    places: Vec<String>,
    state: State<'_, AppState>,
) -> Result<dto::IconsPayload, String> {
    let cache = Arc::clone(&state.icons);
    let named = read_game_files(&state, move |files| journal::icons_of(files, &places)).await?;
    let wanted: Vec<u32> = named.values().copied().collect();
    let missing = cache.missing(&wanted);
    if !missing.is_empty() {
        let decoded =
            read_game_files(&state, move |files| Ok(icons::decode(files, &missing))).await?;
        cache.store(decoded);
    }
    // The icons keyed by the file they came out of, re-keyed by the place that named it. Every
    // delve names the one picture the group finder draws them all with, so this is a fan-out
    // rather than a rename, and the cache is asked once per file either way.
    let by_file = cache.answer(&wanted);
    let mut icons = serde_json::Map::new();
    for (place, file) in named {
        if let Some(url) = by_file["icons"].get(file.to_string()) {
            icons.insert(place, url.clone());
        }
    }
    dto::convert(serde_json::json!({ "icons": icons }))
}

/// A page of the wardrobe, every appearance on it worn on a body of its own.
///
/// The same three numbers per row as [`worn_set`], and a very different question: that one is
/// one body wearing several things, and this is several bodies each wearing one. The window
/// asks for a page at a time rather than a row at a time because the two of them cost almost the
/// same — the body, her skin and the six tables are read once for whatever is asked for, and a
/// row adds only its own textures and geometry. See [`gallery::of`], and `budget.rs` for what
/// that claim is held to.
#[tauri::command]
#[specta::specta]
async fn gallery_models(
    pieces: Vec<dto::WornPiece>,
    state: State<'_, AppState>,
) -> Result<dto::GalleryPayload, String> {
    let pieces: Vec<worn::Piece> = dto::convert(pieces)?;
    let who = character_look_of(&state)?;
    read_game_files(&state, move |files| gallery::of(files, &pieces, &who))
        .await
        .and_then(dto::convert)
}

/// A page of the set grid, each set worn whole on a body of its own.
///
/// Ids rather than pieces, which is the one thing this does not have in common with
/// [`gallery_models`] beside it. A card in the grid is a name and a count until somebody opens
/// it, so the window has no clothes to send: what a set is wearing is read here, for the whole
/// page out of one walk of each table, rather than by opening a dozen sets one at a time. See
/// [`gallery::sets`].
#[tauri::command]
#[specta::specta]
async fn gallery_sets(
    set_ids: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<dto::SetGalleryPayload, String> {
    let who = character_look_of(&state)?;
    read_game_files(&state, move |files| gallery::sets(files, &set_ids, &who))
        .await
        .and_then(dto::convert)
}

/// The look a list of items carries, as the three numbers a render is asked for by.
///
/// The hop a segment needs and nothing else does. Every other view that draws an appearance
/// walked out of `ItemAppearance` to reach its rows and already holds these; a segment holds
/// item ids, because an item id is what the addon can catch at the moment the game says a
/// transmog source was learned. See [`appearances::of_items`].
///
/// Asked when a reader clicks a row rather than when the segment is drawn — a modal listing
/// thirty sources would otherwise walk three of the game's tables to fill in pictures nobody
/// asked to see.
#[tauri::command]
#[specta::specta]
async fn item_appearances(
    item_ids: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<dto::ItemAppearancesPayload, String> {
    read_game_files(&state, move |files| appearances::of_items(files, &item_ids))
        .await
        .and_then(dto::convert)
}

/// Runs a read of the installed game's own files, off the main thread.
///
/// This reads the game's storage rather than anything the addon collected, so it needs the
/// install itself and not just its `WTF` folder — `resolve_wow_path` lands on `_retail_`,
/// and `Data/` is its sibling.
///
/// Off the main thread because the first read of a session still opens the storage, which
/// means inflating a couple of hundred megabytes and would freeze the window for as long as
/// it took. Every read after that is handed the handle the first one left behind — see
/// [`casc::OpenStorage`] — which is what took a click from over a second to under half of one.
async fn read_game_files<T, F>(state: &State<'_, AppState>, read: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&dyn casc::GameFiles) -> Result<T, String> + Send + 'static,
{
    let retail = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        configured_wow_path(&settings)?
    };
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        let install = retail
            .parent()
            .ok_or("The game folder has no parent to look for Data in.")?;
        read(storage.files(install)?.as_ref())
    })
    .await
    .map_err(|error| format!("Reading the game's files did not finish: {error}"))?
}

#[tauri::command]
#[specta::specta]
fn settings(state: State<'_, AppState>) -> Result<dto::SettingsPayload, String> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Settings lock failed.".to_string())
        .and_then(dto::convert)
}

/// Asks the user for the game folder.
///
/// This has to be `async`. Tauri runs a synchronous command on the main thread, and the
/// folder picker blocks until the user answers it — on the main thread that is the event
/// loop the picker itself needs, so the whole window locks up with the dialog on screen.
/// An async command runs off the main thread, which is what the dialog plugin's own
/// documentation calls for.
#[tauri::command]
#[specta::specta]
async fn choose_wow_path(window: WebviewWindow) -> Option<String> {
    window
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
#[specta::specta]
fn save_wow_path(
    wow_path: String,
    state: State<'_, AppState>,
) -> Result<dto::SettingsPayload, String> {
    let resolved = collector::resolve_wow_path(Path::new(wow_path.trim()))?;
    let mut settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
    settings.wow_path = Some(resolved.to_string_lossy().into_owned());
    state.save(&settings)?;
    dto::convert(settings.clone())
}

#[tauri::command]
#[specta::specta]
fn sync_now(state: State<'_, AppState>) -> Result<SyncResult, String> {
    perform_sync(&state)
}

/* ---------- combat logging ---------- */

/// What the install is really doing about combat logs, from the install rather than from the
/// setting: the CVar as the game last wrote it, and whether a file in `Logs/` is growing.
///
/// Cheap — two small reads and a directory listing — so the window asks on a timer while
/// Setup is open, and the background sync asks on its own beat. Every call remembers the log
/// it saw, which is what lets the next one tell a file being written from one left behind.
fn combat_log_status(state: &AppState) -> Result<combatlog::Status, String> {
    let (wow_path, requested) = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        (configured_wow_path(&settings).ok(), settings.combat_logging)
    };
    // Not an error. A first run has no game folder yet, and the honest answer to "what is the
    // install doing" is then "there is nothing here to look at" — which the panel can say,
    // and which still lets it show the switch in the position Chronie was left in.
    let Some(wow_path) = wow_path else {
        return Ok(combatlog::without_install(requested));
    };
    let mut seen = state
        .combat_log_seen
        .lock()
        .map_err(|_| "Combat log lock failed.")?;
    let status = combatlog::status(&wow_path, requested, seen.as_ref(), Utc::now().timestamp());
    seen.clone_from(&status.log);
    Ok(status)
}

#[tauri::command]
#[specta::specta]
fn combat_logging(state: State<'_, AppState>) -> Result<combatlog::Status, String> {
    combat_log_status(&state)
}

/// Turns Chronie's combat logging setting on or off.
///
/// The addon is reinstalled straight away rather than at the next launch, because the setting
/// only reaches the game inside the addon folder — and answering with the resulting status
/// means the panel repaints from what the install now says instead of from what the click
/// hoped. The game reads addon files once, at load, so this takes effect at the next login or
/// `/reload`; the panel is what says so.
#[tauri::command]
#[specta::specta]
fn set_combat_logging(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<combatlog::Status, String> {
    let configured = {
        let mut settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        settings.combat_logging = enabled;
        state.save(&settings)?;
        configured_wow_path(&settings).is_ok()
    };
    // Skipped rather than failed when no game folder has been chosen yet: the setting is
    // recorded either way, and the install that runs when a folder is finally chosen carries
    // it. Failing here would leave the switch reporting the opposite of what was saved.
    if configured {
        install_bundled_addon(&state)?;
    }
    combat_log_status(&state)
}

/* ---------- what the last session cost, if it was lost ---------- */

/// Whether the client was playing after the last thing Chronie has a record of.
///
/// The reading itself is [`gap::verdict`], which is pure; this is the three files it needs
/// read out of the install — the newest combat log, the last stamped line in it, and how far
/// the database reaches — and nothing else. An install with no game folder chosen has nothing
/// to look at and says so rather than failing: the timeline is drawn before Setup is finished,
/// and a view that errors because a folder is missing is worse than one that stays quiet.
fn session_gap_now(state: &AppState) -> Result<gap::Verdict, String> {
    let wow_path = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        configured_wow_path(&settings).ok()
    };
    let Some(wow_path) = wow_path else {
        return Ok(gap::Verdict::Unknown);
    };
    let Some(found) = combatlog::newest_found(&wow_path) else {
        return Ok(gap::Verdict::Unknown);
    };
    // Milliseconds out of the log, seconds everywhere else: the addon's clock and the
    // database's are both `time()`, which is whole seconds, and a rule comparing the two has
    // no use for the third decimal place.
    let played_to = logfile::tail_at(
        &found.path,
        combatlog::year_of(&found),
        logfile::Zone::Local,
    )
    .map(|millis| millis.div_euclid(1000));
    let recorded_to = collector::newest_segment_end(&state.database_path())?;
    Ok(gap::verdict(
        Some(&found.file),
        played_to,
        recorded_to,
        Utc::now().timestamp(),
    ))
}

#[tauri::command]
#[specta::specta]
fn session_gap(state: State<'_, AppState>) -> Result<gap::Verdict, String> {
    session_gap_now(&state)
}

/* ---------- clearing the logs up again ---------- */

/// What a sweep would delete right now, what it will not touch, and what it has already taken.
///
/// Answered whether or not the sweeper is on, because this is the dry run: the panel shows the
/// files and the size before the switch is thrown, so the first sweep on somebody's machine is
/// a thing they agreed to rather than a thing they discovered afterwards.
fn retention_report(state: &AppState) -> Result<retention::Report, String> {
    let (wow_path, retain_days) = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        (
            configured_wow_path(&settings).ok(),
            settings.retain_log_days,
        )
    };
    collector::retention_report(
        &state.database_path(),
        wow_path.as_deref(),
        retain_days,
        Utc::now().timestamp(),
    )
}

#[tauri::command]
#[specta::specta]
fn log_retention(state: State<'_, AppState>) -> Result<retention::Report, String> {
    retention_report(&state)
}

/// Turns the sweeper on at a given window, or off.
///
/// `days` is `None` for off. Nothing is deleted here — the setting is recorded, and the sweep
/// happens on the next sync, immediately after the read that decides what is eligible. The
/// answer is the report again, so the panel repaints from what is now true rather than from
/// what the click hoped.
#[tauri::command]
#[specta::specta]
fn set_log_retention(
    days: Option<u32>,
    state: State<'_, AppState>,
) -> Result<retention::Report, String> {
    {
        let mut settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        settings.retain_log_days = days.map(|days| days.max(retention::MIN_RETAIN_DAYS));
        state.save(&settings)?;
    }
    retention_report(&state)
}

/* ---------- what photographs itself, and what is kept of it ---------- */

/// Which things worth remembering take a picture of themselves.
///
/// The list is the addon's to act on, so it only means anything once it is in the game folder
/// — which is why this reinstalls straight away rather than waiting for the next launch, the
/// same way combat logging does. Unknown names are not rejected here: `settings_module` drops
/// anything that is not a plain name on the way into the Lua, and a rule this build does not
/// have simply never fires.
///
/// Answers with the whole of the settings, so the page repaints from what was stored rather
/// than from what the click hoped.
#[tauri::command]
#[specta::specta]
fn set_capture_triggers(
    triggers: Vec<String>,
    state: State<'_, AppState>,
) -> Result<dto::SettingsPayload, String> {
    let (saved, configured) = {
        let mut settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        settings.capture_triggers = triggers;
        state.save(&settings)?;
        (settings.clone(), configured_wow_path(&settings).is_ok())
    };
    // Skipped rather than failed with no game folder yet, for the same reason the combat
    // logging switch skips it: the setting is recorded either way, and the install that runs
    // when a folder is finally chosen carries it.
    if configured {
        install_bundled_addon(&state)?;
    }
    dto::convert(saved)
}

/// What Chronie does with a screenshot once it has found the file: how much of it to keep,
/// and whether the game keeps its own copy too.
///
/// The two travel together because they are one decision about disk — the store's size and
/// the game folder's — and neither reaches the addon at all, so nothing is reinstalled. Both
/// only ever apply to the *next* ingestion; a picture already in the store stays exactly as it
/// was taken custody of, which is the honest behaviour: nothing here goes back and recompresses
/// something the player already has.
#[tauri::command]
#[specta::specta]
fn set_capture_storage(
    quality: captures::Quality,
    keep_originals: bool,
    state: State<'_, AppState>,
) -> Result<dto::SettingsPayload, String> {
    let mut settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
    settings.capture_quality = quality;
    settings.keep_original_screenshots = keep_originals;
    state.save(&settings)?;
    dto::convert(settings.clone())
}

/// The four ways a user can correct the app's guess about what a segment was.
///
/// Each one returns the whole dashboard rather than an acknowledgement, so the window
/// repaints from stored state instead of from what the frontend hoped the write did.
#[tauri::command]
#[specta::specta]
fn add_activity(
    segment_id: i64,
    kind: String,
    metadata: dto::ActivityMetadata,
    state: State<'_, AppState>,
) -> Result<dto::DashboardPayload, String> {
    let metadata = serde_json::to_value(metadata).map_err(|error| error.to_string())?;
    collector::add_activity(
        &state.database_path(),
        segment_id,
        kind.trim(),
        &metadata,
        Utc::now().timestamp(),
    )?;
    load_dashboard(&state.database_path()).and_then(dto::convert)
}

#[tauri::command]
#[specta::specta]
fn update_activity(
    activity_id: i64,
    kind: String,
    metadata: dto::ActivityMetadata,
    state: State<'_, AppState>,
) -> Result<dto::DashboardPayload, String> {
    let metadata = serde_json::to_value(metadata).map_err(|error| error.to_string())?;
    collector::update_activity(
        &state.database_path(),
        activity_id,
        kind.trim(),
        &metadata,
        Utc::now().timestamp(),
    )?;
    load_dashboard(&state.database_path()).and_then(dto::convert)
}

#[tauri::command]
#[specta::specta]
fn delete_activity(
    activity_id: i64,
    state: State<'_, AppState>,
) -> Result<dto::DashboardPayload, String> {
    collector::delete_activity(&state.database_path(), activity_id, Utc::now().timestamp())?;
    load_dashboard(&state.database_path()).and_then(dto::convert)
}

#[tauri::command]
#[specta::specta]
fn reset_activities(
    segment_id: i64,
    state: State<'_, AppState>,
) -> Result<dto::DashboardPayload, String> {
    collector::reset_activities(&state.database_path(), segment_id, Utc::now().timestamp())?;
    load_dashboard(&state.database_path()).and_then(dto::convert)
}

/// The two ways somebody changes a capture, answering with the whole dashboard for the same
/// reason the activity edits do: what ends up on screen is what was stored, never what the
/// window hoped the write did. Which matters more here than anywhere — a note that looked
/// saved and was not is a sentence somebody will not think to type again.
#[tauri::command]
#[specta::specta]
fn set_capture_note(
    capture_id: i64,
    note: String,
    state: State<'_, AppState>,
) -> Result<dto::DashboardPayload, String> {
    collector::set_capture_note(
        &state.database_path(),
        capture_id,
        &note,
        Utc::now().timestamp(),
    )?;
    load_dashboard(&state.database_path()).and_then(dto::convert)
}

#[tauri::command]
#[specta::specta]
fn delete_capture(
    capture_id: i64,
    state: State<'_, AppState>,
) -> Result<dto::DashboardPayload, String> {
    collector::delete_capture(&state.database_path(), capture_id, Utc::now().timestamp())?;
    load_dashboard(&state.database_path()).and_then(dto::convert)
}

/// The pictures a grid of captures needs, asked for once the rows are drawn.
///
/// Async, and not for the bridge's sake: the first look at an evening's captures decodes and
/// re-encodes a screenshot apiece, which is tens of milliseconds each and would hold the main
/// thread for the length of the grid. Every one after that is a file read, because the
/// thumbnails are kept beside the images they were made from.
#[tauri::command]
#[specta::specta]
async fn capture_thumbnails(
    capture_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<dto::CaptureThumbnailsPayload, String> {
    collector::capture_thumbnails(&state.database_path(), &capture_ids).and_then(dto::convert)
}

/// One capture at the size it was taken, which is what opening a picture asks for.
#[tauri::command]
#[specta::specta]
async fn capture_image(
    capture_id: i64,
    state: State<'_, AppState>,
) -> Result<dto::CaptureImagePayload, String> {
    collector::capture_image(&state.database_path(), capture_id).and_then(dto::convert)
}

/// The one file in the addon the app writes rather than copies: what it has been asked to do.
///
/// This is the whole channel between the two halves. The app already lays the addon folder
/// down on every launch, so a setting reaches the game by riding along with it — the addon
/// then reads a plain Lua table instead of guessing, and what is on disk in the game folder
/// is always what Setup last said.
const SETTINGS_MODULE: &str = "src/Settings.lua";

/// The other file the app writes rather than copies: what it has asked the game to save.
///
/// The one thing that travels *into* a WoW account, and it travels here rather than through
/// SavedVariables because the client rewrites those wholesale at logout — see
/// `docs/transmog-sets.md`. Listed in `chronie.toc` like any other source file, so the client
/// loads it and never touches it.
const REQUESTS_MODULE: &str = "src/CustomSetRequests.lua";

/// A trigger name as a Lua string literal, or nothing at all.
///
/// The names come out of a settings file somebody can edit by hand, and they end up inside a
/// Lua source file the game executes. Rather than escape whatever arrives, this only lets
/// through what a trigger name can actually be — letters, and nothing else — so there is no
/// quote, backslash, newline or comment marker left to get the escaping wrong about. A name
/// that is not one is dropped rather than repaired: a trigger Chronie does not have would do
/// nothing anyway, and silently rewriting somebody's typo into a different rule would be
/// worse than ignoring it.
fn trigger_literal(name: &str) -> Option<String> {
    let clean = !name.is_empty()
        && name
            .chars()
            .all(|character| character.is_ascii_alphabetic());
    clean.then(|| format!("\"{name}\""))
}

/// The contents of that file for a given setting.
///
/// Pure, so the thing that actually reaches somebody's game folder is testable without a
/// game folder. The shape has to match the `ns.settings` the bundled `src/Settings.lua`
/// declares, because a hand-installed copy gets that one and must still load.
fn settings_module(combat_logging: bool, capture_triggers: &[String]) -> String {
    let triggers: Vec<String> = capture_triggers
        .iter()
        .filter_map(|name| trigger_literal(name))
        .collect();
    let triggers = triggers.join(", ");
    format!(
        "local _, ns = ...\n\
         \n\
         -- Written by the Chronie desktop app when it installed this addon. Editing it by\n\
         -- hand lasts until the app next starts, which lays the whole folder down again;\n\
         -- the Setup screen is where these are meant to be changed.\n\
         ns.settings = {{\n\
         \x20   combatLogging = {combat_logging},\n\
         \x20   captureTriggers = {{ {triggers} }},\n\
         }}\n"
    )
}

/// Lays the shipped addon out under `destination`, configured the way `settings` says.
///
/// Two of the files are written rather than copied. The settings module carries what the Setup
/// screen says; the requests module carries the outfits still waiting to be saved into the
/// game — and it has to be written here as well as when a send happens, because installing lays
/// the whole folder down again and copying the shipped empty one over the top would lose every
/// request that had not been carried out yet.
fn stage_addon(
    destination: &Path,
    settings: &Settings,
    requests: &[ingamesets::Request],
    now: i64,
) -> Result<(), String> {
    for (relative, contents) in BUNDLED_ADDON {
        let output = destination.join(relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if *relative == SETTINGS_MODULE {
            fs::write(
                &output,
                settings_module(settings.combat_logging, &settings.capture_triggers),
            )
        } else if *relative == REQUESTS_MODULE {
            fs::write(&output, ingamesets::requests_module(now, requests))
        } else {
            fs::write(&output, contents)
        }
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Writes the waiting requests into an addon folder that is already standing.
///
/// One file rather than the whole folder, because a send should reach the game without
/// reinstalling an addon that is already the right version — and because a reinstall is a
/// rename of a directory the player may be running out of at that moment.
///
/// A game folder with no Chronie in it is not an error. Somebody can send an outfit before they
/// have ever installed the addon, and the install itself lays the same file down with the same
/// requests in it, so nothing is lost by saying nothing here.
fn write_requests(
    wow_path: &Path,
    requests: &[ingamesets::Request],
    now: i64,
) -> Result<(), String> {
    let target = wow_path
        .join("Interface")
        .join("AddOns")
        .join("chronie")
        .join(REQUESTS_MODULE);
    if !target.parent().is_some_and(Path::is_dir) {
        return Ok(());
    }
    fs::write(&target, ingamesets::requests_module(now, requests))
        .map_err(|error| format!("Could not write {}: {error}", target.display()))
}

/// The version in the shipped addon's .toc, which is the version any install this app
/// performs ends up with — the file is read out of the binary, not off the game folder.
fn bundled_addon_version() -> String {
    BUNDLED_ADDON
        .iter()
        .find(|(relative, _)| *relative == "chronie.toc")
        .and_then(|(_, contents)| std::str::from_utf8(contents).ok())
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("## Version:").map(str::trim))
        })
        .unwrap_or("development")
        .to_string()
}

/// Swaps the game's copy of the addon for the one this build ships.
///
/// The new copy is assembled beside the old one and moved into place in a single rename, so
/// the game never sees a folder holding half of one version and half of another — and the old
/// copy is only deleted once its replacement is standing.
fn replace_addon(
    wow_path: &Path,
    settings: &Settings,
    requests: &[ingamesets::Request],
    now: i64,
) -> Result<InstallResult, String> {
    let addons = wow_path.join("Interface").join("AddOns");
    if !addons.is_dir() {
        return Err(format!("AddOns folder not found at {}.", addons.display()));
    }
    let staging = tempfile::Builder::new()
        .prefix(".chronie-install-")
        .tempdir_in(&addons)
        .map_err(|error| error.to_string())?;
    stage_addon(staging.path(), settings, requests, now)?;
    let target = addons.join("chronie");
    let backup = addons.join(".chronie-backup");
    if backup.exists() {
        fs::remove_dir_all(&backup).map_err(|error| error.to_string())?;
    }
    if target.exists() {
        fs::rename(&target, &backup).map_err(|error| error.to_string())?;
    }
    let staged_path = staging.keep();
    if let Err(error) = fs::rename(&staged_path, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        return Err(format!("Could not activate the staged addon: {error}"));
    }
    if backup.exists() {
        fs::remove_dir_all(backup).map_err(|error| error.to_string())?;
    }
    Ok(InstallResult {
        version: bundled_addon_version(),
    })
}

/// Installs the shipped addon into the configured game folder.
fn install_bundled_addon(state: &AppState) -> Result<InstallResult, String> {
    let (wow_path, settings) = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        (configured_wow_path(&settings)?, settings.clone())
    };
    // Read before the folder is torn down and laid again, so a request made a moment ago
    // survives an install rather than being replaced by the shipped empty file.
    let waiting = collector::waiting_set_requests(&state.database_path()).unwrap_or_default();
    replace_addon(&wow_path, &settings, &waiting, Utc::now().timestamp())
}

#[tauri::command]
#[specta::specta]
fn install_addon(state: State<'_, AppState>) -> Result<InstallResult, String> {
    install_bundled_addon(&state)
}

/* ---------- moving the history between machines ---------- */

/// Starts waiting for a database from another Chronie on this network, and stops again.
///
/// Waiting is something a person switches on for as long as it takes, not something the app
/// does in the background: a machine that is always listening is one that can always be
/// asked to throw its history away.
#[tauri::command]
#[specta::specta]
fn wifi_receive_start(state: State<'_, AppState>) -> Result<wifi::ReceiveStatus, String> {
    state.station.start()
}

#[tauri::command]
#[specta::specta]
fn wifi_receive_stop(state: State<'_, AppState>) -> Result<wifi::ReceiveStatus, String> {
    state.station.stop()
}

/// What the receiving half is doing, asked for on a timer while the panel is open. Polled
/// rather than pushed because the whole of it is three fields, and a window that asks is a
/// window that cannot miss the one event that mattered.
#[tauri::command]
#[specta::specta]
fn wifi_receive_status(state: State<'_, AppState>) -> Result<wifi::ReceiveStatus, String> {
    state.station.status()
}

/// The answer to the offer on screen. `false` is a first-class outcome, not a cancel.
#[tauri::command]
#[specta::specta]
fn wifi_answer_offer(
    accepted: bool,
    state: State<'_, AppState>,
) -> Result<wifi::ReceiveStatus, String> {
    state.station.answer(accepted)
}

/// The Chronies on this network that are waiting for a database.
///
/// Async because it spends a second or so listening for answers, which on the main thread
/// would be a second of frozen window.
#[tauri::command]
#[specta::specta]
async fn wifi_discover() -> Result<Vec<wifi::Peer>, String> {
    tauri::async_runtime::spawn_blocking(wifi::discover)
        .await
        .map_err(|error| format!("Looking for other Chronies did not finish: {error}"))?
}

/// Offers this machine's database to the Chronie at `address`, and sends it if they agree.
///
/// Async and off the main thread for the same reason, only more so: this waits on somebody
/// walking to another computer.
#[tauri::command]
#[specta::specta]
async fn wifi_send(address: String, state: State<'_, AppState>) -> Result<wifi::Receipt, String> {
    let database_path = state.database_path();
    let data_dir = state.data_dir.clone();
    let device = state.device.clone();
    let database = Arc::clone(&state.database);
    tauri::async_runtime::spawn_blocking(move || {
        wifi::send(&database_path, &data_dir, &device, &address, &database)
    })
    .await
    .map_err(|error| format!("The transfer did not finish: {error}"))?
}

#[tauri::command]
#[specta::specta]
async fn check_for_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppUpdateResult, String> {
    if !state.updater_configured {
        return Err(
            "This build has no update endpoint; download the latest release manually.".into(),
        );
    }
    let Some(update) = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(AppUpdateResult {
            updated: false,
            version: app.package_info().version.to_string(),
        });
    };
    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    Ok(AppUpdateResult {
        updated: true,
        version,
    })
}

fn start_automatic_updates(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(10));
        loop {
            let handle = app.clone();
            let _ = tauri::async_runtime::block_on(async move {
                let updater = handle.updater().map_err(|error| error.to_string())?;
                if let Some(update) = updater.check().await.map_err(|error| error.to_string())? {
                    update
                        .download_and_install(|_, _| {}, || {})
                        .await
                        .map_err(|error| error.to_string())?;
                }
                Ok::<(), String>(())
            });
            std::thread::sleep(Duration::from_secs(4 * 60 * 60));
        }
    });
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open Chronie", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut pixels = vec![0_u8; 16 * 16 * 4];
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[42, 120, 214, 255]);
    }
    TrayIconBuilder::new()
        .icon(Image::new_owned(pixels, 16, 16))
        .tooltip("Chronie segment sync")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Reinstalls the shipped addon every time the app starts.
///
/// The app and the addon are two halves of one pipeline: the addon writes `db.segments` in
/// the shape the collector expects to read. Leaving the game folder's copy to a button
/// somebody has to remember to press means an app that has quietly updated itself in the
/// background can end up reading a file an older addon wrote. Laying the shipped copy down on
/// every launch removes the question — the installed addon is always the one this build came
/// with.
///
/// Off the main thread, because it happens during setup and the window should not wait on the
/// disk to appear. Failure is only logged: on a first run there is no game folder configured
/// yet, which is the normal state rather than an error worth interrupting anyone over, and
/// Setup's own button is still there for an explicit answer.
fn install_addon_at_startup(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        match install_bundled_addon(&state) {
            Ok(result) => eprintln!("Chronie installed addon {}.", result.version),
            Err(error) => eprintln!("Chronie did not install its addon: {error}"),
        }
    });
}

fn start_background_sync(app: AppHandle) {
    std::thread::spawn(move || loop {
        let state = app.state::<AppState>();
        if state
            .settings
            .lock()
            .is_ok_and(|settings| settings.wow_path.is_some())
        {
            let _ = perform_sync(&state);
            // On the same beat, and for the same reason it is a beat at all: whether a combat
            // log is growing is a question about two moments, and taking a look every thirty
            // seconds is what gives the Setup panel a previous one to compare against the
            // first time somebody opens it.
            let _ = combat_log_status(&state);
        }
        std::thread::sleep(Duration::from_secs(30));
    });
}

/// Whether the shipped config carries a block the updater plugin can actually load.
/// Tauri hands a plugin `null` when its key is absent and treats a deserialization failure
/// as fatal, so registering the plugin against a missing or malformed block kills the
/// process during startup. Pure, so the rule is testable without a running app.
fn updater_configured(plugins: &PluginConfig) -> bool {
    plugins.0.get(UPDATER_PLUGIN).is_some_and(|config| {
        serde_json::from_value::<tauri_plugin_updater::Config>(config.clone()).is_ok()
    })
}

/// How large the startup log is allowed to get before it starts over.
///
/// A launch costs two short lines, so a megabyte is somewhere north of ten thousand of them
/// — long enough that whatever a person is being asked to look at is still in the file, and
/// small enough that nothing has to prune a log the app itself never reads.
const STARTUP_LOG_LIMIT: u64 = 1024 * 1024;

/// The directory a startup log belongs in on `os`.
///
/// The failures worth recording all happen before there is an app to ask Tauri where its
/// data lives, so this works out the place the same way the platform would. Windows keeps it
/// beside the app's own data under `%LOCALAPPDATA%`; macOS has `~/Library/Logs`, which is
/// both where Console.app looks and somewhere a person can be talked through opening; Linux
/// uses the XDG state directory, which is what that specification has for exactly this — a
/// file that should survive a reboot and that nobody would miss if it did not.
///
/// A temporary directory is the last resort and a bad one, because macOS sweeps it and that
/// is precisely how the previous version of this lost every crash it recorded. It stands
/// only for the case where the environment names no home at all.
fn log_directory(
    os: &str,
    environment: impl Fn(&str) -> Option<PathBuf>,
    temporary: &Path,
) -> PathBuf {
    let home = || environment("HOME");
    match os {
        "windows" => environment("LOCALAPPDATA").map(|data| data.join("Chronie")),
        "macos" => home().map(|home| home.join("Library").join("Logs").join("Chronie")),
        _ => environment("XDG_STATE_HOME")
            .or_else(|| home().map(|home| home.join(".local").join("state")))
            .map(|state| state.join("chronie")),
    }
    .unwrap_or_else(|| temporary.join("Chronie"))
}

/// Where this machine's startup log sits.
fn startup_log() -> PathBuf {
    log_directory(
        std::env::consts::OS,
        |key| std::env::var_os(key).map(PathBuf::from),
        &std::env::temp_dir(),
    )
    .join("chronie.log")
}

/// Appends one stamped line to the log at `path`, starting the file over once it is too big.
///
/// Every error is swallowed by the caller rather than here: a log that cannot be written is
/// not a reason to stop a launch that was otherwise going to work.
fn append_log_line(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::metadata(path).is_ok_and(|file| file.len() > STARTUP_LOG_LIMIT) {
        fs::remove_file(path)?;
    }
    let stamp = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(format!("[{stamp}] {line}\n").as_bytes()))
}

/// Records one line about this launch, wherever this platform keeps them.
fn record(line: &str) {
    let _ = append_log_line(&startup_log(), line);
}

/// Sends panics to the log as well as to wherever they were already going.
///
/// A panic during startup — in `setup`, inside a plugin, in the context macro's own
/// deserialising — unwinds straight past the error handling in [`run`] and takes the process
/// with it. On a tray app with no console that is invisible: the icon never appears and
/// nothing anywhere says why. Chaining onto the default hook rather than replacing it keeps
/// the message on stderr for anyone running the binary from a terminal.
fn install_panic_log() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        record(&format!("panic: {panic}"));
        previous(panic);
    }));
}

fn report_startup_failure(message: &str) {
    eprintln!("Chronie failed to start: {message}");
    eprintln!("Recorded in {}", startup_log().display());
    record(&format!("failed to start: {message}"));
}

fn command_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::new().commands(tauri_specta::collect_commands![
        achievement_details,
        add_activity,
        capture_image,
        capture_thumbnails,
        character_look,
        character_model,
        character_worn_set,
        check_for_app_update,
        choose_wow_path,
        combat_logging,
        currency_icons,
        custom_sets,
        dashboard,
        delete_activity,
        delete_capture,
        delete_custom_set,
        delete_transmog_tag,
        gallery_models,
        gallery_sets,
        game_icons,
        in_game_set_appearances,
        in_game_sets,
        install_addon,
        item_appearances,
        item_details,
        log_retention,
        place_icons,
        query_schema,
        release,
        reset_activities,
        run_query,
        save_character_look,
        save_custom_set,
        save_wow_path,
        send_set_to_game,
        session_gap,
        set_capture_note,
        set_capture_storage,
        set_capture_triggers,
        set_combat_logging,
        set_log_retention,
        set_requests,
        set_transmog_favourite,
        set_transmog_tag,
        settings,
        sync_now,
        transmog_appearances,
        transmog_marks,
        transmog_set_items,
        transmog_sets,
        update_activity,
        wifi_answer_offer,
        wifi_discover,
        wifi_receive_start,
        wifi_receive_status,
        wifi_receive_stop,
        wifi_send,
        worn_set,
    ])
}

fn checkout_bindings(source: &str) -> String {
    source.replace("\r\n", "\n")
}

/// Writes the deterministic TypeScript command client, or verifies the committed copy.
///
/// This uses only Rust metadata and the filesystem: no Tauri process or webview is started,
/// which makes the same operation suitable for local generation and CI drift detection.
pub fn export_bindings(check: bool) -> Result<(), String> {
    let destination = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/bindings.ts");
    let language = || {
        specta_typescript::Typescript::default()
            .bigint(specta_typescript::BigIntExportBehavior::Number)
            .header("// @ts-nocheck")
    };
    let generated = tempfile::NamedTempFile::new().map_err(|error| error.to_string())?;
    command_builder()
        .export(language(), generated.path())
        .map_err(|error| error.to_string())?;
    let generated = fs::read_to_string(generated.path()).map_err(|error| error.to_string())?;
    let expected = generated
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    if !check {
        return fs::write(destination, expected).map_err(|error| error.to_string());
    }

    let committed = fs::read_to_string(&destination).map_err(|_| {
        format!(
            "{} is missing; run `bun run bindings:generate`.",
            destination.display()
        )
    })?;
    if expected != checkout_bindings(&committed) {
        return Err(format!(
            "{} is stale; run `bun run bindings:generate`.",
            destination.display()
        ));
    }
    Ok(())
}

pub fn run() {
    install_panic_log();
    record(&format!("starting Chronie {}", env!("CARGO_PKG_VERSION")));
    let context = tauri::generate_context!();
    let commands = command_builder();
    // The rolling dev release strips `plugins.updater` from the shipped config whenever no
    // signing key is available. Registering the plugin regardless makes Tauri fail while
    // deserializing the absent config, which aborts startup before a window or tray exists
    // and looks exactly like the process never launched.
    let updater_configured = updater_configured(&context.config().plugins);
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The webview cannot open a window of its own, so a link in the page reaches the
        // user's browser only by being handed to the operating system from here.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ));
    if updater_configured {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    let result = builder
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            let data_directory = data_dir.clone();
            let database_path = data_dir.join("chronie.sqlite3");
            collector::initialize(&database_path).map_err(std::io::Error::other)?;
            let json_path = data_dir.join("segments.json");
            if json_path.is_file() {
                fs::remove_file(json_path)?;
            }
            let database: Arc<Mutex<()>> = Arc::default();
            let device = wifi::device_name();
            let state = AppState {
                settings: Mutex::new(load_settings(&data_dir.join("settings.json"))),
                station: wifi::Station::new(
                    database_path,
                    data_dir.clone(),
                    device.clone(),
                    Arc::clone(&database),
                ),
                device,
                database,
                data_dir,
                storage: Arc::default(),
                icons: Arc::default(),
                achievements: Arc::default(),
                items: Arc::default(),
                combat_log_seen: Mutex::default(),
                updater_configured,
            };
            app.manage(state);
            setup_tray(app.handle())?;
            let _ = app.autolaunch().enable();
            install_addon_at_startup(app.handle().clone());
            start_background_sync(app.handle().clone());
            if updater_configured {
                start_automatic_updates(app.handle().clone());
            }
            if std::env::args().any(|argument| argument == "--background") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            // Paired with the line at the top of `run`. Two lines and the app got up; one
            // line and it died in here, which is the difference the log exists to draw.
            record(&format!("ready; data in {}", data_directory.display()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(commands.invoke_handler())
        .run(context);
    if let Err(error) = result {
        report_startup_failure(&error.to_string());
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// The addon's manifest as it sits in the tree, read again at compile time so the tests
    /// judge the bundle against the source rather than against a copy of it written here.
    const ADDON_TOC: &str = include_str!("../../../addon/chronie.toc");

    fn plugins(value: Value) -> PluginConfig {
        PluginConfig(serde_json::from_value(value).unwrap())
    }

    #[test]
    fn binding_drift_check_ignores_windows_checkout_line_endings() {
        assert_eq!(checkout_bindings("one\r\ntwo\r\n"), "one\ntwo\n");
    }

    /// The files the .toc names, in the .toc's own order, read the way build.rs reads them.
    fn files_listed_in_the_toc() -> Vec<String> {
        ADDON_TOC
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| line.replace('\\', "/"))
            .collect()
    }

    fn version_in_the_toc() -> String {
        ADDON_TOC
            .lines()
            .find_map(|line| line.strip_prefix("## Version:"))
            .expect("the addon's .toc should carry a version")
            .trim()
            .to_string()
    }

    fn bundled(relative: &str) -> &'static [u8] {
        BUNDLED_ADDON
            .iter()
            .find(|(path, _)| *path == relative)
            .unwrap_or_else(|| panic!("the bundle should carry {relative}"))
            .1
    }

    /// A game folder the way `resolve_wow_path` hands one over: the `_retail_` directory.
    fn game_folder(root: &Path) -> PathBuf {
        let retail = root.join("_retail_");
        fs::create_dir_all(retail.join("Interface").join("AddOns")).unwrap();
        retail
    }

    fn addon_folder(retail: &Path) -> PathBuf {
        retail.join("Interface").join("AddOns").join("chronie")
    }

    /// Every file under `root`, as sorted slash-separated paths relative to it.
    fn tree(root: &Path) -> Vec<String> {
        let mut found = Vec::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(&directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    let relative = path.strip_prefix(root).unwrap().to_string_lossy();
                    found.push(relative.replace('\\', "/"));
                }
            }
        }
        found.sort();
        found
    }

    #[test]
    fn bundles_the_files_the_toc_lists_and_nothing_else() {
        // Compared as sets: load order lives in the .toc the game reads, so the order the
        // build script happens to emit rows in carries no meaning. What matters is that a
        // file cannot go missing from the binary, and that nothing the .toc never named —
        // the busted specs above all — can ride along into somebody's game folder.
        let mut expected = files_listed_in_the_toc();
        expected.push("chronie.toc".to_string());
        expected.sort();
        let mut bundled: Vec<String> = BUNDLED_ADDON
            .iter()
            .map(|(relative, _)| (*relative).to_string())
            .collect();
        bundled.sort();
        assert_eq!(bundled, expected);
        for (relative, contents) in BUNDLED_ADDON {
            assert!(
                !relative.starts_with("spec/"),
                "{relative} is not part of the addon"
            );
            assert!(!contents.is_empty(), "{relative} was embedded empty");
        }
    }

    /// build.rs is the only thing that can know the commit, and nothing else in the build would
    /// notice if it started reporting a branch name, a `git` error message, or the merge commit
    /// of a pull request. The window turns whatever arrives into a link to GitHub, so the shape
    /// is the whole of what makes that link work: forty hex characters, or nothing at all.
    #[test]
    fn reports_the_commit_it_was_built_from() {
        let release = release();

        assert_eq!(release.channel, "dev");
        let commit = release.commit;
        assert!(
            commit.is_empty()
                || (commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit())),
            "CHRONIE_COMMIT should be a full commit sha or nothing, and was {commit:?}",
        );
    }

    #[test]
    fn installs_the_shipped_addon_and_reports_its_version() {
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());

        let result = replace_addon(&retail, &Settings::default(), &[], 0).unwrap();

        assert_eq!(result.version, version_in_the_toc());
        let installed = addon_folder(&retail);
        assert!(installed.join("Main.lua").is_file());
        assert!(!installed.join("spec").exists());
        assert_eq!(
            fs::read(installed.join("chronie.toc")).unwrap(),
            bundled("chronie.toc")
        );
        let lua_modules = fs::read_dir(installed.join("src"))
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|kind| kind == "lua")
            })
            .count();
        assert!(lua_modules > 0, "no Lua modules landed in src/");
    }

    /// An outfit somebody sent has to survive the trip into the game folder, because that file
    /// is the only way a request ever reaches the addon.
    ///
    /// Installing lays the whole folder down again, so the shipped empty module would otherwise
    /// go over the top of it and every request not yet carried out would be lost — silently,
    /// and at exactly the moment somebody was setting Chronie up.
    #[test]
    fn carries_a_waiting_request_into_the_game_folder() {
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());
        let waiting = ingamesets::Request {
            id: 4,
            name: "Winter Look".into(),
            icon: Some(133_600),
            created_at: 10,
            outcome: None,
            applied_at: None,
            set_id: None,
            slots: vec![ingamesets::Slot {
                slot: 0,
                appearance_id: 55,
                secondary_appearance_id: None,
                illusion_id: None,
            }],
        };

        replace_addon(&retail, &Settings::default(), &[waiting], 20).unwrap();

        let written =
            fs::read_to_string(addon_folder(&retail).join("src/CustomSetRequests.lua")).unwrap();
        assert!(
            written.contains(r#"["name"] = "Winter Look","#),
            "{written}"
        );
        assert!(
            written.contains(r#"["slot"] = 0, ["appearance"] = 55,"#),
            "{written}"
        );
        assert_ne!(written.as_bytes(), bundled("src/CustomSetRequests.lua"));
    }

    /// And an install with nothing waiting still writes a module that loads, rather than the
    /// shipped one — which is the same file either way, but has to be written by the same code
    /// path or the empty case is the untested one.
    #[test]
    fn writes_a_module_that_asks_for_nothing_when_nothing_is_waiting() {
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());

        replace_addon(&retail, &Settings::default(), &[], 0).unwrap();

        let written =
            fs::read_to_string(addon_folder(&retail).join("src/CustomSetRequests.lua")).unwrap();
        assert!(written.contains("ns.customSetRequests = {"), "{written}");
        assert!(!written.contains(r#"["id"]"#), "{written}");
    }

    /// The setting has to survive the trip into the game folder, because the addon reads it
    /// there and nowhere else.
    #[test]
    fn writes_the_combat_logging_setting_into_the_installed_addon() {
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());
        let settings = Settings {
            combat_logging: true,
            ..Settings::default()
        };

        replace_addon(&retail, &settings, &[], 0).unwrap();

        let installed = fs::read_to_string(addon_folder(&retail).join(SETTINGS_MODULE)).unwrap();
        assert!(
            installed.contains("combatLogging = true"),
            "the installed addon was not told to log: {installed}"
        );
    }

    /// And the default install has to say no, whatever the bundle happens to carry — nobody
    /// gets hundreds of megabytes of combat log for having installed Chronie.
    #[test]
    fn installs_with_combat_logging_off_by_default() {
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());

        replace_addon(&retail, &Settings::default(), &[], 0).unwrap();

        let installed = fs::read_to_string(addon_folder(&retail).join(SETTINGS_MODULE)).unwrap();
        assert!(installed.contains("combatLogging = false"), "{installed}");
    }

    /// The bundled module is what a hand-installed copy loads, so it has to declare the same
    /// table the generated one does — and default to logging nothing.
    #[test]
    fn ships_a_settings_module_matching_the_one_it_generates() {
        let bundled = std::str::from_utf8(bundled(SETTINGS_MODULE)).unwrap();

        assert!(bundled.contains("ns.settings = {"), "{bundled}");
        assert!(bundled.contains("combatLogging = false"), "{bundled}");
        assert!(
            bundled.contains("captureTriggers = { \"accountFirstAchievement\" }"),
            "{bundled}"
        );
        let generated = settings_module(false, &default_capture_triggers());
        assert!(generated.contains("ns.settings = {"));
        assert!(
            generated.contains("captureTriggers = { \"accountFirstAchievement\" }"),
            "{generated}"
        );
    }

    /// The list has to survive the trip into the game folder the same way combat logging
    /// does, because the addon reads it there and nowhere else.
    #[test]
    fn writes_the_capture_triggers_into_the_installed_addon() {
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());
        let settings = Settings {
            capture_triggers: vec!["levelUp".into(), "mount".into()],
            ..Settings::default()
        };

        replace_addon(&retail, &settings, &[], 0).unwrap();

        let installed = fs::read_to_string(addon_folder(&retail).join(SETTINGS_MODULE)).unwrap();
        assert!(
            installed.contains("captureTriggers = { \"levelUp\", \"mount\" }"),
            "{installed}"
        );
    }

    /// An empty list is a thing somebody can mean: photograph nothing unless I press the key.
    #[test]
    fn writes_an_empty_trigger_list_as_one() {
        let generated = settings_module(false, &[]);

        assert!(generated.contains("captureTriggers = {  }"), "{generated}");
    }

    /// The names reach a Lua file the game executes, out of a settings file somebody can
    /// edit by hand. Nothing that is not a plain name may get that far.
    #[test]
    fn keeps_anything_that_is_not_a_trigger_name_out_of_the_lua() {
        assert_eq!(trigger_literal("levelUp").as_deref(), Some("\"levelUp\""));
        assert_eq!(trigger_literal(""), None);
        assert_eq!(trigger_literal("level up"), None);
        assert_eq!(trigger_literal("level_up"), None);
        assert_eq!(trigger_literal("\" } print(1) --"), None);
        assert_eq!(trigger_literal("a\\\"b"), None);
        assert_eq!(trigger_literal("mount\nlevelUp"), None);

        let generated = settings_module(false, &["\" } print(1) --".into(), "mount".into()]);
        assert!(
            generated.contains("captureTriggers = { \"mount\" }"),
            "{generated}"
        );
    }

    /// A settings file written before automatic capture existed must not read as "photograph
    /// nothing" — the default is what an install that has never been told otherwise gets.
    #[test]
    fn reads_a_settings_file_that_predates_capture_triggers_as_the_default() {
        let settings: Settings = serde_json::from_str(r#"{"wowPath": "/games/wow"}"#).unwrap();

        assert_eq!(settings.capture_triggers, default_capture_triggers());
    }

    /// And an explicit empty list is respected, because turning it off is a thing to want.
    #[test]
    fn reads_an_explicit_empty_trigger_list_as_off() {
        let settings: Settings = serde_json::from_str(r#"{"captureTriggers": []}"#).unwrap();

        assert!(settings.capture_triggers.is_empty());
    }

    /// A settings file written before there was anything to say about screenshot storage gets
    /// the same answer a new install does: re-encode, and take the game's copy away once
    /// Chronie holds one of its own.
    #[test]
    fn reads_a_settings_file_that_predates_screenshot_storage_as_the_default() {
        let settings: Settings = serde_json::from_str(r#"{"wowPath": "/games/wow"}"#).unwrap();

        assert_eq!(settings.capture_quality, captures::Quality::Balanced);
        assert!(!settings.keep_original_screenshots);
    }

    /// And both cross the settings file under the names the window uses, because the window is
    /// what writes them — a rename on either side that the other did not make is a control
    /// that silently stops saving.
    #[test]
    fn round_trips_the_screenshot_storage_settings_through_the_file() {
        let settings = Settings {
            capture_quality: captures::Quality::Original,
            keep_original_screenshots: true,
            ..Settings::default()
        };

        let written = serde_json::to_string(&settings).unwrap();

        assert!(
            written.contains(r#""captureQuality":"original""#),
            "{written}"
        );
        assert!(
            written.contains(r#""keepOriginalScreenshots":true"#),
            "{written}"
        );
        let read: Settings = serde_json::from_str(&written).unwrap();
        assert_eq!(read.capture_quality, captures::Quality::Original);
        assert!(read.keep_original_screenshots);
    }

    /// Who the character is crosses that file too, and it is the one setting the reader never
    /// sees the storage of: a body drawn from an install nobody has answered anything about is
    /// exactly the body this app drew before there was anywhere to answer, so a field that
    /// stopped being written would look like nothing at all until somebody noticed her hair.
    #[test]
    fn round_trips_who_the_character_is_through_the_file() {
        let settings = Settings {
            character_look: vec![customization::Picked {
                question: 16,
                swatch: 133,
            }],
            ..Settings::default()
        };

        let written = serde_json::to_string(&settings).unwrap();

        assert!(
            written.contains(r#""characterLook":[{"question":16,"swatch":133}]"#),
            "{written}"
        );
        let read: Settings = serde_json::from_str(&written).unwrap();
        assert_eq!(read.character_look, settings.character_look);
    }

    /// And a settings file older than the field is a reader who has said nothing about her,
    /// which is what every install starts as rather than a file to refuse.
    #[test]
    fn reads_a_settings_file_that_predates_the_character_as_nobody_having_said() {
        let settings: Settings = serde_json::from_str(r#"{"wowPath": "/games/wow"}"#).unwrap();

        assert_eq!(settings.character_look, Vec::new());
    }

    #[test]
    fn replaces_an_older_copy_rather_than_merging_with_it() {
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());
        let installed = addon_folder(&retail);
        let stale = installed.join("src").join("Removed.lua");
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&stale, b"-- a module this build no longer ships\n").unwrap();
        fs::write(installed.join("chronie.toc"), b"## Version: 0.0.1-stale\n").unwrap();

        replace_addon(&retail, &Settings::default(), &[], 0).unwrap();

        assert!(
            !stale.exists(),
            "a file from the old copy survived the install"
        );
        assert_eq!(
            fs::read(installed.join("chronie.toc")).unwrap(),
            bundled("chronie.toc")
        );
        // The backup is the install's own scaffolding; leaving it behind would put a second
        // copy of the addon in the folder the game scans.
        assert!(!retail
            .join("Interface")
            .join("AddOns")
            .join(".chronie-backup")
            .exists());
    }

    /// The particular file that had to go, and the reason the install being a swap rather
    /// than a copy matters. An older Chronie shipped a Bindings.xml, which the client loads
    /// by name out of the addon's root folder without consulting any manifest — so a copy
    /// that only wrote this build's files over the top would leave it sitting there, still
    /// declaring a header on two bindings and still saying so in red at every login (issue
    /// #69). The staged folder never contains one, and the folder is what is swapped in.
    #[test]
    fn leaves_no_keybinding_file_from_an_older_copy_behind() {
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());
        let installed = addon_folder(&retail);
        fs::create_dir_all(&installed).unwrap();
        let stale = installed.join("Bindings.xml");
        fs::write(
            &stale,
            b"<Bindings><Binding name=\"CHRONIE_CAPTURE\" /></Bindings>\n",
        )
        .unwrap();

        replace_addon(&retail, &Settings::default(), &[], 0).unwrap();

        assert!(
            !stale.exists(),
            "an older copy's Bindings.xml survived the install"
        );
        assert!(
            installed.join("Main.lua").is_file(),
            "the new copy did not land"
        );
    }

    #[test]
    fn installs_the_same_way_however_often_it_runs() {
        // The app installs on every launch now, so a second run has to be a no-op rather
        // than something that accumulates.
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());
        let addons = retail.join("Interface").join("AddOns");

        let first = replace_addon(&retail, &Settings::default(), &[], 0).unwrap();
        let after_first = tree(&addons);
        let second = replace_addon(&retail, &Settings::default(), &[], 0).unwrap();

        assert_eq!(second.version, first.version);
        assert_eq!(tree(&addons), after_first);
    }

    #[test]
    fn refuses_a_game_folder_with_no_addons_directory() {
        let root = tempfile::tempdir().unwrap();
        let bystander = root.path().join("WTF");
        fs::create_dir_all(&bystander).unwrap();

        let error = replace_addon(root.path(), &Settings::default(), &[], 0).unwrap_err();

        assert!(error.contains("AddOns"), "unhelpful error: {error}");
        assert_eq!(tree(root.path()), Vec::<String>::new());
        assert!(
            bystander.is_dir(),
            "the failed install took the folder's contents with it"
        );
    }

    #[test]
    fn registers_the_updater_only_against_a_loadable_config() {
        let valid = json!({
            "endpoints": ["https://example.com/latest.json"],
            "pubkey": "dW50cnVzdGVk",
        });
        let cases = [
            // The dev release drops the whole block when it has no signing key.
            (json!({}), false),
            (json!({ "updater": Value::Null }), false),
            // A block Tauri cannot deserialize is just as fatal as a missing one.
            (
                json!({ "updater": { "endpoints": ["https://example.com/l.json"] } }),
                false,
            ),
            (
                json!({ "updater": { "endpoints": "not-a-list", "pubkey": "dW50cnVzdGVk" } }),
                false,
            ),
            (json!({ "updater": valid }), true),
        ];
        for (config, expected) in cases {
            assert_eq!(
                updater_configured(&plugins(config.clone())),
                expected,
                "unexpected verdict for {config}"
            );
        }
    }

    #[test]
    fn ships_an_updater_block_that_loads_whenever_it_is_present() {
        // The release pipeline rewrites this file before the tests run and drops the block
        // entirely when it has no signing key, so the config compiled into this binary may
        // legitimately carry none. What must never ship is a block that is present but
        // unloadable, because that fails startup exactly like a missing one.
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let plugins = plugins(config["plugins"].clone());
        if plugins.0.contains_key(UPDATER_PLUGIN) {
            assert!(updater_configured(&plugins));
        }
    }

    /// An environment holding only the variables named, for driving [`log_directory`].
    fn environment(variables: &[(&str, &str)]) -> impl Fn(&str) -> Option<PathBuf> {
        let variables: Vec<(String, PathBuf)> = variables
            .iter()
            .map(|(key, value)| ((*key).to_string(), PathBuf::from(value)))
            .collect();
        move |wanted| {
            variables
                .iter()
                .find(|(key, _)| key == wanted)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn keeps_the_log_where_each_platform_keeps_logs() {
        let local = "C:\\Users\\ana\\AppData\\Local";
        let home = [("HOME", "/home/ana"), ("LOCALAPPDATA", local)];
        let cases = [
            ("windows", PathBuf::from(local).join("Chronie")),
            (
                "macos",
                PathBuf::from("/home/ana/Library/Logs").join("Chronie"),
            ),
            (
                "linux",
                PathBuf::from("/home/ana/.local/state").join("chronie"),
            ),
        ];
        for (os, expected) in cases {
            let directory = log_directory(os, environment(&home), Path::new("/tmp"));
            assert_eq!(directory, expected, "wrong directory on {os}");
        }
    }

    #[test]
    fn prefers_the_xdg_state_directory_where_one_is_named() {
        let named = [("HOME", "/home/ana"), ("XDG_STATE_HOME", "/home/ana/state")];
        let directory = log_directory("linux", environment(&named), Path::new("/tmp"));
        assert_eq!(directory, PathBuf::from("/home/ana/state").join("chronie"));
    }

    /// The old log went to a temporary directory on every platform but Windows, which on
    /// macOS is swept — so the crashes it recorded were gone by the time anyone asked. It is
    /// still the fallback, but only for an environment that names nowhere else at all.
    #[test]
    fn falls_back_to_a_temporary_directory_only_with_nowhere_else_to_go() {
        for os in ["windows", "macos", "linux"] {
            let directory = log_directory(os, environment(&[]), Path::new("/tmp"));
            let expected = PathBuf::from("/tmp").join("Chronie");
            assert_eq!(directory, expected, "wrong fallback on {os}");
        }
    }

    #[test]
    fn stamps_each_line_and_keeps_the_ones_already_written() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("logs").join("chronie.log");
        append_log_line(&path, "starting Chronie 0.1.0").unwrap();
        append_log_line(&path, "failed to start: no window").unwrap();

        let written = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = written.lines().collect();
        assert_eq!(lines.len(), 2, "expected both lines in {written}");
        assert!(
            lines[0].ends_with("] starting Chronie 0.1.0"),
            "{}",
            lines[0]
        );
        assert!(
            lines[1].ends_with("] failed to start: no window"),
            "{}",
            lines[1]
        );
        // A stamp, so two launches can be told apart and a crash can be dated.
        assert!(lines[0].starts_with('['), "{}", lines[0]);
    }

    #[test]
    fn starts_the_log_over_once_it_outgrows_its_limit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("chronie.log");
        fs::write(&path, vec![b'x'; STARTUP_LOG_LIMIT as usize + 1]).unwrap();

        append_log_line(&path, "starting Chronie 0.1.0").unwrap();

        let written = fs::read_to_string(&path).unwrap();
        assert!(
            !written.contains('x'),
            "the oversized log should have been dropped"
        );
        assert!(written.ends_with("] starting Chronie 0.1.0\n"), "{written}");
    }

    /// The manifest as it sits in the tree, so the tests judge what Cargo and the bundler
    /// will actually read rather than a description of it written here.
    const CARGO_TOML: &str = include_str!("../Cargo.toml");

    /// Every `name = "…"` belonging to a table in the manifest opened by `header`.
    ///
    /// Enough of TOML to ask which binaries a manifest declares and what the package is
    /// called, and no more — the alternative is a parser dependency in the shipped tree for
    /// the sake of two assertions.
    fn manifest_names(manifest: &str, header: &str) -> Vec<String> {
        let mut names = Vec::new();
        let mut inside = false;
        for line in manifest.lines().map(str::trim) {
            if line.starts_with('[') {
                inside = line == header;
            } else if inside {
                if let Some(value) = line
                    .strip_prefix("name")
                    .and_then(|rest| rest.trim_start().strip_prefix('=').map(str::trim))
                {
                    names.push(value.trim_matches('"').to_string());
                }
            }
        }
        names
    }

    #[test]
    fn reads_the_names_a_manifest_declares_under_one_header() {
        let manifest = "[package]\nname = \"app\"\n\n[[bin]]\nname = \"one\"\n[[bin]]\n\
                        path = \"src/bin/two.rs\"\nname = \"two\"\n";
        assert_eq!(manifest_names(manifest, "[package]"), ["app"]);
        assert_eq!(manifest_names(manifest, "[[bin]]"), ["one", "two"]);
    }

    /// The bundle has to launch the app, and every binary the crate has is shipped inside it.
    ///
    /// Two ways that has gone wrong, and this guards both. A crate that declares no `[[bin]]`
    /// leaves the bundler to discover its binaries by reading `src/bin/`, and a crate whose
    /// search turns up exactly one promotes it to the bundle's main executable whatever it
    /// happens to be called — `src/main.rs` is never in that search, because Cargo does not
    /// need it named to build it. So the moment `src/bin/export_bindings.rs` arrived, the
    /// shipped app started launching the bindings exporter, which writes a file and exits,
    /// and a player saw a program that died the instant it opened. And even once the right
    /// one launches, a second binary is still 20 MB of dead weight copied into the `.app` and
    /// into every Windows download and auto-update.
    ///
    /// So: the manifest names the package's own binary, and that binary is the only one the
    /// crate has. A tool that is not the app belongs in `examples/`, which no bundle carries —
    /// or, if it has to run on Windows as well, in `tests/`, for the reason
    /// `tests/bindings.rs` gives.
    #[test]
    fn the_manifest_declares_the_app_binary_and_nothing_else() {
        let package = manifest_names(CARGO_TOML, "[package]");
        let package = package
            .first()
            .expect("the manifest should name the package");
        assert_eq!(
            manifest_names(CARGO_TOML, "[[bin]]"),
            std::slice::from_ref(package),
            "the manifest has to declare a [[bin]] named {package} and no other, or the \
             bundle will launch or carry a binary that is not the app"
        );
        let discovered: Vec<String> =
            fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bin"))
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
        assert!(
            discovered.is_empty(),
            "src/bin holds {discovered:?}, and Cargo builds those alongside the declared \
             [[bin]] whether the manifest mentions them or not — the bundle would ship them. \
             A tool that is not the app belongs in examples/ or in the test suite."
        );
    }
}
