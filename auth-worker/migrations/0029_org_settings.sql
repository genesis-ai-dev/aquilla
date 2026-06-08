-- Migration: 0029_org_settings.sql
-- Description: Per-org versioned settings blob mirroring project_settings (§"Org Settings").
-- One row per organization; `settings` is a JSON blob with all-optional keys.
-- `version` is a monotonic counter — clients send `ifMatchVersion` on write
-- and a mismatch returns 409. Writes require org role >= MAINTAINER (600).
--
-- Keys: rules (TranslationRule[]). Shape is a superset of project_settings
-- so the same client serialization paths work for both.

CREATE TABLE org_settings (
    org_id      INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    settings    TEXT    NOT NULL DEFAULT '{}',
    version     INTEGER NOT NULL DEFAULT 0,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by  INTEGER REFERENCES users(id)
);

CREATE INDEX idx_org_settings_updated_at
  ON org_settings(updated_at);
