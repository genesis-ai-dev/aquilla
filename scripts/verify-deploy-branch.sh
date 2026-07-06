#!/usr/bin/env bash
# Guards against deploying to prod/staging from the wrong git branch (e.g.
# running a prod deploy script while checked out on `dev` or a feature
# branch). Complements verify-dist-host.sh, which only catches a stale
# dist/ — this catches the sync-worker/auth-worker deploys too, which have
# no build step for verify-dist-host.sh to check.
#
# Usage: verify-deploy-branch.sh <expected-branch>
set -euo pipefail

expected="$1"
current="$(git rev-parse --abbrev-ref HEAD)"

if [ "$current" != "$expected" ]; then
  echo "ABORT: this deploy target requires branch '$expected' (currently on '$current')." >&2
  echo "Checkout '$expected' first, or use the matching 'npm run deploy:aquilla:dev:*' script to test a feature branch against the dev environment." >&2
  exit 1
fi

echo "OK: on branch '$current' as required for this deploy target."
