-- Migration 0031: project-level snapshots table (FRO-176).
--
-- The existing `snapshots` table in schema.sql is file-scoped (has file_id)
-- which contradicts the spec (snapshots-and-history.md §Invariants — "labeled
-- timestamps over the event log" for the whole project). This migration drops
-- the old table and creates the spec-correct project-scoped one.
--
-- snapshot_ts is BIGINT epoch-ms — the watermark used by restore to query
-- "what was each cell's value at this point in time?"
-- description is optional (nullable TEXT).
-- deleted_at is a soft-delete LWW column.
DROP TABLE IF EXISTS snapshots;

CREATE TABLE snapshots (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    created_by  TEXT NOT NULL,
    snapshot_ts BIGINT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_snapshots_project_active
    ON snapshots(project_id, snapshot_ts DESC)
    WHERE deleted_at IS NULL;
