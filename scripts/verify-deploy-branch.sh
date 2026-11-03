#!/usr/bin/env bash
# Guards against deploying any live environment from the wrong git branch
# (for example, running a development deploy from a feature branch).
# Complements verify-dist-host.sh, which only catches a stale dist/ — this
# catches the sync-worker/auth-worker deploys too, which have no SPA build.
#
# Usage: verify-deploy-branch.sh <expected-branch | release>
# "release" accepts any release/YYYY/MM/DD or release/YYYY/MM/DD-NN branch (production).
# In GitHub Actions the checkout must also match the ref GitHub reports
# (GITHUB_REF_NAME) — or DEPLOY_REF_NAME, set by a workflow that chose its
# deploy ref at run time instead of being dispatched on it.
set -euo pipefail

expected="$1"
git_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
ci_branch=""

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  # GITHUB_REF_NAME is the ref the workflow ran on. A workflow that picks its
  # deploy ref at run time (release-deploy.yml runs on a schedule, so GitHub
  # reports the default branch while the job checks out the release branch
  # it chose) names that ref in DEPLOY_REF_NAME. It is checked against the
  # checkout below exactly as GITHUB_REF_NAME is.
  ci_branch="${DEPLOY_REF_NAME:-${GITHUB_REF_NAME:-}}"
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

if [ "$expected" = "release" ]; then
  if ! [[ "$current" =~ ^release/[0-9]{4}/[0-9]{2}/[0-9]{2}(-[0-9]{2})?$ ]]; then
    echo "ABORT: this deploy target requires a release/YYYY/MM/DD branch (currently on '$current')." >&2
    echo "Cut a release branch from dev and deploy from it." >&2
    exit 1
  fi
  expected="$current"
fi

if [ "$current" != "$expected" ]; then
  echo "ABORT: this deploy target requires branch '$expected' (currently on '$current')." >&2
  echo "Checkout the clean, current '$expected' branch and use its matching deploy command." >&2
  exit 1
fi

# Local live deploys must be reproducible from the exact remote commit. GitHub
# Actions checkouts are already pinned to the explicitly dispatched ref.
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
