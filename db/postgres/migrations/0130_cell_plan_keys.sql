-- Migration 0130 (AQU-1493): where each line with no verse reference counts on
-- the plan, as last projected.
--
-- A line nobody gave a reference (one added in the editor, or a heading an
-- imported Bible carries without one) counts in the chapter of the line above
-- it, or for a heading the verse below it. Working that out walks the file's
-- anchor chain (db/shared/plan-keys.ts `inheritedKeysSql`), which on a
-- whole-Bible Hello AO import (34k cells, 3,206 headings) takes 65-80 ms. Run
-- inline, every translation save on such a file paid it inside the progress
-- recompute the request awaits, as did each chapter card, each "Go to first
-- ..." click, the board's assignee chips and assignment.create.
--
-- Where a line counts changes only when lines move, gain or lose a reference,
-- or change type, and every path that does that already runs the FULL progress
-- recompute. So that recompute writes these rows (its first statement) and
-- every other reader joins them. One row per such source cell of a Scripture
-- file; referenced lines have none. Not lane-keyed: where a line counts is the
-- same in every language.
--
-- section_key: the chapter ("GEN 2") or a bare book code for front matter.
-- place_ref + depth: where the line sits, for listing it in file order — depth
-- > 0 lines AFTER place_ref, < 0 lines BEFORE it ('' = the top of the file).
--
-- AFTER APPLYING, run once: `pnpm neon:backfill:progress:prod
-- --unreferenced-lines` (`:dev` for the preview database). It selects every
-- Scripture file whose stored rows differ from the walk, which before the
-- backfill is every file holding a line with no reference, and re-projects it.
-- Until then such lines count in no chapter, exactly as before AQU-1493.

CREATE TABLE IF NOT EXISTS cell_plan_keys (
    project_id  TEXT NOT NULL,
    file_id     TEXT NOT NULL,
    cell_id     TEXT NOT NULL,
    section_key TEXT NOT NULL,
    place_ref   TEXT NOT NULL DEFAULT '',
    depth       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, file_id, cell_id)
);
