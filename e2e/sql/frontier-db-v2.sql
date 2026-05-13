-- Consolidated frontier-db-v2 schema for local E2E only.
--
-- Mirrors frontier-server's `cloudflare/migrations/000{1..18}.sql` collapsed
-- to only the tables codex-auth-worker reads/writes. Production frontier-db-v2
-- is owned by frontier-server's migrations — this file is NEVER applied there.
-- Vendored 2026-05-13 from frontier-server origin/main; refresh manually if
-- a column auth-worker depends on is later added on the frontier-server side.

-- Identity.
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    gitlab_user_id INTEGER UNIQUE,
    gitlab_username TEXT,
    gitlab_token TEXT,
    stripe_customer_id TEXT UNIQUE,
    subscription_tier TEXT DEFAULT 'free',
    preferences TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    activity_type TEXT,
    description TEXT,
    activity_metadata TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token);

-- Role ladder (migration 0013).
CREATE TABLE IF NOT EXISTS roles (
    level INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT
);
INSERT OR IGNORE INTO roles (level, name, description) VALUES
    (100, 'viewer',       'Read cells and comments'),
    (200, 'commenter',    'Viewer + write comments'),
    (300, 'reviewer',     'Commenter + validate cells'),
    (400, 'contributor',  'Reviewer + edit cell values'),
    (500, 'project_lead', 'Contributor + assign reviewers/validators'),
    (600, 'maintainer',   'Project lead + manage members/settings'),
    (700, 'owner',        'Maintainer + delete or transfer project');

-- Orgs (migrations 0008, 0017 — stripe_customer_id NULLable variant).
CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    stripe_customer_id TEXT UNIQUE,
    subscription_tier TEXT NOT NULL DEFAULT 'free',
    owner_user_id INTEGER NOT NULL,
    gitlab_group_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_user_id);

-- Org membership (migrations 0016, 0018).
CREATE TABLE IF NOT EXISTS org_members (
    org_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role_level INTEGER NOT NULL,
    granted_by INTEGER,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME,
    PRIMARY KEY (org_id, user_id),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (role_level) REFERENCES roles(level),
    FOREIGN KEY (granted_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id);

-- Projects (migrations 0013, 0015).
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    gitlab_project_id INTEGER UNIQUE,
    org_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    archived_at DATETIME,
    archived_by INTEGER REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (org_id) REFERENCES organizations(id)
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_by ON projects(created_by);
CREATE INDEX IF NOT EXISTS idx_projects_archived
  ON projects(archived_at) WHERE archived_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role_level INTEGER NOT NULL,
    granted_by INTEGER,
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (role_level) REFERENCES roles(level),
    FOREIGN KEY (granted_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

-- Shareable invites (migration 0014).
CREATE TABLE IF NOT EXISTS project_invites (
    token TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    role_level INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    used_by INTEGER,
    used_at DATETIME,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (role_level) REFERENCES roles(level),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_project_invites_project ON project_invites(project_id);
CREATE INDEX IF NOT EXISTS idx_project_invites_unused
  ON project_invites(project_id, used_by) WHERE used_by IS NULL;
