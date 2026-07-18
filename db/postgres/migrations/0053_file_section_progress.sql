-- AQU-517: compact, server-maintained file and section progress.
--
-- This is a derived projection over cells. It deliberately stores no cell
-- text or identifiers: one file row plus one row per canonical section. The
-- validator histogram is keyed by exact endorsement count, with 15 meaning
-- "15 or more", so validationCount changes can be answered without rescanning
-- every cell.

CREATE TABLE IF NOT EXISTS file_section_progress (
    project_id          TEXT NOT NULL,
    file_id             TEXT NOT NULL,
    scope               TEXT NOT NULL CHECK (scope IN ('file', 'section')),
    section_key         TEXT NOT NULL DEFAULT '',
    total_count         INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
    filled_count        INTEGER NOT NULL DEFAULT 0 CHECK (filled_count >= 0),
    validator_histogram JSONB NOT NULL DEFAULT '{}'::jsonb,
    revision            BIGINT NOT NULL DEFAULT 0,
    updated_at          BIGINT NOT NULL,
    PRIMARY KEY (project_id, file_id, scope, section_key),
    CHECK (
      (scope = 'file' AND section_key = '') OR
      (scope = 'section' AND section_key <> '')
    )
);

CREATE INDEX IF NOT EXISTS idx_file_section_progress_file_revision
  ON file_section_progress(project_id, file_id, revision);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE file_section_progress TO app_runtime;

ALTER TABLE file_section_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_section_progress FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_file_section_progress_project_access ON file_section_progress;
CREATE POLICY rls_file_section_progress_project_access ON file_section_progress
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));
