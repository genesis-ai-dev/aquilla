#!/usr/bin/env bash
# Tears down a per-PR sync-worker + its forked D1, plus the R2 keys under
# the pr-<N>/ prefix in aquilla-snapshots-staging. Idempotent.
#
# Usage:
#   PR_NUMBER=43 CLOUDFLARE_ACCOUNT_ID=... ./scripts/pr-db-cleanup.sh
set -euo pipefail

: "${PR_NUMBER:?need PR_NUMBER}"
: "${CLOUDFLARE_ACCOUNT_ID:?need CLOUDFLARE_ACCOUNT_ID}"

DB_NAME="codex-db-pr-${PR_NUMBER}"
WORKER_NAME="aquilla-sync-worker-pr-${PR_NUMBER}"
R2_BUCKET="aquilla-snapshots-staging"
R2_PREFIX="pr-${PR_NUMBER}/"

echo "[pr-db-cleanup] PR=${PR_NUMBER}"

# 1. Delete the per-PR worker. wrangler returns non-zero if it doesn't exist;
#    we treat that as success since this is a teardown.
echo "[pr-db-cleanup] deleting worker ${WORKER_NAME}"
npx wrangler delete --name "${WORKER_NAME}" 2>&1 | tail -5 || true

# 2. Delete R2 objects under pr-<N>/. R2 doesn't have a recursive delete;
#    list + chunked delete. Defensive: wrangler r2 object list with --json
#    can emit non-JSON output on error (auth failures, ratelimit, etc.) —
#    we treat anything unparseable as "nothing to delete here" and break.
echo "[pr-db-cleanup] purging R2 keys under ${R2_BUCKET}/${R2_PREFIX}"
cursor=""
deleted=0
while :; do
  args=(--prefix "${R2_PREFIX}")
  [ -n "${cursor}" ] && args+=(--cursor "${cursor}")
  page="$(npx wrangler r2 object list "${R2_BUCKET}" --json "${args[@]}" 2>/dev/null || echo '{"objects":[]}')"
  parsed="$(echo "${page}" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('__INVALID__')
    sys.exit(0)
keys = [o.get('key', '') for o in d.get('objects', [])]
cursor = d.get('cursor', '') if d.get('truncated') else ''
print('__CURSOR__:' + cursor)
for k in keys: print(k)
")"
  if echo "${parsed}" | head -1 | grep -q '__INVALID__'; then
    echo "[pr-db-cleanup]   skip R2 (list returned non-JSON — likely no bucket access or already empty)"
    break
  fi
  cursor="$(echo "${parsed}" | head -1 | sed 's|^__CURSOR__:||')"
  keys="$(echo "${parsed}" | tail -n +2)"
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
