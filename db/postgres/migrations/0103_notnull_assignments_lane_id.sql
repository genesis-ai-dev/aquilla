-- 0103_notnull_assignments_lane_id.sql — AQU-1240 cutover (PR2, POST-BACKFILL).
-- Enforce lane_id NOT NULL via the zero-downtime validated-CHECK pattern.
-- Requires backfill complete + 0099 FK validated. See 0100 for full rationale.
-- Idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.assignments'::regclass
       AND attname = 'lane_id'
       AND NOT attnotnull
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'assignments_lane_id_nn'
         AND conrelid = 'public.assignments'::regclass
    ) THEN
      ALTER TABLE public.assignments
        ADD CONSTRAINT assignments_lane_id_nn CHECK (lane_id IS NOT NULL) NOT VALID;
    END IF;
    ALTER TABLE public.assignments VALIDATE CONSTRAINT assignments_lane_id_nn;
    ALTER TABLE public.assignments ALTER COLUMN lane_id SET NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'assignments_lane_id_nn'
       AND conrelid = 'public.assignments'::regclass
  ) THEN
    ALTER TABLE public.assignments DROP CONSTRAINT assignments_lane_id_nn;
  END IF;
END $$;
