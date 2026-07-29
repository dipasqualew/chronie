#!/usr/bin/env bun
/**
 * Builds the desktop app from this checkout and installs that build on this machine.
 *
 * `scripts/install.ps1` installs the newest *published* dev release; this is the other
 * half — the way to run the code you are looking at as a real installed application
 * rather than under `bun run dev`. Either way it is a copy: the bundled `.app` into
 * `/Applications` on macOS, the executable into `%LOCALAPPDATA%\Chronie` on Windows.
 *
 * Windows used to go through the NSIS installer the build produced. It cannot any more —
 * Windows Defender signatures the NSIS stub and refuses to run one that is unsigned, which
 * is issue #135 and is as true of a locally built installer as of a published one. Copying
 * the executable in is what `install.ps1` now does to the published build, minus the
 * shortcut and the uninstall entry, which are already there if it has ever been run and are
 * not what this command is for.
 *
 *   bun run install-locally
 *
 * The Rust build honours `CARGO_TARGET_DIR`, so this looks for the bundle where cargo
 * was actually told to put it — which is what makes the command work from a worktree
 * pointed at the main checkout's target directory.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TAURI_DIR = join(ROOT, "apps/desktop/src-tauri");

/**
 * Where cargo puts the bundles, which `CARGO_TARGET_DIR` is free to move elsewhere. Cargo
 * reads a relative one against its own working directory, and tauri runs it in `src-tauri`,
 * so that — not the repository root — is what a relative value is relative to.
 */
const TARGET_DIR = process.env.CARGO_TARGET_DIR
  ? resolve(TAURI_DIR, process.env.CARGO_TARGET_DIR)
  : join(TAURI_DIR, "target");

/** The bundle is named after `productName`, so read it rather than hardcode "Chronie". */
const config = JSON.parse(readFileSync(join(TAURI_DIR, "tauri.conf.json"), "utf8")) as {
  productName: string;
};

/**
 * The shipped config asks for signed updater artifacts, and signing needs a private key
 * nobody has locally, so a plain `tauri build` fails on this machine. A local install has
 * no business updating itself from the published dev release anyway, so the updater comes
 * out — the same shape the release workflow builds when it has no signing key, which
 * `updater_configured` in `lib.rs` already knows how to start against.
 */
const UNSIGNED = JSON.stringify({
  bundle: { createUpdaterArtifacts: false },
  plugins: { updater: null },
});

/**
 * `bundle.targets` in the config is Windows-only, so the format is named here instead:
 * asking for `app` on a Mac produces the `.app` the config would never have asked for.
 * Naming none of them asks for no bundle at all, which is what Windows wants — the payload
 * there is the single executable cargo has already written.
 */
function build(bundles?: string): void {
  const format = bundles ? ["--bundles", bundles] : ["--no-bundle"];
  const args = ["run", "--cwd", "apps/desktop", "tauri", "build", ...format];
  execFileSync("bun", [...args, "--config", UNSIGNED], { cwd: ROOT, stdio: "inherit" });
}

/**
 * The name cargo gives the app's executable, which is the Cargo package's and not
 * `productName`'s. Asked of cargo rather than read out of `Cargo.toml`, because nothing here
 * parses TOML and `[[bin]]` could rename it again anyway.
 *
 * It asks for the binary named after the package rather than for the first one listed. Taking
 * whatever came first is how the bundled `.app` ended up launching the bindings exporter back
 * when that was a second binary, and it would be no better a way to pick what gets copied into
 * `%LOCALAPPDATA%`.
 */
function cargoPackageName(): string {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--no-deps",
        "--manifest-path",
        join(TAURI_DIR, "Cargo.toml"),
      ],
      { encoding: "utf8" },
    ),
  ) as { packages: { name: string; targets: { kind: string[]; name: string }[] }[] };
  const crate = metadata.packages[0];
  const binary = crate?.targets.find(
    (target) => target.kind.includes("bin") && target.name === crate.name,
  );
  if (!binary) {
    throw new Error(`The desktop crate has no binary target named ${crate?.name}.`);
  }
  return binary.name;
}

function installOnMac(): string {
  build("app");
  const app = `${config.productName}.app`;
  const built = join(TARGET_DIR, "release/bundle/macos", app);
  if (!existsSync(built)) {
    throw new Error(`The build did not produce ${built}.`);
  }
  // A macOS install is a copy, and copying onto a half-replaced bundle is how you get an
  // app that launches into a signature error, so the old one goes first.
  const installed = join("/Applications", app);
  rmSync(installed, { recursive: true, force: true });
  cpSync(built, installed, { recursive: true, verbatimSymlinks: true });
  return installed;
}

function installOnWindows(): string {
  // Nothing needs bundling: the payload is the one executable, and skipping NSIS skips
  // both the minute it takes and the installer nothing is allowed to run.
  build();
  // Cargo names it after the Cargo package, and it is the bundler — skipped here — that
  // renames it to `productName`. So this reads `chronie-desktop.exe` and writes `Chronie.exe`,
  // which is the name the shortcut, `debug-desktop.ps1` and `install.ps1` all expect.
  const built = join(TARGET_DIR, `release/${cargoPackageName()}.exe`);
  if (!existsSync(built)) {
    throw new Error(`The build did not produce ${built}.`);
  }
  // The running copy holds this file open, and Windows will not write over one that is
  // open. `taskkill` is fine with there being nothing to kill, hence the swallowed error.
  try {
    execFileSync("taskkill", ["/IM", `${config.productName}.exe`, "/F"], { stdio: "ignore" });
  } catch {
    // Not running. Nothing to close.
  }
  const installed = join(
    process.env.LOCALAPPDATA ?? "",
    config.productName,
    `${config.productName}.exe`,
  );
  mkdirSync(dirname(installed), { recursive: true });
  cpSync(built, installed);
  return installed;
}

if (process.platform === "darwin") {
  console.log(`Installed ${installOnMac()}`);
} else if (process.platform === "win32") {
  console.log(`Installed ${installOnWindows()}; open Chronie from the Start menu.`);
} else {
  console.error(
    `No local install for ${process.platform}: Chronie bundles for macOS and Windows only.`,
  );
  process.exit(1);
}
