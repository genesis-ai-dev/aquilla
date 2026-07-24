-- Migration 0069: external integrations (provider-generic) — Monday.com first.
--
-- Monday is the first of several planned integrations, so the storage is
-- provider-generic (`provider` discriminator, currently always 'monday'):
--   * integration_connections — ONE OAuth connection per (org, provider).
--     Tokens are AES-GCM encrypted (base64(iv||ciphertext), key =
--     SHA-256(SECRET_KEY || ":monday-token") for Monday) — never plaintext,
--     never returned by any route. `account` absorbs provider identity fields
--     (for Monday: accountId/accountSlug/userId/userName).
--   * integration_links — ONE remote link per (project, provider), using the
--     org's connection (cascading delete). For Monday: external_id = board id,
--     config = MondayMapping (auth-worker/src/lib/monday/types.ts),
--     remote_state = cached board structure. `dirty_at` marks a debounced
--     pending push; the auth-worker cron flushes dirty links every 5 minutes.
--   * integration_item_links — Aquilla entity (project or file) → remote item
--     id, for idempotent upserts. Cleared by item-deleted webhooks.

CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY,                -- uuid
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL,             -- 'monday' (first of several)
  account JSONB,                      -- provider identity, e.g. {accountId, accountSlug, userId, userName}
  access_token_enc TEXT NOT NULL,     -- AES-GCM, base64(iv||ciphertext)
  refresh_token_enc TEXT,             -- OAuth 2.1 rotating refresh token, same encryption; NULL for legacy non-expiring tokens
  access_token_expires_at TIMESTAMPTZ,-- from the access-token JWT exp claim; NULL = non-expiring (legacy flow)
  needs_reauth BOOLEAN NOT NULL DEFAULT FALSE, -- set when refresh fails (revoked/max lifetime); cleared on successful OAuth callback
  scopes TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider)
);

CREATE TABLE IF NOT EXISTS integration_links (
  id TEXT PRIMARY KEY,                -- uuid
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,             -- 'monday'
  connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,          -- remote container id (Monday: board id)
  external_name TEXT,                 -- remote container name (Monday: board name)
  config JSONB NOT NULL,              -- per-provider mapping config (Monday: MondayMapping)
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  webhook_ids JSONB NOT NULL DEFAULT '[]'::jsonb,   -- remote webhook ids we created
  remote_state JSONB,                 -- cached remote structure (Monday: {fetchedAt, columns, groups})
  remote_state_stale BOOLEAN NOT NULL DEFAULT FALSE,
  dirty_at TIMESTAMPTZ,               -- set when progress changed but push was debounced
  last_pushed_at TIMESTAMPTZ,
  last_push_status TEXT,              -- 'ok' | 'error'
  last_push_error TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_integration_links_dirty ON integration_links (dirty_at) WHERE dirty_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration_item_links (
  link_id TEXT NOT NULL REFERENCES integration_links(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL,          -- 'project' | 'file'
  entity_id TEXT NOT NULL,            -- project_id or file_id
  external_item_id TEXT NOT NULL,     -- remote item id (Monday: item id)
  PRIMARY KEY (link_id, entity_kind, entity_id)
);
