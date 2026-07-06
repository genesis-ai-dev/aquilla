-- 0050_live_source_links.sql
--
-- FRO-476: live source links — mirror engine + deterministic staleness.
-- See docs/superpowers/specs/2026-07-06-linked-projects-provenance-invalidation-design.md
-- §2, §4 for the full design.
--
-- SWARM-TODO(FRO-476): NOT yet applied to any live Neon branch (dev/staging/
-- prod). Apply by hand per auth-worker/wrangler.toml's documented procedure:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/schema.sql
-- (schema.sql already carries these columns — see the `projects`/`cells`
-- table definitions — so applying schema.sql end-to-end picks this up.)
-- Verify: `SELECT source_link_mode, source_link_cursor FROM projects LIMIT 1;`
-- and `SELECT upstream_event_id, tombstoned_at FROM cells LIMIT 1;` should
-- both resolve without a missing-column error on the target Neon branch.
--
-- Link metadata (v1: columns on `projects`, beside `source_project_id`).
-- `source_link_mode` distinguishes a one-time snapshot (`clone`, today's
-- detach-snapshot behavior applied at birth) from a subscribed link
-- (`live`, this issue's mirror sync). NULL means legacy/self-contained —
-- existing linked projects predating this migration behave as `clone`
-- (no mirror sync runs) until explicitly re-linked.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_link_mode     TEXT;   -- 'clone' | 'live'
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_link_consumes TEXT;   -- 'source' | 'target' (null = 'source')
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_link_gate     TEXT;   -- 'head' | 'validated' (target-consumption only)
-- Max upstream server_seq (lane-relevant) this project has mirrored. The
-- deterministic "how far behind am I" marker — see link-sync.ts.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_link_cursor   BIGINT NOT NULL DEFAULT 0;

-- Mirror provenance on cells. A mirrored source cell records the upstream
-- event it currently reflects (`upstream_event_id`/`upstream_seq`, the
-- monotonic apply-guard key) and, if the upstream deleted it, when the
-- downstream tombstoned it (never actually deleted — see §5).
ALTER TABLE cells ADD COLUMN IF NOT EXISTS upstream_event_id TEXT;
ALTER TABLE cells ADD COLUMN IF NOT EXISTS upstream_seq      BIGINT;
ALTER TABLE cells ADD COLUMN IF NOT EXISTS tombstoned_at     BIGINT;

CREATE INDEX IF NOT EXISTS idx_cells_upstream_event ON cells(upstream_event_id)
  WHERE upstream_event_id IS NOT NULL;
