-- Migration 0056: Agent API source artifacts (AQU-533 §5 ingestion, W2-B).
--
-- An artifact is an uploaded source file (USFM, JSON, XLIFF, …) preserved
-- verbatim in R2 for round-trip fidelity and format inspection. The bytes live
-- in the SNAPSHOTS bucket under `{prefix}artifacts/{projectId}/{artifactId}`;
-- this row is the metadata index + provenance (who uploaded it, under which
-- credential) and the digest for integrity checks.
--
-- `file_id` is NULL until a PlanImport changeset that references this artifact
-- commits — at which point the created file id is linked back here so export can
-- find the original bytes (mirrors file_source_blobs' round-trip intent, but for
-- agent-uploaded originals that predate a file).
--
-- Storage decision (design §4 D9): greenfield table starts on Postgres.

CREATE TABLE IF NOT EXISTS artifacts (
    id                  UUID PRIMARY KEY,          -- server-minted
    project_id          TEXT NOT NULL,
    uploaded_by_user_id TEXT NOT NULL,             -- the credential's owning user
    credential_id       TEXT NOT NULL,
    name                TEXT NOT NULL,             -- caller-supplied display name
    content_type        TEXT,                      -- caller-declared MIME, nullable
    size_bytes          BIGINT NOT NULL,
    sha256              TEXT NOT NULL,             -- hex digest of the stored bytes
    r2_key              TEXT NOT NULL,             -- key in the SNAPSHOTS bucket
    file_id             TEXT,                      -- linked on PlanImport commit
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);

-- ─────────────── tenant-isolation RLS backstop (mirrors 0055) ───────────────
-- Defence-in-depth: rows are visible to app_runtime only for projects the
-- SET LOCAL app.user_id belongs to. Role logic stays in the worker layer.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE artifacts TO app_runtime;

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_artifacts_project_access ON artifacts;
CREATE POLICY rls_artifacts_project_access ON artifacts
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));
