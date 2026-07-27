# Chronie

Chronie is a small World of Warcraft addon plus a Windows desktop companion. The
addon records segments in SavedVariables. The desktop app collects those records
in the background, stores permanent history in an embedded SQLite database,
displays the report, and installs or updates the addon for you.

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

The installer is per-user and does not require administrator access. Chronie starts
with Windows and stays in the system tray when its window is closed.

Open **Setup**, choose either the World of Warcraft folder or its `_retail_`
folder, then select **Install or update addon**. That button downloads the public
`main` branch and installs only `apps/addon` as `Interface/AddOns/chronie`.
Select **Sync now** after `/reload` or logging out; Chronie also checks
SavedVariables every 30 seconds in the background.

## Move a history to another machine

Setup's **Sync over WiFi** hands one Chronie's whole database to another one on the
same network — a desktop's collection onto a laptop, or a spare machine kept as a
copy. On the machine that is to receive it, select **Wait for a database**. On the
machine sending, select **Look for Chronies**, pick the one that is waiting, and
select **Send history**. Nothing moves until somebody on the receiving machine
reads what is being offered and accepts it.

Accepting replaces the receiving machine's history rather than merging into it. What
it displaces is not deleted: the old database is left beside the new one as
`chronie.replaced.sqlite3` in the app's data folder.

Only a Chronie that is waiting can be sent to or even found, and the transfer is
neither encrypted nor authenticated — it is a transfer between two machines in one
home, guarded by somebody being at both of them. Chronie listens on port 51571 for
as long as it is waiting and not a moment longer.

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
The Rust test suite exercises SavedVariables parsing, permanent SQLite persistence, and safe addon
archive installation:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Addon checks still use Lua 5.1 semantics. `./scripts/check.sh` runs all of the above
plus luacheck, busted and the TypeScript type check:

```sh
./scripts/check.sh
bun run typecheck
```

The desktop frontend and this repository's scripts are TypeScript. Nothing compiles
them ahead of time — Vite, Vitest and Bun strip the types — so `bun run typecheck` is
what actually reads them.

Every change reaches `main` through a pull request. Branch, push, and open the
pull request straight away — it is what runs CI, and it is where the change is
reviewed if anyone wants to review it:

```sh
git switch -c some-change
git push -u origin some-change
gh pr create --fill
```

Then wait for its CI rather than guessing at it:

```sh
bun run ci:wait                  # the branch currently checked out
bun run ci:wait some-branch
```

`scripts/wait-for-ci.ts` blocks until every workflow run for the branch's head commit
has finished, prints the failed jobs, their annotations and their error lines, and exits
non-zero if anything was not green. It uses the `gh` CLI when one is installed and the
GitHub REST API with `GH_TOKEN`/`GITHUB_TOKEN` when one is not.

Green CI is enough to merge — `gh pr merge --squash --delete-branch` — and that
holds for agents working in this repository too. A pull request should be left
open for a human only when the change is genuinely unclear rather than merely
large, and it should say what the open question is.

## Rolling development updates

`.github/workflows/dev-release.yml` maintains one prerelease named `dev`.
Successive builds replace its assets instead of creating a long list of releases.
Each build gets an increasing `0.1.<run number>` version, allowing Tauri to detect
it as newer.

The workflow always publishes a Windows installer. To additionally publish signed
automatic-update artifacts, authenticate GitHub CLI with `gh auth login`, then run:

```powershell
.\scripts\setup-signing.ps1
```

That creates an ignored local signing key and configures
`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and
`TAURI_SIGNING_PUBLIC_KEY` in GitHub.

The private key must never be committed. Stable releases can later use normal
version tags while the rolling `dev` release remains available for prototyping.

## Reference

The desktop app reads the installed game's own files to show transmog sets. What it
takes to get from a set to a renderable model — file ids, column indices, the traps,
and which constants were verified against which build — is recorded in:

- [`docs/game-files.md`](docs/game-files.md) — CASC, DB2/WDC5 quirks, and the table
  chain from a transmog set to model and texture bytes.
- [`docs/character-rendering.md`](docs/character-rendering.md) — showing an appearance
  on a character: the composite atlas, geosets, M2/SKIN and BLP.

These exist so that reading the local game install is never necessary; it is off
limits for ordinary work.
