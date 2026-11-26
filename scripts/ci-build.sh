#!/usr/bin/env bash
# Cloudflare owns the repo trigger. Compile here; the deploy command bundles
# Vite once the matching auth and sync preview URLs are known. No test suites.
set -euo pipefail
node scripts/assert-workers-build-env.mjs
CI=1 pnpm --dir auth-worker install --frozen-lockfile &
auth_install=$!
CI=1 pnpm --dir sync-worker install --frozen-lockfile &
sync_install=$!
wait "$auth_install"
wait "$sync_install"
# `pnpm run typecheck` is `tsc -b` with an explicit 6 GiB heap (package.json).
# The app project alone needs about 4.8 GB of heap when the collector is not
# squeezed, and Node's default ceiling is about 4 GB at best (it is sized from
# the machine's memory), so plain `tsc -b` passed only while GC could keep up:
# a 175 MB JSON import on one PR was enough to end it with "JavaScript heap out
# of memory" (2026-11-26), which would have failed every PR's preview once
# merged. The Workers Builds container has 8 GB on every plan, and the Worker
# installs above have finished by now, so 6 GiB fits. The flag raises the
# ceiling only; it does not reserve the memory.
pnpm run typecheck
# Wrangler bundles the Workers with esbuild, which never type-checks, and the
# root `tsc -b` does not cover them, so a Worker type error would otherwise
# deploy (#1044 shipped a ReferenceError on every mirror sync that way).
pnpm --dir auth-worker run type-check
pnpm --dir sync-worker run type-check
