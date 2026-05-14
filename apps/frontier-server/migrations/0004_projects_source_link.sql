-- Migration: 0004_projects_source_link.sql
-- Description: AD-9 — Add `source_project_id` self-FK to `projects` so a
--   project can declare an upstream source project. Nullable:
--
--     * NULL  → self-contained (default) or source-only (depending on
--               whether project_settings.targetLanguage is set).
--     * SET   → linked target — the project's source side reads from the
--               upstream's source cells; only target-side events are
--               emitted in this project.
--
--   Permissions for setting / clearing this column are enforced at the
--   `project.link-source` event handler (project_lead+; AD-9). The column
--   itself is a passive pointer.

ALTER TABLE projects ADD COLUMN source_project_id TEXT
    REFERENCES projects(id);

CREATE INDEX idx_projects_source_project ON projects(source_project_id)
    WHERE source_project_id IS NOT NULL;
