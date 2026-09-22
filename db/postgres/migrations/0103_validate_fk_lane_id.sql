-- 0103_validate_fk_lane_id.sql — AQU-1240 cutover (PR2, POST-BACKFILL), step 1/2.
--
-- Flip every composite lane_id FK from NOT VALID (added in 0102) to VALIDATED.
-- VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE: it scans the table to
-- prove every existing (project_id, lane_id) points at a real lane, but does NOT
-- block concurrent reads or writes. A composite FK with a NULL member is exempt
-- (MATCH SIMPLE), so this is safe to run even if some lane_id are still NULL —
-- it proves referential integrity independently of the NOT NULL cutover, which
-- lives in the per-table 0104–0111 migrations.
--
-- Idempotent: skips any constraint already validated. Runs all 8 in one file;
-- each VALIDATE is quick relative to a full rewrite and holds only a shared lock.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cells', 'cell_validators', 'file_section_progress', 'assignments',
    'artifact_bindings', 'scene_briefs', 'contextual_runs', 'contextual_drafts'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = t || '_lane_id_fkey'
         AND conrelid = ('public.' || t)::regclass
         AND NOT convalidated
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
        t, t || '_lane_id_fkey'
      );
    END IF;
  END LOOP;
END $$;
