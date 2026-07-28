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

That unpacks the newest build into `%LOCALAPPDATA%\Chronie`, puts Chronie in the
Start menu and adds it to Apps & Features. It is per-user throughout and asks for
no administrator access. Chronie starts with Windows and stays in the system tray
when its window is closed.

Run the same line again to update — it replaces the files and leaves the recorded
history alone. To remove it, use Apps & Features, or run its uninstaller directly:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Chronie\uninstall.ps1"
```

That takes the application, the shortcut and the autostart entry. Your recorded
history is under `%APPDATA%\dev.chronie.wow` and is left behind on purpose; delete
that folder yourself if you want it gone.

There is no `-setup.exe` to download, and that is deliberate. Windows Defender
recognises the NSIS stub that self-extracting installers are built from — not
anything in Chronie — and refuses to run an unsigned one, so the installer this
used to publish was blocked both on the releases page and at launch
([#135](https://github.com/dipasqualew/chronie/issues/135)). Only a code-signing
certificate fixes that, and there is not one. A zip needs no stub, so
`install.ps1` does the installing itself.

Open **Setup**, choose either the World of Warcraft folder or its `_retail_`
folder, then select **Install or update addon**. That button downloads the public
`main` branch and installs only `apps/addon` as `Interface/AddOns/chronie`.
Select **Sync now** after `/reload` or logging out; Chronie also checks
SavedVariables every 30 seconds in the background.

## Combat logging

Setup's **Combat logging** switch asks the addon to start the game's combat log at
login, and to tick **Advanced Combat Logging** — the setting that puts positions and
map ids into the log rather than only names and numbers.

It is off until you turn it on, because it is not cheap: a raid night is hundreds of
megabytes, and Chronie does not delete old logs. Clearing out the game's `Logs`
folder is still yours to do.

The panel reports what the install is actually doing rather than what it was asked
to do — the setting as the game's own config records it, and whether a file in
`Logs` is really growing. If your client refuses to let an addon write the CVar, the
panel says so and names the box to tick yourself. In game, `/chronie log` asks the
same question of the client directly.

## Ask the history something

The **Query** tab is the collected history as what it actually is — a SQLite database
— with a SQL editor over it and a chart under that. Point one dropdown at a column to
run along the bottom and another at a column to run up the side, and the answer is a
bar, a line or a scatter. The tables and their columns are listed beside the editor,
and the row of questions above it — hours per character, gold per hour by place,
keystone times by level — are there to be run and then edited.

Nothing typed there can change anything. Only `SELECT`, `WITH`, `VALUES` and
`EXPLAIN` are run at all, one statement at a time, and a query still going after ten
seconds is stopped.

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

To run this checkout as an installed application rather than under `bun run dev` —
the `.app` in `/Applications` on macOS, the executable in `%LOCALAPPDATA%\Chronie`
on Windows, replacing whatever the one-liner above put there:

```sh
bun run install-locally
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

The workflow always publishes `Chronie_<version>_x64-portable.zip`, which is the
executable and `scripts/uninstall.ps1` and nothing else; `install.ps1` unpacks it.

To additionally publish signed automatic-update artifacts, authenticate GitHub CLI
with `gh auth login`, then run:

```powershell
.\scripts\setup-signing.ps1
```

That creates an ignored local signing key and configures
`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and
`TAURI_SIGNING_PUBLIC_KEY` in GitHub.

The private key must never be committed. Stable releases can later use normal
version tags while the rolling `dev` release remains available for prototyping.

Automatic updating will not work until Chronie has a code-signing certificate,
whatever that key says. Tauri's updater on Windows downloads the NSIS installer
and runs it, and that is the artifact Windows Defender refuses — the same wall
[#135](https://github.com/dipasqualew/chronie/issues/135) hit. Until then, updating
is running the `install.ps1` one-liner again.

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
