-- 0102_notnull_file_section_progress_lane_id.sql — AQU-1240 cutover (PR2, POST-BACKFILL).
-- Enforce lane_id NOT NULL via the zero-downtime validated-CHECK pattern.
-- Requires backfill complete + 0099 FK validated. See 0100 for full rationale.
-- Idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.file_section_progress'::regclass
       AND attname = 'lane_id'
       AND NOT attnotnull
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'file_section_progress_lane_id_nn'
         AND conrelid = 'public.file_section_progress'::regclass
    ) THEN
      ALTER TABLE public.file_section_progress
        ADD CONSTRAINT file_section_progress_lane_id_nn CHECK (lane_id IS NOT NULL) NOT VALID;
    END IF;
    ALTER TABLE public.file_section_progress VALIDATE CONSTRAINT file_section_progress_lane_id_nn;
    ALTER TABLE public.file_section_progress ALTER COLUMN lane_id SET NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'file_section_progress_lane_id_nn'
       AND conrelid = 'public.file_section_progress'::regclass
  ) THEN
    ALTER TABLE public.file_section_progress DROP CONSTRAINT file_section_progress_lane_id_nn;
  END IF;
END $$;
