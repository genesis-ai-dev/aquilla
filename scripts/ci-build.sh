#!/usr/bin/env bash
# Build the route-free PR preview. It always targets development APIs; main,
# dev, and feature builds must never compile a preview against production.
set -euo pipefail

node scripts/assert-workers-build-env.mjs

H=api.dev.aquilla.app

export VITE_SYNC_WORKER_HOST="$H/sync"
export VITE_AUTH_BASE="https://$H/identity"
export VITE_CHAT_BASE="https://$H/chat"

echo "ci-preview-build: branch=$WORKERS_CI_BRANCH -> API host $H"

pnpm run build
bash scripts/verify-dist-host.sh "$H"
rm -f dist/_redirects
node scripts/verify-deployment-artifacts.mjs dist
