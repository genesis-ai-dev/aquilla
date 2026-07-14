-- Migration 0054: set-based RLS policies (projects-list timeout fix)
--
-- WHY
-- ---
-- The 0034/0053 RLS policies call app_user_can_access_project(project_id)
-- in their USING clause. That scalar function contains a CTE + four EXISTS
-- subqueries, so Postgres cannot inline it: it executes ONCE PER CANDIDATE
-- ROW. Any query that scans many rows of an RLS'd table pays
-- rows × (4 index probes) — O(N) function calls with real per-call cost.
--
-- The worst hit is auth-worker's GET /api/v2/projects: it loads file
-- projections for EVERY project the caller can access in one
-- `WHERE project_id IN (...)` query. For an org member (org-wide access to
-- all org projects) the policy fires once per file row. Measured on the
-- canonical schema at 300 projects × 40 files (12k file rows):
--
--     per-row function policy:  ~650 ms, 96,156 buffer reads
--     set-based policy (below):  ~10 ms,     169 buffer reads
--
-- On Neon over Hyperdrive with production table sizes this is the
-- difference between a normal response and a statement/Worker timeout —
-- i.e. the projects list going down for exactly the users with the most
-- projects.
--
-- WHAT
-- ----
-- Replace the per-row predicate with an uncorrelated set membership test:
--
--     USING (project_id IN (SELECT app_accessible_project_ids()))
--
-- app_accessible_project_ids() returns the full set of project ids the
-- current user can access (same four paths as app_user_can_access_project:
-- direct / group / org / creator). Because the subquery does not reference
-- the candidate row, the planner evaluates it ONCE per statement and hashes
-- the result — every subsequent row check is a hash probe.
--
-- Semantics are unchanged, including fail-closed behaviour: a missing or
-- empty app.user_id coalesces to user id 0, which matches no membership
-- row, so the function returns an empty set and the policy hides all rows
-- (same as the old function returning FALSE).
--
-- app_user_can_access_project() is kept as-is: it remains the right tool
-- for single-project point checks and is still referenced by tests.
--
-- APPLY (owner role, same procedure as 0034 — see db/postgres/RLS.md):
--   psql $NEON_OWNER_CONNECTION_STRING -f db/postgres/migrations/0054_rls_set_based_policies.sql

-- ─────────────────────── accessible-projects helper ────────────────────────

CREATE OR REPLACE FUNCTION app_accessible_project_ids()
RETURNS SETOF TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  -- Path 1: direct project_members row
  SELECT pm.project_id
    FROM project_members pm
   WHERE pm.user_id = COALESCE(NULLIF(current_setting('app.user_id', true), '')::bigint, 0)
  UNION
  -- Path 2: group grant (group_project_grants ∩ group_members)
  SELECT gpg.project_id
    FROM group_project_grants gpg
    JOIN group_members gm ON gm.group_id = gpg.group_id
   WHERE gm.user_id = COALESCE(NULLIF(current_setting('app.user_id', true), '')::bigint, 0)
  UNION
  -- Path 3: org-wide membership (when project has an org)
  SELECT pr.id
    FROM projects pr
    JOIN org_members om ON om.org_id = pr.org_id
   WHERE om.user_id = COALESCE(NULLIF(current_setting('app.user_id', true), '')::bigint, 0)
  UNION
  -- Path 4: creator fallback
  SELECT pr.id
    FROM projects pr
   WHERE pr.created_by = COALESCE(NULLIF(current_setting('app.user_id', true), '')::bigint, 0)
$$;

GRANT EXECUTE ON FUNCTION app_accessible_project_ids() TO app_runtime;

-- Supporting indexes for the helper's four paths. All are already in
-- schema.sql; IF NOT EXISTS makes this migration self-sufficient against a
-- hand-managed live database that might predate them.
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user   ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user     ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_by  ON projects(created_by);

-- ─────────────────────── recreate policies set-based ───────────────────────
-- Same names, same tables (0034 + file_section_progress from 0053), same
-- PERMISSIVE / FOR ALL / TO app_runtime shape — only the USING predicate
-- changes. CREATE POLICY has no OR REPLACE, hence DROP + CREATE.

-- cells
DROP POLICY IF EXISTS rls_cells_project_access ON cells;
CREATE POLICY rls_cells_project_access ON cells
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (project_id IN (SELECT app_accessible_project_ids()));

-- events
DROP POLICY IF EXISTS rls_events_project_access ON events;
CREATE POLICY rls_events_project_access ON events
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (project_id IN (SELECT app_accessible_project_ids()));

-- files
DROP POLICY IF EXISTS rls_files_project_access ON files;
CREATE POLICY rls_files_project_access ON files
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (project_id IN (SELECT app_accessible_project_ids()));

-- comments
DROP POLICY IF EXISTS rls_comments_project_access ON comments;
CREATE POLICY rls_comments_project_access ON comments
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (project_id IN (SELECT app_accessible_project_ids()));

-- cell_validators
DROP POLICY IF EXISTS rls_cell_validators_project_access ON cell_validators;
CREATE POLICY rls_cell_validators_project_access ON cell_validators
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (project_id IN (SELECT app_accessible_project_ids()));

-- cell_audio
DROP POLICY IF EXISTS rls_cell_audio_project_access ON cell_audio;
CREATE POLICY rls_cell_audio_project_access ON cell_audio
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (project_id IN (SELECT app_accessible_project_ids()));

-- project_settings
DROP POLICY IF EXISTS rls_project_settings_project_access ON project_settings;
CREATE POLICY rls_project_settings_project_access ON project_settings
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (project_id IN (SELECT app_accessible_project_ids()));

-- file_section_progress (added by 0053 with the per-row predicate)
DROP POLICY IF EXISTS rls_file_section_progress_project_access ON file_section_progress;
CREATE POLICY rls_file_section_progress_project_access ON file_section_progress
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (project_id IN (SELECT app_accessible_project_ids()));
