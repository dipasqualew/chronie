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
echo "==> clippy"
cargo clippy --manifest-path "$MANIFEST" --all-targets -- -D warnings

echo "==> desktop backend"
cargo test --manifest-path "$MANIFEST"
