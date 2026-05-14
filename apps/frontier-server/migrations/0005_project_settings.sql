-- Migration: 0005_project_settings.sql
-- Description: Per-project versioned settings blob (Aquilla spec
--   03-data-model.md §"Project Settings"). One row per project; `settings`
--   is a JSON blob with all-optional keys (sourceLanguage, targetLanguage,
--   systemPrompt, rules, rulePenalties, healthSettings, validationCount,
--   validationCountAudio). `version` is a monotonic counter — clients send
--   `ifMatchVersion` on write and a mismatch returns 409 so the UI can
--   surface a "settings changed elsewhere; refresh and reapply" notice.
--
--   `targetLanguage` left unset identifies a source-only project per AD-9:
--   it has its own source side but emits no target.cell.commit events.
--
-- Numbering note: this migration lives at 0005 to stay clear of Phase 1A's
--   range (0002–0004, events / cells projection changes / source_project_id
--   on projects). The two streams can be applied in any order as long as
--   the writer of `projects.source_project_id` lands before the routes that
--   read it (Phase 1A's 0004). This PR's routes reference that column —
--   document that ordering dependency in the PR body.

CREATE TABLE project_settings (
    project_id  TEXT    PRIMARY KEY,
    settings    TEXT    NOT NULL DEFAULT '{}',
    version     INTEGER NOT NULL DEFAULT 0,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by  INTEGER,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE INDEX idx_project_settings_updated_at
  ON project_settings(updated_at);
