-- 0100_notnull_cells_lane_id.sql — AQU-1240 cutover (PR2, POST-BACKFILL), step 2/2.
--
-- Enforce lane_id NOT NULL on cells with the zero-downtime pattern:
--   1. ADD a CHECK (lane_id IS NOT NULL) NOT VALID (instant, no scan).
--   2. VALIDATE it — SHARE UPDATE EXCLUSIVE scan that does NOT block reads/writes.
--   3. SET NOT NULL — Postgres 12+ uses the just-validated CHECK to skip the
--      second full-table scan, so the ACCESS EXCLUSIVE window is metadata-only.
--   4. DROP the now-redundant CHECK.
--
-- SAFE ONLY AFTER BACKFILL populated every cells.lane_id AND 0099 validated the
-- FK. If any lane_id is still NULL, step 2 fails loudly — that failure is the
-- intended gate; do NOT force it. Run the verify script first (it must report 0
-- NULL rows for cells). Idempotent: guarded, so a re-run is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.cells'::regclass
       AND attname = 'lane_id'
       AND NOT attnotnull
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'cells_lane_id_nn'
         AND conrelid = 'public.cells'::regclass
    ) THEN
      ALTER TABLE public.cells
        ADD CONSTRAINT cells_lane_id_nn CHECK (lane_id IS NOT NULL) NOT VALID;
    END IF;
    ALTER TABLE public.cells VALIDATE CONSTRAINT cells_lane_id_nn;
    ALTER TABLE public.cells ALTER COLUMN lane_id SET NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cells_lane_id_nn'
       AND conrelid = 'public.cells'::regclass
  ) THEN
    ALTER TABLE public.cells DROP CONSTRAINT cells_lane_id_nn;
  END IF;
END $$;
