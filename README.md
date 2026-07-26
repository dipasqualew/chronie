# WDP

WDP is a small World of Warcraft addon plus a Windows desktop companion. The
addon records sessions in SavedVariables. The desktop app collects those records
in the background, displays the seven-day report, and installs or updates the
addon for you.

## Repository layout

- `apps/addon` — the Lua addon shipped into `Interface/AddOns/chronie`
- `apps/desktop` — the Bun/Vite frontend and Rust/Tauri desktop application
- `scripts` — repository-wide setup, checks, and the Windows bootstrap installer

This leaves `apps/` open for later services without coupling them to the game
addon.

## Install a development build on Windows

Once the repository is public and the `dev` release workflow has been configured,
open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/dipasqualew/chronie/main/scripts/install.ps1 | iex
```

The installer is per-user and does not require administrator access. WDP starts
with Windows and stays in the system tray when its window is closed.

Open **Setup**, choose either the World of Warcraft folder or its `_retail_`
folder, then select **Install or update addon**. That button downloads the public
`main` branch, installs only `apps/addon` as `Interface/AddOns/chronie`, and
removes the legacy `wdp-wow` add-on folder. Select **Sync now** after `/reload`
or logging out; WDP also checks SavedVariables every 30 seconds in the background.

## Development

Prerequisites: [Bun](https://bun.sh/), Rust, and the platform prerequisites from
the Tauri documentation.

```sh
bun install
bun run dev
```

Run frontend unit tests and browser E2E tests:

```sh
bun run test
bun run test:e2e
```

The E2E suite injects a fake desktop bridge and a synthetic datastore. It does
not need an installed game, network access, or real character/location names.
The Rust test suite exercises SavedVariables parsing, retention, and safe addon
archive installation:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Addon checks still use Lua 5.1 semantics:

```sh
./scripts/check.sh
```

## Rolling development updates

`.github/workflows/dev-release.yml` maintains one prerelease named `dev`.
Successive builds replace its assets instead of creating a long list of releases.
Each build gets an increasing `0.1.<run number>` version, allowing Tauri to detect
it as newer.

Before running it for the first time, authenticate GitHub CLI with `gh auth
login`, then run:

```powershell
.\scripts\setup-signing.ps1
```

That creates an ignored local signing key and configures
`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and
`TAURI_SIGNING_PUBLIC_KEY` in GitHub.

The private key must never be committed. Stable releases can later use normal
version tags while the rolling `dev` release remains available for prototyping.
