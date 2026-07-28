#!/usr/bin/env bash
# Lint + test. The single command a human runs before committing.
#
# CI runs the same three scripts, one to a runner, because they need nothing from each other
# and the wall clock of the slowest is better than the sum of all three. Here they run in
# order, so the output reads top to bottom and the first failure is the one you see.
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/check-lua.sh
./scripts/check-rust.sh
./scripts/check-frontend.sh
