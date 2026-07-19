-- AQU-575: project portfolio settings projections.
--
-- project_settings.settings can be several MB per project. Portfolio reads need
-- only validationCount and targetLanes, so returning the full blob for every
-- project can transfer hundreds of MB for a multi-org account. STORED generated
-- columns pay the JSON parse at write time and cannot drift from the source.
ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS validation_count TEXT
    GENERATED ALWAYS AS ((settings::jsonb)->>'validationCount') STORED,
  ADD COLUMN IF NOT EXISTS target_lanes JSONB
    GENERATED ALWAYS AS ((settings::jsonb)->'targetLanes') STORED;
