-- 0129_artifact_bindings_drop_target_lang.sql — AQU-1611 (table group: artifact_bindings).
--
-- artifact_bindings.lane_id became the row's identity in AQU-1240 and was made
-- NOT NULL by 0108, which only validates once the lane backfill has left zero
-- NULLs. Migrations apply in order, so by the time this runs every binding
-- already carries its lane and `target_lang` is a duplicate of
-- lanes.legacy_tag — the lane row keeps the tag forever, so nothing is lost.
--
-- Order matters: the lane-keyed UNIQUE is created BEFORE the tag-keyed one is
-- dropped, so the table is never without its uniqueness guarantee. Within one
-- artifact the project is fixed (the composite FK to artifacts), and
-- lanes.legacy_tag is unique per project, so target_lang -> lane_id is 1:1 and
-- the new constraint cannot collide. If it does, that is real duplicate data:
-- the ADD CONSTRAINT fails loudly rather than silently collapsing rows —
-- resolve the duplicates, do not force it.
--
-- Idempotent: re-running after the column is gone is a no-op.
DO $$
DECLARE
  v_con text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.artifact_bindings'::regclass
       AND attname = 'target_lang'
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'artifact_bindings_lane_member_key'
       AND conrelid = 'public.artifact_bindings'::regclass
  ) THEN
    ALTER TABLE public.artifact_bindings
      ADD CONSTRAINT artifact_bindings_lane_member_key
      UNIQUE (artifact_id, file_id, binding_role, lane_id, member_path);
  END IF;

  FOR v_con IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.artifact_bindings'::regclass
       AND c.contype = 'u'
       AND EXISTS (
         SELECT 1 FROM unnest(c.conkey) AS k
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = k
          WHERE a.attname = 'target_lang'
       )
  LOOP
    EXECUTE format('ALTER TABLE public.artifact_bindings DROP CONSTRAINT %I', v_con);
  END LOOP;

  ALTER TABLE public.artifact_bindings DROP COLUMN target_lang;
END $$;
