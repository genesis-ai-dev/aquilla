#!/usr/bin/env bash
# Bring up everything `pnpm perf:interaction` and `pnpm perf:measure` need, on
# a machine with no Docker — a Claude Code cloud session, a CI runner.
#
#   bash scripts/perf/stack-up.sh        # idempotent; returns when the stack answers
#
# It provisions the native Postgres cluster the e2e suite uses
# (scripts/e2e-pg-native.sh), creates the dev database, installs the two
# workers' own dependencies, and starts `pnpm dev` in the background with its
# output in .perf/dev-stack.log. A stack that is already up is left alone.
set -euo pipefail

cd "$(dirname "$0")/../.."
log() { echo "[perf-stack] $*" >&2; }

PG_URL="postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev" # secret-scan:allow — throwaway loopback-only dev cluster, same fixture credential as scripts/dev-stack.ts

up() {
  curl -sf -o /dev/null http://127.0.0.1:5173/ \
    && curl -sf -o /dev/null http://127.0.0.1:8788/healthz \
    && curl -s -o /dev/null http://127.0.0.1:8789/
}

if up; then
  log "stack already up"
  exit 0
fi

eval "$(bash scripts/e2e-pg-native.sh)"
psql "$E2E_PG_ADMIN_URL" -Atc "SELECT 1 FROM pg_database WHERE datname = 'aquilla_dev'" | grep -q 1 \
  || psql "$E2E_PG_ADMIN_URL" -c "CREATE DATABASE aquilla_dev OWNER aquilla" >&2

[ -d node_modules ] || pnpm i --frozen-lockfile >&2
for worker in sync-worker auth-worker; do
  [ -d "$worker/node_modules" ] || (cd "$worker" && npm ci --no-audit --no-fund >&2)
done

mkdir -p .perf
log "starting pnpm dev (log: .perf/dev-stack.log)"
LOCAL_PG_URL="$PG_URL" nohup pnpm dev --no-sandbox > .perf/dev-stack.log 2>&1 &

for _ in $(seq 1 120); do
  if up; then
    log "stack is up"
    exit 0
  fi
  sleep 2
done
log "the stack did not answer within 4 minutes — see .perf/dev-stack.log"
exit 1
