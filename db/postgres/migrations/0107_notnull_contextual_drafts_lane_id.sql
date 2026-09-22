-- 0107_notnull_contextual_drafts_lane_id.sql — AQU-1240 cutover (PR2, POST-BACKFILL).
--
-- AUXILIARY TABLE: apply ONLY after the verify script reports 0 NULL lane_id for
-- contextual_drafts (forward-write coverage was added in PR1; legacy rows may lag).
-- Zero-downtime validated-CHECK pattern; see 0100/0104. Idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.contextual_drafts'::regclass
       AND attname = 'lane_id'
       AND NOT attnotnull
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'contextual_drafts_lane_id_nn'
         AND conrelid = 'public.contextual_drafts'::regclass
    ) THEN
      ALTER TABLE public.contextual_drafts
        ADD CONSTRAINT contextual_drafts_lane_id_nn CHECK (lane_id IS NOT NULL) NOT VALID;
    END IF;
    ALTER TABLE public.contextual_drafts VALIDATE CONSTRAINT contextual_drafts_lane_id_nn;
    ALTER TABLE public.contextual_drafts ALTER COLUMN lane_id SET NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'contextual_drafts_lane_id_nn'
       AND conrelid = 'public.contextual_drafts'::regclass
  ) THEN
    ALTER TABLE public.contextual_drafts DROP CONSTRAINT contextual_drafts_lane_id_nn;
  END IF;
END $$;
