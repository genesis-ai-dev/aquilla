-- Migration 0136: row-level security for contextual_run_traces.
--
-- 0129 created the table with no policy and no entry in the UNCOVERED ledger
-- (scripts/rls-coverage.test.ts), which left it the only contextual table
-- outside the backstop — and it is the one that stores prompts and replies,
-- the project's working text. This gives it the same exact-project policy as
-- its siblings (0074 / 0076): app_contextual_project_scope(project_id).
--
-- Every caller today uses the bare runtime handle, after authorizing at the
-- route or run boundary (auth-worker/src/lib/contextual/traces.ts):
--   • INSERT — TraceRecorder, flushed by the run driver once per wave.
--   • SELECT — GET /contextual/runs/:runId/traces, behind a VIEWER check.
--   • DELETE — pruneExpiredTraces, the 30-day retention sweep on the
--     5-minute cron.
-- Rows are never rewritten, so there is no UPDATE policy and no UPDATE grant.

ALTER TABLE contextual_run_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE contextual_run_traces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_contextual_run_traces_select ON contextual_run_traces;
CREATE POLICY rls_contextual_run_traces_select ON contextual_run_traces FOR SELECT TO app_runtime
  USING (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_run_traces_insert ON contextual_run_traces;
CREATE POLICY rls_contextual_run_traces_insert ON contextual_run_traces FOR INSERT TO app_runtime
  WITH CHECK (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_run_traces_delete ON contextual_run_traces;
CREATE POLICY rls_contextual_run_traces_delete ON contextual_run_traces FOR DELETE TO app_runtime
  USING (app_contextual_project_scope(project_id));

-- Policies alone are unreachable without a grant (0034): RLS and table
-- privileges are independent layers, and app_runtime has none by default.
GRANT SELECT, INSERT, DELETE ON TABLE contextual_run_traces TO app_runtime;
-- Unlike its siblings (text uuidv7 ids) this table's id is bigserial, so an
-- INSERT also draws from the backing sequence.
GRANT USAGE ON SEQUENCE contextual_run_traces_id_seq TO app_runtime;
