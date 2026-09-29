#!/usr/bin/env bash
# Mirrors a main commit to the downstream distribution's upstream-main branch;
# see CONTRIBUTING.md#downstream-distributions.
set -euo pipefail

commit=$(git rev-parse --verify "${MIRROR_COMMIT:?Set MIRROR_COMMIT}^{commit}")
url=${DOWNSTREAM_URL:?Set DOWNSTREAM_URL}

current=$(git ls-remote "$url" refs/heads/upstream-main | cut -f1)
# A rerun of an older mirror run must not rewind the branch.
if [ -n "$current" ] &&
  git merge-base --is-ancestor "$commit" "$current" 2>/dev/null; then
  echo "upstream-main already contains $commit."
  exit 0
fi
# Anything else there is not main's history, such as a manual test push.
git push --quiet --force "$url" "$commit:refs/heads/upstream-main"
