mod collector;

use chrono::Utc;
use collector::{dashboard as load_dashboard, SyncResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{Cursor, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewWindow,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

const REPOSITORY_ARCHIVE: &str =
    "https://github.com/dipasqualew/chronie/archive/refs/heads/main.zip";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    wow_path: Option<String>,
    last_sync: Option<String>,
}

struct AppState {
    data_dir: PathBuf,
    settings: Mutex<Settings>,
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

#[tauri::command]
fn settings(state: State<'_, AppState>) -> Result<Settings, String> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Settings lock failed.".to_string())
}

#[tauri::command]
fn choose_wow_path(window: WebviewWindow) -> Option<String> {
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

fn safe_archive_path(path: &str) -> Option<PathBuf> {
    let marker = "/apps/addon/";
    let relative = path.split_once(marker)?.1;
    let parsed = Path::new(relative);
    if parsed.as_os_str().is_empty()
        || parsed
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some(parsed.to_path_buf())
}

fn extract_addon(archive: &[u8], destination: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(archive)).map_err(|error| error.to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| error.to_string())?;
        let Some(relative) = safe_archive_path(entry.name()) else {
            continue;
        };
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = fs::File::create(&output).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
    }
    if !destination.join("chronie.toc").is_file() {
        return Err("The downloaded repository did not contain apps/addon/chronie.toc.".into());
    }
    Ok(())
}

fn addon_version(path: &Path) -> String {
    fs::read_to_string(path.join("chronie.toc"))
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("## Version:").map(str::trim))
                .map(str::to_string)
        })
        .unwrap_or_else(|| "development".into())
}

fn replace_addon(archive: &[u8], wow_path: &Path) -> Result<InstallResult, String> {
    let addons = wow_path.join("Interface").join("AddOns");
    if !addons.is_dir() {
        return Err(format!("AddOns folder not found at {}.", addons.display()));
    }
    let staging = tempfile::Builder::new()
        .prefix(".chronie-install-")
        .tempdir_in(&addons)
        .map_err(|error| error.to_string())?;
    extract_addon(archive, staging.path())?;
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
        return Err(format!("Could not activate the downloaded addon: {error}"));
    }
    if backup.exists() {
        fs::remove_dir_all(backup).map_err(|error| error.to_string())?;
    }
    Ok(InstallResult {
        version: addon_version(&target),
    })
}

#[tauri::command]
async fn install_addon(state: State<'_, AppState>) -> Result<InstallResult, String> {
    let wow_path = {
        let settings = state.settings.lock().map_err(|_| "Settings lock failed.")?;
        configured_wow_path(&settings)?
    };
    let response = reqwest::get(REPOSITORY_ARCHIVE)
        .await
        .map_err(|error| format!("Could not download the addon: {error}"))?
        .error_for_status()
        .map_err(|error| format!("GitHub returned an error: {error}"))?;
    let archive = response.bytes().await.map_err(|error| error.to_string())?;
    replace_addon(&archive, &wow_path)
}

#[tauri::command]
async fn check_for_app_update(app: AppHandle) -> Result<AppUpdateResult, String> {
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .setup(|app| {
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
            };
            app.manage(state);
            setup_tray(app.handle())?;
            let _ = app.autolaunch().enable();
            start_background_sync(app.handle().clone());
            start_automatic_updates(app.handle().clone());
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
            settings,
            choose_wow_path,
            save_wow_path,
            sync_now,
            install_addon,
            check_for_app_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Chronie");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_archive_traversal() {
        assert!(safe_archive_path("repo/apps/addon/../../outside").is_none());
        assert!(safe_archive_path("repo/apps/addon/src/Good.lua").is_some());
    }

    #[test]
    fn installs_only_the_addon_subdirectory() {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        archive
            .start_file("repo/apps/addon/chronie.toc", options)
            .unwrap();
        archive.write_all(b"## Version: 9.8.7\nMain.lua").unwrap();
        archive
            .start_file("repo/apps/addon/Main.lua", options)
            .unwrap();
        archive.write_all(b"-- synthetic addon").unwrap();
        archive
            .start_file("repo/apps/desktop/private.txt", options)
            .unwrap();
        archive.write_all(b"must not install").unwrap();
        let bytes = archive.finish().unwrap().into_inner();

        let temp = tempfile::tempdir().unwrap();
        let wow = temp.path().join("_retail_");
        fs::create_dir_all(wow.join("Interface/AddOns")).unwrap();
        let result = replace_addon(&bytes, &wow).unwrap();

        assert_eq!(result.version, "9.8.7");
        assert!(wow.join("Interface/AddOns/chronie/Main.lua").is_file());
        assert!(!wow.join("Interface/AddOns/chronie/private.txt").exists());
    }
}
