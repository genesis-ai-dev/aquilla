-- AQU-2308: hand-set milestones — a named start→end range of cells in one file.
--
-- A milestone is its OWN record (id, name, start anchor, end anchor), not a
-- label on a cell. That distinction is the whole design:
--
--   * Not `cells.milestone_label`. The canceled marker attempt (AQU-2185, PR
--     #1652 — never applied anywhere, so there is nothing to migrate) named one
--     cell and let the division run to the next marker. That cannot express
--     "lines 50 to 70 are The storm" without also naming whatever follows line
--     70, so dividing part of a file forced you to re-section all of it.
--   * Not the cell's import envelope (`metadata.aquillaImport.milestone`). A
--     re-import replaces that envelope wholesale, which would silently discard
--     every hand-set division the moment a new version of the file arrived.
--
-- Which cells a milestone covers is deliberately NOT stored. It is resolved at
-- read time by walking the file's cell order from `start_cell_id` to
-- `end_cell_id` (db/shared/file-milestones.ts), so a cell inserted inside the
-- range is covered automatically and no stored span can fall out of step with
-- the file.
--
-- Carried by two file-scoped, non-chain-mutating events — `file.milestone.set`
-- (upsert by id) and `file.milestone.remove` — neither of which has a parent or
-- advances any cell's head, so setting a milestone marks no lane's translation
-- stale. Maintainer floor, same as `file.track.set`: a division relayouts the
-- navigator for every collaborator who opens the file.

CREATE TABLE IF NOT EXISTS file_milestones (
    project_id    TEXT NOT NULL,
    file_id       TEXT NOT NULL,
    -- Client-minted and stable for the life of the record; it is what
    -- `file.milestone.set` upserts on and what `file.milestone.remove` names.
    milestone_id  TEXT NOT NULL,
    -- Shown exactly as typed. Content, not UI vocabulary, so it is never
    -- localized and never reformatted (capped at 200 chars on the write path).
    name          TEXT NOT NULL,
    -- Anchors, not a span. Both are cell ids in this file; a record whose
    -- anchor has gone is simply not shown until anchor survival lands
    -- (AQU-2311), rather than being deleted here.
    start_cell_id TEXT NOT NULL,
    end_cell_id   TEXT NOT NULL,
    author        TEXT NOT NULL,
    -- The event that last wrote this row, for provenance and for rebuild.
    event_id      TEXT NOT NULL,
    server_seq    BIGINT,
    created_at    BIGINT NOT NULL,
    updated_at    BIGINT NOT NULL,
    PRIMARY KEY (project_id, file_id, milestone_id)
);

-- The one read this table has: every milestone of one open file.
CREATE INDEX IF NOT EXISTS idx_file_milestones_file
    ON file_milestones(project_id, file_id);
