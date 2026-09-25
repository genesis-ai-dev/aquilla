-- 0105_notnull_cell_validators_lane_id.sql — AQU-1240 cutover (PR2, POST-BACKFILL).
-- Enforce lane_id NOT NULL via the zero-downtime validated-CHECK pattern.
-- Requires backfill complete + 0103 FK validated. See 0104 for full rationale.
-- Idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.cell_validators'::regclass
       AND attname = 'lane_id'
       AND NOT attnotnull
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'cell_validators_lane_id_nn'
         AND conrelid = 'public.cell_validators'::regclass
    ) THEN
      ALTER TABLE public.cell_validators
        ADD CONSTRAINT cell_validators_lane_id_nn CHECK (lane_id IS NOT NULL) NOT VALID;
    END IF;
    ALTER TABLE public.cell_validators VALIDATE CONSTRAINT cell_validators_lane_id_nn;
    ALTER TABLE public.cell_validators ALTER COLUMN lane_id SET NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cell_validators_lane_id_nn'
       AND conrelid = 'public.cell_validators'::regclass
  ) THEN
    ALTER TABLE public.cell_validators DROP CONSTRAINT cell_validators_lane_id_nn;
  END IF;
END $$;
