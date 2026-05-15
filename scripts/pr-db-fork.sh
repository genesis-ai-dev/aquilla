#!/usr/bin/env bash
# Per-PR D1 fork + sync-worker variant deploy.
#
# Provisions (idempotent):
#   1. D1 `aquilla-pr-<N>` — mirrors aquilla-db-staging's schema, plus any
#      new migrations from the PR applied on top. The fork NEVER reads
#      from prod aquilla-db; staging is kept in lockstep with prod schema
#      separately (apply prod migrations to staging when they ship).
#   2. Worker `aquilla-sync-worker-pr-<N>` — points at the new D1, shares
#      aquilla-snapshots-staging via R2_KEY_PREFIX=pr-<N>.
#
# Triggered when any `apps/*/migrations/**.sql` changes (spec
# §"Preview databases (Tier 2)" — single D1 per PR, shared across all
# apps that need persistence).
#
# Usage:
#   PR_NUMBER=43 CLOUDFLARE_ACCOUNT_ID=... ./scripts/pr-db-fork.sh
#
# Optional env:
#   MIGRATION_GLOB — glob of new SQL files in this PR to apply after
#     the staging schema mirror. Defaults to detecting added/modified
#     files under apps/*/migrations/ via git diff.
set -euo pipefail

: "${PR_NUMBER:?need PR_NUMBER}"
: "${CLOUDFLARE_ACCOUNT_ID:?need CLOUDFLARE_ACCOUNT_ID}"

DB_NAME="aquilla-pr-${PR_NUMBER}"
WORKER_NAME="aquilla-sync-worker-pr-${PR_NUMBER}"
# Source schema from staging, NEVER from prod. The CI workflow that runs
# this script must not read prod data under any circumstance — staging
# is kept in lockstep with prod's schema (apply prod migrations to
# staging too), and PR forks branch off staging.
SOURCE_DB="aquilla-db-staging"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${REPO_ROOT}/apps/sync/wrangler.pr.toml.tpl"
# Render the per-PR wrangler config INSIDE apps/sync/ so wrangler resolves
# `main = "src/index.ts"` relative to the worker dir (not /tmp). Suffix the
# PR number so concurrent fork runs don't stomp each other.
OUT_TOML="${REPO_ROOT}/apps/sync/wrangler.pr-${PR_NUMBER}.toml"
trap 'rm -f "${OUT_TOML}"' EXIT

echo "[pr-db-fork] PR=${PR_NUMBER} db=${DB_NAME} worker=${WORKER_NAME}"

# 1. Create the D1 if it doesn't exist. wrangler exits non-zero on duplicate;
#    we tolerate that and proceed to fetch the ID either way.
if npx wrangler d1 list --json | python3 -c "
import json, sys
name = sys.argv[1]
for db in json.load(sys.stdin):
    if db['name'] == name:
        sys.exit(0)
sys.exit(1)
" "${DB_NAME}"; then
  echo "[pr-db-fork] D1 ${DB_NAME} exists, skipping create"
else
  echo "[pr-db-fork] creating D1 ${DB_NAME}"
  npx wrangler d1 create "${DB_NAME}" >/dev/null
fi

DB_ID="$(npx wrangler d1 list --json | python3 -c "
import json, sys
name = sys.argv[1]
for db in json.load(sys.stdin):
    if db['name'] == name:
        print(db['uuid']); break
" "${DB_NAME}")"
if [ -z "${DB_ID}" ]; then
  echo "[pr-db-fork] ERROR: failed to resolve D1 id for ${DB_NAME}" >&2
  exit 1
fi
echo "[pr-db-fork] DB_ID=${DB_ID}"

# 2. Mirror prod schema (read-only on prod). Idempotent: re-applying
#    `CREATE TABLE IF NOT EXISTS` and friends is safe. We filter out CF
#    internals + FTS shadow tables + sqlite_sequence so apply doesn't error.
echo "[pr-db-fork] mirroring schema from ${SOURCE_DB}"
SCHEMA_FILE="$(mktemp -t "codex-schema-XXXXXX.sql")"
trap 'rm -f "${OUT_TOML}" "${SCHEMA_FILE}"' EXIT
npx wrangler d1 execute "${SOURCE_DB}" --remote --json --command "
SELECT name, sql FROM sqlite_master
WHERE type IN ('table','index','trigger','view') AND sql IS NOT NULL
ORDER BY type, name
" | python3 -c "
import json, sys
rows = json.load(sys.stdin)[0]['results']
SKIP = {'_cf_KV', 'sqlite_sequence', 'd1_migrations',
        'cells_fts_data', 'cells_fts_idx', 'cells_fts_docsize', 'cells_fts_config'}
groups = {'TABLE': [], 'VIRTUAL': [], 'INDEX': [], 'TRIGGER': []}
for r in rows:
    if r['name'] in SKIP: continue
    s = r['sql'].strip()
    u = s.upper()
    if u.startswith('CREATE VIRTUAL TABLE'): groups['VIRTUAL'].append(s)
    elif u.startswith('CREATE TABLE'): groups['TABLE'].append(s)
    elif u.startswith('CREATE TRIGGER'): groups['TRIGGER'].append(s)
    elif u.startswith('CREATE INDEX') or u.startswith('CREATE UNIQUE INDEX'): groups['INDEX'].append(s)
for key in ('TABLE','VIRTUAL','INDEX','TRIGGER'):
    for s in groups[key]: print(s.rstrip(';') + ';')
" > "${SCHEMA_FILE}"

# Apply only when the fork is empty. After the first apply, subsequent
# PR-sync runs skip this step so we don't fight migrations the PR added.
table_count="$(npx wrangler d1 execute "${DB_NAME}" --remote --json --command "
SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
" | python3 -c "
import json, sys
d = json.load(sys.stdin)[0]['results'][0]
print(d.get('c', 0))")"
if [ "${table_count}" = "0" ]; then
  echo "[pr-db-fork] applying staging schema (fresh fork)"
  npx wrangler d1 execute "${DB_NAME}" --remote --file="${SCHEMA_FILE}" >/dev/null
else
  echo "[pr-db-fork] DB has ${table_count} tables, skipping schema mirror"
fi

# 3. Apply any new migrations from the PR. Default: every .sql added or
#    modified under apps/*/migrations/ between origin/dev and HEAD.
if [ -n "${MIGRATION_GLOB:-}" ]; then
  MIGS=$(ls ${MIGRATION_GLOB} 2>/dev/null || true)
else
  MIGS="$(git diff --name-only --diff-filter=AM origin/dev...HEAD | grep -E '^apps/[^/]+/migrations/.*\.sql$' || true)"
fi
if [ -n "${MIGS}" ]; then
  echo "[pr-db-fork] applying PR migrations:"
  for m in ${MIGS}; do
    echo "[pr-db-fork]   - ${m}"
    npx wrangler d1 execute "${DB_NAME}" --remote --file="${REPO_ROOT}/${m}" >/dev/null
  done
else
  echo "[pr-db-fork] no new migrations in this PR"
fi

# 4. Generate the per-PR wrangler.toml from the template + deploy the worker.
sed -e "s|__PR__|${PR_NUMBER}|g" \
    -e "s|__DB_ID__|${DB_ID}|g" \
    "${TEMPLATE}" > "${OUT_TOML}"
echo "[pr-db-fork] deploying worker ${WORKER_NAME}"
(cd "${REPO_ROOT}/apps/sync" && npx wrangler deploy --config "${OUT_TOML}")

WORKER_URL="https://${WORKER_NAME}.blue-darkness-7674.workers.dev"
echo "[pr-db-fork] done"
echo "::notice::PR ${PR_NUMBER} sync-worker deployed at ${WORKER_URL}"
echo "worker_url=${WORKER_URL}" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "db_name=${DB_NAME}" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "worker_name=${WORKER_NAME}" >> "${GITHUB_OUTPUT:-/dev/null}"
