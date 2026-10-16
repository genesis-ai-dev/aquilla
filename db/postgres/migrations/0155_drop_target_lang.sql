-- 0155_drop_target_lang.sql — AQU-1611c
--
-- Writers stopped filling projection `target_lang` in the previous release
-- (AQU-1611b). Lane identity is `lane_id`. This drops the column from the
-- eight projection tables:
--
--   cells, cell_validators, file_section_progress, assignments,
--   artifact_bindings, scene_briefs, contextual_runs, contextual_drafts
--
-- `events.payload` is not rewritten. `lanes` rows are not deleted.
-- `lanes.legacy_tag` is not changed, including the empty-string bridge.
--
-- Dependents that still name the column after 0154, so the DROP would fail
-- without this:
--   * `artifact_bindings` UNIQUE (artifact_id, file_id, binding_role,
--     target_lang, member_path) from 0066. The lane-keyed unique
--     `artifact_bindings_lane_member_key` (0134) stays.
--   * any leftover index on these tables whose keys still include the
--     column. Indexes rebuilt on `lane_id` by 0151 and 0154 do not, and
--     this file does not drop them.
--
-- A primary key that still includes the column means 0114 did not run.
-- This migration refuses that rather than dropping the key.
--
-- No CREATE INDEX. No CREATE INDEX CONCURRENTLY.
--
-- Idempotent. A database loaded from schema.sql (columns already absent)
-- is unchanged.
--
-- scripts/neon-backfill-lanes.ts and scripts/neon-backfill-lane-batch.ts
-- (AQU-1616) still read these columns. They are the backfills that run
-- BEFORE this migration and cannot run after it: run the lane-batch
-- backfill with --apply before `neon:apply`, which applies 0155 and 0156
-- in filename order.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.contype, c.conrelid::regclass AS tbl
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid IN (
         'public.cells'::regclass,
         'public.cell_validators'::regclass,
         'public.file_section_progress'::regclass,
         'public.assignments'::regclass,
         'public.artifact_bindings'::regclass,
         'public.scene_briefs'::regclass,
         'public.contextual_runs'::regclass,
         'public.contextual_drafts'::regclass
       )
       AND a.attname = 'target_lang'
       AND c.contype IN ('u', 'p')
  LOOP
    IF r.contype = 'p' THEN
      RAISE EXCEPTION
        '0155: %.% primary key still includes target_lang; run 0114 first',
        r.tbl, r.conname;
    END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;

  FOR r IN
    SELECT n.nspname AS schemaname, ic.relname AS indexname
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
     WHERE n.nspname = 'public'
       AND t.relname IN (
         'cells', 'cell_validators', 'file_section_progress', 'assignments',
         'artifact_bindings', 'scene_briefs', 'contextual_runs', 'contextual_drafts'
       )
       AND a.attname = 'target_lang'
       AND NOT i.indisprimary
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid
       )
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', r.schemaname, r.indexname);
  END LOOP;
END $$;

ALTER TABLE public.cells DROP COLUMN IF EXISTS target_lang;
ALTER TABLE public.cell_validators DROP COLUMN IF EXISTS target_lang;
ALTER TABLE public.file_section_progress DROP COLUMN IF EXISTS target_lang;
ALTER TABLE public.assignments DROP COLUMN IF EXISTS target_lang;
ALTER TABLE public.artifact_bindings DROP COLUMN IF EXISTS target_lang;
ALTER TABLE public.scene_briefs DROP COLUMN IF EXISTS target_lang;
ALTER TABLE public.contextual_runs DROP COLUMN IF EXISTS target_lang;
ALTER TABLE public.contextual_drafts DROP COLUMN IF EXISTS target_lang;
