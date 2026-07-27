-- 0066_artifact_import_bindings.sql
--
-- AQU-635: normalized import provenance. Artifacts remain immutable byte
-- records; bindings describe how one artifact was interpreted into one or more
-- Aquilla files (a Paratext package can bind many member paths/files). Per-unit
-- locators intentionally stay in cells.metadata so there is no parallel unit
-- table or format-specific schema.
--
-- Additive only:
--   * existing artifact uploads and artifacts.file_id keep working;
--   * existing file_source_blobs exports keep working;
--   * no data is rewritten or deleted;
--   * the new runtime can populate bindings as each importer is cut over.

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS artifact_bindings (
    id              UUID PRIMARY KEY,
    project_id      TEXT NOT NULL,
    artifact_id     UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    file_id         TEXT NOT NULL,
    binding_role    TEXT NOT NULL
                      CHECK (binding_role IN ('source', 'target', 'support', 'roundtrip-output')),
    target_lang     TEXT NOT NULL DEFAULT '',
    member_path     TEXT NOT NULL DEFAULT '',
    profile_id      TEXT NOT NULL,
    profile_version TEXT NOT NULL,
    fidelity        TEXT NOT NULL
                      CHECK (fidelity IN ('native', 'verified-recipe', 'content-only', 'preserved-only')),
    manifest        JSONB NOT NULL DEFAULT '{}'::jsonb,
    recipe          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (artifact_id, file_id, binding_role, target_lang, member_path)
);

CREATE INDEX IF NOT EXISTS idx_artifact_bindings_project_file
  ON artifact_bindings(project_id, file_id);
CREATE INDEX IF NOT EXISTS idx_artifact_bindings_artifact
  ON artifact_bindings(artifact_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE artifact_bindings TO app_runtime;

ALTER TABLE artifact_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_artifact_bindings_project_access ON artifact_bindings;
CREATE POLICY rls_artifact_bindings_project_access ON artifact_bindings
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id))
  WITH CHECK (app_user_can_access_project(project_id));
