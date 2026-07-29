#!/usr/bin/env bash
# The desktop backend: the whole workspace, tests and all.
#
# One cargo invocation, and the bindings check rides inside it. `bindings.ts` used to be
# verified by running a binary of its own, which cost a second link of the whole tree and gave
# the Tauri bundler a second binary to copy into every shipped app; it is a test now.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> desktop backend"
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
