-- Per-cell file attachments (AQU-777). Projection of `cell.attachment.*`
-- events; the bytes live in the same R2 bucket as audio, under
-- projects/{pid}/files/{fid}/attachments/{objectName}.
--
-- Modelled on `cell_audio` (the other per-cell blob pointer) rather than on
-- `comments`: an attachment is a pointer to an R2 object plus the metadata
-- needed to render a link without fetching the bytes, and it has the same
-- "soft-delete so the event log and the projection agree" requirement.
--
-- The primary key is PROJECT-SCOPED from the start. `attachment_id` is a
-- client-generated uuidv7 so a collision is vanishingly unlikely, but AQU-1296
-- is the standing lesson that a globally-keyed projection of a per-project id
-- fails silently when ids ever do repeat (an importer replay, a project fork).
CREATE TABLE IF NOT EXISTS cell_attachments (
    project_id    TEXT   NOT NULL,
    attachment_id TEXT   NOT NULL,
    file_id       TEXT   NOT NULL,
    cell_id       TEXT   NOT NULL,
    -- R2 object name within the cell's file scope ("<attachmentId>.<ext>").
    -- Stored rather than derived: the extension is picked from the uploaded
    -- filename at attach time and must stay stable for the life of the row.
    object_name   TEXT   NOT NULL,
    -- The user-visible file name, as picked ("chapter-3-layout.png").
    name          TEXT   NOT NULL,
    mime_type     TEXT,
    size_bytes    BIGINT,
    author_id     TEXT   NOT NULL,
    author_label  TEXT,
    created_at    BIGINT NOT NULL,
    -- Soft-delete, as comments do it: the row survives so a removal is
    -- replayable from the event log and a stale client can tell "gone" from
    -- "never existed".
    deleted_at    BIGINT,
    event_id      TEXT   NOT NULL,
    PRIMARY KEY (project_id, attachment_id)
);

-- The drawer's only query: every live attachment in one file, grouped by cell.
-- Partial on `deleted_at IS NULL` because removed rows are never read back.
CREATE INDEX IF NOT EXISTS cell_attachments_file_idx
    ON cell_attachments (project_id, file_id, cell_id, created_at)
    WHERE deleted_at IS NULL;

-- ─────────────── tenant-isolation RLS backstop (mirrors 0034/0056) ──────────
-- `cell_attachments` is project-scoped per-cell data, the same class as
-- `cell_audio` and `comments`, both of which 0034_rls_backstop.sql covers — so
-- it arrives with the backstop rather than landing on db/postgres/RLS.md's
-- "not covered (follow-on task)" list. Role logic stays in the worker layer.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cell_attachments TO app_runtime;

ALTER TABLE cell_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_cell_attachments_project_access ON cell_attachments;
CREATE POLICY rls_cell_attachments_project_access ON cell_attachments
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));
