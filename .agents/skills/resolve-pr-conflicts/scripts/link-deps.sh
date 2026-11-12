#!/usr/bin/env bash
# Give a scratch worktree runnable dependencies and an armed pre-push hook.
#
#   link-deps.sh [worktree-dir]        (default: current directory)
#
# For the root package and each standalone worker it compares the worktree's
# pnpm-lock.yaml with what the main checkout ACTUALLY has installed
# (node_modules/.pnpm/lock.yaml - the main checkout's installs are often stale
# against its own lockfile). Identical -> symlink (instant). Different -> a real
# frozen install in the worktree, because borrowing mismatched deps produces
# phantom tsc/vitest failures that look exactly like real regressions.
#
# Run it AFTER the merge, so the lockfiles are the merged ones. Safe to re-run.
set -euo pipefail

wt="$(cd "${1:-.}" && git rev-parse --show-toplevel)"
common="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)"
main="$(dirname "$common")"

if [ "$wt" = "$main" ]; then
  echo "Refusing to run in the main checkout - this is for scratch worktrees." >&2
  exit 1
fi

installed_matches() { # <package dir relative to repo root>
  local installed="$main/$1/node_modules/.pnpm/lock.yaml"
  [ -f "$installed" ] && cmp -s "$wt/$1/pnpm-lock.yaml" "$installed"
}

# --- root ---------------------------------------------------------------------
if [ -e "$wt/node_modules" ]; then
  echo "root:         node_modules already present - left alone"
elif installed_matches .; then
  # Per-entry links inside a REAL directory: tsc -b writes its incremental state
  # to node_modules/.tmp and vite caches to node_modules/.vite, and neither may
  # be shared with the main checkout.
  mkdir "$wt/node_modules"
  for entry in "$main"/node_modules/* "$main"/node_modules/.[!.]*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    case "$name" in
      .tmp | .vite | .vite-temp | .cache | .DS_Store) continue ;;
    esac
    ln -s "$entry" "$wt/node_modules/$name"
  done
  mkdir "$wt/node_modules/.tmp"
  echo "root:         linked to the main checkout (own .tmp / .vite)"
else
  echo "root:         lockfile differs from the main checkout's install - installing"
  (cd "$wt" && pnpm install --frozen-lockfile)
fi

# --- standalone workers (not workspace members; each has its own lockfile) -----
for w in auth-worker sync-worker agent-worker; do
  [ -f "$wt/$w/package.json" ] || continue
  if [ -e "$wt/$w/node_modules" ]; then
    echo "$w: node_modules already present - left alone"
  elif installed_matches "$w"; then
    ln -s "$main/$w/node_modules" "$wt/$w/node_modules"
    echo "$w: linked to the main checkout"
  else
    echo "$w: lockfile differs from the main checkout's install - installing"
    (cd "$wt/$w" && pnpm install --ignore-workspace --frozen-lockfile)
  fi
done

# --- pre-push hook ------------------------------------------------------------
# core.hooksPath is the relative ".husky/_", which is generated (never checked
# out), so a fresh worktree has no hook and `git push` goes out ungated.
if [ -e "$wt/.husky/_/pre-push" ]; then
  echo "pre-push:     armed"
elif [ -e "$main/.husky/_/pre-push" ]; then
  ln -s "$main/.husky/_" "$wt/.husky/_"
  echo "pre-push:     armed via the main checkout's .husky/_ (shows as '?? .husky/_' - never stage it)"
else
  echo "pre-push:     NOT armed - run scan:secrets and test:e2e:affected by hand before pushing"
fi
