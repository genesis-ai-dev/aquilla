-- 0083: durable team channel — the one-channel message store (AQU-1049 port).
--
-- Ported and simplified from the AQU-1049→1053 worktree series
-- (`team_threads` / `team_messages`) to the v2 one-channel model in
-- docs/superpowers/specs/2026-08-28-agent-social-workspace-design.md.
--
-- What changed versus the donor tables:
--
--   • `team_messages.thread_id` is NULLABLE. NULL means the MAIN project
--     channel. The donor required every message to live in a thread, which
--     cannot express "the Coordinator narrating at top level" — the main
--     channel IS the team overview in v2.
--   • Authors are `(author_kind, author_id)` text, not `author_user_id`.
--     Personas ('drafter'/'reviewer'/'coordinator') speak here alongside
--     humans; a users FK could not represent them. Human `author_id` is the
--     username, matching how contextual steering records `created_by`.
--   • The body is jsonb with a `body_kind` tag rather than plain text, so
--     durable pipeline activity ('activity') and plain talk ('text') share
--     one ordered history instead of needing a second table.
--   • Threads carry `(source_kind, source_ref)` — one thread per work item,
--     e.g. source_ref = a contextual run id — so the ingestion write-through
--     can find-or-create a run's thread without a second lookup table. The
--     donor's `team_runs` join table is therefore not ported.
--   • The donor's monotonic `position`/`sequence` counters are dropped.
--     Ordering and cursors are `(created_at, id)`; `created_at` defaults to
--     clock_timestamp() (statement time) so two rows written inside one
--     transaction still order deterministically. A per-thread counter would
--     have to be bumped under a row lock by the autopilot tick, which writes
--     activity outside any request transaction.
--   • No `next_sequence`, no release-flag gate (the surface ships unflagged
--     on dev — see the route module for that divergence).
--
-- Foreign keys are intentionally omitted, matching db/postgres/schema.sql.
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0083_team_channel.sql

CREATE TABLE IF NOT EXISTS team_threads (
  id text PRIMARY KEY,                  -- uuid
  project_id text NOT NULL,
  -- What spawned the thread. 'run' = a contextual autopilot run (source_ref
  -- is its run id); 'human' = opened from the channel by a person.
  source_kind text NOT NULL CHECK (source_kind IN ('run', 'human')),
  source_ref text,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (char_length(id) = 36),
  CHECK (octet_length(project_id) <= 512),
  CHECK (source_ref IS NULL OR octet_length(source_ref) <= 512),
  -- One thread per work item. NULLs are distinct in Postgres unique
  -- constraints, so human-opened threads (source_ref IS NULL) never collide
  -- while ingestion can use ON CONFLICT to find-or-create a run's thread.
  UNIQUE (project_id, source_kind, source_ref)
);
CREATE INDEX IF NOT EXISTS team_threads_project_time
  ON team_threads(project_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS team_messages (
  id text PRIMARY KEY,                  -- uuid
  project_id text NOT NULL,
  -- NULL = the main project channel.
  thread_id text,
  author_kind text NOT NULL CHECK (author_kind IN ('human', 'persona')),
  -- Username for a human; persona id ('drafter'/'reviewer'/'coordinator')
  -- for an agent teammate. Deliberately an open registry: new personas
  -- (terminology, audio, import) join without a migration.
  author_id text NOT NULL CHECK (char_length(author_id) BETWEEN 1 AND 128),
  body_kind text NOT NULL CHECK (body_kind IN ('text', 'activity', 'question')),
  body jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(body) = 'object')
    CHECK (octet_length(body::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (char_length(id) = 36),
  CHECK (octet_length(project_id) <= 512),
  CHECK (thread_id IS NULL OR char_length(thread_id) = 36)
);
-- Main-channel page: partial index so the top-level read never walks thread
-- traffic, which is the bulk of the rows on a busy project.
CREATE INDEX IF NOT EXISTS team_messages_main_time
  ON team_messages(project_id, created_at DESC, id DESC)
  WHERE thread_id IS NULL;
CREATE INDEX IF NOT EXISTS team_messages_thread_time
  ON team_messages(project_id, thread_id, created_at DESC, id DESC);

-- Runtime appends and reads; it never rewrites a message. Threads take an
-- UPDATE for `updated_at`/`status` only. Tenant scoping stays at the
-- authenticated route boundary, matching the sibling contextual tables whose
-- background driver has no request-scoped RLS identity.
ALTER TABLE team_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_threads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_team_threads ON team_threads;
CREATE POLICY rls_team_threads ON team_threads
  AS PERMISSIVE FOR ALL TO app_runtime
  USING (
    NULLIF(current_setting('app.project_id', true), '') IS NULL
    OR project_id = current_setting('app.project_id', true)
  )
  WITH CHECK (
    NULLIF(current_setting('app.project_id', true), '') IS NULL
    OR project_id = current_setting('app.project_id', true)
  );

ALTER TABLE team_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_team_messages ON team_messages;
CREATE POLICY rls_team_messages ON team_messages
  AS PERMISSIVE FOR ALL TO app_runtime
  USING (
    NULLIF(current_setting('app.project_id', true), '') IS NULL
    OR project_id = current_setting('app.project_id', true)
  )
  WITH CHECK (
    NULLIF(current_setting('app.project_id', true), '') IS NULL
    OR project_id = current_setting('app.project_id', true)
  );

GRANT SELECT, INSERT, UPDATE ON TABLE team_threads TO app_runtime;
GRANT SELECT, INSERT ON TABLE team_messages TO app_runtime;
