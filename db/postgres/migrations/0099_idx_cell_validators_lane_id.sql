-- AQU-1240 slice 7d: dual-read index on cell_validators.lane_id.
--
-- Keep this file a SINGLE statement: CONCURRENTLY cannot run in a transaction
-- block. The migration runner sends each file as one query.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cell_validators_lane_id
  ON cell_validators(project_id, file_id, cell_id, lane_id) WHERE lane_id IS NOT NULL;
