#!/usr/bin/env bash
# Build aquilla-web for the environment selected by Cloudflare Workers Builds.
set -euo pipefail

node scripts/assert-workers-build-env.mjs

case "$WORKERS_CI_BRANCH" in
  main) H=api.aquilla.app ;;
  *) H=api.dev.aquilla.app ;;
esac

export VITE_SYNC_WORKER_HOST="$H/sync"
export VITE_AUTH_BASE="https://$H/identity"
export VITE_CHAT_BASE="https://$H/chat"

echo "ci-build: branch=$WORKERS_CI_BRANCH -> API host $H"

pnpm run build
bash scripts/verify-dist-host.sh "$H"
rm -f dist/_redirects
node scripts/verify-deployment-artifacts.mjs dist
