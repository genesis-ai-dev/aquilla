-- 0108_notnull_artifact_bindings_lane_id.sql — AQU-1240 cutover (PR2, POST-BACKFILL).
--
-- AUXILIARY TABLE: forward-write lane_id coverage was only added in PR1, so a
-- legacy row whose target_lang has no matching lane could still be NULL after
-- backfill. Apply ONLY after the verify script reports 0 NULL lane_id for
-- artifact_bindings; if it doesn't, resolve the stragglers (re-run backfill /
-- add the missing lane) before enforcing NOT NULL. The VALIDATE step fails
-- loudly on residual NULLs — that is the gate, do not force it.
--
-- Zero-downtime validated-CHECK pattern; see 0104. Idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.artifact_bindings'::regclass
       AND attname = 'lane_id'
       AND NOT attnotnull
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'artifact_bindings_lane_id_nn'
         AND conrelid = 'public.artifact_bindings'::regclass
    ) THEN
      ALTER TABLE public.artifact_bindings
        ADD CONSTRAINT artifact_bindings_lane_id_nn CHECK (lane_id IS NOT NULL) NOT VALID;
    END IF;
    ALTER TABLE public.artifact_bindings VALIDATE CONSTRAINT artifact_bindings_lane_id_nn;
    ALTER TABLE public.artifact_bindings ALTER COLUMN lane_id SET NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'artifact_bindings_lane_id_nn'
       AND conrelid = 'public.artifact_bindings'::regclass
  ) THEN
    ALTER TABLE public.artifact_bindings DROP CONSTRAINT artifact_bindings_lane_id_nn;
  END IF;
END $$;
