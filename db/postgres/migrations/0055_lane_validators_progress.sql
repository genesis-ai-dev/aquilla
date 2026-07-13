-- 0055_lane_validators_progress.sql
--
-- AQU-538: TMS-style project data model, slice 2 — carry the target-language
-- lane into the per-cell validator records and the per-file/section progress
-- rollups. See docs/superpowers/specs/2026-07-11-project-data-model-decision.md
-- and migration 0054 (the lane dimension on `cells`).
--
-- A user's standing validation is per-lane: validating a cell in lane A must
-- not touch lane B's validated flag, and the same user may hold validations on
-- two lanes of one cell. `file_section_progress` likewise materializes one row
-- per lane so progress bars read per-lane. `target_lang = ''` is the
-- legacy/default lane, so every existing row and every event that doesn't carry
-- a `targetLang` keeps byte-identical behavior (N=1 back-compat, no flag-day).
--
-- NOT applied automatically to live Neon branches. Apply by hand per
-- auth-worker/wrangler.toml's documented procedure:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0055_lane_validators_progress.sql
-- (Fresh databases pick this up from schema.sql; the dev-stack reconcile
-- also performs this exact upgrade on drifted local containers — see
-- scripts/dev-stack.ts reconcilePgSchema.)
-- Verify: `SELECT target_lang FROM cell_validators LIMIT 1;` resolves, and the
--   primary keys of cell_validators and file_section_progress both list
--   target_lang (query pg_index/pg_attribute as in migration 0054).

-- ── cell_validators: standing validation is per-lane ──────────────────────
ALTER TABLE cell_validators ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT '';

-- Rebuild the PK to include the lane. Existing rows all carry '' so the new
-- 5-column key is trivially unique. Idempotent: skipped when the PK already
-- contains target_lang.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'cell_validators'::regclass
      AND i.indisprimary
      AND a.attname = 'target_lang'
  ) THEN
    ALTER TABLE cell_validators DROP CONSTRAINT cell_validators_pkey;
    ALTER TABLE cell_validators ADD PRIMARY KEY (project_id, file_id, cell_id, target_lang, username);
  END IF;
END $$;

-- ── file_section_progress: one rollup row per lane ────────────────────────
ALTER TABLE file_section_progress ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT '';

-- Rebuild the PK to include the lane. Existing rows all carry '' so the new
-- 5-column key is trivially unique. Idempotent: skipped when the PK already
-- contains target_lang.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'file_section_progress'::regclass
      AND i.indisprimary
      AND a.attname = 'target_lang'
  ) THEN
    ALTER TABLE file_section_progress DROP CONSTRAINT file_section_progress_pkey;
    ALTER TABLE file_section_progress ADD PRIMARY KEY (project_id, file_id, scope, section_key, target_lang);
  END IF;
END $$;
