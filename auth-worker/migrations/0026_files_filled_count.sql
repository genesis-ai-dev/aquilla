-- Migration: 0026_files_filled_count.sql
-- Description: Add a "translated / filled" rollup counter to the `files` table.
--
--   The existing rollup tracked validated cells (approved_count) and words
--   (word_count) but had no count of cells that simply HAVE a translation —
--   i.e. the "is this cell done" signal the chapter-selector dots encode.
--   Project managers scan that at a glance (translation progress, distinct
--   from validation progress), so we surface it as a first-class counter.
--
--   Definition mirrors fileCountersRecomputeStmt in
--   sync-worker/src/events/event-projection.ts:
--     filled_count — target-side cells with non-whitespace content
--                    (side = 'target' AND TRIM(value) != '')
--
--   Whitespace-only cells are excluded so they match the dots (which show no
--   progress for a blank cell) and align with word_count semantics.
--
--   Idempotent backfill: recomputes from `cells`, so re-running is a no-op.

ALTER TABLE files ADD COLUMN filled_count INTEGER NOT NULL DEFAULT 0;

UPDATE files SET
  filled_count = (
    SELECT COUNT(*) FROM cells c
    WHERE c.project_id = files.project_id
      AND c.file_id = files.id
      AND c.side = 'target'
      AND TRIM(c.value) != ''
  );
