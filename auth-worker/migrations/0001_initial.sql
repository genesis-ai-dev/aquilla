-- Migration: 0001_initial.sql
-- Description: Fresh codex schema. ONE D1 (`codex`) for the whole app —
--   identity, orgs, projects, members, invites, plus the file/cell
--   projections sync-worker writes on Y.Doc onSave. Replaces the prior
--   split between frontier-db-v2 (legacy frontier-server schema) and
--   codex-db (projections).
--
-- Legacy fields stripped:
--   - users.gitlab_user_id / gitlab_username / gitlab_token  (codex-web
--     dropped GitLab integration in #66)
--   - users.stripe_customer_id, users.subscription_tier        (no billing)
--   - organizations.stripe_customer_id, subscription_tier,
--     gitlab_group_id                                          (no billing,
--     no GitLab)
--   - projects.gitlab_project_id                               (no GitLab)
--   - `roles` lookup table                                     (constants
--     live in src/lib/frontier/roles.ts on the client and
--     apps/identity/src/services/project-permissions.ts on the server)
--   - subscription_status, api_usage, ab_test_*, pricing_plans (none of
--     these touched codex-web)

-- ── Identity ──────────────────────────────────────────────────────────

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    preferences TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);

CREATE TABLE activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    activity_type TEXT,
    description TEXT,
    activity_metadata TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX idx_activity_logs_timestamp ON activity_logs(timestamp);

CREATE TABLE password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_password_reset_tokens_token ON password_reset_tokens(token);

-- ── Organizations ────────────────────────────────────────────────────

CREATE TABLE organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    owner_user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE INDEX idx_organizations_owner ON organizations(owner_user_id);

CREATE TABLE org_members (
    org_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role_level INTEGER NOT NULL,
    granted_by INTEGER,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME,
    PRIMARY KEY (org_id, user_id),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users(id)
);
CREATE INDEX idx_org_members_user ON org_members(user_id);
CREATE INDEX idx_org_members_org ON org_members(org_id);

-- ── Projects ─────────────────────────────────────────────────────────

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    org_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    archived_at DATETIME,
    archived_by INTEGER REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (org_id) REFERENCES organizations(id)
);
CREATE INDEX idx_projects_org ON projects(org_id);
CREATE INDEX idx_projects_created_by ON projects(created_by);
CREATE INDEX idx_projects_archived
  ON projects(archived_at) WHERE archived_at IS NOT NULL;

CREATE TABLE project_members (
    project_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role_level INTEGER NOT NULL,
    granted_by INTEGER,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users(id)
);
CREATE INDEX idx_project_members_user ON project_members(user_id);

CREATE TABLE project_invites (
    token TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    role_level INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    used_by INTEGER,
    used_at DATETIME,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by) REFERENCES users(id)
);
CREATE INDEX idx_project_invites_project ON project_invites(project_id);
CREATE INDEX idx_project_invites_unused
  ON project_invites(project_id, used_by) WHERE used_by IS NULL;

-- ── File / cell projections (written by sync-worker on Y.Doc onSave) ──

CREATE TABLE files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    source_language TEXT,
    target_language TEXT,
    cell_count INTEGER NOT NULL DEFAULT 0,
    approved_count INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    last_edit_at INTEGER,
    projected_from TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_files_project ON files(project_id);
CREATE INDEX idx_files_last_edit ON files(project_id, last_edit_at);

CREATE TABLE cells (
    file_id TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    content_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    validated INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    last_editor TEXT,
    last_edit_at INTEGER NOT NULL,
    projected_from TEXT,
    edit_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (file_id, cell_id),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX idx_cells_last_edit ON cells(file_id, last_edit_at);
CREATE INDEX idx_cells_validated ON cells(file_id, validated);

-- FTS5 over cell content for literal substring search.
CREATE VIRTUAL TABLE cells_fts USING fts5(
    content_text,
    content='cells',
    content_rowid='rowid'
);

CREATE TRIGGER cells_fts_insert AFTER INSERT ON cells BEGIN
    INSERT INTO cells_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;

CREATE TRIGGER cells_fts_delete AFTER DELETE ON cells BEGIN
    INSERT INTO cells_fts(cells_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
END;

CREATE TRIGGER cells_fts_update AFTER UPDATE ON cells BEGIN
    INSERT INTO cells_fts(cells_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
    INSERT INTO cells_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;

-- Named checkpoints for disaster recovery / snapshots.
CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    label TEXT,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    r2_key TEXT NOT NULL,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX idx_checkpoints_file ON checkpoints(file_id, created_at);
CREATE INDEX idx_checkpoints_project ON checkpoints(project_id, created_at);

-- ── Event log + validator projection (sync-worker CQRS Phase 0) ───────

CREATE TABLE events (
    id              TEXT PRIMARY KEY,
    schema_version  INTEGER NOT NULL,
    project_id      TEXT NOT NULL,
    file_id         TEXT,
    cell_id         TEXT,
    kind            TEXT NOT NULL,
    author          TEXT NOT NULL,
    payload         TEXT NOT NULL,
    client_ts       INTEGER NOT NULL,
    server_ts       INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_events_cell    ON events(project_id, file_id, cell_id, server_ts);
CREATE INDEX idx_events_project ON events(project_id, server_ts);
CREATE INDEX idx_events_author  ON events(author, server_ts);

CREATE TABLE cell_validators (
    project_id      TEXT NOT NULL,
    file_id         TEXT NOT NULL,
    cell_id         TEXT NOT NULL,
    edit_event_id   TEXT NOT NULL,
    username        TEXT NOT NULL,
    is_active       INTEGER NOT NULL,
    decided_ts      INTEGER NOT NULL,
    PRIMARY KEY (project_id, file_id, cell_id, edit_event_id, username)
) STRICT;
CREATE INDEX idx_validators_active ON cell_validators(project_id, file_id, cell_id)
    WHERE is_active = 1;
