#!/usr/bin/env bash
# The addon half: luacheck over every Lua file the client loads, then busted.
set -euo pipefail
cd "$(dirname "$0")/.."

eval "$(luarocks --lua-version 5.1 path --bin 2>/dev/null || true)"

echo "==> luacheck"
luacheck apps/addon/src apps/addon/Main.lua apps/addon/spec

echo "==> busted"
busted --verbose
