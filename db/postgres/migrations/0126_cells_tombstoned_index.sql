-- Migration 0126: index the cells a live link's upstream deleted — AQU-1564.
--
-- `source.cell.mirror { deleted: true }` keeps the downstream's source row and
-- stamps `tombstoned_at` (AQU-476 §5). The `files` counter recompute now leaves
-- those cells out of `cell_count`, and it has to do it with a set it collects
-- once — `cell_id NOT IN (this file's tombstoned cell ids)`, see
-- sync-worker/src/events/tombstoned-cells-scope.ts — because the grouped scan it
-- filters must stay an Index Only Scan on `cells_pkey` with no Sort node
-- (sync-worker/src/__tests__/hot-query-plans.test.ts).
--
-- WHY AN INDEX: that recompute runs on every cell commit. Without one, the set
-- is read by walking every source row of the file and checking `tombstoned_at`
-- on the heap — tens of thousands of rows on a large file. Only live-linked
-- downstreams have tombstones at all (one per cell their upstream ever deleted:
-- a link's first sync replays the upstream's whole history), so the partial
-- index holds a small slice of the table, and every other file pays an empty
-- probe. Same shape as `idx_cells_hidden` (migration 0116).
--
-- Performance only: the counters are correct with or without it.
--
-- Keep this file a SINGLE statement: CONCURRENTLY cannot run in a transaction
-- block. The migration runner sends each file as one query. Building it
-- concurrently avoids blocking edits on production's large cells table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cells_tombstoned
  ON cells(project_id, file_id)
  WHERE tombstoned_at IS NOT NULL;
