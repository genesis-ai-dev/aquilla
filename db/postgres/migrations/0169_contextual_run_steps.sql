-- AQU-1845 — per-LLM-call checkpoint for Autopilot waves.
--
-- A wave's model calls used to be lost whenever its driver died mid-flight:
-- the run cursor only advances past a COMPLETED wave, so the replay re-issued
-- (and re-paid for) every call the dead attempt had already finished. This
-- table is the checkpoint between those two attempts — one row per model call,
-- written the moment the call returns, read by the replay before it dials the
-- provider.
--
-- Rows are ephemeral coordination state, like contextual_project_leases: the
-- driver clears a run's rows after every wave that completes (the cursor has
-- moved; nothing will replay those spans) and on settlement. `created_at`
-- carries the retention sweep for rows whose driver died without ever coming
-- back.
--
-- `project_id` exists for the RLS policy below, not for any read path — the
-- driver always knows the run's project, and carrying it keeps this table
-- under exactly the scope helper its sibling contextual tables use instead of
-- becoming the one unscoped table in the group.
CREATE TABLE IF NOT EXISTS contextual_run_steps (
  run_id     text NOT NULL,
  project_id text NOT NULL,
  step_key   text NOT NULL,
  output     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_key),
  CHECK (octet_length(run_id) <= 512),
  CHECK (octet_length(project_id) <= 512),
  CHECK (octet_length(step_key) <= 512)
);

CREATE INDEX IF NOT EXISTS contextual_run_steps_created
  ON contextual_run_steps(created_at);

-- Same scope as the sibling contextual tables (0074): an authenticated route
-- sees only its own project, and the background driver — which has no
-- request-scoped identity — takes the bare-worker path.
ALTER TABLE contextual_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE contextual_run_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_contextual_run_steps_select ON contextual_run_steps;
CREATE POLICY rls_contextual_run_steps_select ON contextual_run_steps FOR SELECT TO app_runtime
  USING (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_run_steps_insert ON contextual_run_steps;
CREATE POLICY rls_contextual_run_steps_insert ON contextual_run_steps FOR INSERT TO app_runtime
  WITH CHECK (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_run_steps_delete ON contextual_run_steps;
CREATE POLICY rls_contextual_run_steps_delete ON contextual_run_steps FOR DELETE TO app_runtime
  USING (app_contextual_project_scope(project_id));

-- No UPDATE: a checkpoint is written once and then only read or dropped.
GRANT SELECT, INSERT, DELETE ON TABLE contextual_run_steps TO app_runtime;
