-- Migration 0054: external API credentials (personal access tokens) for the
-- Agent API (AQU-533 §2 "Trust model" — credentials + autonomy modes).
--
-- A PAT is minted per user in auth-worker, scoped optionally to an org and/or a
-- project, and carries an autonomy ceiling (`ask` | `act`). Only a SHA-256 hash
-- of the token is stored; the plaintext is shown to the caller exactly once at
-- creation. `token_prefix` (first 12 chars of the full token, incl. the `aqk_`
-- tag) is kept for display in credential-management UIs — enough to recognize a
-- token, never enough to reconstruct it.
--
-- Live role/membership is re-resolved on every API call (see
-- db/shared/project-roles.ts): a credential never outlives or exceeds the
-- user's current role. The row here only records the credential's own ceiling,
-- scope, and lifecycle (expiry/revocation/last-use).
--
-- Greenfield table → starts on Postgres (design §4 D9), consistent with the
-- changesets/jobs tables. User-scoped like agent_sessions (0050); role logic
-- lives in the worker layer, not RLS.

CREATE TABLE IF NOT EXISTS api_credentials (
    id           UUID PRIMARY KEY,
    user_id      TEXT NOT NULL,               -- users.id (as text); owner of the credential
    name         TEXT NOT NULL,               -- human label, shown in management UIs
    token_prefix TEXT NOT NULL,               -- first 12 chars of the plaintext token (display only)
    token_hash   TEXT NOT NULL UNIQUE,        -- SHA-256 hex of the full token
    mode         TEXT NOT NULL CHECK (mode IN ('ask', 'act')),
    org_id       TEXT,                         -- optional org scope
    project_id   TEXT,                         -- optional project scope
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ,                  -- null = never expires
    last_used_at TIMESTAMPTZ,                  -- throttled bump (>=5min) on validate
    revoked_at   TIMESTAMPTZ                   -- null = active
);

CREATE INDEX IF NOT EXISTS idx_api_credentials_user ON api_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_api_credentials_token_hash ON api_credentials(token_hash);
