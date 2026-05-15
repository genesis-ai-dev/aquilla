#!/usr/bin/env bash
# Nightly reset of aquilla-db-staging — the shared dev D1 that per-PR
# preview workers fall back to when their PR didn't fork.
#
# CF D1 doesn't expose a "drop database" primitive that preserves the
# binding id, so this script drops every user table inside the DB
# (leaving sqlite internals + cf internals alone), then reapplies every
# migration from `apps/*/migrations/` in name order, then `seed.sql`.
#
# Behavior is idempotent: a failed reset (e.g. a malformed migration)
# leaves the DB in whatever state it reached. The next run will try to
# drop tables that no longer exist and apply migrations that already
# applied — both `DROP TABLE IF EXISTS` and `CREATE TABLE IF NOT EXISTS`
# patterns make this safe.
#
# Usage:
#   CLOUDFLARE_ACCOUNT_ID=... ./scripts/nightly-dev-reset.sh
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?need CLOUDFLARE_ACCOUNT_ID}"

DB_NAME="aquilla-db-staging"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[nightly-dev-reset] target=${DB_NAME}"

# 1. Enumerate user tables. Skip sqlite internals, CF internals, FTS
#    shadow tables, and d1_migrations (CF rewrites that automatically).
TABLES="$(npx wrangler d1 execute "${DB_NAME}" --remote --json --command "
SELECT name FROM sqlite_master
WHERE type='table'
  AND name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '_cf_%'
  AND name NOT IN ('d1_migrations',
                   'cells_fts_data', 'cells_fts_idx',
                   'cells_fts_docsize', 'cells_fts_config')
" | python3 -c "
import json, sys
rows = json.load(sys.stdin)[0]['results']
for r in rows: print(r['name'])
")"

if [ -n "${TABLES}" ]; then
  echo "[nightly-dev-reset] dropping $(echo "${TABLES}" | wc -l | tr -d ' ') user tables"
  DROP_SQL=""
  while IFS= read -r t; do
    [ -z "${t}" ] && continue
    DROP_SQL+="DROP TABLE IF EXISTS \"${t}\";"$'\n'
  done <<< "${TABLES}"
  npx wrangler d1 execute "${DB_NAME}" --remote --command "${DROP_SQL}" >/dev/null
else
  echo "[nightly-dev-reset] DB is already empty"
fi

# 2. Apply every migration under apps/*/migrations/ in sorted order.
#    Sort is name-based; the convention is 4-digit-prefix filenames
#    (0001_initial.sql, 0002_events_ad2.sql, ...). Cross-app migrations
#    interleave by prefix — fine as long as the prefixes are unique
#    across the monorepo (they currently are; if two apps ever ship the
#    same prefix, this needs revisiting).
echo "[nightly-dev-reset] applying migrations"
mapfile -t MIGS < <(find "${REPO_ROOT}/apps" -path '*/migrations/*.sql' | sort)
for m in "${MIGS[@]}"; do
  rel="${m#${REPO_ROOT}/}"
  echo "[nightly-dev-reset]   - ${rel}"
  npx wrangler d1 execute "${DB_NAME}" --remote --file="${m}" >/dev/null
done

# 3. Seed the canonical test cast.
if [ -f "${REPO_ROOT}/seed.sql" ]; then
  echo "[nightly-dev-reset] applying seed.sql"
  npx wrangler d1 execute "${DB_NAME}" --remote --file="${REPO_ROOT}/seed.sql" >/dev/null
else
  echo "[nightly-dev-reset] no seed.sql at repo root — skipping"
fi

echo "[nightly-dev-reset] done"
