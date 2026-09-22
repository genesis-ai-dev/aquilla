-- AQU-1240 slice 7d: dual-read index on cells.lane_id.
--
-- Keep this file a SINGLE statement: CONCURRENTLY cannot run in a transaction
-- block. The migration runner sends each file as one query. Avoid blocking
-- edits while building this index on production's large cells table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cells_lane_id
  ON cells(project_id, file_id, lane_id) WHERE lane_id IS NOT NULL;
