-- AQU-1205: RFC 8628 device grants. Only hashes of both codes persist.
CREATE TABLE IF NOT EXISTS agent_authorizations (
  device_hash TEXT PRIMARY KEY,
  user_code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'act')),
  requested_project_id TEXT,
  project_id TEXT,
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_poll_at TIMESTAMPTZ,
  poll_interval INTEGER NOT NULL DEFAULT 5
);
CREATE INDEX IF NOT EXISTS agent_authorizations_expiry
  ON agent_authorizations(expires_at);

-- Identity-less initiation/redemption is authorized by possession of a code;
-- browser decisions additionally require a live user session and project role.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_authorizations TO app_runtime;
  END IF;
END $$;
