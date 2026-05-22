-- Migration: 0009_snapshots.sql
-- Description: Spec-aligned Snapshot entity (03-data-model.md §"Snapshot"
--   and §"Snapshot lifecycle"). A snapshot is a labeled timestamp in D1 —
--   NO binary blob (AD-4 reserves R2 for media + originals). "View this file
--   at snapshot X" is a SQL query against `events` filtered by
--   `client_ts <= snapshot.snapshot_ts`; "restore" emits fresh
--   `target.cell.commit` events at the snapshot's values.
--
--   The pre-existing `checkpoints` table (0001_initial.sql) keeps an
--   r2_key because it was a disaster-recovery primitive sized for the old
--   Y.Doc model. It is intentionally left in place: ops-only, not the same
--   thing as the user-facing Snapshot. New work writes to `snapshots`.
--
-- Soft delete (`deleted_at`) so a deleted snapshot can be undone within the
-- session and the underlying events stay queryable in history; hard purges
-- happen in a future GC pass.

CREATE TABLE snapshots (
    id           TEXT    PRIMARY KEY,             -- UUIDv7
    project_id   TEXT    NOT NULL,
    file_id      TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    snapshot_ts  INTEGER NOT NULL,                -- ms since epoch; the "view this file as of T" cutoff
    created_by   INTEGER NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at   DATETIME,                        -- soft delete; null = active
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (file_id)    REFERENCES files(id)    ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_snapshots_file ON snapshots(file_id, snapshot_ts);

-- "Active snapshots for this project, newest first" — drives the listing UI.
CREATE INDEX idx_snapshots_project_active
  ON snapshots(project_id, snapshot_ts) WHERE deleted_at IS NULL;
