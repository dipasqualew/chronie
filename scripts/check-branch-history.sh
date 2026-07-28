#!/usr/bin/env bash
# Reject the merge-conflict pattern where a feature branch merges an older main
# into itself. The current pull request base contains every older main commit,
# so a merge's non-first parent being its ancestor identifies that history
# without rejecting merges from another feature branch.
set -euo pipefail

base=${1:?usage: check-branch-history.sh <base> <head>}
head=${2:?usage: check-branch-history.sh <base> <head>}
failed=false

git rev-parse --verify "${base}^{commit}" >/dev/null
git rev-parse --verify "${head}^{commit}" >/dev/null

while read -r merge _first_parent other_parents; do
    [[ -n "${merge:-}" ]] || continue
    for parent in $other_parents; do
        if git merge-base --is-ancestor "$parent" "$base"; then
            subject=$(git show --no-patch --format=%s "$merge")
            printf 'Forbidden merge commit %s: %s\n' "$merge" "$subject"
            printf '::error title=Feature branch merged main::Merge commit %s brings main into the feature branch. Remove it and use git rebase origin/main.\n' "${merge:0:12}"
            failed=true
            break
        fi
    done
done < <(git rev-list --merges --parents "${base}..${head}")

if [[ "$failed" == true ]]; then
    exit 1
fi

echo "Branch history does not merge main into the feature branch."
