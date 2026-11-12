-- 0156: drop the generated language projections on project_settings (AQU-1595).
--
-- source_language and target_language came from 0054. target_lanes came from
-- 0063. All three are STORED generated columns over settings JSON. Lane rows
-- are the language now (lanes.language, lanes.name, lanes.legacy_tag,
-- lanes.archived_at, lanes.id).
--
-- Apply one release after the AQU-1595 read-stop is in production, and only
-- after AQU-1616 has filled lanes.language. A reader that still names one of
-- these columns fails the moment it is gone.
--
-- archived_lanes is not dropped. It is not a column on this branch: pull
-- request #1174 (migration 0139) has not merged.
--
-- The JSON keys inside settings stay. This does not rewrite history. The lane
-- backfill reads those keys; it does not read these columns.
--
-- No new indexes. DROP COLUMN does not rewrite the settings blob.

ALTER TABLE project_settings DROP COLUMN IF EXISTS source_language;
ALTER TABLE project_settings DROP COLUMN IF EXISTS target_language;
ALTER TABLE project_settings DROP COLUMN IF EXISTS target_lanes;
