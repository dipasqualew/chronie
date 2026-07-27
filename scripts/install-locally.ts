#!/usr/bin/env bun
/**
 * Builds the desktop app from this checkout and installs that build on this machine.
 *
 * `scripts/install.ps1` installs the newest *published* dev release; this is the other
 * half — the way to run the code you are looking at as a real installed application
 * rather than under `bun run dev`. On macOS that means dropping the bundled `.app` into
 * `/Applications`; on Windows it means running the NSIS installer the build produced,
 * which is per-user and asks for no administrator rights.
 *
 *   bun run install-locally
 *
 * The Rust build honours `CARGO_TARGET_DIR`, so this looks for the bundle where cargo
 * was actually told to put it — which is what makes the command work from a worktree
 * pointed at the main checkout's target directory.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

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
 */
function build(bundles: string): void {
    const args = ["run", "--cwd", "apps/desktop", "tauri", "build", "--bundles", bundles];
    execFileSync("bun", [...args, "--config", UNSIGNED], { cwd: ROOT, stdio: "inherit" });
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
    build("nsis");
    const bundle = join(TARGET_DIR, "release/bundle/nsis");
    const setup = existsSync(bundle)
        ? readdirSync(bundle).find((name) => name.endsWith("-setup.exe"))
        : undefined;
    if (!setup) {
        throw new Error(`The build did not produce an installer in ${bundle}.`);
    }
    // The installer is `currentUser`, so it needs no elevation and replaces any existing
    // install in place; waiting on it keeps this command's exit meaningful.
    execFileSync(join(bundle, setup), [], { stdio: "inherit" });
    return join(bundle, setup);
}

if (process.platform === "darwin") {
    console.log(`Installed ${installOnMac()}`);
} else if (process.platform === "win32") {
    console.log(`Ran ${installOnWindows()}; open Chronie from the Start menu.`);
} else {
    console.error(`No local install for ${process.platform}: Chronie bundles for macOS and Windows only.`);
    process.exit(1);
}
