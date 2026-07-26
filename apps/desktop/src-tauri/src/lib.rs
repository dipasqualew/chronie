mod activity;
pub mod casc;
mod collector;
pub mod db2;
pub mod glb;
pub mod icons;
pub mod m2;
pub mod models;
pub mod transmog;

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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    wow_path: Option<String>,
    last_sync: Option<String>,
}

struct AppState {
    data_dir: PathBuf,
    settings: Mutex<Settings>,
    /// The icons decoded so far. Shared rather than owned, because reading the game's files
    /// happens on a worker thread that outlives the command that started it.
    icons: Arc<IconCache>,
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
    let wow_path = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        configured_wow_path(&settings)?
    };
    let result = collector::collect(&wow_path, &state.database_path(), Utc::now().timestamp())?;
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

/// The pictures for a set's appearances, as PNG data URLs keyed by FileDataID.
///
/// Asked for after the rows are on screen rather than with them: the ids come out of the
/// same payload the rows were drawn from, and a set reads as a list of slots long before its
/// textures have been decoded. Icons already decoded are answered from memory, which is what
/// makes the second set of a collection cost nothing — so this only reaches the game's
/// storage when the request holds something genuinely new.
#[tauri::command]
async fn transmog_icons(
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

/// The model one appearance is drawn with, as a `.glb` in a data URL, or `null`.
///
/// Asked for one appearance at a time, because a reader looks at one at a time and a set's
/// worth of models is tens of megabytes of geometry nobody has clicked on. Only heads,
/// shoulders, weapons and shields have anything to answer with; the rest of a set is texture
/// painted onto the character's body, and `null` is the ordinary answer for it rather than a
/// failure — the window keeps showing the icon it already has.
#[tauri::command]
async fn transmog_model(display_info_id: u32, state: State<'_, AppState>) -> Result<Value, String> {
    read_game_files(&state, move |files| models::model_of(files, display_info_id)).await
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

/// Lays the shipped addon out under `destination`.
fn stage_addon(destination: &Path) -> Result<(), String> {
    for (relative, contents) in BUNDLED_ADDON {
        let output = destination.join(relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&output, contents).map_err(|error| error.to_string())?;
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
fn replace_addon(wow_path: &Path) -> Result<InstallResult, String> {
    let addons = wow_path.join("Interface").join("AddOns");
    if !addons.is_dir() {
        return Err(format!("AddOns folder not found at {}.", addons.display()));
    }
    let staging = tempfile::Builder::new()
        .prefix(".chronie-install-")
        .tempdir_in(&addons)
        .map_err(|error| error.to_string())?;
    stage_addon(staging.path())?;
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
    let wow_path = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        configured_wow_path(&settings)?
    };
    replace_addon(&wow_path)
}

#[tauri::command]
fn install_addon(state: State<'_, AppState>) -> Result<InstallResult, String> {
    install_bundled_addon(&state)
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
            let state = AppState {
                settings: Mutex::new(load_settings(&data_dir.join("settings.json"))),
                data_dir,
                icons: Arc::default(),
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
            transmog_icons,
            transmog_model,
            settings,
            choose_wow_path,
            save_wow_path,
            sync_now,
            install_addon,
            check_for_app_update,
            add_activity,
            update_activity,
            delete_activity,
            reset_activities,
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

        let result = replace_addon(&retail).unwrap();

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

    #[test]
    fn replaces_an_older_copy_rather_than_merging_with_it() {
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());
        let installed = addon_folder(&retail);
        let stale = installed.join("src").join("Removed.lua");
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&stale, b"-- a module this build no longer ships\n").unwrap();
        fs::write(installed.join("chronie.toc"), b"## Version: 0.0.1-stale\n").unwrap();

        replace_addon(&retail).unwrap();

        assert!(!stale.exists(), "a file from the old copy survived the install");
        assert_eq!(fs::read(installed.join("chronie.toc")).unwrap(), bundled("chronie.toc"));
        // The backup is the install's own scaffolding; leaving it behind would put a second
        // copy of the addon in the folder the game scans.
        assert!(!retail.join("Interface").join("AddOns").join(".chronie-backup").exists());
    }

    #[test]
    fn installs_the_same_way_however_often_it_runs() {
        // The app installs on every launch now, so a second run has to be a no-op rather
        // than something that accumulates.
        let root = tempfile::tempdir().unwrap();
        let retail = game_folder(root.path());
        let addons = retail.join("Interface").join("AddOns");

        let first = replace_addon(&retail).unwrap();
        let after_first = tree(&addons);
        let second = replace_addon(&retail).unwrap();

        assert_eq!(second.version, first.version);
        assert_eq!(tree(&addons), after_first);
    }

    #[test]
    fn refuses_a_game_folder_with_no_addons_directory() {
        let root = tempfile::tempdir().unwrap();
        let bystander = root.path().join("WTF");
        fs::create_dir_all(&bystander).unwrap();

        let error = replace_addon(root.path()).unwrap_err();

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
