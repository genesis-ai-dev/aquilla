-- AQU-1408 §1: a per-cell statistical gloss a contributor has corrected by hand.
--
-- The gloss is the project's OWN word-for-word reading of a translated cell,
-- derived from its translated pairs. Until now it was computed in the browser
-- and thrown away, so a translator who could see it was wrong had nowhere to
-- put the correction. This table is where the correction lives.
--
-- It is NOT a row of `cell_backtranslations`. That table is keyed
-- (project_id, file_id, cell_id, target_event_id), so a saved gloss and the AI
-- back-translation of the same commit would collide on its primary key — and
-- the two are different kinds of output that a reader must be able to tell
-- apart (the whole point of AQU-1408 §4). A separate table keeps both readings
-- of one commit addressable, and leaves the live `cell_backtranslations` key
-- untouched.
--
-- Shape mirrors `cell_backtranslations` deliberately: pinned to the target
-- commit it describes (staleness = cells.event_id <> target_event_id), lane
-- scoped, and carrying the event that wrote it.

CREATE TABLE IF NOT EXISTS cell_glosses (
    project_id      TEXT NOT NULL,
    file_id         TEXT NOT NULL,
    cell_id         TEXT NOT NULL,
    target_event_id TEXT NOT NULL,
    gloss_text      TEXT NOT NULL,
    author          TEXT NOT NULL,
    event_id        TEXT NOT NULL,
    server_seq      BIGINT,
    created_at      BIGINT NOT NULL,
    -- The target lane this gloss reads. NULL belongs to the lane whose
    -- legacy_tag is '' — the same rule cell_backtranslations.lane_id follows,
    -- so a project whose `lanes` rows do not resolve still reads back.
    lane_id         TEXT,
    PRIMARY KEY (project_id, file_id, cell_id, target_event_id)
);

CREATE INDEX IF NOT EXISTS idx_cell_gloss_cell
    ON cell_glosses(project_id, file_id, cell_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cell_gloss_file
    ON cell_glosses(project_id, file_id);
-- Latest gloss per cell within one lane: the per-file read's exact shape.
CREATE INDEX IF NOT EXISTS idx_cell_gloss_lane
    ON cell_glosses(project_id, file_id, cell_id, lane_id, created_at DESC);

-- A `source.cell.delete` takes this table with the rest of the cell's rows, so
-- AQU-1767's undo has to be able to put it back too. Without this column a
-- remove-then-restore would silently drop every correction on the cell — the
-- one failure mode that archive exists to prevent.
ALTER TABLE removed_cell_archive
    ADD COLUMN IF NOT EXISTS glosses JSONB NOT NULL DEFAULT '[]'::jsonb;
