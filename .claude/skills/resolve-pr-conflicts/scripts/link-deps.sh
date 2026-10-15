#!/usr/bin/env bash
# Give a scratch worktree its own installed dependencies and an armed pre-push
# hook, so it can type-check, test, and push through the gate as it stands.
#
#   link-deps.sh [worktree-dir]        (default: current directory)
#
# Every package gets a real frozen install from the worktree's own lockfile:
# the root (`pnpm install --frozen-lockfile`) and each standalone worker -
# auth-worker, sync-worker, agent-worker (`pnpm install --ignore-workspace
# --frozen-lockfile`). Nothing is linked to the main checkout:
#
# - The pre-push hook's first step (scripts/assert-worktree-node-modules.ts)
#   refuses the push when node_modules, auth-worker/node_modules or
#   sync-worker/node_modules is a symlink that resolves outside the worktree.
# - Links INSIDE a real root node_modules pass that check but still resolve
#   into the main checkout's node_modules/.pnpm, which vite.config.ts's
#   server.fs.allow does not cover, so the e2e app cannot load wa-sqlite wasm.
# - The main checkout's installs are often stale against its own lockfile;
#   borrowed versions produce phantom tsc/vitest failures that look exactly
#   like real regressions.
#
# From a warm pnpm store the root takes seconds and a worker about one; an
# install that is already current is a no-op. The root install's `prepare`
# script (husky) generates .husky/_, which arms the hook.
#
# Run it AFTER the merge, so the lockfiles are the merged ones. Safe to re-run:
# it replaces node_modules that an older copy of this script, or a hand-made
# symlink, pointed at the main checkout.
set -euo pipefail

wt="$(cd "${1:-.}" && git rev-parse --show-toplevel)"
common="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)"
main="$(dirname "$common")"

if [ "$wt" = "$main" ]; then
  echo "Refusing to run in the main checkout - this is for scratch worktrees." >&2
  exit 1
fi

# CI=1 as in scripts/worktree-new.ts: without a TTY, pnpm aborts instead of
# asking whether to rebuild a node_modules made by different pnpm settings.
pnpm_install() { # <dir> <pnpm install args...>
  (cd "$1" && shift && CI="${CI:-1}" pnpm install "$@")
}

drop_borrowed() { # <label> <node_modules path>
  local nm="$2"
  if [ -L "$nm" ]; then
    # A whole-directory symlink: exactly what the pre-push hook refuses.
    # `unlink` removes the link only, never the main checkout's install.
    unlink "$nm"
    echo "$1 removed a node_modules symlink to another checkout"
  elif [ -L "$nm/.pnpm" ] || [ -L "$nm/.modules.yaml" ]; then
    # A real directory of per-entry links (older copies of this script). A pnpm
    # install never makes these two links, so this is safe to identify by them.
    # rm -rf deletes the links themselves, not what they point at.
    rm -rf "$nm"
    echo "$1 removed per-entry links into another checkout's node_modules"
  fi
}

# --- root ---------------------------------------------------------------------
drop_borrowed "root:        " "$wt/node_modules"
echo "root:         pnpm install --frozen-lockfile"
pnpm_install "$wt" --frozen-lockfile

# --- standalone workers (not workspace members; each has its own lockfile) -----
# --ignore-workspace because a plain install inside a worker walks up to the
# root workspace and installs nothing for the worker.
for w in auth-worker sync-worker agent-worker; do
  [ -f "$wt/$w/package.json" ] || continue
  drop_borrowed "$w:" "$wt/$w/node_modules"
  echo "$w: pnpm install --ignore-workspace --frozen-lockfile"
  pnpm_install "$wt/$w" --ignore-workspace --frozen-lockfile
done

# --- pre-push hook ------------------------------------------------------------
# core.hooksPath is the relative ".husky/_", which is generated (never checked
# out). The root install's husky `prepare` normally creates it; the main
# checkout's copy is the fallback if that did not run.
if [ ! -e "$wt/.husky/_/pre-push" ] && [ ! -L "$wt/.husky/_" ] && [ -e "$main/.husky/_/pre-push" ]; then
  ln -s "$main/.husky/_" "$wt/.husky/_"
  echo "pre-push:     linked the main checkout's .husky/_ (husky did not generate one; shows as '?? .husky/_' - never stage it)"
fi
hooks_path="$(git -C "$wt" config --get core.hooksPath || true)"
if [ -n "$hooks_path" ] && [ -e "$(cd "$wt" && cd "$hooks_path" 2>/dev/null && pwd)/pre-push" ]; then
  echo "pre-push:     armed (core.hooksPath=$hooks_path)"
else
  echo "pre-push:     NOT armed (core.hooksPath=${hooks_path:-unset}) - run scan:secrets and test:e2e:affected by hand before pushing"
fi

# --- same check the hook runs first -------------------------------------------
# Fails here, with the hook's own message, rather than minutes later at push.
# Branches from before AQU-1623 do not have the check (nor the hook step).
if [ -f "$wt/scripts/assert-worktree-node-modules.ts" ]; then
  (cd "$wt" && pnpm exec tsx scripts/assert-worktree-node-modules.ts)
  echo "node_modules: every install belongs to this worktree (the hook's check passes)"
fi
