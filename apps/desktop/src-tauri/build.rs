use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    embed_addon();
    embed_migrations();
    embed_commit();
    embed_windows_manifest_for_tests();
    tauri_build::build()
}

/// Gives `[[test]]` binaries the Windows application manifest that only `[[bin]]`s get.
///
/// `tauri_build::build()` embeds a manifest declaring a dependency on version 6 of
/// Common-Controls, and announces it to Cargo through `embed_resource` as
/// `cargo:rustc-link-arg-bins` — bins and nothing else. Any other target that links Tauri's
/// Windows window and dialog code therefore imports functions that only the version 6
/// comctl32 exports, is given the version 5 one out of System32 because nothing asked for the
/// other, and dies in the loader with `STATUS_ENTRYPOINT_NOT_FOUND` before `main` runs.
///
/// That is not hypothetical. It is what `tests/bindings.rs` does the moment it calls
/// `command_builder()`, and it is why the bindings check could not simply become an example
/// when it stopped being a binary the app had to ship.
///
/// The manifest is written here rather than kept as a file beside this script for the same
/// reason the migrations and the addon are: `OUT_DIR` is a path this code knows exactly,
/// which spares the resource compiler a relative lookup of its own.
fn embed_windows_manifest_for_tests() {
    if env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    // The same assembly `tauri-build`'s own `windows-app-manifest.xml` names. A test binary
    // needs no more than this: it is not shipped, and nothing reads its version resources.
    let manifest = "<assembly xmlns=\"urn:schemas-microsoft-com:asm.v1\" manifestVersion=\"1.0\">\
                    <dependency><dependentAssembly><assemblyIdentity type=\"win32\" \
                    name=\"Microsoft.Windows.Common-Controls\" version=\"6.0.0.0\" \
                    processorArchitecture=\"*\" publicKeyToken=\"6595b64144ccf1df\" \
                    language=\"*\"/></dependentAssembly></dependency></assembly>\n";

    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let manifest_path = out.join("tests.manifest");
    fs::write(&manifest_path, manifest).expect("the test manifest should be writable");

    // Resource id 1 of type 24 is `CREATEPROCESS_MANIFEST_RESOURCE_ID` as `RT_MANIFEST`: the
    // one the loader reads when it starts a process. The path is absolute and its backslashes
    // are escaped, because a resource script is C-like enough that `\t` in a Windows path is a
    // tab.
    let script = out.join("tests.rc");
    let quoted = manifest_path.display().to_string().replace('\\', "\\\\");
    fs::write(&script, format!("1 24 \"{quoted}\"\n")).expect("the test .rc should be writable");

    embed_resource::compile_for_tests(&script, embed_resource::NONE)
        .manifest_required()
        .expect("the test manifest should compile");
}

/// Writes the timestamped migration files into a Rust slice in lexicographic order.
///
/// The folder is the list: a feature adds one uniquely named file and does not append to a
/// shared Rust array. Sorting here gives SQLite the same total order on every filesystem,
/// including the two historical migrations that share a minute.
fn embed_migrations() {
    let directory = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("migrations");
    println!("cargo:rerun-if-changed={}", directory.display());

    let mut files = fs::read_dir(&directory)
        .expect("the desktop should have a migrations folder")
        .map(|entry| {
            entry
                .expect("a migration directory entry should be readable")
                .path()
        })
        .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
        .collect::<Vec<_>>();
    files.sort();
    assert!(!files.is_empty(), "the desktop should have migrations");

    let entries = files
        .iter()
        .map(|path| {
            println!("cargo:rerun-if-changed={}", path.display());
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .expect("a migration filename should be UTF-8");
            assert_migration_name(name);
            format!(
                "    Migration {{ name: {name:?}, sql: include_str!({:?}) }},\n",
                path.to_string_lossy()
            )
        })
        .collect::<String>();

    let generated = format!("pub(super) static MIGRATIONS: &[Migration] = &[\n{entries}];\n");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("migrations.rs");
    fs::write(out, generated).expect("the generated migration list should be writable");
}

fn assert_migration_name(name: &str) {
    let (timestamp, description) = name
        .split_once('_')
        .unwrap_or_else(|| panic!("{name} has no timestamp separator"));
    assert!(
        timestamp.len() == 13
            && timestamp.as_bytes()[8] == b'T'
            && timestamp
                .bytes()
                .enumerate()
                .all(|(index, byte)| index == 8 || byte.is_ascii_digit()),
        "{name} does not use YYYYMMDDThhmm"
    );
    assert!(
        description.len() > ".sql".len()
            && description.ends_with(".sql")
            && description[..description.len() - ".sql".len()]
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'),
        "{name} does not have a lowercase snake-case description"
    );
}

/// Writes the commit this build came out of into `CHRONIE_COMMIT`, for the window to show.
///
/// There is no version number worth showing yet — every build is the rolling `dev` release and
/// the only thing that tells two of them apart is the commit they were cut from. So that is what
/// the app reports, and the one place it can be known is here: by the time the binary is running
/// there is no repository under it to ask.
///
/// `GITHUB_SHA` first, because on a pull request the checkout's own `HEAD` is a merge commit that
/// exists nowhere but that runner, and a link to it would be a link to nothing. Then git, which
/// is what a build on somebody's own machine has. Then nothing, which is honest: a build from a
/// source tarball has no commit, and the window says so rather than inventing one.
fn embed_commit() {
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    let commit = env::var("GITHUB_SHA")
        .ok()
        .filter(|sha| !sha.trim().is_empty())
        .or_else(head_commit)
        .unwrap_or_default();
    println!("cargo:rustc-env=CHRONIE_COMMIT={}", commit.trim());
}

/// The commit checked out beside this build script, and the files that would change it.
///
/// The paths come from git rather than from `.git/…` spelled out here, because this repository is
/// worked in through worktrees: in one of those `.git` is a file, `HEAD` lives under
/// `.git/worktrees/<name>/`, and a hard-coded path would watch the wrong branch entirely. Only
/// paths that exist are declared — a branch whose ref has been packed away has no file of its
/// own, and naming a missing one would re-run this on every single build.
fn head_commit() -> Option<String> {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").ok()?);
    let git = |arguments: &[&str]| -> Option<String> {
        let output = Command::new("git")
            .current_dir(&root)
            .args(arguments)
            .output()
            .ok()?;
        let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
        (output.status.success() && !text.is_empty()).then_some(text)
    };

    let commit = git(&["rev-parse", "HEAD"])?;
    let mut watched = vec![git(&["rev-parse", "--git-path", "HEAD"])];
    if let Some(reference) = git(&["symbolic-ref", "--quiet", "HEAD"]) {
        watched.push(git(&["rev-parse", "--git-path", &reference]));
    }
    for path in watched.into_iter().flatten() {
        let path = root.join(path);
        if path.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
    Some(commit)
}

/// Writes the source of `BUNDLED_ADDON`: the addon this build ships, file by file.
///
/// The app and the addon are two halves of one pipeline, so the binary carries its own copy
/// rather than fetching one — whatever the app installs is then necessarily the addon that
/// was in the tree when the app was compiled.
///
/// The .toc decides what goes in, and it decides alone. It is the addon's own manifest, the
/// list the game client itself loads, so anything else under `apps/addon` — the busted specs
/// above all — is not part of the addon and has no business in either the binary or the game
/// folder. There was one exception once, a Bindings.xml the client loaded by name without
/// consulting the manifest; the addon binds no keys now and there is nothing left that the
/// .toc does not account for.
fn embed_addon() {
    let addon = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../addon")
        .canonicalize()
        .expect("apps/addon should sit two levels above src-tauri");
    let toc = addon.join("chronie.toc");
    println!("cargo:rerun-if-changed={}", toc.display());

    let manifest = fs::read_to_string(&toc).expect("the addon should have a chronie.toc");
    let mut entries = vec![entry(&toc, "chronie.toc")];
    for line in manifest.lines() {
        let listed = line.trim();
        if listed.is_empty() || listed.starts_with('#') {
            continue;
        }
        // Real .toc files address files with backslashes; this one uses forward slashes.
        // Accept either, and refuse anything that would escape the addon folder.
        let relative = listed.replace('\\', "/");
        assert!(
            !relative.starts_with('/') && !relative.split('/').any(|part| part == ".."),
            "chronie.toc lists a path outside the addon: {listed}"
        );
        let source = addon.join(&relative);
        println!("cargo:rerun-if-changed={}", source.display());
        assert!(
            source.is_file(),
            "chronie.toc lists a missing file: {listed}"
        );
        entries.push(entry(&source, &relative));
    }

    let generated = format!(
        "/// Every file the shipped addon is made of, keyed by its path inside the addon\n\
         /// folder. Generated by build.rs from apps/addon/chronie.toc.\n\
         static BUNDLED_ADDON: &[(&str, &[u8])] = &[\n{}];\n",
        entries.concat()
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("bundled_addon.rs");
    fs::write(&out, generated).expect("the generated addon manifest should be writable");
}

/// One `(path, bytes)` row. Both literals go through `{:?}`, which escapes the backslashes a
/// Windows path arrives with instead of letting them start an escape sequence.
fn entry(source: &Path, relative: &str) -> String {
    format!(
        "    ({relative:?}, include_bytes!({:?})),\n",
        source.to_string_lossy()
    )
}
