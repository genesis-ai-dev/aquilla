-- Migration 0117: index the newest target edit per lane — AQU-1464
-- "Show the lane's last change date in the archive confirmation".
--
-- The archive-confirmation dialog answers one question before a PM locks a
-- lane: "is anyone still working in here?" That is the newest `last_edit_at`
-- among the lane's TARGET rows, with its `last_editor`:
--
--   SELECT last_editor, last_edit_at FROM cells
--    WHERE project_id = ? AND lane_id = ? AND side = 'target'
--    ORDER BY last_edit_at DESC LIMIT 1
--
-- WHY A NEW INDEX: `cells` is the hottest table in the schema (~16M rows on
-- prod) and no existing index serves that predicate. `idx_cells_lane_id`
-- (project_id, file_id, lane_id) and `idx_cells_last_edit` (project_id,
-- file_id, side, last_edit_at) both lead with file_id after project_id, so a
-- project-and-lane lookup that spans every file in the project can only use
-- the project_id prefix — it degenerates into scanning the project's whole
-- cell set plus a sort. This index makes it a backward index scan stopping at
-- the first row: O(1) regardless of project size, which is what keeps the
-- dialog inside its ~1s budget.
--
-- WHY PARTIAL ON side = 'target': source rows are lane-agnostic (they are
-- shared by every lane — target_lang is always '' on them) and can never be
-- the answer, so they are excluded. That keeps the index to the target half
-- of the table and matches the query's own predicate exactly.
--
-- Apply by hand against Neon (same convention as prior migrations here —
-- NOT applied automatically):
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0117_cells_lane_last_edit.sql
-- Verify: `idx_cells_lane_last_edit` appears on `cells`; EXPLAIN of the query
-- above reports an "Index Scan Backward" on it with no Sort node.

CREATE INDEX IF NOT EXISTS idx_cells_lane_last_edit
  ON cells(project_id, lane_id, last_edit_at DESC)
  WHERE side = 'target';
