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

Work on a branch. `main` is not a working branch: commit to a branch named for the
change, push that branch, and leave `main` alone unless you are explicitly asked to
merge. Do not open a PR unless explicitly asked.

## Work ends when CI is green

Pushing is not finishing. A change is finished when every workflow the push
triggered has concluded successfully on the branch you pushed, and the only way
to know that is to wait for it:

```sh
bun run ci:wait                  # the branch currently checked out
bun run ci:wait some-branch      # a named branch
bun run ci:wait --sha 1a2b3c4    # a specific commit
```

`scripts/wait-for-ci.ts` blocks until every run for the branch's head commit has
finished, then prints the failed jobs, the steps inside them that failed, every
check annotation, and the error lines from the job logs. It exits 0 only when
everything went green. It uses the `gh` CLI when there is one and the GitHub REST
API with `GH_TOKEN`/`GITHUB_TOKEN` when there is not, so it works in a sandbox
without `gh` installed.

Run it after every push and read what it prints. A red run is a task, not a
report: fix it, push again, wait again. Do not hand off while the script is still
running, while it has exited non-zero, or without having run it at all — and do
not offer a local `./scripts/check.sh` run in its place, because the local run
cannot see the browser suite's downloads, the Linux build dependencies, or the
Windows release job.

## Checks

`./scripts/check.sh` runs luacheck, busted, the Rust collector tests, the TypeScript
type check, then the desktop frontend and browser tests. It must report zero warnings and
zero failures before committing. Luacheck caps lines at 120 characters, and new WoW API
globals have to be declared in `.luacheckrc` or it fails the build.

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

The frontend, its tests and this repository's own scripts are TypeScript, under
`strict`. There is no JavaScript left in the tree and no new file should add any.
The shapes the Rust backend serialises are written down once in
`apps/desktop/src/types.ts`; a change to a `serde_json::json!` literal in
`src-tauri/src/collector.rs` belongs there too, and nothing downstream should
re-describe a segment for itself. Nothing is compiled by `tsc` — Vite, Vitest and
Bun each strip the types — so `bun run typecheck` is the only thing that ever
reads the annotations, which is why `./scripts/check.sh` runs it.

The addon's only job in that pipeline is writing `db.segments`; everything
downstream reads the file the client dumps at logout.
