-- 0134_artifact_bindings_lane_member_key.sql — AQU-1611, EXPAND step
-- (table group: artifact_bindings).
--
-- artifact_bindings.lane_id became the row's identity in AQU-1240 and 0108
-- made it NOT NULL, so target_lang is a duplicate of lanes.legacy_tag, which
-- the lane row keeps forever. This migration only ADDS the lane-keyed UNIQUE
-- that upserts can arbitrate on.
--
-- It deliberately does NOT drop target_lang or its UNIQUE. "Migrate first,
-- then deploy" (docs/DEPLOYMENT-ENVIRONMENTS.md) means the previous Workers
-- are still live while this runs, and they still write target_lang and
-- arbitrate on the tag-keyed UNIQUE; dropping either here would break every
-- artifact-binding write for that window. Prod also lags dev by a release, so
-- migrations must be backward-compatible across one release: add now, remove
-- later. The contract step — writers stop writing the column, the tag-keyed
-- UNIQUE and the column are dropped, the test lane-fill trigger and the
-- AQU-1240 backfill script stop reading it — is a separate migration in a
-- later release, once no deployed Worker writes the column.
--
-- Both UNIQUEs coexist safely and express the same guarantee: within one
-- artifact the project is fixed (composite FK to artifacts) and
-- lanes.legacy_tag is unique per project, so target_lang <-> lane_id is 1:1.
-- The ADD therefore cannot fail on existing rows; if it does, that is real
-- duplicate data — resolve it, do not force this through.
--
-- Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'artifact_bindings_lane_member_key'
       AND conrelid = 'public.artifact_bindings'::regclass
  ) THEN
    ALTER TABLE public.artifact_bindings
      ADD CONSTRAINT artifact_bindings_lane_member_key
      UNIQUE (artifact_id, file_id, binding_role, lane_id, member_path);
  END IF;
END $$;
