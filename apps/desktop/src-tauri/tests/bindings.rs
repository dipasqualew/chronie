//! The committed `src/bindings.ts` against the commands it was generated from.
//!
//! `bindings.ts` says what the frontend may call and what comes back, and it is generated from
//! the command signatures in this crate, so drift between the two is a type error nobody sees
//! until a call fails in front of a player. Nothing here reads the app's behaviour — this is a
//! contract test on a generated file, which is why it asserts on the file rather than on any
//! module.
//!
//! It is a test rather than a target of its own, and it took two goes to find that out. A
//! `[[bin]]` is what the exporter was, and the Tauri bundler copies every binary the crate has
//! into the shipped app: 20 MB of bindings exporter beside the app in `Chronie.app`, in the
//! Windows download, and in every auto-update. An example is invisible to the bundler but
//! cannot be run on Windows at all — `tauri-build` embeds the application manifest through
//! `embed_resource`, which announces it to Cargo as `cargo:rustc-link-arg-bins`, so anything
//! that is not a bin links without it, loads the version 5 comctl32 from System32 instead of
//! the version 6 the manifest asks for, and dies with `STATUS_ENTRYPOINT_NOT_FOUND` before
//! `main` is reached.
//!
//! That is why this is an integration test and not a `#[test]` inside `lib.rs`. It has to reach
//! `command_builder()`, which drags Tauri's Windows window and dialog code in behind it, and
//! `build.rs` can hand the manifest to a `[[test]]` target — `cargo:rustc-link-arg-tests` — but
//! has no way to name the unit-test harness Cargo builds out of `lib.rs`. Keeping the call out
//! of that harness also leaves it linking exactly what it linked before, which is what keeps
//! the other 796 tests loading on Windows.

/// Reads by default. `bun run bindings:generate` sets `CHRONIE_WRITE_BINDINGS` and comes back
/// through here to rewrite the file, so one code path both writes and checks it.
#[test]
fn the_committed_bindings_match_the_commands() {
    let write = std::env::var_os("CHRONIE_WRITE_BINDINGS").is_some();
    if let Err(error) = chronie_desktop_lib::export_bindings(!write) {
        panic!("{error}");
    }
}
