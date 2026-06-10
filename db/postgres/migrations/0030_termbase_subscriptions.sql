-- Postgres migration 0030: org termbase publish/subscribe
--
-- Mirrors D1 migration auth-worker/migrations/0030_termbase_subscriptions.sql
-- (terminology Slices 6-7). ADDITIVE ONLY — one publish-flag column on
-- `projects` plus the subscriptions join table. Both are already present in
-- db/postgres/schema.sql, so fresh databases are unaffected — this patches
-- databases provisioned before they were added.
--
-- Apply once against the Neon prod DB:
--   psql "$NEON_DATABASE_URL" -f db/postgres/migrations/0030_termbase_subscriptions.sql
-- or via the Neon dashboard SQL editor. The local dev stack applies it
-- automatically on boot (scripts/dev-stack.ts).
--
-- Idempotent: IF NOT EXISTS guards prevent errors on re-runs.

-- 1. Publish flag on projects (additive; default false).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS org_published_termbase BOOLEAN NOT NULL DEFAULT FALSE;

-- Discoverability index: only published rows matter for the org listing.
CREATE INDEX IF NOT EXISTS idx_projects_org_published_termbase
  ON projects (org_id)
  WHERE org_published_termbase = TRUE;

-- 2. Subscriptions join table. PK (project_id, termbase_project_id) makes a
--    subscription idempotent (re-subscribe = no-op / priority update).
CREATE TABLE IF NOT EXISTS project_termbase_subscriptions (
    project_id          TEXT    NOT NULL,
    termbase_project_id TEXT    NOT NULL,
    priority            INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (project_id, termbase_project_id)
);

-- Lookup by upstream termbase (e.g. "who subscribes to me?" + implicit-grant
-- reverse checks).
CREATE INDEX IF NOT EXISTS idx_termbase_subs_termbase
  ON project_termbase_subscriptions (termbase_project_id);
