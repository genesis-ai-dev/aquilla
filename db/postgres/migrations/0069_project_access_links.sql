-- 0069_project_access_links.sql — AQU-626: authenticated per-user project
-- links protected by a PIN.
--
-- The feature originally landed with its D1 migration and declarative
-- Postgres schema, but without a Neon migration. Keep this definition aligned
-- with db/postgres/schema.sql so existing Neon branches can advance safely.

CREATE TABLE IF NOT EXISTS project_access_links (
    token           TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    user_id         BIGINT NOT NULL,
    pin_hash        TEXT NOT NULL,
    role_level      INTEGER NOT NULL DEFAULT 400,
    created_by      BIGINT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_access_links_project
  ON project_access_links(project_id);

CREATE INDEX IF NOT EXISTS idx_project_access_links_user
  ON project_access_links(user_id);
