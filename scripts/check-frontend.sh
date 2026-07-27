#!/usr/bin/env bash
# Everything TypeScript: the type annotations nothing else ever reads, the unit tests, and
# the browser suite that drives the built page.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> typecheck"
bun run typecheck

echo "==> desktop frontend"
bun run --cwd apps/desktop test
bun run --cwd apps/desktop test:e2e
