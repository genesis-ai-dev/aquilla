-- 0105_notnull_scene_briefs_lane_id.sql — AQU-1240 cutover (PR2, POST-BACKFILL).
--
-- AUXILIARY TABLE: apply ONLY after the verify script reports 0 NULL lane_id for
-- scene_briefs (forward-write coverage was added in PR1; legacy rows may lag).
-- Zero-downtime validated-CHECK pattern; see 0100/0104. Idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.scene_briefs'::regclass
       AND attname = 'lane_id'
       AND NOT attnotnull
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'scene_briefs_lane_id_nn'
         AND conrelid = 'public.scene_briefs'::regclass
    ) THEN
      ALTER TABLE public.scene_briefs
        ADD CONSTRAINT scene_briefs_lane_id_nn CHECK (lane_id IS NOT NULL) NOT VALID;
    END IF;
    ALTER TABLE public.scene_briefs VALIDATE CONSTRAINT scene_briefs_lane_id_nn;
    ALTER TABLE public.scene_briefs ALTER COLUMN lane_id SET NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scene_briefs_lane_id_nn'
       AND conrelid = 'public.scene_briefs'::regclass
  ) THEN
    ALTER TABLE public.scene_briefs DROP CONSTRAINT scene_briefs_lane_id_nn;
  END IF;
END $$;
