#!/usr/bin/env bash
# Opens or refreshes the pull request that merges upstream OAO into a
# downstream distribution. Runs inside the downstream repository; see
# CONTRIBUTING.md#downstream-distributions.
set -euo pipefail

base_branch=${UPSTREAM_SYNC_BASE_BRANCH:?Set UPSTREAM_SYNC_BASE_BRANCH}
push_url=${UPSTREAM_SYNC_PUSH_URL:?Set UPSTREAM_SYNC_PUSH_URL}
upstream=$(git rev-parse --verify "${UPSTREAM_SYNC_COMMIT:?Set UPSTREAM_SYNC_COMMIT}^{commit}")
sync_branch=${UPSTREAM_SYNC_BRANCH:-upstream-sync}
upstream_repository=${UPSTREAM_REPOSITORY:-vectrix-ai/oao}
bot_name='github-actions[bot]'
bot_email='41898282+github-actions[bot]@users.noreply.github.com'

git fetch --quiet --no-tags origin \
  "+refs/heads/$base_branch:refs/remotes/origin/$base_branch"
base=$(git rev-parse "refs/remotes/origin/$base_branch")
pr=$(gh pr list --head "$sync_branch" --base "$base_branch" --state open \
  --json number --jq '.[0].number // empty')
short=$(git rev-parse --short=7 "$upstream")

# The sync branch can outlive its pull request, for example when one is closed
# after someone committed a conflict resolution to it.
head=
if git fetch --quiet --no-tags origin \
  "+refs/heads/$sync_branch:refs/remotes/origin/$sync_branch" 2>/dev/null; then
  head=$(git rev-parse "refs/remotes/origin/$sync_branch")
fi

# Prints who committed the sync branch's commits that are missing from the
# given commits, other than this job: someone resolving conflicts by hand.
manual_committers() {
  if [ -n "$head" ]; then
    git log --format=%ce "$head" "${@/#/^}" | grep -vxF "$bot_email" || true
  fi
}

if git merge-base --is-ancestor "$upstream" "$base"; then
  echo "$base_branch already contains $upstream_repository@$short."
  if [ -n "$pr" ] && [ -n "$(manual_committers "$base")" ]; then
    gh pr close "$pr" --comment "\`$base_branch\` already contains \
$upstream_repository@$short. Kept \`$sync_branch\` because it has manual \
commits that are not in \`$base_branch\`; delete it if they are not needed."
  elif [ -n "$pr" ]; then
    gh pr close "$pr" --delete-branch \
      --comment "\`$base_branch\` already contains $upstream_repository@$short."
  fi
  exit 0
fi

if [ -n "$pr" ] && [ -n "$head" ] &&
  git merge-base --is-ancestor "$upstream" "$head"; then
  echo "Pull request #$pr already contains $upstream_repository@$short."
  exit 0
fi

# Keep manual commits and merge upstream on top instead of rebuilding.
manual=
if [ -n "$(manual_committers "$base" "$upstream")" ]; then manual=1; fi

version=$( (git show "$upstream:package.json" 2>/dev/null || true) |
  sed -nE 's/^  "version": "([^"]+)",?$/\1/p')
title="chore: sync upstream OAO${version:+ v$version} ($short)"
message="Merge $upstream_repository@$upstream into $base_branch."

worktree=$(mktemp -d)
body=$(mktemp)
cleanup() {
  git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf "$worktree" "$body"
}
trap cleanup EXIT

in_worktree() {
  git -C "$worktree" -c user.name="$bot_name" -c user.email="$bot_email" "$@"
}

if [ -n "$manual" ]; then
  start=$head
  resolve_from="origin/$sync_branch"
else
  start=$base
  resolve_from="origin/$base_branch"
fi
git worktree add --quiet --detach "$worktree" "$start"
conflicts=
if git merge-base --is-ancestor "$upstream" "$start"; then
  result=$start
elif in_worktree merge --quiet --no-ff -m "$title" -m "$message" "$upstream" \
  >/dev/null 2>&1; then
  result=$(git -C "$worktree" rev-parse HEAD)
else
  conflicts=$(git -C "$worktree" diff --name-only --diff-filter=U)
  if [ -z "$conflicts" ]; then
    echo "Merging $upstream into $start failed without conflicts." >&2
    exit 1
  fi
  in_worktree merge --abort
  # A manual branch keeps its commits; otherwise the pull request shows the
  # upstream commit so GitHub reports the conflicts against the base branch.
  if [ -n "$manual" ]; then result=$head; else result=$upstream; fi
fi

commit_count=$(git rev-list --count --no-merges "$base..$upstream")
{
  echo "Merges [\`$upstream_repository@$short\`](https://github.com/$upstream_repository/commit/$upstream) into \`$base_branch\`."
  echo
  echo '> [!IMPORTANT]'
  echo '> Merge with **Create a merge commit**. Squash and rebase merges drop the'
  echo '> upstream ancestry, so the next sync would replay these changes.'
  if [ -n "$conflicts" ]; then
    echo
    echo '### Conflicts'
    echo
    echo 'The automatic merge conflicts in:'
    echo
    while IFS= read -r file; do echo "- \`$file\`"; done <<<"$conflicts"
    echo
    echo 'Resolve them on this branch. Later syncs keep manual commits and merge'
    echo 'new upstream changes into them.'
    echo
    echo '```sh'
    echo 'git fetch origin'
    echo "git switch -C $sync_branch $resolve_from"
    echo "git merge $upstream"
    echo '# resolve, commit, then:'
    echo "git push --force-with-lease origin $sync_branch"
    echo '```'
  fi
  echo
  echo "### Upstream commits ($commit_count)"
  echo
  # Qualify issue references so they link upstream, not to this repository.
  git log --no-merges --max-count=50 --format='- %h %s' "$base..$upstream" |
    sed -E "s|#([0-9]+)|$upstream_repository#\1|g"
  if [ "$commit_count" -gt 50 ]; then
    echo "- and $((commit_count - 50)) older commits"
  fi
} >"$body"

if [ -n "$pr" ]; then
  if [ "$result" != "$head" ]; then
    git push --quiet --force-with-lease="refs/heads/$sync_branch:$head" \
      "$push_url" "$result:refs/heads/$sync_branch"
  fi
  gh pr edit "$pr" --title "$title" --body-file "$body"
  if [ -n "$manual" ]; then
    if [ -n "$conflicts" ]; then
      gh pr comment "$pr" --body "$upstream_repository@$short conflicts with \
the manual resolution on this branch; see the updated description."
    else
      gh pr comment "$pr" \
        --body "Merged $upstream_repository@$short into the manually resolved branch."
    fi
  fi
  exit 0
fi

# Pull requests opened with GITHUB_TOKEN do not start workflows. Open the pull
# request first, then push the merge so the deploy-key push runs CI. A manual
# branch is reused as it is; otherwise the pull request opens on the upstream
# commit.
if [ -n "$manual" ]; then
  opened_at=$head
else
  opened_at=$upstream
  git push --quiet --force "$push_url" "$upstream:refs/heads/$sync_branch"
fi
gh pr create --base "$base_branch" --head "$sync_branch" \
  --title "$title" --body-file "$body"
if [ "$result" != "$opened_at" ]; then
  git push --quiet --force-with-lease="refs/heads/$sync_branch:$opened_at" \
    "$push_url" "$result:refs/heads/$sync_branch"
fi
