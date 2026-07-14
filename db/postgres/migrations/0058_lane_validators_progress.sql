-- 0058_lane_validators_progress.sql
--
-- AQU-538: TMS-style project data model, slice 2 — carry the target-language
-- lane into the per-cell validator records and the per-file/section progress
-- rollups. See docs/superpowers/specs/2026-07-11-project-data-model-decision.md
-- and migration 0057 (the lane dimension on `cells`).
--
-- A user's standing validation is per-lane: validating a cell in lane A must
-- not touch lane B's validated flag, and the same user may hold validations on
-- two lanes of one cell. `file_section_progress` likewise materializes one row
-- per lane so progress bars read per-lane. `target_lang = ''` is the
-- legacy/default lane, so every existing row and every event that doesn't carry
-- a `targetLang` keeps byte-identical behavior (N=1 back-compat, no flag-day).
--
-- EXPAND / CONTRACT (backward-compatible split — see the companion contract
-- migration 0062_lane_validators_progress_pk.sql). This file is the EXPAND half
-- and is SAFE while the OLD, pre-lane workers still serve: the ADD COLUMNs are
-- metadata-only (constant DEFAULT ''), and it builds the 5-column unique indexes
-- WITHOUT dropping the old 4-column PKs. Both arbiters stay valid, so old-code
-- `ON CONFLICT(...username)` / `ON CONFLICT(...section_key)` and new-code
-- `ON CONFLICT(...,target_lang)` both work during the transition. The PKs are
-- promoted to the 5-column form only later, by 0062, after the new workers are
-- live.
--
-- NOT applied automatically to live Neon branches. Apply by hand per
-- auth-worker/wrangler.toml's documented procedure:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0058_lane_validators_progress.sql
-- On LARGE / production tables, build the indexes CONCURRENTLY first via the
-- zero-downtime runbook (docs/runbooks/2026-07-14-aqu538-neon-main-rollout.md);
-- the guarded CREATEs below then no-op. Fresh databases pick the final 5-col PKs
-- up from schema.sql, so the guards skip the redundant indexes.
-- Verify: `SELECT target_lang FROM cell_validators LIMIT 1;` resolves.

-- ── cell_validators: standing validation is per-lane ──────────────────────
ALTER TABLE cell_validators ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT '';

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
    CREATE UNIQUE INDEX IF NOT EXISTS cell_validators_pkey5
      ON cell_validators (project_id, file_id, cell_id, target_lang, username);
  END IF;
END $$;

-- ── file_section_progress: one rollup row per lane ────────────────────────
ALTER TABLE file_section_progress ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT '';

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
    CREATE UNIQUE INDEX IF NOT EXISTS file_section_progress_pkey5
      ON file_section_progress (project_id, file_id, scope, section_key, target_lang);
  END IF;
END $$;
