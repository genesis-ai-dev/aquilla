-- AQU-837: sandbox rehearsal only. One unresolved checkout per workspace.
-- Never delete/reuse an attempt to recover an ambiguous Stripe response.
CREATE TABLE IF NOT EXISTS workspace_checkout_attempts (
  id TEXT PRIMARY KEY,
  org_id BIGINT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  catalog_json JSONB NOT NULL CHECK (jsonb_typeof(catalog_json) = 'object'),
  prices_json JSONB NOT NULL CHECK (jsonb_typeof(prices_json) = 'array'),
  quote_json JSONB NOT NULL CHECK (jsonb_typeof(quote_json) = 'object'),
  request_params JSONB NOT NULL CHECK (jsonb_typeof(request_params) = 'object'),
  expires_at BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id TEXT UNIQUE,
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox = TRUE)
);
