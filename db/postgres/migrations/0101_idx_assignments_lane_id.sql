-- AQU-1240 slice 7d: dual-read index on assignments.lane_id.
--
-- Keep this file a SINGLE statement: CONCURRENTLY cannot run in a transaction
-- block. The migration runner sends each file as one query.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assignments_lane_id
  ON assignments(project_id, lane_id) WHERE lane_id IS NOT NULL;
