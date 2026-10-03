-- 0129_cell_audio_lane_id.sql — AQU-1591: audio takes belong to a lane.
--
-- AQU-1200 decided it: audio is per lane. Source audio (the shared programme
-- audio an import attaches) belongs to the project's source lane; a dub — a
-- recording, a TTS take, a clone — belongs to the target lane whose language it
-- performs. `cell_audio` had no lane column at all, which is why a take
-- recorded in one lane showed up in every other one.
--
-- Additive and nullable, exactly like 0097 did it for `cells`: ADD COLUMN with
-- no default is a catalog-only change in Postgres (no table rewrite, no long
-- lock). Pre-existing rows keep NULL until the batch backfill (AQU-1616)
-- resolves them, and every reader applies the backfill's own rule to a NULL —
-- `role = 'source'` reads as the source lane, a dub as the lane whose
-- legacy_tag is '' — so replay, read and backfill agree on a take's lane before
-- and after that PR lands.
--
-- The primary keys are deliberately untouched. `(project, file, cell, audio_id)`
-- is already unique without a lane (audio_id is a UUID), so unlike `cells` —
-- where one cell position genuinely holds one row per lane — there is no
-- identity to widen here. 0114 did that for the tables that needed it.
ALTER TABLE cell_audio            ADD COLUMN IF NOT EXISTS lane_id TEXT;
ALTER TABLE cell_audio_validators ADD COLUMN IF NOT EXISTS lane_id TEXT;

-- The same composite FK every other lane_id column carries. NOT VALID then
-- VALIDATE keeps the add itself from scanning under a long lock; a NULL
-- lane_id is exempt.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cell_audio_lane_id_fkey' AND conrelid = 'public.cell_audio'::regclass
  ) THEN
    ALTER TABLE public.cell_audio
      ADD CONSTRAINT cell_audio_lane_id_fkey
      FOREIGN KEY (project_id, lane_id) REFERENCES public.lanes (project_id, id)
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cell_audio_lane_id_fkey' AND conrelid = 'public.cell_audio'::regclass AND NOT convalidated
  ) THEN
    ALTER TABLE public.cell_audio VALIDATE CONSTRAINT cell_audio_lane_id_fkey;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cell_audio_validators_lane_id_fkey' AND conrelid = 'public.cell_audio_validators'::regclass
  ) THEN
    ALTER TABLE public.cell_audio_validators
      ADD CONSTRAINT cell_audio_validators_lane_id_fkey
      FOREIGN KEY (project_id, lane_id) REFERENCES public.lanes (project_id, id)
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cell_audio_validators_lane_id_fkey' AND conrelid = 'public.cell_audio_validators'::regclass AND NOT convalidated
  ) THEN
    ALTER TABLE public.cell_audio_validators VALIDATE CONSTRAINT cell_audio_validators_lane_id_fkey;
  END IF;
END $$;

-- The per-file read and the progress audio CTE both now filter on the lane
-- beside the file. Partial on deleted = 0, mirroring idx_cell_audio_file.
CREATE INDEX IF NOT EXISTS idx_cell_audio_lane
    ON cell_audio(project_id, file_id, lane_id) WHERE deleted = 0;
