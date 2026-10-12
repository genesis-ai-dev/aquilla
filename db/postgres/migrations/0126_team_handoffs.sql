-- 0126: human-expert handoffs on the shared team channel (AQU-1052 port).
--
-- The team channel (0122) gives the project one shared history in which the
-- agent personas and the humans speak. What it has no record of is the ask
-- that runs the other way: a contributor who hits a question only a human
-- expert can settle, and the agent work that is waiting on the answer.
--
-- A handoff is that ask, as a ROW beside the thread it is discussed in:
--
--   request    question + requested_by + created_at
--   assignment assigned_to + assigned_by + assigned_at
--   answer     answer + answered_by + answered_at
--   resume     resumed_by + resumed_at
--
-- Four facts, each with its actor and its time, which is the whole point:
-- "someone asked, someone answered, the work carried on" has to be
-- reconstructible months later by a lead who was not in the room.
--
-- Why a table and not just messages in the thread: assignment is MUTABLE
-- state ("who is this waiting on right now") and the open set is read
-- project-wide. Deriving either by folding an append-only, paged message
-- history would make a correctness question out of a cheap index. The
-- conversation still lives in the channel — the ask opens a `human` thread
-- and posts the question into the main channel, the answer is posted into
-- that thread — so nothing here is a second, competing history.
--
-- Divergences from `contextual_decisions`, the agent → human sibling:
--
--   • Actors are USERNAMES, not user ids. This is the team channel's own
--     vocabulary (`team_messages.author_id`), and a handoff's actors are
--     rendered beside messages written by the same people; a join per name
--     to render a thread is the wrong trade.
--   • Answering does NOT resume the dependent work. A decision answer wakes
--     its blocked run, because the run asked the question and is sitting on
--     the reply. A handoff is raised by a PERSON about work that person
--     parked, and the answer may well be "stop, this file is wrong" — so
--     resuming is a separate, explicit act, recorded as its own fact.
--   • No `superseded`/`expired` sweep. Nothing deterministic can close a
--     question addressed to a human; it stays open until someone answers.
--
-- Foreign keys are intentionally omitted, matching db/postgres/schema.sql.
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0126_team_handoffs.sql

CREATE TABLE IF NOT EXISTS team_handoffs (
  id text PRIMARY KEY,                  -- uuid
  project_id text NOT NULL,
  -- The `human` thread (0122) this ask is discussed in. One thread per
  -- handoff: team_threads.source_ref is this id, which is what lets the
  -- thread be found from the handoff and the handoff from the thread.
  thread_id text NOT NULL,
  -- WHAT is being asked, in the requester's words. Never "review this".
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 2000),
  -- WHO asked. Username, matching team_messages.author_id for a human.
  requested_by text NOT NULL CHECK (char_length(requested_by) BETWEEN 1 AND 128),
  -- The contextual run this ask blocks, if any. NULL is a standalone
  -- question: worth asking and worth recording, with no work waiting on it.
  run_id text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered')),
  -- Routing is an ASSIGNMENT, not an answer: an assigned handoff is still
  -- `open`, and anyone with the knowledge may answer it (same rule as
  -- contextual_decisions).
  assigned_to text,
  assigned_by text,
  assigned_at timestamptz,
  answer text,
  answered_by text,
  answered_at timestamptz,
  resumed_by text,
  resumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (char_length(id) = 36),
  CHECK (char_length(thread_id) = 36),
  CHECK (octet_length(project_id) <= 512),
  CHECK (run_id IS NULL OR octet_length(run_id) <= 512),
  CHECK (answer IS NULL OR char_length(answer) BETWEEN 1 AND 2000),
  -- An assignment is all three columns or none. A routed handoff that cannot
  -- say who routed it, or when, is not the inspectable record this table is
  -- for. Same shape for the answer and the resume.
  CHECK ((assigned_to IS NULL) = (assigned_at IS NULL)
     AND (assigned_to IS NULL) = (assigned_by IS NULL)),
  CHECK ((answer IS NULL) = (answered_by IS NULL)
     AND (answer IS NULL) = (answered_at IS NULL)),
  CHECK ((resumed_at IS NULL) = (resumed_by IS NULL)),
  -- `answered` means exactly "has an accountable answer", so the status and
  -- the answer columns cannot drift apart in either direction.
  CHECK ((status = 'answered') = (answer IS NOT NULL)),
  -- Dependent work can only resume after the answer, and only when there is
  -- dependent work to resume.
  CHECK (resumed_at IS NULL OR (answer IS NOT NULL AND run_id IS NOT NULL))
);
-- One handoff per thread, in both directions.
CREATE UNIQUE INDEX IF NOT EXISTS team_handoffs_thread
  ON team_handoffs(thread_id);
-- The project's list, newest-first, which is how the surface reads it.
CREATE INDEX IF NOT EXISTS team_handoffs_project_time
  ON team_handoffs(project_id, created_at DESC, id DESC);
-- "What is this team waiting on a person for" — oldest first, because the
-- longest-unanswered ask is the one that needs chasing.
CREATE INDEX IF NOT EXISTS team_handoffs_open
  ON team_handoffs(project_id, created_at ASC)
  WHERE status = 'open';
-- "Is this run waiting on a human?" — the run surface's lookup.
CREATE INDEX IF NOT EXISTS team_handoffs_run
  ON team_handoffs(run_id)
  WHERE run_id IS NOT NULL;

ALTER TABLE team_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_team_handoffs ON team_handoffs;
CREATE POLICY rls_team_handoffs ON team_handoffs
  AS PERMISSIVE FOR ALL TO app_runtime
  USING (
    NULLIF(current_setting('app.project_id', true), '') IS NULL
    OR project_id = current_setting('app.project_id', true)
  )
  WITH CHECK (
    NULLIF(current_setting('app.project_id', true), '') IS NULL
    OR project_id = current_setting('app.project_id', true)
  );

GRANT SELECT, INSERT, UPDATE ON TABLE team_handoffs TO app_runtime;
