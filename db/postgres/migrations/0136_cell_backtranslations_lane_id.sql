-- 0136_cell_backtranslations_lane_id.sql — AQU-1589
--
-- Back-translations were one row-set per cell, so the newest reading in any
-- lane was the reading every lane saw, and deleting one target lane removed
-- every lane's readings. lane_id is the lanes.id the event's targetLang
-- resolves to (absent or '' → the target lane whose legacy_tag is '').
--
-- Nullable on purpose. Existing rows stay NULL until the AQU-1616 backfill;
-- readers treat NULL as that '' lane so nothing disappears first. The primary
-- key is unchanged, and this migration does not SET NOT NULL.
--
-- The composite FK matches 0102/0115: NOT VALID first (no scan, still enforced
-- on new writes), then VALIDATE. Every existing lane_id is NULL, and a
-- composite FK with a NULL member is exempt (MATCH SIMPLE), so validation
-- holds before the backfill.

ALTER TABLE cell_backtranslations ADD COLUMN IF NOT EXISTS lane_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cell_backtranslations_lane_id_fkey'
       AND conrelid = 'public.cell_backtranslations'::regclass
  ) THEN
    ALTER TABLE public.cell_backtranslations
      ADD CONSTRAINT cell_backtranslations_lane_id_fkey
      FOREIGN KEY (project_id, lane_id) REFERENCES public.lanes (project_id, id)
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cell_backtranslations_lane_id_fkey'
       AND conrelid = 'public.cell_backtranslations'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.cell_backtranslations
      VALIDATE CONSTRAINT cell_backtranslations_lane_id_fkey;
  END IF;
END $$;

-- Latest reading per cell within one lane, including NULL lane_id (the
-- pre-backfill default lane). Not CONCURRENTLY: the migration runner sends
-- this file as one query, and CONCURRENTLY cannot run inside it.
CREATE INDEX IF NOT EXISTS idx_cell_bt_lane
  ON cell_backtranslations (project_id, file_id, cell_id, lane_id, created_at DESC);
