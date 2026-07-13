#!/usr/bin/env bash
# Cloudflare Workers Builds — SPA (aquilla-web) build for all branches.
#
# The same build command runs for every branch (Workers Builds only varies the
# DEPLOY command between production/non-production, not the build command), so
# the branch → API-host mapping lives here, keyed off $WORKERS_CI_BRANCH:
#   main    → api.aquilla.app          (prod backend)
#   staging → api.staging.aquilla.app  (staging backend)
#   *       → api.dev.aquilla.app      (dev backend; PR/preview builds land here)
#
# Baking the right VITE_* hosts is load-bearing: a bare build shipped
# dev-API-pointing bundles to aquilla.app once (see .github/workflows/deploy.yml).
# dist/_redirects is stripped because Workers' static-assets parser rejects the
# SPA `/* /index.html 200` rule (error 100324); wrangler.toml handles SPA
# fallback via not_found_handling instead.
set -euo pipefail

case "${WORKERS_CI_BRANCH:-}" in
  main)    H=api.aquilla.app ;;
  staging) H=api.staging.aquilla.app ;;
  *)       H=api.dev.aquilla.app ;;
esac

export VITE_SYNC_WORKER_HOST="$H/sync"
export VITE_AUTH_BASE="https://$H/identity"
export VITE_CHAT_BASE="https://$H/chat"

echo "ci-build: branch=${WORKERS_CI_BRANCH:-<unset>} → API host $H"

pnpm run build
rm -f dist/_redirects
