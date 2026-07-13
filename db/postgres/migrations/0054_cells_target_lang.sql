-- 0054_cells_target_lang.sql
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
-- The PK gains the lane so two lanes' target rows for the same cell coexist:
--   (project_id, file_id, cell_id, side)  →  (…, side, target_lang)
--
-- NOT applied automatically to live Neon branches. Apply by hand per
-- auth-worker/wrangler.toml's documented procedure:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0054_cells_target_lang.sql
-- (Fresh databases pick this up from schema.sql; the dev-stack reconcile
-- also performs this exact upgrade on drifted local containers — see
-- scripts/dev-stack.ts reconcilePgSchema.)
-- Verify: `SELECT target_lang FROM cells LIMIT 1;` resolves, and
--   SELECT a.attname FROM pg_index i
--   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
--   WHERE i.indrelid = 'cells'::regclass AND i.indisprimary;
-- lists target_lang.

ALTER TABLE cells ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT '';

-- Rebuild the PK to include the lane. Existing rows all carry '' so the new
-- 5-column key is trivially unique. Idempotent: skipped when the PK already
-- contains target_lang.
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
    ALTER TABLE cells DROP CONSTRAINT cells_pkey;
    ALTER TABLE cells ADD PRIMARY KEY (project_id, file_id, cell_id, side, target_lang);
  END IF;
END $$;
