-- 0071: contextual translation run engine (pipeline design §8, slice D1).
--
-- Three tables:
--   contextual_runs     — one row per durable pipeline run; the span cursor
--                         (ordered seed list + next index) makes every tick
--                         resumable from Postgres alone. The tick executor
--                         self-continues server-side; a Workflows driver can
--                         wrap it later without a schema change.
--   contextual_steering — the human steering inbox (direction / refresh_span /
--                         note). Rows are consumed (consumed_at) by the next
--                         tick, never deleted — the trail is the audit log.
--   contextual_drafts   — staged span drafts awaiting human review. v1 design
--                         deviation (documented): drafts persist HERE, not in
--                         the external changesets table. A new proposal on the
--                         same cell supersedes the old proposed row (partial
--                         UNIQUE below), in the same batch.

CREATE TABLE IF NOT EXISTS contextual_runs (
  id text PRIMARY KEY,                  -- uuidv7 (time-ordered; client store compares lexicographically)
  project_id text NOT NULL,
  file_id text NOT NULL,
  target_lang text NOT NULL DEFAULT '', -- lane ('' = the file's single target language)
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','pausing','paused','parked','done','failed','terminated')),
  initiated_by text,                    -- username
  role_snapshot jsonb,                  -- {userId, username, level} at start
  span_cursor jsonb,                    -- {seeds:[SpanSeed…], nextIndex:int}; NULL until the first tick derives seeds
  done_spans integer NOT NULL DEFAULT 0,
  total_spans integer NOT NULL DEFAULT 0,
  failed_spans integer NOT NULL DEFAULT 0,
  units_spent integer NOT NULL DEFAULT 0,
  calls_spent integer NOT NULL DEFAULT 0,
  last_error text,
  steering_cursor timestamptz,          -- last steering read; informational
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One ACTIVE run per (project, file, lane). Partial UNIQUE both serves the
-- pill's hydrate lookup and enforces createRun's refuse-double-active.
CREATE UNIQUE INDEX IF NOT EXISTS contextual_runs_active
  ON contextual_runs(project_id, file_id, target_lang)
  WHERE status IN ('running','pausing','paused','parked');

CREATE TABLE IF NOT EXISTS contextual_steering (
  id text PRIMARY KEY,                  -- uuidv7
  project_id text NOT NULL,
  file_id text,                         -- NULL = project-wide
  run_id text,                          -- NULL = any run on the scope
  kind text NOT NULL CHECK (kind IN ('direction','refresh_span','note')),
  body text NOT NULL,                   -- ≤10KB, enforced in code (db/shared/contextual-runs.ts)
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz               -- NULL = not yet read by a tick
);
CREATE INDEX IF NOT EXISTS contextual_steering_scope
  ON contextual_steering(project_id, created_at);

CREATE TABLE IF NOT EXISTS contextual_drafts (
  id text PRIMARY KEY,                  -- uuidv7
  run_id text NOT NULL,
  project_id text NOT NULL,
  file_id text NOT NULL,
  cell_id text NOT NULL,
  scene_brief_id text,
  text text NOT NULL,
  verdicts jsonb,                       -- verifier verdict summary for the review card
  provenance jsonb,                     -- {spanId, promptVersion, exampleIds…}
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','applied','rejected','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by text
);
-- One live proposal per cell; a re-propose supersedes the old row first
-- (same batch) so this index never conflicts.
CREATE UNIQUE INDEX IF NOT EXISTS contextual_drafts_live
  ON contextual_drafts(project_id, file_id, cell_id)
  WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS contextual_drafts_run
  ON contextual_drafts(run_id, status);
