#!/usr/bin/env bash
# Lint + test. The single command CI and humans both run.
set -euo pipefail
cd "$(dirname "$0")/.."

eval "$(luarocks --lua-version 5.1 path --bin 2>/dev/null || true)"

echo "==> luacheck"
luacheck src Main.lua spec

echo "==> busted"
busted --verbose

# The collector runs outside the game, on whatever Python the gaming machine has,
# so it is tested with the standard library and nothing else.
echo "==> collector"
python3 -m unittest discover --start-directory scripts --pattern "*_test.py"
