-- Postgres migration 0029: add org_settings table
--
-- Mirrors D1 migration auth-worker/migrations/0029_org_settings.sql (versioned
-- per-org settings blob; same optimistic-concurrency design as project_settings).
-- The D1 migration ran against SQLite; this one applies the equivalent change
-- to Postgres. The table is already present in db/postgres/schema.sql, so fresh
-- databases are unaffected — this patches databases provisioned before it was
-- added. Without it, GET /api/v2/orgs/:orgId/settings 500s with
-- `relation "org_settings" does not exist` (42P01).
--
-- Note: the D1 file also creates idx_org_settings_updated_at; schema.sql
-- deliberately carries no such index for Postgres, so none is created here.
--
-- Apply once against the Neon prod DB:
--   psql "$NEON_DATABASE_URL" -f db/postgres/migrations/0029_org_settings.sql
-- or via the Neon dashboard SQL editor. The local dev stack applies it
-- automatically on boot (scripts/dev-stack.ts).
--
-- Idempotent: IF NOT EXISTS guard prevents errors on re-runs.
CREATE TABLE IF NOT EXISTS org_settings (
    org_id     BIGINT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    settings   TEXT NOT NULL DEFAULT '{}',
    version    INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now(),
    updated_by BIGINT REFERENCES users(id)
);
