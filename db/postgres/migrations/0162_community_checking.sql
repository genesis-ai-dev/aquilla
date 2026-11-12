-- AQU-1249: feature-flagged WIP. Capabilities confer no project membership.
CREATE TABLE IF NOT EXISTS checking_links (
  token TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'reviewer')),
  units JSONB NOT NULL,
  pin_hash TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until BIGINT,
  join_count INTEGER NOT NULL DEFAULT 0,
  join_window BIGINT NOT NULL DEFAULT 0,
  feedback_count INTEGER NOT NULL DEFAULT 0,
  feedback_window BIGINT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS checking_links_project ON checking_links(project_id);
