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

What the desktop app needs to know about the game's own file formats is written
down in `docs/game-files.md` and `docs/character-rendering.md` — file ids, column
indices, verified constants and the traps. That is what those documents are for:
read them instead of going to look.

## Every change gets a worktree of its own

The repository's own checkout is not a working directory either. Somebody else —
another agent, a human in an editor — may be part way through a change in it,
with files saved and nothing committed, and there is no way to tell by looking.
Switching branches under them fails or drags their work onto the new branch, and
a `git add -A` commits it as if it were yours. So every change starts with a
checkout that belongs to it alone, branched off `origin/main`:

```sh
git fetch origin main
git worktree add .claude/worktrees/some-change -b some-change origin/main
cd .claude/worktrees/some-change
bun install
```

`bun install` there is seconds, because the packages come from bun's cache, but
Rust is not: point `CARGO_TARGET_DIR` at the main checkout's target directory and
the backend builds incrementally instead of compiling tauri from nothing.

```sh
CARGO_TARGET_DIR=../../../apps/desktop/src-tauri/target ./scripts/check.sh
```

Remove the worktree once its pull request is merged, so the tree does not fill up
with checkouts nobody is working in:

```sh
git worktree remove .claude/worktrees/some-change
```

## All work happens on a pull request

`main` is not a working branch. Push the worktree's branch and open a pull
request against `main` as the first thing you do after that first push — not as a
last step once the work is already finished:

```sh
git push -u origin some-change
gh pr create --fill
```

The pull request is not paperwork, it is the mechanism. It is what runs the CI
you are about to wait on, it is where the diff, the checks and the reasoning sit
together, and it is what a human reads if they want to read anything. Work that
is not on an open pull request is work nobody can see. Never commit to `main`,
never push to `main`, and never merge a branch locally and push the result.

Merge it yourself when you are happy with it. Green CI and a change you would
defend is enough — you do not need the human to approve it, and you should not
stop to ask:

```sh
gh pr merge --squash --delete-branch
```

The reason to leave a pull request unmerged is lack of clarity, not size or
risk. Leave it open, say plainly why, and hand back when a human might
reasonably read the change differently than you did: the request was ambiguous
and you picked one reading, you went beyond what was asked, you worked around a
problem rather than fixing it, or you are not confident the result is what was
actually wanted. Then the open pull request _is_ the review request — describe
the specific question you want answered in it. Anything else — an ordinary
change, green CI, nothing left open — you merge.

## Work ends when CI is green

Pushing is not finishing, and neither is opening the pull request. A change is
finished when every workflow the pull request triggered has concluded
successfully, and the only way to know that is to wait for it:

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

It keys on the head commit, so it covers every run the pull request has,
whichever event started it. `gh pr checks <number> --watch` tells you the same
thing GitHub's own page does; `ci:wait` is the one that tells you why a run is
red.

Run it after every push and read what it prints. A red run is a task, not a
report: fix it, push to the same branch, wait again — the pull request stays
open through all of it. Do not hand off while the script is still running, while
it has exited non-zero, or without having run it at all — and do not offer a
local `./scripts/check.sh` run in its place, because the local run cannot see
the browser suite's downloads, the Linux build dependencies, or the Windows
release job.

CI is something you reach through the pull request and nowhere else. Do not push
a branch that has no pull request open on it just to get a run, and do not go
reading runs that no pull request accounts for.

## A bug is a missing test before it is a broken line

When the work is a bug — an issue labelled one, a reported Lua error, a stack
trace, anything that says "this does not behave as it should" — the first commit
of the change is a test that fails for exactly the reason the report describes.
Run it and watch it fail before you touch the code that makes it pass. A fix
written first and covered afterwards proves only that the code you just wrote
does what you just wrote; a test written first proves the bug was real, that you
understood it, and that it cannot come back unnoticed.

Put the test at the level the bug actually lives at, and only at that level:

- A wrong value out of a function, a missing nil guard, an API the client build
  does not have — **unit**, against the module, with the outside world injected.
  If the buggy code sits somewhere a unit test cannot reach, that is the bug
  telling you to extract it into a pure module first.
- A file the game or the app parses rather than executes, a manifest, a shape
  crossing the Rust/TypeScript boundary — **contract**, asserting on the file or
  the serialised shape itself.
- Something only visible once the pieces are wired together — **integration**,
  booting the addon through `spec/helpers/addon_loader.lua` or the app through
  its own entry point.
- Something a player or a user would see and nothing smaller would catch —
  **e2e**, driving the real thing from outside.

One bug usually earns one test. Reach for a bigger level than the bug needs and
the suite gets slower and vaguer for no more coverage; reach for a smaller one
than it needs and the test passes while the bug survives. `/test` describes what
each level means here.

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

The frontend is React. `index.html` carries the stylesheet and nothing else —
everything below `#root` is drawn from `src/main.tsx`. A view is a `.tsx`
component and the logic behind it is a `.ts` module beside it, the same split the
addon's frames and pure modules use and for the same reason: `sessions.ts`,
`characters.ts`, `transmog.ts`, `combatLog.ts` and `wifi.ts` are where the rules
live and where the tests are, and the components over them only draw. Nothing
builds markup out of strings, so nothing has to remember to escape a name out of
the game.

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
