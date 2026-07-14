-- 0057_project_member_scopes.sql — AQU-553 (Slice 5): lane-scoped reviewer
-- permissions. ADDITIVE restrictions layered on top of a member's role floor.
--
-- Semantics:
--   * No rows for a (project_id, user_id) pair = UNSCOPED = exactly today's
--     behavior (the member writes across every lane and every file their role
--     allows).
--   * kind='lane' rows: the member may only write target-side content (commits,
--     validate/unvalidate) on those lanes. The default lane is stored as the
--     literal empty string ''.
--   * kind='file' rows: the member's writes are restricted to those fileIds.
--   * Kinds COMPOSE with AND — a member with both a 'lane' row and a 'file' row
--     may only write on that lane AND in that file.
--
-- Enforcement lives in sync-worker authorize (target-side writes + validate);
-- source-side events, comments, audio, and file-level events are never gated.
-- Leads (role >= 500) must stay unscoped; the auth-worker CRUD rejects scoping
-- them, so no rows for a lead should ever exist here.
CREATE TABLE IF NOT EXISTS project_member_scopes (
    project_id TEXT NOT NULL,
    user_id    BIGINT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('lane','file')),
    value      TEXT NOT NULL,
    created_by TEXT,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (project_id, user_id, kind, value)
);
