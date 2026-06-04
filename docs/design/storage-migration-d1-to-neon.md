# Storage Migration: D1 → Neon (Postgres)

**Status:** Stage A complete (schema live on Neon) · **Prereq reading:** `.claude/skills/d1-performance/SKILL.md`, `docs/design/storage-scaling-d1-vs-postgres-r2.md` (cost analysis)

## Decision
Move the database from Cloudflare D1 to managed Postgres (Neon), accessed from
Workers via Cloudflare Hyperdrive. Boring, mature infrastructure over a clever
Cloudflare-native alternative (per-org Durable Object SQLite). Rationale: D1's
10 GB ceiling is hit (the migration filled the prod DB); Postgres removes the
ceiling entirely, keeps all data in one queryable place (org-scoped dashboards,
cross-project reads, the legacy import are plain SQL), and avoids hand-building a
custom rollup/reconcile/shard-routing layer during a high-stakes window.

Neon project: **Aquilla** (`sweet-paper-88472094`, org Frontier R&D, Postgres 18,
us-east-2, autoscale 0.25–2 CU). Creds in `.env` (`NEON_PG_HOST/DB/ROLE/PASSWORD`,
`NEON_PG_POOLER_HOST`).

## Phase 1 — Move to Postgres (in progress, one moving part at a time)

### Stage A — schema port ✅ DONE
- Full D1 schema (33 tables) ported to `db/postgres/schema.sql` and applied to Neon
  (**26 app tables + 85 indexes**; D1-internal `_cf_KV`/`d1_migrations` and FTS5
  shadow tables excluded).
- **FTS5 → Postgres native:** `cells.value_tsv tsvector GENERATED ALWAYS AS
  to_tsvector('simple', value) STORED` + GIN index `idx_cells_value_tsv`. `'simple'`
  config (no stemming) because the corpus is multilingual. The 3 FTS5 sync triggers
  are gone — the generated column self-maintains. Verified: column generated, GIN
  present, `@@ websearch_to_tsquery` matches.
- Translation rules + omitted-FK rationale documented in the schema file header.
- Helper: `scripts/pg.ts` (`pg` client, direct host, TLS-verified) runs `.sql` files
  or inline SQL against Neon.

### Stage B — worker data-access adaptation (NEXT, the big one)
Both auth-worker and sync-worker speak the D1 binding API (`prepare().bind().run()/
all()/first()`, `batch()`) and D1 SQL dialect. Adapt to Postgres-via-Hyperdrive.
- Approach: a thin **D1-compatible shim** over a PG driver — translate `?`→`$n`
  placeholders, present `.bind().run()/all()/first()`/`.batch()`. Plain queries pass
  through; only dialect-specific ones get edited:
  - `INSERT OR IGNORE` → `INSERT … ON CONFLICT DO NOTHING`
  - FTS `… MATCH ?` / `cells_fts` joins → `value_tsv @@ websearch_to_tsquery('simple', $1)`, rank via `ts_rank`
  - `json_extract`/SQLite funcs, `unixepoch()`, the correlated `MAX(server_seq)+1` (works as-is)
- Verify FTS **search parity** vs current FTS5 behaviour before flipping reads.
- Driver: Hyperdrive presents a PG TCP endpoint → use `postgres`/`pg` in the worker
  with the Hyperdrive connection string (not `@neondatabase/serverless`, which is HTTP-direct).

### Stage C — data migration into Neon (IN PROGRESS — re-import from source, defer projections)
Revised per direction: don't copy the degraded D1; re-import fresh from the real
sources, raw data only, projections built once at the end.
- **Step 1 — identity/org layer ✅** copied D1→Neon as-is (small + already correct):
  `scripts/pg-copy-base.ts` → users 1121, organizations 48, groups 225, org_members
  508, group_members 652. ON CONFLICT DO NOTHING; identity sequences reset.
- **Step 2 — content (events only) ✅ built, canary-verified:** `scripts/pg-import-content.ts`
  re-imports projects+files+events from GitLab into Postgres, **deferring every
  projection** (cells/files/validators/counters/FTS). Writes only `projects` +
  `group_project_grants` + `events`. Canary (8 heaviest projects): **333,688 events
  in 48.5s = 6,884 events/s (~34× the D1 ~200/s)** — and most of that is GitLab
  clone/parse, not the DB. cells stayed 0 (deferred confirmed).
  - TODO: run the full sweep (all ~436 projects) — `npx tsx scripts/pg-import-content.ts`.
- **Step 3 — build projections (TODO):** set-based from events — cells (final state
  per cell), cell_validators, file counters. Then verify parity vs D1 (counts +
  health-score outputs) before any cutover.

### Stage D — Hyperdrive + cutover
- Provision Hyperdrive in front of Neon; bind to both workers; flip reads → writes.
- **Unblocks finishing the legacy GitLab import** — remaining projects import into
  Postgres normally (no 10 GB ceiling, concurrent writers, COPY-fast).

## Phase 2 — Offload event log to R2 cold storage (LATER, explicit go-ahead only)
Do NOT start until Phase 1 is complete and stable. Event log is append-only; the live
read path is the Postgres projection, so old events don't need the hot DB.
- **Key the archive on the server sequence (monotonic, immutable), NOT org_id** (org
  membership is mutable; projects move between orgs).
- Path-addressed R2 (`events/{projectId}/{fileId}.jsonl` or `.../{cellId}/`) so
  by-ID history is a direct GET. Keep a recent hot-tail in Postgres; age out the rest.
- No data lost by deferring — truncate Postgres `events` to the hot tail only once R2
  is the system of record.

## Explicit non-goals
- No per-org Durable Object database architecture (documented fallback only).
- No custom rollup / projection-reconcile layer.
- No event-log changes in Phase 1.
