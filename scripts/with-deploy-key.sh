#!/usr/bin/env bash
# Runs a command whose git SSH operations authenticate with the deploy key in
# DEPLOY_KEY and trust only GitHub's published host keys.
set -euo pipefail

: "${DEPLOY_KEY:?Set DEPLOY_KEY}"
ssh_dir=$(mktemp -d)
trap 'rm -rf "$ssh_dir"' EXIT
(umask 077 && printf '%s\n' "$DEPLOY_KEY" >"$ssh_dir/key")
unset DEPLOY_KEY
gh api meta --jq '.ssh_keys[] | "github.com " + .' >"$ssh_dir/known_hosts"
export GIT_SSH_COMMAND="ssh -i $ssh_dir/key -o IdentitiesOnly=yes \
-o UserKnownHostsFile=$ssh_dir/known_hosts -o StrictHostKeyChecking=yes"
"$@"
