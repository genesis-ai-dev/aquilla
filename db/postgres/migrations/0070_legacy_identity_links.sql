-- 0070_legacy_identity_links.sql — AQU-713
-- One-way frontier-db-v2 identity provenance plus database-enforced,
-- case-insensitive identity uniqueness.

-- Refuse to add the unique indexes if historical case-twins exist. Nothing in
-- this migration is committed when this preflight raises.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users GROUP BY LOWER(username) HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'users contains case-insensitive username duplicates';
  END IF;
  IF EXISTS (
    SELECT 1 FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'users contains case-insensitive email duplicates';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci
  ON users (LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci
  ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS legacy_identity_links (
  source            TEXT NOT NULL,
  source_user_id    BIGINT NOT NULL,
  neon_user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_username   TEXT NOT NULL,
  source_email      TEXT NOT NULL,
  gitlab_user_id    BIGINT NOT NULL,
  imported_via      TEXT NOT NULL CHECK (imported_via IN ('jit', 'scheduled')),
  imported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_user_id),
  UNIQUE (source, neon_user_id)
);

CREATE INDEX IF NOT EXISTS idx_legacy_identity_links_neon_user
  ON legacy_identity_links (neon_user_id);

GRANT SELECT, INSERT ON TABLE legacy_identity_links TO app_runtime;
