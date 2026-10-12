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
pnpm exec tsc -b
# Wrangler bundles the Workers with esbuild, which never type-checks, and the
# root `tsc -b` does not cover them, so a Worker type error would otherwise
# deploy (#1044 shipped a ReferenceError on every mirror sync that way).
pnpm --dir auth-worker run type-check
pnpm --dir sync-worker run type-check
