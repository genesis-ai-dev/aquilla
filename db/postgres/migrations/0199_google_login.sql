-- AQU-1057. Passwordless identities use the normal Aquilla session lifecycle.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
CREATE TABLE IF NOT EXISTS provider_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, user_id)
);
-- No provider access/refresh tokens. Temporary codes are hashed at rest.
CREATE TABLE IF NOT EXISTS social_login_flows (
  state_hash TEXT PRIMARY KEY,
  browser_challenge TEXT NOT NULL,
  google_verifier TEXT,
  nonce TEXT NOT NULL,
  app_origin TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','callback','ready','pending','consumed')),
  code_hash TEXT UNIQUE,
  subject TEXT,
  email TEXT,
  authoritative_email BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX IF NOT EXISTS social_login_flows_expiry ON social_login_flows(expires_at);
