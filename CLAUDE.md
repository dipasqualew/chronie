# wdp-wow

A World of Warcraft addon. Lua 5.1 / LuaJIT semantics — the game client has no
LuaRocks, no `require`, and no standard library beyond what Blizzard exposes.

## Git workflow

Commit and push straight to `main`. Do not create a feature branch or open a PR
unless explicitly asked — this is a solo addon repo and the branch-then-merge
round trip is pure overhead here.

## Checks

`./scripts/check.sh` runs luacheck then busted. It must report zero warnings and
zero failures before committing. Luacheck caps lines at 120 characters, and new
WoW API globals have to be declared in `.luacheckrc` or it fails the build.

A run that is not fully green is not a finished piece of work. Leaving lint
warnings, test failures, or errors behind — whether they predate the change, were
caused by it, or "only" affect tests you did not write — is never acceptable.
Fix every one of them, or stop and say plainly which you could not fix and why.
Do not report work as done while `./scripts/check.sh` exits non-zero, and do not
silence a problem by deleting or weakening the test that found it.

## Structure

Every file under `src/` is loaded by the client in the order listed in
`wdp-wow.toc`; a file missing from the .toc fails the test suite as well as the
game. Modules are `ns.newThing(deps)` factories returning a table of closures.

`Main.lua` is the only place allowed to touch WoW globals. It collects them into
a `WowEnv` table and injects it, so `src/` modules stay drivable from the fakes
in `spec/helpers/fake_wow.lua` without monkey patching.

Keep frame code thin and push logic into a pure module beside it — the pure
module is where the tests earn their keep.
