-- AQU-2459: file revisions — a file's source side becomes derived state.
--
-- A file is an immutable source artifact, a filter stamp (`<filterId>@<walk>`,
-- the parserVersion shape of decision 0001) and a chain of revisions. Each
-- revision is ONE parse of ONE blob, aligned against the previous revision by
-- `db/shared/file-revision.ts::alignRevision` so every unit keeps its cell id
-- across insertions and edits. A revision is one `file.revision` event plus a
-- manifest in R2, never N `source.cell.create` events.
--
-- `files.head_revision_n` NULL means a legacy, materialized file: it takes
-- today's import paths unchanged until the revisions route adopts it (revision
-- 1 written from its current cells, ids preserved). Decision 0008.

ALTER TABLE files ADD COLUMN IF NOT EXISTS head_revision_n INTEGER;

CREATE TABLE IF NOT EXISTS file_revisions (
    project_id        TEXT NOT NULL,
    file_id           TEXT NOT NULL,
    revision_n        INTEGER NOT NULL,
    parent_revision_n INTEGER,
    -- sha256 of the source artifact this revision parsed; '' for an adopted
    -- revision whose blob was never stored.
    artifact_sha256   TEXT NOT NULL,
    filter_stamp      TEXT NOT NULL,
    options_hash      TEXT NOT NULL,
    -- The aligned unit list (cell ids, content hashes, text) as JSON in R2.
    manifest_r2_key   TEXT NOT NULL,
    unit_count        INTEGER NOT NULL,
    inserted_count    INTEGER NOT NULL DEFAULT 0,
    changed_count     INTEGER NOT NULL DEFAULT 0,
    moved_count       INTEGER NOT NULL DEFAULT 0,
    deleted_count     INTEGER NOT NULL DEFAULT 0,
    -- import | reimport | adopt | drive | git | dcs | langquest
    origin            TEXT NOT NULL,
    event_id          TEXT NOT NULL,
    author            TEXT NOT NULL,
    created_at        BIGINT NOT NULL,
    PRIMARY KEY (project_id, file_id, revision_n)
);
