// Chronie lives in the tray, so a release build must not drag a console window along.
// Startup failures are still recoverable: run() writes them to a log file and stderr.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    chronie_desktop_lib::run();
}
