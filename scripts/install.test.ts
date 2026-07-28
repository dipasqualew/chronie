/**
 * The Windows install path, asserted against the three files that have to agree about it.
 *
 * Nothing here runs PowerShell — these are Windows scripts and the suite is not — so what
 * is checked is the contract between them, which is where this went wrong. The release
 * workflow names an asset, `install.ps1` picks one out of the release by name, and
 * `debug-desktop.ps1` goes looking for the result at a fixed path. Any of those three can
 * be edited without the other two, and when they disagree nobody finds out until somebody
 * tries to install the thing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const installer = read("scripts/install.ps1");
const uninstaller = read("scripts/uninstall.ps1");
const workflow = read(".github/workflows/dev-release.yml");
const debugScript = read("scripts/debug-desktop.ps1");

/** The one thing `install.ps1` will accept off the release, as the suffix it matches on. */
function selectedSuffix(): string {
    const match = installer.match(/\$_\.name -like "\*([^"]+)"/);
    if (!match?.[1]) {
        throw new Error("install.ps1 no longer picks its release asset with a `-like \"*suffix\"` filter");
    }
    return match[1];
}

/** The name the release workflow gives the archive it uploads. */
function publishedArchiveName(): string {
    const match = workflow.match(/\$archiveName = "([^"]+)"/);
    if (!match?.[1]) {
        throw new Error("dev-release.yml no longer assigns the uploaded archive's name to $archiveName");
    }
    return match[1];
}

describe("the published Windows build", () => {
    it("is an archive rather than an executable", () => {
        // The whole of issue #135. Windows Defender signatures the NSIS stub that
        // self-extracting installers are built from, so a `-setup.exe` is blocked on
        // download and again on launch however harmless its contents are. Only a
        // code-signing certificate makes such a stub trustworthy and there is not one, so
        // what gets published must not be a stub at all.
        expect(selectedSuffix().endsWith(".zip")).toBe(true);
        expect(publishedArchiveName().endsWith(".zip")).toBe(true);
    });

    it("is named the way the installer looks for it", () => {
        expect(publishedArchiveName().endsWith(selectedSuffix())).toBe(true);
    });

    it("carries the uninstaller, because nothing else puts one on the machine", () => {
        // `install.ps1` arrives through `irm | iex` and has no checkout beside it to copy
        // from, so the only way `uninstall.ps1` reaches the install folder is inside the
        // archive the workflow builds.
        expect(workflow).toContain("scripts/uninstall.ps1");
    });
});

describe("install.ps1", () => {
    it("never runs what it downloaded", () => {
        const destination = installer.match(/-OutFile (\$\w+)/)?.[1];
        expect(destination).toBeTruthy();
        // Not a stylistic preference: launching the downloaded file is exactly the step that
        // produced "the file contains a virus or potentially unwanted software".
        expect(installer).not.toMatch(new RegExp(`Start-Process[^\\n]*\\${destination}\\b`));
    });

    it("installs where the rest of the repository looks for it", () => {
        const installRoot = String.raw`Join-Path $env:LOCALAPPDATA "Chronie"`;
        expect(installer).toContain(installRoot);
        expect(uninstaller).toContain(installRoot);
        expect(debugScript).toContain(String.raw`Join-Path $env:LOCALAPPDATA "Chronie\Chronie.exe"`);
    });

    it("registers an uninstall entry that points at the uninstaller it shipped", () => {
        expect(installer).toContain(String.raw`HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Chronie`);
        expect(installer).toMatch(/UninstallString\s*=[^\n]*uninstall\.ps1/);
    });
});

describe("uninstall.ps1", () => {
    it("takes the autostart entry with it", () => {
        // Chronie asks to start with Windows every time it launches, so an install whose
        // files are gone but whose Run entry is not leaves the machine trying to start a
        // program that no longer exists, forever.
        expect(uninstaller).toContain(String.raw`HKCU:\Software\Microsoft\Windows\CurrentVersion\Run`);
    });

    it("leaves the recorded history alone", () => {
        // The database and settings live under %APPDATA%\dev.chronie.wow. Removing the app
        // is not a request to throw away a year of played sessions.
        expect(uninstaller).not.toMatch(/Remove-Item[^\n]*APPDATA/);
    });
});
