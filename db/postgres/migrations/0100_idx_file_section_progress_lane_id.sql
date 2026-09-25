-- AQU-1240 slice 7d: dual-read index on file_section_progress.lane_id.
--
-- Keep this file a SINGLE statement: CONCURRENTLY cannot run in a transaction
-- block. The migration runner sends each file as one query.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_file_section_progress_lane_id
  ON file_section_progress(project_id, file_id, lane_id) WHERE lane_id IS NOT NULL;
