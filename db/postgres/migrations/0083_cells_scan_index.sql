-- Keep this file a SINGLE statement: CONCURRENTLY cannot run in a transaction
-- block. The migration runner sends each file as one query. Avoid blocking
-- edits while building this index on production's large cells table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cells_file_scan
  ON cells(project_id, file_id, side, target_lang, cell_id);
