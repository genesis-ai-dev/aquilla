-- 0113_lane_id_primary_keys.sql — AQU-1420
--
-- Row identity moves from target_lang to lane_id on the three tables whose
-- primary key still treated the legacy tag as the lane. The target_lang
-- column stays: source rows are still '', and target rows still store the
-- lane's legacy tag. This migration does not rewrite any stored ''.
--
-- Numbered 0113 so it sorts after 0112 (the grant foreign key, AQU-1416)
-- when both land on the same database.
--
-- Aborts if two live rows already share the new key. That is a content
-- collision, not something to drop with ON CONFLICT DO NOTHING.
-- Idempotent: a primary key that already includes lane_id and not target_lang
-- is left alone.

DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'cells_pkey' AND conrelid = 'public.cells'::regclass;
  IF def IS NOT NULL AND (def NOT LIKE '%lane_id%' OR def LIKE '%target_lang%') THEN
    IF EXISTS (
      SELECT 1 FROM public.cells
      GROUP BY project_id, file_id, cell_id, lane_id
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'AQU-1420: cells (project_id, file_id, cell_id, lane_id) is not unique';
    END IF;
    ALTER TABLE public.cells DROP CONSTRAINT cells_pkey;
    ALTER TABLE public.cells ADD PRIMARY KEY (project_id, file_id, cell_id, lane_id);
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'file_section_progress_pkey'
     AND conrelid = 'public.file_section_progress'::regclass;
  IF def IS NOT NULL AND (def NOT LIKE '%lane_id%' OR def LIKE '%target_lang%') THEN
    IF EXISTS (
      SELECT 1 FROM public.file_section_progress
      GROUP BY project_id, file_id, scope, section_key, lane_id
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'AQU-1420: file_section_progress (project_id, file_id, scope, section_key, lane_id) is not unique';
    END IF;
    ALTER TABLE public.file_section_progress DROP CONSTRAINT file_section_progress_pkey;
    ALTER TABLE public.file_section_progress
      ADD PRIMARY KEY (project_id, file_id, scope, section_key, lane_id);
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'cell_validators_pkey'
     AND conrelid = 'public.cell_validators'::regclass;
  IF def IS NOT NULL AND (def NOT LIKE '%lane_id%' OR def LIKE '%target_lang%') THEN
    IF EXISTS (
      SELECT 1 FROM public.cell_validators
      GROUP BY project_id, file_id, cell_id, lane_id, username
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'AQU-1420: cell_validators (project_id, file_id, cell_id, lane_id, username) is not unique';
    END IF;
    ALTER TABLE public.cell_validators DROP CONSTRAINT cell_validators_pkey;
    ALTER TABLE public.cell_validators
      ADD PRIMARY KEY (project_id, file_id, cell_id, lane_id, username);
  END IF;
END $$;
