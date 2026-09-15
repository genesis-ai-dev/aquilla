-- 0093_lane_id_columns.sql — AQU-1240 (v2) slice 3a: additive lane_id columns.
--
-- Adds a nullable lane_id TEXT to every table that carries target_lang. Pure
-- metadata change (ADD COLUMN with no default is instant in Postgres, even on
-- the 17M-row cells table — no table rewrite, no long lock) and BEHAVIOR-NEUTRAL:
-- nothing writes or reads lane_id until the backfill (slice 4) and the read
-- cutover (later). Original target_lang stays put; lane_id is a NEW column, not
-- a rewrite, so the migration is trivially reversible (DROP COLUMN).
--
-- Populated later by joining (project_id, side, target_lang) -> the matching
-- lanes row: source rows -> the project's role='source' lane; target rows ->
-- the role='target' lane whose legacy_tag = target_lang.
--
-- Indexes on lane_id are intentionally deferred to the read-cutover slice and
-- will be built with CREATE INDEX CONCURRENTLY to avoid locking hot tables.
ALTER TABLE cells                 ADD COLUMN IF NOT EXISTS lane_id TEXT;
ALTER TABLE cell_validators       ADD COLUMN IF NOT EXISTS lane_id TEXT;
ALTER TABLE file_section_progress ADD COLUMN IF NOT EXISTS lane_id TEXT;
ALTER TABLE assignments           ADD COLUMN IF NOT EXISTS lane_id TEXT;
ALTER TABLE artifact_bindings     ADD COLUMN IF NOT EXISTS lane_id TEXT;
ALTER TABLE scene_briefs          ADD COLUMN IF NOT EXISTS lane_id TEXT;
ALTER TABLE contextual_runs       ADD COLUMN IF NOT EXISTS lane_id TEXT;
ALTER TABLE contextual_drafts     ADD COLUMN IF NOT EXISTS lane_id TEXT;
