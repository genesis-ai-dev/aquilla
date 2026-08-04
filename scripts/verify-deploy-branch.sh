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
git_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
ci_branch=""

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  ci_branch="${GITHUB_REF_NAME:-}"
elif [ "${WORKERS_CI:-}" = "1" ]; then
  ci_branch="${WORKERS_CI_BRANCH:-}"
fi

if [ -n "$git_branch" ]; then
  current="$git_branch"
  if [ -n "$ci_branch" ] && [ "$ci_branch" != "$git_branch" ]; then
    echo "ABORT: CI reports branch '$ci_branch', but Git is on '$git_branch'." >&2
    exit 1
  fi
elif [ -n "$ci_branch" ]; then
  current="$ci_branch"
else
  echo "ABORT: detached HEAD without trusted CI branch metadata." >&2
  exit 1
fi

if [ "$current" != "$expected" ]; then
  echo "ABORT: this deploy target requires branch '$expected' (currently on '$current')." >&2
  echo "Checkout '$expected' first, or use the matching 'npm run deploy:aquilla:dev:*' script to test a feature branch against the dev environment." >&2
  exit 1
fi

# Local production/staging deploys must be reproducible from the exact remote
# commit. CI checkouts are already pinned to the event SHA and authenticated
# Cloudflare Builds may not expose reusable Git remote credentials.
if [ -z "$ci_branch" ]; then
  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    echo "ABORT: deploys require a clean working tree." >&2
    exit 1
  fi

  remote_sha="$(GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code origin "refs/heads/$expected" | awk '{print $1}')" || {
    echo "ABORT: could not verify origin/$expected; refusing an unverifiable deploy." >&2
    exit 1
  }
  head_sha="$(git rev-parse HEAD)"
  if [ "$head_sha" != "$remote_sha" ]; then
    echo "ABORT: HEAD ($head_sha) is not the current origin/$expected ($remote_sha)." >&2
    echo "Push or update the branch before deploying." >&2
    exit 1
  fi
fi

echo "OK: branch '$current' is authorized for this deploy target."
