-- Migration 0140 (AQU-1679): a link that follows INTO a file the project
-- already has, instead of adding a second copy of it.
--
-- Linking an established project is additive (AQU-1525): every upstream file
-- arrives as a new file whose id is derived from the upstream's
-- (`deterministicDownstreamFileId`) and whose cells carry the upstream's own
-- cell ids. A project that had already imported the same material on its own
-- therefore ends up with two files of one name — the original, which holds the
-- team's translations, and the mirrored copy, which is the one that follows the
-- upstream and has none. Nothing could join them, because the mirror finds a
-- line by the upstream's cell id and an independently imported file does not
-- share those.
--
-- AQU-1679 lets a Project Lead pick, per same-named file, "replace the source
-- in my existing file". The existing file stays the same file — same id, same
-- cell ids, so every translation, validation, comment and recording keyed on
-- them stays put — and the mirror writes the upstream's source onto it. That
-- needs two records the link did not have:
--
-- 1. `projects.source_link_adopt` — which of this project's files stand in for
--    which upstream files. NULL = none (every link today). Otherwise JSON:
--
--      { "files": { "<upstream file id>": "<this project's file id>", … },
--        "pending": ["<upstream file id>", …] }
--
--    `pending` lists the files whose lines have not been matched yet; the
--    mirror sync (sync-worker events/link-adopt.ts) matches them before its
--    forward fold and removes them from the list. TEXT holding JSON, parsed in
--    JS, for the same reason as 0127/0128: a malformed blob degrades to "none"
--    instead of throwing mid-sync.
--
-- 2. `cells.upstream_cell_id` — on a source row of such a file, the upstream
--    cell it stands in for. Written by `source.cell.mirror`'s projection when
--    the mirror event's upstream cell id differs from the row's own, so it is
--    rebuilt from the event log like every other projected column. NULL on
--    every other row, including ordinary mirrored rows, whose cell id already
--    IS the upstream's.
--
-- No index: the mirror reads the mapping one file at a time, which the primary
-- key's (project_id, file_id) prefix already serves.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS source_link_adopt TEXT;

ALTER TABLE cells
  ADD COLUMN IF NOT EXISTS upstream_cell_id TEXT;
