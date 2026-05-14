-- Migration: 0006_multi_project_invites.sql
-- Description: Loosen project_invites.token from PRIMARY KEY to a shared
--   identifier so a single share-link token can span N projects. The new
--   uniqueness contract is `(token, project_id)` — one row per project,
--   all rows sharing the same token + role_level + expiry. Redemption
--   materializes a project_members row per row sharing the token.
--
--   Drives the `multi-project-invite` user story (spec 03-data-model.md
--   §"Project invite": "many Projects (multi-project invite — multiple
--   project_invites rows share a token in the prototype)").
--
-- SQLite has no in-place way to demote a PRIMARY KEY, so this migration
-- follows the canonical 12-step swap: build a new table, copy rows, drop
-- the old one, rename, recreate indexes. The old indexes (project, unused)
-- are recreated post-swap.

-- 1. New table with the loosened key.
CREATE TABLE project_invites_new (
    token TEXT NOT NULL,
    project_id TEXT NOT NULL,
    role_level INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    used_by INTEGER,
    used_at DATETIME,
    PRIMARY KEY (token, project_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by) REFERENCES users(id)
);

-- 2. Carry over any existing rows (codex-web has no real users yet per the
--    project_no_users_yet memory, so this is empty in practice — but a
--    no-op INSERT keeps preview-env DBs consistent).
INSERT INTO project_invites_new (
    token, project_id, role_level, created_by, created_at,
    expires_at, used_by, used_at
)
SELECT token, project_id, role_level, created_by, created_at,
       expires_at, used_by, used_at
  FROM project_invites;

-- 3. Drop the old table + its indexes.
DROP INDEX IF EXISTS idx_project_invites_unused;
DROP INDEX IF EXISTS idx_project_invites_project;
DROP TABLE project_invites;

-- 4. Rename + reinstate indexes.
ALTER TABLE project_invites_new RENAME TO project_invites;

CREATE INDEX idx_project_invites_project ON project_invites(project_id);
CREATE INDEX idx_project_invites_token   ON project_invites(token);
CREATE INDEX idx_project_invites_unused
  ON project_invites(project_id, used_by) WHERE used_by IS NULL;
