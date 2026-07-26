#!/usr/bin/env bash
# Lint + test. The single command CI and humans both run.
set -euo pipefail
cd "$(dirname "$0")/.."

eval "$(luarocks --lua-version 5.1 path --bin 2>/dev/null || true)"

echo "==> luacheck"
luacheck apps/addon/src apps/addon/Main.lua apps/addon/spec

echo "==> busted"
busted --verbose

echo "==> desktop backend"
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml

echo "==> desktop frontend"
bun run --cwd apps/desktop test
bun run --cwd apps/desktop test:e2e
