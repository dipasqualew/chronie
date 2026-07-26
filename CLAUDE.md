# chronie

A World of Warcraft addon. Lua 5.1 / LuaJIT semantics — the game client has no
LuaRocks, no `require`, and no standard library beyond what Blizzard exposes.

## The local WoW install is off limits

Never search the filesystem for a World of Warcraft installation, and never read
its files — not the game directory, not `Interface/AddOns`, not
`WTF/.../SavedVariables`. Do not run `find`, `ls`, `grep`, or any other command
against those paths, and do not use them to inspect real data or reproduce a bug.
Reason about the addon from this repository's source and from the fakes in
`apps/addon/spec/helpers/fake_wow.lua` instead. If a question can only be settled
by looking at live game data, ask for the relevant snippet rather than going to
find it.

## Git workflow

Commit and push straight to `main`. Do not create a feature branch or open a PR
unless explicitly asked — this is a solo addon repo and the branch-then-merge
round trip is pure overhead here. For now, completing work in this repository
includes committing it, pushing `main`, and waiting for every CI workflow
triggered by that push to finish successfully. Do not hand off while CI is
pending or red.

## Checks

`./scripts/check.sh` runs luacheck, busted, the Rust collector tests, then the desktop frontend tests. It
must report zero warnings and zero failures before committing. Luacheck caps lines at 120 characters, and new
WoW API globals have to be declared in `.luacheckrc` or it fails the build.

A run that is not fully green is not a finished piece of work. Leaving lint
warnings, test failures, or errors behind — whether they predate the change, were
caused by it, or "only" affect tests you did not write — is never acceptable.
Fix every one of them, or stop and say plainly which you could not fix and why.
Do not report work as done while `./scripts/check.sh` exits non-zero, and do not
silence a problem by deleting or weakening the test that found it.

## Structure

Every file under `apps/addon/src/` is loaded by the client in the order listed in
`apps/addon/chronie.toc`; a file missing from the .toc fails the test suite as well as the
game. Modules are `ns.newThing(deps)` factories returning a table of closures.

`apps/addon/Main.lua` is the only place allowed to touch WoW globals. It collects them into
a `WowEnv` table and injects it, so addon source modules stay drivable from the fakes
in `apps/addon/spec/helpers/fake_wow.lua` without monkey patching.

Keep frame code thin and push logic into a pure module beside it — the pure
module is where the tests earn their keep.

`apps/desktop/` is a Tauri application. Its Rust backend replaces the former
Python collector, watches SavedVariables, persists permanent history in embedded
SQLite, and installs the addon. Its frontend replaces the standalone HTML report.

The addon's only job in that pipeline is writing `db.segments`; everything
downstream reads the file the client dumps at logout.
