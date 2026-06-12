-- Translation agent run ledger (2026-06-12 translation-agent design §5).
-- One row per POST /api/v1/ai/agent/run: who asked, what they asked, which
-- model, tokens/cost, and final status. Staged target.cell.commit events
-- carry payload.agent_run_id → run_id, so attribution / undo-run / PM cost
-- rollups all key off this table.

CREATE TABLE IF NOT EXISTS agent_runs (
    run_id      TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    user_id     BIGINT NOT NULL,
    username    TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    model       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running', -- running|ok|capped|error
    prompt_tokens     BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    cost_cents  DOUBLE PRECISION NOT NULL DEFAULT 0,
    steps       INTEGER NOT NULL DEFAULT 0,
    started_at  BIGINT NOT NULL,
    ended_at    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs (project_id, started_at DESC);
