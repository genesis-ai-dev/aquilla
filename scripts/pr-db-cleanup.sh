#!/usr/bin/env bash
# Tears down a per-PR sync-worker + its forked D1, plus the R2 keys under
# the pr-<N>/ prefix in codex-snapshots-staging. Idempotent.
#
# Usage:
#   PR_NUMBER=43 CLOUDFLARE_ACCOUNT_ID=... ./scripts/pr-db-cleanup.sh
set -euo pipefail

: "${PR_NUMBER:?need PR_NUMBER}"
: "${CLOUDFLARE_ACCOUNT_ID:?need CLOUDFLARE_ACCOUNT_ID}"

DB_NAME="codex-db-pr-${PR_NUMBER}"
WORKER_NAME="codex-sync-worker-pr-${PR_NUMBER}"
R2_BUCKET="codex-snapshots-staging"
R2_PREFIX="pr-${PR_NUMBER}/"

echo "[pr-db-cleanup] PR=${PR_NUMBER}"

# 1. Delete the per-PR worker. wrangler returns non-zero if it doesn't exist;
#    we treat that as success since this is a teardown.
echo "[pr-db-cleanup] deleting worker ${WORKER_NAME}"
npx wrangler delete --name "${WORKER_NAME}" 2>&1 | tail -5 || true

# 2. Delete R2 objects under pr-<N>/. R2 doesn't have a recursive delete;
#    list + chunked delete.
echo "[pr-db-cleanup] purging R2 keys under ${R2_BUCKET}/${R2_PREFIX}"
cursor=""
deleted=0
while :; do
  args=(--prefix "${R2_PREFIX}")
  [ -n "${cursor}" ] && args+=(--cursor "${cursor}")
  page="$(npx wrangler r2 object list "${R2_BUCKET}" --json "${args[@]}" 2>/dev/null || echo '{"objects":[]}')"
  keys="$(echo "${page}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for o in d.get('objects', []): print(o['key'])
")"
  cursor="$(echo "${page}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('cursor', '') if d.get('truncated') else '')
")"
  if [ -z "${keys}" ]; then break; fi
  while IFS= read -r key; do
    [ -z "${key}" ] && continue
    npx wrangler r2 object delete "${R2_BUCKET}/${key}" >/dev/null 2>&1 || true
    deleted=$((deleted + 1))
  done <<< "${keys}"
  if [ -z "${cursor}" ]; then break; fi
done
echo "[pr-db-cleanup] removed ${deleted} R2 objects"

# 3. Delete the D1. --skip-confirmation suppresses the interactive prompt.
echo "[pr-db-cleanup] deleting D1 ${DB_NAME}"
npx wrangler d1 delete "${DB_NAME}" --skip-confirmation 2>&1 | tail -5 || true

echo "[pr-db-cleanup] done"
