-- MCP OAuth (ChatGPT plugin / Claude / Codex connectors): authorization codes
-- for the OAuth 2.1 authorization-code + PKCE grant on the identity worker
-- (auth-worker/src/routes/mcp-oauth.ts). A redeemed code mints an ordinary
-- api_credentials row, so the Agent API and MCP server need no new token type.
--
-- Only the SHA-256 of the code persists. Codes live five minutes and redeem
-- once; a replayed code revokes the credential it minted (OAuth 2.1 §4.1.3),
-- which is why credential_id is kept. Exactly one of project_id / org_id is
-- set — the human approves one scope, as in the device flow (0090).
CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'act')),
  project_id TEXT,
  org_id TEXT,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'consumed')),
  credential_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((project_id IS NULL) <> (org_id IS NULL))
);
CREATE INDEX IF NOT EXISTS mcp_oauth_codes_expiry ON mcp_oauth_codes(expires_at);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_oauth_codes TO app_runtime;
  END IF;
END $$;
