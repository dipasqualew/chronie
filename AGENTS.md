# chronie

A World of Warcraft addon. Lua 5.1 / LuaJIT semantics — the game client has no
LuaRocks, no `require`, and no standard library beyond what Blizzard exposes.

## The local WoW install, when the machine has one

Go and look. The game's own files are the only place several of the questions
this repository asks can actually be settled, and not being allowed to look has
already cost real time: `wow-m2` was passed over for want of a prototype against
a real `humanfemale_hd.m2`, and a wrong `ItemDisplayInfo` column survived a long
time because nothing could be held up against it.

The install root is `/Applications/World of Warcraft` on macOS and
`C:\Program Files (x86)\World of Warcraft` on Windows, but Battle.net lets the
player put it anywhere, so a second drive — `D:\World of Warcraft`,
`/Volumes/Games/World of Warcraft` — is ordinary rather than exotic. Under the
root sit the per-flavour folders `_retail_`, `_classic_`, `_classic_era_` and
`_ptr_`, and beside them the one shared `Data/` that holds the CASC storage all
of them read.

Which of the two paths you want depends on what is asking for it.
`CascFiles::open` wants **the root**, the folder holding `Data/`, because that is
where the models, textures and DB2 tables are. `resolve_wow_path` and everything
downstream of it want **`_retail_`**, the folder holding `WTF/`, because that is
where the addon and its SavedVariables are. The tools already take one:

```sh
cargo run --example dump_model -- "/Applications/World of Warcraft" 900001 helm.glb
bun run render worn/712245/5 legs.png --install "/Applications/World of Warcraft"
```

**A container has no install, and no amount of looking will produce one.** Remote
runs have no game on the machine; the paths above are simply absent. Check them
once, and when they are not there stop looking and fall back to the committed
fixtures under `apps/desktop/fixtures/transmog` — that is what `--fixtures`
reads, and it is the only mode CI has.

Two things an install does not change. **Nothing in the test suite may read it**:
tests run from those fixtures and from the fakes in
`apps/addon/spec/helpers/fake_wow.lua`, always, because a test that passes only
on a machine with the game installed is a test that fails for everybody else.
And **what is already known comes first.** `docs/game-tables.json` is the
registry of table FileDataIDs and consumed column positions, each with the build
it was confirmed on; `docs/game-files.md` and `docs/character-rendering.md` are
the traps, the evidence and the runs that settled them. Going to look is for the
questions those do not answer. When a look settles one, the answer goes back into
the registry — then `bun run tables:generate`, which rewrites the Rust constants,
the fixture generators' ids and the document's own table together. Nothing else
in the tree may declare a FileDataID or a column index; `scripts/game-tables.test.ts`
fails the check when something does, and `docs/game-files.md` describes the whole
loop under "Verifying a patch".

The SavedVariables under `_retail_/WTF/` are a real person's characters. Reading
them to understand a bug is the point of being allowed in there; committing one
as a fixture is not — cut a synthetic file down to the shape that matters
instead.

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

When `main` advances while a branch is open, update the branch with
`git fetch origin main` followed by `git rebase origin/main`. Never merge
`origin/main` into a feature branch: the project squash-merges pull requests, so
merging the squashed copy back into a branch that contains the original commits
creates false conflicts. If the branch was stacked on another branch whose pull
request has since been squash-merged, re-cut it from the new `origin/main` and
replay only the commits unique to the branch (for example,
`git rebase --onto origin/main <old-parent-tip>`).

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

## The browser suite

`apps/desktop/e2e/` drives the built page in a real browser. It is **one spec
file per area** — `timeline.spec.ts`, `transmog.spec.ts`, `wifi.spec.ts` — with
the page objects under `e2e/pages/` and the fixture under `e2e/mock/`, both split
the same way. That is not tidiness: `playwright.config.ts` asks for
`fullyParallel`, one file cannot use it, and six branches appending to the tail
of one file all collide within a few lines of each other. A new area is a new
file, and a feature edits its own.

Four rules hold inside those files.

1. **A scenario stays one test, structured with `test.step()`.** Steps say where
   a run failed and carry the semantics of what was being attempted, and keeping
   the scenario whole avoids repeating its setup once per assertion. Do not chop
   a scenario into a test per claim; do start a new test where a genuinely
   different scenario starts.
2. **No raw locators in a test file.** Every locator lives in a page object. A
   spec names behaviour and never reaches into the DOM — not even through a
   locator a page object handed it.
3. **A page object defines only methods that are actually called.** No method
   kept for a caller that no longer exists.
4. **Locators use accessibility selectors only — `getByRole`, `getByLabel`,
   `getByText`, `getByAltText`, `getByTitle` — and never a class, an id or a
   position.** Where the window does not expose the roles and accessible names
   that needs, **add them to the window**; that is part of the work rather than a
   reason to fall back to CSS. A test that cannot ask for a thing by name has
   found a thing a screen reader cannot ask for either.

What is *not* a locator is still fair game: reading a computed colour, a
`data-` attribute or the pixels of a canvas is how this suite checks things the
accessibility tree has no opinion about — see `e2e/pages/paint.ts`. Keep those
readings in a page object too, on a locator that was found by name.

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

The frontend is React. `index.html` carries nothing at all — everything below
`#root` is drawn from `src/main.tsx`. A view is a `.tsx` component and the logic
behind it is a `.ts` module beside it, the same split the addon's frames and pure
modules use and for the same reason: `sessions.ts`, `characters.ts`,
`transmog.ts`, `combatLog.ts` and `wifi.ts` are where the rules live and where the
tests are, and the components over them only draw. Nothing builds markup out of
strings, so nothing has to remember to escape a name out of the game.

**A component's styling is a `.css` file beside it, imported by it** —
`wardrobeList.css` next to `wardrobeList.tsx`, `outfitPanel.css` next to
`outfitPanel.tsx`. Vite handles the import natively. `src/base.css` is the
exception and the only one: the palette, the element defaults and the few shapes
no single component owns, read by `main.tsx` before anything else so that every
sheet after it is written in those terms.

This replaces the rule that `index.html` carried the stylesheet, which was the
single largest producer of merge conflicts in this repository — six branches in a
day all appending to the tail of one 1,400-line sheet, two unrelated features
landing nine lines apart. The reason that rule existed was the packaged app's CSP:
Tauri stamps a nonce onto `style-src` and onto the `<style>` tags it embeds, and a
nonce makes every engine ignore `'unsafe-inline'`. It does not apply. A built page
reaches its CSS through a `<link>` that `'self'` already allows, and the dev
server hands Vite the same nonce through a `csp-nonce` meta tag — see
`vite.config.ts`. What has not changed is that a `style=""` attribute can never
carry a nonce, so **nothing the app draws may be styled from a `style` prop**;
that is what `data-class` and `data-quality` are for.

The frontend, its tests and this repository's own scripts are TypeScript, under
`strict`. There is no JavaScript left in the tree and no new file should add any.
The shapes that cross the Tauri boundary are Rust DTOs and command signatures;
tauri-specta generates `apps/desktop/src/bindings.ts` from them. Run
`bun run bindings:generate` after changing either, and never edit the generated
file or mirror a command payload in `types.ts`. `scripts/check-rust.sh` rejects a
stale generated client. Nothing is compiled by `tsc` — Vite, Vitest and Bun each
strip the types — so `bun run typecheck` is the only thing that ever reads the
annotations, which is why `./scripts/check.sh` runs it.

The addon's only job in that pipeline is writing `db.segments`; everything
downstream reads the file the client dumps at logout.
