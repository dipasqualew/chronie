mod activity;
pub mod achievements;
pub mod captures;
pub mod casc;
pub mod character;
mod collector;
pub mod combatlog;
pub mod db2;
pub mod glb;
pub mod icons;
pub mod logfile;
pub mod m2;
pub mod models;
pub mod placement;
pub mod retention;
pub mod skin;
pub mod transmog;
pub mod wifi;
pub mod worn;

use achievements::AchievementBook;
use chrono::Utc;
use collector::{dashboard as load_dashboard, SyncResult};
use icons::IconCache;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// The icons decoded so far. Shared rather than owned, because reading the game's files
    /// happens on a worker thread that outlives the command that started it.
    icons: Arc<IconCache>,
    /// The achievements looked up so far, shared for the same reason.
    achievements: Arc<AchievementBook>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateResult {
    updated: bool,
    version: String,
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
fn dashboard(state: State<'_, AppState>) -> Result<Value, String> {
    load_dashboard(&state.database_path())
}

/// The transmog sets the installed game knows about.
#[tauri::command]
async fn transmog_sets(state: State<'_, AppState>) -> Result<Value, String> {
    read_game_files(&state, transmog::sets).await
}

/// What one transmog set is made of, walked out of the same files.
///
/// The window already has the set from the grid, so only its id crosses over; everything a
/// row shows is resolved here rather than assembled from two halves.
#[tauri::command]
async fn transmog_set_items(set_id: u32, state: State<'_, AppState>) -> Result<Value, String> {
    read_game_files(&state, move |files| transmog::set_items(files, set_id)).await
}

/// What the game says about the achievements a window is showing.
///
/// The dashboard already carries the ids, because the addon recorded them at the moment they
/// were earned; everything a reader recognises an achievement by is in the game's own tables
/// and is looked up here. Asked for after the segment is drawn, for the same reason the
/// icons are: a list of achievements is worth reading while the tables that describe them
/// are still being opened.
#[tauri::command]
async fn achievement_details(ids: Vec<u32>, state: State<'_, AppState>) -> Result<Value, String> {
    let book = Arc::clone(&state.achievements);
    let missing = book.missing(&ids);
    if !missing.is_empty() {
        let found =
            read_game_files(&state, move |files| achievements::read(files, &missing)).await?;
        book.store(found);
    }
    Ok(book.answer(&ids))
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
async fn game_icons(
    icon_file_data_ids: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let cache = Arc::clone(&state.icons);
    let missing = cache.missing(&icon_file_data_ids);
    if !missing.is_empty() {
        let decoded =
            read_game_files(&state, move |files| Ok(icons::decode(files, &missing))).await?;
        cache.store(decoded);
    }
    Ok(cache.answer(&icon_file_data_ids))
}

/// The character an appearance is worn on, bare, as a `.glb` in a data URL.
///
/// One fixed model for the whole app — a Human Female, because gear is authored to look right
/// on human proportions — so this is asked for once and shown for every set opened after.
///
/// No base skin is passed, because which texture a character's skin is comes out of four
/// customization tables whose column positions have not been read off an install. See
/// `character::Atlas::base`, which is the one place that changes when they have been.
#[tauri::command]
async fn character_model(state: State<'_, AppState>) -> Result<Value, String> {
    read_game_files(&state, character::model_of).await
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
async fn worn_set(pieces: Vec<worn::Piece>, state: State<'_, AppState>) -> Result<Value, String> {
    read_game_files(&state, move |files| {
        character::worn_set_of(files, &pieces)
    })
    .await
}

/// Runs a read of the installed game's own files, off the main thread.
///
/// This reads the game's storage rather than anything the addon collected, so it needs the
/// install itself and not just its `WTF` folder — `resolve_wow_path` lands on `_retail_`,
/// and `Data/` is its sibling. Getting at it means inflating a couple of hundred megabytes,
/// which on the main thread would freeze the window for as long as it took; the views that
/// ask for this are opened by a click that should stay responsive.
async fn read_game_files<T, F>(state: &State<'_, AppState>, read: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&dyn casc::GameFiles) -> Result<T, String> + Send + 'static,
{
    let retail = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        configured_wow_path(&settings)?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let install = retail
            .parent()
            .ok_or("The game folder has no parent to look for Data in.")?;
        read(&casc::CascFiles::open(install)?)
    })
    .await
    .map_err(|error| format!("Reading the game's files did not finish: {error}"))?
}

#[tauri::command]
fn settings(state: State<'_, AppState>) -> Result<Settings, String> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Settings lock failed.".to_string())
}

/// Asks the user for the game folder.
///
/// This has to be `async`. Tauri runs a synchronous command on the main thread, and the
/// folder picker blocks until the user answers it — on the main thread that is the event
/// loop the picker itself needs, so the whole window locks up with the dialog on screen.
/// An async command runs off the main thread, which is what the dialog plugin's own
/// documentation calls for.
#[tauri::command]
async fn choose_wow_path(window: WebviewWindow) -> Option<String> {
    window
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn save_wow_path(wow_path: String, state: State<'_, AppState>) -> Result<Settings, String> {
    let resolved = collector::resolve_wow_path(Path::new(wow_path.trim()))?;
    let mut settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
    settings.wow_path = Some(resolved.to_string_lossy().into_owned());
    state.save(&settings)?;
    Ok(settings.clone())
}

#[tauri::command]
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
    let status = combatlog::status(
        &wow_path,
        requested,
        seen.as_ref(),
        Utc::now().timestamp(),
    );
    seen.clone_from(&status.log);
    Ok(status)
}

#[tauri::command]
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

/* ---------- clearing the logs up again ---------- */

/// What a sweep would delete right now, what it will not touch, and what it has already taken.
///
/// Answered whether or not the sweeper is on, because this is the dry run: the panel shows the
/// files and the size before the switch is thrown, so the first sweep on somebody's machine is
/// a thing they agreed to rather than a thing they discovered afterwards.
fn retention_report(state: &AppState) -> Result<retention::Report, String> {
    let (wow_path, retain_days) = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        (configured_wow_path(&settings).ok(), settings.retain_log_days)
    };
    collector::retention_report(
        &state.database_path(),
        wow_path.as_deref(),
        retain_days,
        Utc::now().timestamp(),
    )
}

#[tauri::command]
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
fn set_capture_triggers(
    triggers: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Settings, String> {
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
    Ok(saved)
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
fn set_capture_storage(
    quality: captures::Quality,
    keep_originals: bool,
    state: State<'_, AppState>,
) -> Result<Settings, String> {
    let mut settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
    settings.capture_quality = quality;
    settings.keep_original_screenshots = keep_originals;
    state.save(&settings)?;
    Ok(settings.clone())
}

/// The four ways a user can correct the app's guess about what a segment was.
///
/// Each one returns the whole dashboard rather than an acknowledgement, so the window
/// repaints from stored state instead of from what the frontend hoped the write did.
#[tauri::command]
fn add_activity(
    segment_id: i64,
    kind: String,
    metadata: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    collector::add_activity(
        &state.database_path(),
        segment_id,
        kind.trim(),
        &metadata,
        Utc::now().timestamp(),
    )?;
    load_dashboard(&state.database_path())
}

#[tauri::command]
fn update_activity(
    activity_id: i64,
    kind: String,
    metadata: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    collector::update_activity(
        &state.database_path(),
        activity_id,
        kind.trim(),
        &metadata,
        Utc::now().timestamp(),
    )?;
    load_dashboard(&state.database_path())
}

#[tauri::command]
fn delete_activity(activity_id: i64, state: State<'_, AppState>) -> Result<Value, String> {
    collector::delete_activity(&state.database_path(), activity_id, Utc::now().timestamp())?;
    load_dashboard(&state.database_path())
}

#[tauri::command]
fn reset_activities(segment_id: i64, state: State<'_, AppState>) -> Result<Value, String> {
    collector::reset_activities(&state.database_path(), segment_id, Utc::now().timestamp())?;
    load_dashboard(&state.database_path())
}

/// The two ways somebody changes a capture, answering with the whole dashboard for the same
/// reason the activity edits do: what ends up on screen is what was stored, never what the
/// window hoped the write did. Which matters more here than anywhere — a note that looked
/// saved and was not is a sentence somebody will not think to type again.
#[tauri::command]
fn set_capture_note(
    capture_id: i64,
    note: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    collector::set_capture_note(
        &state.database_path(),
        capture_id,
        &note,
        Utc::now().timestamp(),
    )?;
    load_dashboard(&state.database_path())
}

#[tauri::command]
fn delete_capture(capture_id: i64, state: State<'_, AppState>) -> Result<Value, String> {
    collector::delete_capture(&state.database_path(), capture_id, Utc::now().timestamp())?;
    load_dashboard(&state.database_path())
}

/// The pictures a grid of captures needs, asked for once the rows are drawn.
///
/// Async, and not for the bridge's sake: the first look at an evening's captures decodes and
/// re-encodes a screenshot apiece, which is tens of milliseconds each and would hold the main
/// thread for the length of the grid. Every one after that is a file read, because the
/// thumbnails are kept beside the images they were made from.
#[tauri::command]
async fn capture_thumbnails(
    capture_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    collector::capture_thumbnails(&state.database_path(), &capture_ids)
}

/// One capture at the size it was taken, which is what opening a picture asks for.
#[tauri::command]
async fn capture_image(capture_id: i64, state: State<'_, AppState>) -> Result<Value, String> {
    collector::capture_image(&state.database_path(), capture_id)
}

/// The one file in the addon the app writes rather than copies: what it has been asked to do.
///
/// This is the whole channel between the two halves. The app already lays the addon folder
/// down on every launch, so a setting reaches the game by riding along with it — the addon
/// then reads a plain Lua table instead of guessing, and what is on disk in the game folder
/// is always what Setup last said.
const SETTINGS_MODULE: &str = "src/Settings.lua";

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
    let clean = !name.is_empty() && name.chars().all(|character| character.is_ascii_alphabetic());
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
fn stage_addon(destination: &Path, settings: &Settings) -> Result<(), String> {
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
        } else {
            fs::write(&output, contents)
        }
        .map_err(|error| error.to_string())?;
    }
    Ok(())
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
fn replace_addon(wow_path: &Path, settings: &Settings) -> Result<InstallResult, String> {
    let addons = wow_path.join("Interface").join("AddOns");
    if !addons.is_dir() {
        return Err(format!("AddOns folder not found at {}.", addons.display()));
    }
    let staging = tempfile::Builder::new()
        .prefix(".chronie-install-")
        .tempdir_in(&addons)
        .map_err(|error| error.to_string())?;
    stage_addon(staging.path(), settings)?;
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
    replace_addon(&wow_path, &settings)
}

#[tauri::command]
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
fn wifi_receive_start(state: State<'_, AppState>) -> Result<wifi::ReceiveStatus, String> {
    state.station.start()
}

#[tauri::command]
fn wifi_receive_stop(state: State<'_, AppState>) -> Result<wifi::ReceiveStatus, String> {
    state.station.stop()
}

/// What the receiving half is doing, asked for on a timer while the panel is open. Polled
/// rather than pushed because the whole of it is three fields, and a window that asks is a
/// window that cannot miss the one event that mattered.
#[tauri::command]
fn wifi_receive_status(state: State<'_, AppState>) -> Result<wifi::ReceiveStatus, String> {
    state.station.status()
}

/// The answer to the offer on screen. `false` is a first-class outcome, not a cancel.
#[tauri::command]
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

/// Where a startup failure gets recorded. The window and tray do not exist yet when
/// `Builder::run` fails, so a file is the only channel that survives a double click.
fn startup_error_log() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Chronie")
        .join("startup-error.log")
}

fn report_startup_failure(message: &str) {
    let path = startup_error_log();
    eprintln!("Chronie failed to start: {message}");
    eprintln!("Recorded in {}", path.display());
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let stamp = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(format!("[{stamp}] {message}\n").as_bytes()));
}

pub fn run() {
    let context = tauri::generate_context!();
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
                icons: Arc::default(),
                achievements: Arc::default(),
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
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            dashboard,
            transmog_sets,
            transmog_set_items,
            character_model,
            worn_set,
            achievement_details,
            game_icons,
            settings,
            choose_wow_path,
            save_wow_path,
            sync_now,
            combat_logging,
            set_combat_logging,
            log_retention,
            set_log_retention,
            set_capture_triggers,
            set_capture_storage,
            install_addon,
            check_for_app_update,
            add_activity,
            update_activity,
            delete_activity,
            reset_activities,
            set_capture_note,
            delete_capture,
            capture_thumbnails,
            capture_image,
            wifi_receive_start,
            wifi_receive_stop,
            wifi_receive_status,
            wifi_answer_offer,
            wifi_discover,
            wifi_send,
        ])
        .run(context);
    if let Err(error) = result {
        report_startup_failure(&error.to_string());
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The addon's manifest as it sits in the tree, read again at compile time so the tests
    /// judge the bundle against the source rather than against a copy of it written here.
    const ADDON_TOC: &str = include_str!("../../../addon/chronie.toc");

    fn plugins(value: Value) -> PluginConfig {
        PluginConfig(serde_json::from_value(value).unwrap())
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
            assert!(!relative.starts_with("spec/"), "{relative} is not part of the addon");
            assert!(!contents.is_empty(), "{relative} was embedded empty");
        }
    }

    #[test]
    fn installs_the_shipped_addon_and_reports_its_version() {
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());

        let result = replace_addon(&retail, &Settings::default()).unwrap();

        assert_eq!(result.version, version_in_the_toc());
        let installed = addon_folder(&retail);
        assert!(installed.join("Main.lua").is_file());
        assert!(!installed.join("spec").exists());
        assert_eq!(fs::read(installed.join("chronie.toc")).unwrap(), bundled("chronie.toc"));
        let lua_modules = fs::read_dir(installed.join("src"))
            .unwrap()
            .filter(|entry| {
                entry.as_ref().unwrap().path().extension().is_some_and(|kind| kind == "lua")
            })
            .count();
        assert!(lua_modules > 0, "no Lua modules landed in src/");
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

        replace_addon(&retail, &settings).unwrap();

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

        replace_addon(&retail, &Settings::default()).unwrap();

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

        replace_addon(&retail, &settings).unwrap();

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

        assert!(written.contains(r#""captureQuality":"original""#), "{written}");
        assert!(written.contains(r#""keepOriginalScreenshots":true"#), "{written}");
        let read: Settings = serde_json::from_str(&written).unwrap();
        assert_eq!(read.capture_quality, captures::Quality::Original);
        assert!(read.keep_original_screenshots);
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

        replace_addon(&retail, &Settings::default()).unwrap();

        assert!(!stale.exists(), "a file from the old copy survived the install");
        assert_eq!(fs::read(installed.join("chronie.toc")).unwrap(), bundled("chronie.toc"));
        // The backup is the install's own scaffolding; leaving it behind would put a second
        // copy of the addon in the folder the game scans.
        assert!(!retail.join("Interface").join("AddOns").join(".chronie-backup").exists());
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
        fs::write(&stale, b"<Bindings><Binding name=\"CHRONIE_CAPTURE\" /></Bindings>\n").unwrap();

        replace_addon(&retail, &Settings::default()).unwrap();

        assert!(!stale.exists(), "an older copy's Bindings.xml survived the install");
        assert!(installed.join("Main.lua").is_file(), "the new copy did not land");
    }

    #[test]
    fn installs_the_same_way_however_often_it_runs() {
        // The app installs on every launch now, so a second run has to be a no-op rather
        // than something that accumulates.
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());
        let addons = retail.join("Interface").join("AddOns");

        let first = replace_addon(&retail, &Settings::default()).unwrap();
        let after_first = tree(&addons);
        let second = replace_addon(&retail, &Settings::default()).unwrap();

        assert_eq!(second.version, first.version);
        assert_eq!(tree(&addons), after_first);
    }

    #[test]
    fn refuses_a_game_folder_with_no_addons_directory() {
        let root = tempfile::tempdir().unwrap();
        let bystander = root.path().join("WTF");
        fs::create_dir_all(&bystander).unwrap();

        let error = replace_addon(root.path(), &Settings::default()).unwrap_err();

        assert!(error.contains("AddOns"), "unhelpful error: {error}");
        assert_eq!(tree(root.path()), Vec::<String>::new());
        assert!(bystander.is_dir(), "the failed install took the folder's contents with it");
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
}
