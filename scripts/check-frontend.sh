#!/usr/bin/env bash
# Everything TypeScript: the shape of the source, the type annotations nothing else ever reads,
# the unit tests, and the browser suite that drives the built page.
#
# Formatting and linting come first because they are seconds rather than minutes, and because
# a run that is going to fail on an unlisted effect dependency should say so before Chromium
# has started.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> formatting"
bun run format:check

# Reports an unused `eslint-disable` as an error, which is the check that stops a comment
# claiming a rule the repository does not run. See `eslint.config.ts`.
echo "==> lint"
bun run lint

echo "==> typecheck"
bun run typecheck

echo "==> repository scripts"
bun run test:scripts

# The committed game-file fixtures against the generators they came out of. Synthetic all the
# way down, so this needs no World of Warcraft install and is the same on a runner as it is on
# a machine that has one.
echo "==> generated fixtures"
bun run test:fixtures

echo "==> desktop frontend"
bun run --cwd apps/desktop test
bun run --cwd apps/desktop test:e2e
