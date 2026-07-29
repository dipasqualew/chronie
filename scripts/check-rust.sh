#!/usr/bin/env bash
# The desktop backend: the whole workspace, formatted, linted, tests and all.
#
# The bindings check rides inside `cargo test`. `bindings.ts` used to be verified by running a
# binary of its own, which cost a second link of the whole tree and gave the Tauri bundler a
# second binary to copy into every shipped app; it is a test now.
#
# Formatting first because it is the cheapest of the three and needs nothing compiled, then
# clippy, which shares its check artifacts with the test build that follows.
set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST=apps/desktop/src-tauri/Cargo.toml

# Rustfmt's own defaults, with no `rustfmt.toml` anywhere — the point of a formatter is that
# nobody has an opinion about it. `cargo fmt` with no `--check` is what fixes a red run here.
echo "==> rustfmt"
cargo fmt --manifest-path "$MANIFEST" --check

# `--all-targets` so the examples and the integration tests are linted too. Those are where a
# `dump_*` tool goes stale, and a tool nobody compiles is a tool nobody can run.
#
# `-D warnings` and no allow list. There were sixteen findings when this was turned on and all
# sixteen were worth fixing, so there is no baseline to carry and nothing for a new warning to
# hide behind. A lint this repository genuinely disagrees with belongs in an `#[allow]` at the
# item it is about, with the reason written beside it, rather than switched off for the tree.
#
# Worth knowing before it surprises somebody: clippy's lint set travels with the toolchain, so
# the runner having a newer rustc than a laptop means CI can find things a clean local run did
# not. That is how this arrived — five findings on the runner's 1.97 that 1.89 does not have,
# on code neither of them had changed. It is a red build on the pull request rather than a
# surprise on main, which is the trade `-D warnings` is making, and the fix is to fix them.
echo "==> clippy"
cargo clippy --manifest-path "$MANIFEST" --all-targets -- -D warnings

echo "==> desktop backend"
cargo test --manifest-path "$MANIFEST"
