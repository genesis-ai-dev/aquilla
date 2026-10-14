-- 0169_project_settings_records_audio.sql — AQU-1954 "This project records audio"
--
-- A STORED generated column for the project's recordsAudio switch, so the org
-- portfolio can ask it of every project on the page without parsing the
-- settings blob (several MB on some projects). Same pattern as 0063, 0092,
-- 0096, 0123 and 0150.
--
-- On, every file counts toward the project's audio numbers. Off (absent,
-- false, or anything that is not the JSON true), only files with a recording
-- or a cue sheet do, which is what the plan board already measured.
--
-- DEPLOY: adding a generated column rewrites project_settings once, holding
-- its lock for the rewrite, as the earlier generated-column migrations did.
--
-- Idempotent. A database loaded from schema.sql already has the column.
ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS records_audio BOOLEAN
    GENERATED ALWAYS AS (((settings::jsonb) ->> 'recordsAudio') = 'true') STORED;
