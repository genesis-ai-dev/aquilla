-- Migration 0055: Agent API changeset engine (AQU-533, §3 + §2 provenance).
--
-- Three additive changes:
--   1. events.provenance — nullable JSONB envelope stamped ONLY by the external
--      changeset commit path (§2). Every existing writer leaves it NULL; the
--      canonical event insert never touches it. Adding a nullable column is a
--      metadata-only operation and does not rewrite the (large) events table.
--   2. changesets — immutable execution plans (commands + preconditions +
--      server-computed summary + digest + receipt).
--   3. changeset_confirmations — one-time ask-mode human approval assertions,
--      consumed exactly once at commit.
--
-- Storage decision (design §4 D9): greenfield tables start on Postgres to avoid
-- a later migration and D1's single-writer ceiling for large plans.

-- 1. Provenance envelope on the event log.
ALTER TABLE events ADD COLUMN IF NOT EXISTS provenance JSONB;

-- 2. Changesets.
CREATE TABLE IF NOT EXISTS changesets (
    id                 TEXT PRIMARY KEY,          -- client-supplied UUIDv7
    project_id         TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,             -- the credential's owning user
    credential_id      TEXT NOT NULL,
    autonomy_mode      TEXT NOT NULL CHECK (autonomy_mode IN ('ask', 'act')),
    status             TEXT NOT NULL DEFAULT 'staged'
                         CHECK (status IN ('staged', 'committed', 'discarded', 'stale', 'expired')),
    commands           JSONB NOT NULL,
    preconditions      JSONB NOT NULL,
    summary            JSONB NOT NULL,
    digest             TEXT NOT NULL,
    receipt            JSONB,
    confirmation_id    TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at         TIMESTAMPTZ NOT NULL,
    committed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_changesets_project_status ON changesets(project_id, status);

-- 3. Ask-mode approval assertions.
CREATE TABLE IF NOT EXISTS changeset_confirmations (
    id            TEXT PRIMARY KEY,
    changeset_id  TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    digest        TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_changeset_confirmations_changeset
  ON changeset_confirmations(changeset_id);

-- ─────────────── tenant-isolation RLS backstop (mirrors 0034/0053) ───────────────
-- Defence-in-depth: rows are visible to app_runtime only for projects the
-- SET LOCAL app.user_id belongs to. Role logic stays in the worker layer;
-- this only answers "does the current user belong to this project?".
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE changesets TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE changeset_confirmations TO app_runtime;

ALTER TABLE changesets ENABLE ROW LEVEL SECURITY;
ALTER TABLE changesets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_changesets_project_access ON changesets;
CREATE POLICY rls_changesets_project_access ON changesets
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));

-- Confirmations carry no project_id of their own; scope them through the
-- parent changeset's project so the same access rule applies transitively.
ALTER TABLE changeset_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE changeset_confirmations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_changeset_confirmations_project_access ON changeset_confirmations;
CREATE POLICY rls_changeset_confirmations_project_access ON changeset_confirmations
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (
    EXISTS (
      SELECT 1 FROM changesets c
      WHERE c.id = changeset_confirmations.changeset_id
        AND app_user_can_access_project(c.project_id)
    )
  );
