-- Agent sessions: server-persisted conversations for the translation agent
-- (design 2026-07-02-agent-mode-v2 §2.3). convo = JSON array of stored
-- messages (user/assistant/tool — the system prompt is rebuilt per run).
-- Session ids are client-generated UUIDs; ownership is (project_id, user_id)
-- and is enforced on load.

CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    user_id    BIGINT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    convo      TEXT NOT NULL DEFAULT '[]',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_user
    ON agent_sessions (project_id, user_id, updated_at DESC);

-- Runs now belong to a session (nullable — sessionless v1 clients still work).
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS session_id TEXT;
