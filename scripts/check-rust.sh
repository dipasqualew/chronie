#!/usr/bin/env bash
# The desktop backend: the whole workspace, tests and all.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> desktop backend"
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
