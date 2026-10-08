-- 0154_readers_lane_id_indexes.sql — AQU-1611, steps 1 and 2.
--
-- Readers of the projection tables now match `lane_id`. This migration moves
-- the one index those reads still needed on `target_lang`, and drops the
-- partial `lane_id` indexes from 0098–0101. Those were the dual-read indexes
-- from when `lane_id` was a nullable extra column. The primary keys (0114)
-- and `idx_cells_file_scan` now carry `lane_id`, so the partials are redundant.
--
-- Additive. `target_lang` stays on every table. Writers still fill it.
-- AQU-1611c (migration 0155) drops the columns, one release after writers stop.
--
-- Already on `lane_id`, and not repeated here:
--   * `artifact_bindings_lane_member_key` (0134, the expand step)
--   * `scene_briefs_live`, `contextual_runs_active`,
--     `contextual_runs_project_lane_time`, `contextual_drafts_live` (0151)
--
-- Do NOT put CREATE INDEX CONCURRENTLY in this file. The migration runner
-- sends the file as one query, and CONCURRENTLY cannot run in a transaction.
-- On production, Matthew runs the CONCURRENTLY statements in the PR body
-- first. After that script, every step below finds the work already done.
--
-- Idempotent. A database loaded from schema.sql (the index already on
-- lane_id, the partials already absent) is unchanged.

DO $$
DECLARE
  def text;
BEGIN
  SELECT indexdef INTO def
    FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'idx_cells_file_scan';

  -- Still the 0083 index: (project, file, side, target_lang, cell_id).
  IF def IS NOT NULL AND def LIKE '%target_lang%' THEN
    DROP INDEX public.idx_cells_file_scan;
    def := NULL;
  END IF;

  -- Staging name from the production CONCURRENTLY build.
  IF def IS NULL AND EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_cells_file_scan_lane'
  ) THEN
    ALTER INDEX public.idx_cells_file_scan_lane RENAME TO idx_cells_file_scan;
    def := 'lane_id';
  END IF;

  IF def IS NULL THEN
    CREATE INDEX idx_cells_file_scan
      ON public.cells (project_id, file_id, side, lane_id, cell_id);
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_cells_lane_id;
DROP INDEX IF EXISTS public.idx_cell_validators_lane_id;
DROP INDEX IF EXISTS public.idx_file_section_progress_lane_id;
DROP INDEX IF EXISTS public.idx_assignments_lane_id;
