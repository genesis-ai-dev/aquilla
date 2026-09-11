-- AQU-1160: composite index backing the cell-page-read chain-cache's bounded
-- page fetch (`(side, target_lang, cell_id) IN (...)` tuple lookup in
-- sync-worker/src/events/cells-read-route.ts). Salvaged from the reverted
-- ef249e914 keyset-pagination attempt — the index was sound, only the
-- client-side keyset mechanism it was paired with was reverted.
--
-- Keep this file a SINGLE statement: CONCURRENTLY cannot run in a transaction
-- block. The migration runner sends each file as one query. Avoid blocking
-- edits while building this index on production's large cells table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cells_file_scan
  ON cells(project_id, file_id, side, target_lang, cell_id);
