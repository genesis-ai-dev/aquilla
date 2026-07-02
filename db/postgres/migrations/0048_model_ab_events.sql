-- 0048_model_ab_events.sql
--
-- Model A/B testing (see routes/chat.ts + routes/admin.ts /ab-results):
-- when the platform experiment is on (platform_settings.abTest), each
-- default-model chat request is assigned an arm — champion (the configured
-- defaultLlmModel) or challenger — and logged here. The SPA reports what the
-- user did with the AI output (accepted / edited / rejected) via
-- POST /chat/ab-feedback, keyed by the request id the worker returned in the
-- X-AB-Request-Id response header. The admin console aggregates this table to
-- compare model quality (acceptance rate) and reliability (error rate).
--
-- Rows are only written while an experiment is enabled, so both arms always
-- share the same time window and are directly comparable.

CREATE TABLE model_ab_events (
    id         TEXT PRIMARY KEY,                       -- UUID minted by the worker
    user_id    BIGINT NOT NULL,                        -- requester (owner of the feedback)
    arm        TEXT NOT NULL,                          -- 'champion' | 'challenger'
    model      TEXT NOT NULL,                          -- resolved model ID actually used
    source     TEXT NOT NULL DEFAULT 'chat',           -- request surface ('chat' for now)
    error      INTEGER NOT NULL DEFAULT 0,             -- 1 = upstream request failed
    latency_ms INTEGER,                                -- time to upstream response headers
    outcome    TEXT,                                   -- 'accepted' | 'edited' | 'rejected'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    outcome_at TIMESTAMPTZ
);

CREATE INDEX idx_model_ab_events_created ON model_ab_events(created_at);
CREATE INDEX idx_model_ab_events_user ON model_ab_events(user_id);
