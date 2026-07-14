-- 0057_cells_target_lang.sql
--
-- AQU-538: TMS-style project data model, slice 1 — the target-language lane
-- dimension on `cells`. See
-- docs/superpowers/specs/2026-07-11-project-data-model-decision.md.
--
-- A project's target side becomes N lanes fanning out from one shared source.
-- `target_lang = ''` is the legacy/default lane (the file's single configured
-- targetLanguage), so every existing row and every event that doesn't carry a
-- `targetLang` keeps byte-identical behavior (N=1 back-compat, no flag-day).
-- Source-side rows are ALWAYS '' — the source exists once, shared by lanes.
--
-- EXPAND / CONTRACT (backward-compatible split — see the companion contract
-- migration 0061_cells_lane_pk.sql). This file is the EXPAND half and is SAFE
-- to run while the OLD, pre-lane workers are still serving:
--   * ADD COLUMN uses a constant DEFAULT '' → Postgres 11+ records it as
--     catalog metadata only (no table rewrite, instant even on a huge `cells`).
--   * It builds the 5-column unique index `cells_pkey5` but does NOT drop the
--     old 4-column PK. Both are valid ON CONFLICT arbiters at once, so the
--     deployed code's `ON CONFLICT(project_id,file_id,cell_id,side)` and the new
--     code's `ON CONFLICT(...,target_lang)` both work during the transition.
-- The primary key is promoted to the 5-column form only later, by 0061, after
-- the new workers are live — the one step that must not overlap old code.
--
-- NOT applied automatically to live Neon branches. Apply by hand per
-- auth-worker/wrangler.toml's documented procedure:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0057_cells_target_lang.sql
-- On a LARGE / production `cells`, build the index CONCURRENTLY first via the
-- zero-downtime runbook (docs/runbooks/2026-07-14-aqu538-neon-main-rollout.md);
-- the guarded CREATE below then no-ops (IF NOT EXISTS). Fresh databases pick the
-- final 5-col PK up from schema.sql, so the guard skips the redundant index.
-- Verify: `SELECT target_lang FROM cells LIMIT 1;` resolves.

ALTER TABLE cells ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT '';

-- Build the 5-column unique index alongside the existing 4-column PK. Skipped
-- when the PK already carries target_lang (fresh DB from schema.sql, or after
-- 0061 has run). IF NOT EXISTS makes it a no-op when the runbook pre-built the
-- index CONCURRENTLY.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'cells'::regclass
      AND i.indisprimary
      AND a.attname = 'target_lang'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS cells_pkey5
      ON cells (project_id, file_id, cell_id, side, target_lang);
  END IF;
END $$;
