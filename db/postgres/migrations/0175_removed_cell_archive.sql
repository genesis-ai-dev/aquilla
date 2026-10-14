-- 0175_removed_cell_archive.sql — AQU-1767 phase 2: removing a row can be undone.
--
-- `source.cell.delete` hard-deletes the cell's rows and takes everything hanging
-- off it (AQU-1068): every lane's translation, validators, waivers,
-- back-translations and morph rows are DELETED; takes are soft-deleted, links
-- tombstoned, comments blanked. None of that can be rebuilt from the delete
-- event, so an honest "undo remove" needs the state as it was.
--
-- The delete's projection now copies that state here first, in the same batch
-- and under the same chain gate, keyed by the delete event. `source.cell.restore`
-- puts it back: it re-inserts the rows, un-deletes only the takes, links and
-- comments the removal itself took (and nobody has touched since), and releases
-- the delete's chain claim so the cell's head can move again. `restored_by` makes
-- each archive single-use and keeps a rebuild replay landing on the same rows.
--
-- The archive is written ONCE (ON CONFLICT DO NOTHING): a projection rebuild
-- replays the delete against today's state, and the live copy is the truth.
--
-- (0161–0163 are taken or reserved by sibling branches.)

CREATE TABLE IF NOT EXISTS removed_cell_archive (
    delete_event_id   TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL,
    file_id           TEXT NOT NULL,
    cell_id           TEXT NOT NULL,
    deleted_by        TEXT NOT NULL,
    deleted_ts        BIGINT NOT NULL,
    -- Every `cells` row of the cell (source + each lane), as to_jsonb rows.
    cells_rows        JSONB NOT NULL DEFAULT '[]'::jsonb,
    validators        JSONB NOT NULL DEFAULT '[]'::jsonb,
    waivers           JSONB NOT NULL DEFAULT '[]'::jsonb,
    backtranslations  JSONB NOT NULL DEFAULT '[]'::jsonb,
    morph             JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Takes the removal soft-deleted: [{audio_id, selected, event_id}].
    audio             JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Links the removal tombstoned: their keys and event_id.
    links             JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Comments the removal blanked: [{comment_id, body, updated_at}].
    comments          JSONB NOT NULL DEFAULT '[]'::jsonb,
    restored_by       TEXT,
    restored_ts       BIGINT
);

CREATE INDEX IF NOT EXISTS idx_removed_cell_archive_cell
    ON removed_cell_archive (project_id, file_id, cell_id, deleted_ts DESC);
