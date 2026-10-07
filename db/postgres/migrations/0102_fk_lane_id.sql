-- AQU-1240 slice 8 (part 1): composite FK from every lane_id-bearing table to
-- lanes(project_id, id).
--
-- Added NOT VALID on purpose:
--   * NOT VALID is instant — Postgres takes a brief lock and does NOT scan the
--     table (critical for `cells`, which is huge on prod).
--   * A NOT VALID FK is STILL enforced against every NEW insert/update, so from
--     this migration on a bad (project_id, lane_id) pair is rejected at write
--     time. Only the one-time proof of pre-existing rows is skipped.
--   * Existing rows are all-NULL — lane_id was added empty in 0097 and is filled
--     lazily by the backfill (scripts/neon-backfill-lanes.ts). A composite FK
--     with a NULL member is exempt (MATCH SIMPLE), so the constraint already
--     holds on legacy data.
--   * Our writers only ever resolve lane_id via `SELECT id FROM lanes WHERE …`,
--     so a write can only ever produce a lane_id that exists in `lanes` (or
--     NULL) — the FK can never be violated by application code.
--
-- The full-scan `VALIDATE CONSTRAINT` (and `SET NOT NULL`) is deliberately
-- DEFERRED to the post-backfill cutover: it is only safe once every project's
-- lanes rows exist and the backfill has populated lane_id on all rows. Adding
-- NOT NULL here would break writes for any project not yet backfilled (dual-read
-- still covers reads). See the rollout runbook.
--
-- Idempotent: re-running skips constraints that already exist.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cells', 'cell_validators', 'file_section_progress', 'assignments',
    'artifact_bindings', 'scene_briefs', 'contextual_runs', 'contextual_drafts'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = t || '_lane_id_fkey'
         AND conrelid = ('public.' || t)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I '
        || 'FOREIGN KEY (project_id, lane_id) REFERENCES public.lanes (project_id, id) '
        || 'NOT VALID',
        t, t || '_lane_id_fkey'
      );
    END IF;
  END LOOP;
END $$;
