-- 0161_org_validation_count_defaults.sql — AQU-1771
--
-- Org-level defaults for how many validations make a cell (validationCount)
-- or a recorded take (validationCountAudio) count as validated. A project may
-- still set its own; absent on the project falls through to the org, and
-- absent on both reads as 1. Same shape as count_structural (0092).
--
-- STORED generated columns, like the project_settings pair (0063, 0096), so
-- the org dashboard, the progress reads and the Monday push can resolve the
-- effective threshold in SQL without parsing the settings blob per project.
--
-- Idempotent. A database loaded from schema.sql already has both.
ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS validation_count TEXT
    GENERATED ALWAYS AS ((settings::jsonb)->>'validationCount') STORED;

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS validation_count_audio TEXT
    GENERATED ALWAYS AS ((settings::jsonb)->>'validationCountAudio') STORED;
