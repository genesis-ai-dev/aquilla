-- Migration: 0016_backfill_file_counters.sql
-- Description: One-time backfill of the denormalized `files` rollup counters.
--
--   Until now nothing maintained files.cell_count / approved_count /
--   word_count / last_edit_at: file.create seeded them at 0 and the cell
--   projection only ever wrote the `cells` table. Result: every files row
--   sat at cell_count=0 even when it had hundreds of cells, so the web app
--   rendered populated files as "empty" (the file list / hasContent nudge
--   read the stale 0) and sorted them to the bottom (last_edit_at NULL).
--
--   The projection bug itself is fixed in event-projection.ts
--   (fileCountersRecomputeStmt runs on every cell-mutating event). This
--   migration heals the rows that were already written before that fix.
--
--   Definitions mirror fileCountersRecomputeStmt exactly so a backfilled row
--   and a freshly-projected row converge to the same values:
--     cell_count     — distinct cell positions (paired source/target share id)
--     approved_count — validated cells (target side only)
--     word_count     — total target-side words
--     last_edit_at   — most recent cell edit on the file
--
--   Idempotent: recomputes from `cells`, so re-running yields the same result.
UPDATE files SET
  cell_count = (
    SELECT COUNT(DISTINCT c.cell_id) FROM cells c
    WHERE c.project_id = files.project_id AND c.file_id = files.id
  ),
  approved_count = (
    SELECT COUNT(*) FROM cells c
    WHERE c.project_id = files.project_id AND c.file_id = files.id AND c.validated = 1
  ),
  word_count = (
    SELECT COALESCE(SUM(c.word_count), 0) FROM cells c
    WHERE c.project_id = files.project_id AND c.file_id = files.id AND c.side = 'target'
  ),
  last_edit_at = (
    SELECT MAX(c.last_edit_at) FROM cells c
    WHERE c.project_id = files.project_id AND c.file_id = files.id
  );
