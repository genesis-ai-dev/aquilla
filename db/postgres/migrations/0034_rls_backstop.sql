-- Migration 0034: minimal tenant-isolation RLS backstop (FRO-289)
--
-- PURPOSE
-- -------
-- Defence-in-depth: even if application logic passes the wrong project_id, a
-- row belonging to a different tenant cannot be returned.  This migration does
-- NOT encode the 7-rung role ladder — role logic stays in the workers' services
-- layer.  It answers ONE question per table: "does the current user belong to
-- this project?" — yes → see the row; no → row is invisible.
--
-- DESIGN DECISIONS
-- ----------------
-- * Non-owner runtime role (app_runtime): created once per database instance.
--   Workers connect as app_runtime (NOINHERIT, NOLOGIN base; actual login creds
--   come from the Hyperdrive connection string targeting that role).  The table
--   owner role retains full access for migrations / admin tooling and bypasses
--   RLS automatically (Postgres semantics: owners are BYPASSRLS by default).
--
-- * SET LOCAL app.user_id per transaction (shim responsibility).  Policies read
--   current_setting('app.user_id', true) — the second arg suppresses the
--   "setting not found" error so queries during the pre-SET window fail closed
--   (the function returns 0 → no rows visible) rather than throwing.
--
-- * app_user_can_access_project(project_id TEXT) → BOOLEAN helper.  Mirrors
--   exactly the four resolution paths used by auth-worker's resolveProjectRole
--   at ACCESS level only (not role level):
--     1. direct project_members row
--     2. group grant via group_project_grants + group_members
--     3. org-wide grant via org_members (when projects.org_id IS NOT NULL)
--     4. creator fallback (projects.created_by = user_id)
--   Platform admins (allowlist) are NOT encoded here: they are handled at the
--   worker layer.  The RLS backstop is a last line of defense for normal paths.
--
-- APPLY PROCEDURE (see also db/postgres/RLS.md)
-- -----------------------------------------------
-- 1. Connect as the table-owner role (the existing Neon role used for migrations).
-- 2. Run this migration: psql $OWNER_URL -f 0034_rls_backstop.sql
-- 3. The CREATE ROLE statement is idempotent (IF NOT EXISTS).
-- 4. Grant the runtime role login creds on Neon dashboard (or via SQL):
--      ALTER ROLE app_runtime WITH LOGIN PASSWORD '<strong-password>';
-- 5. Add a second Hyperdrive connection in wrangler.toml (or Cloudflare dashboard)
--    pointing to app_runtime creds (see db/postgres/RLS.md §Hyperdrive).
-- 6. Update both workers' HYPERDRIVE binding to use the app_runtime connection.
-- 7. Soak on staging for ≥24 h; watch for empty-result anomalies (a missed
--    SET LOCAL means 0 rows — silent wrong answers, not 500s).
-- 8. Promote to production.
--
-- PER-TABLE INSTANT ROLLBACK
-- ---------------------------
-- If a missed SET LOCAL causes silent 0-row bugs in prod, disable RLS per table
-- without dropping the policy (policies survive and are re-enabled together):
--   ALTER TABLE cells           DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE events          DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE files           DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE comments        DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE cell_validators DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE cell_audio      DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE project_settings DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE snapshots       DISABLE ROW LEVEL SECURITY;
-- Re-enable when confident all call sites SET LOCAL correctly:
--   ALTER TABLE cells           ENABLE ROW LEVEL SECURITY;
--   -- (repeat for each table)

-- ─────────────────────── runtime role ───────────────────────────────────────

-- Create once; idempotent.  NOINHERIT ensures the role cannot escalate by
-- joining a superuser group.  LOGIN + PASSWORD are set separately on Neon
-- (see APPLY PROCEDURE above) because hashed passwords should not be in
-- version-controlled SQL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOINHERIT NOLOGIN;
  END IF;
END
$$;

-- Grant DML on every app table to app_runtime.
-- We enumerate tables explicitly (not GRANT ON ALL TABLES IN SCHEMA public)
-- so future migrations opt in deliberately and can choose different grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    users,
    organizations,
    org_members,
    groups,
    group_members,
    group_project_grants,
    password_reset_tokens,
    activity_logs,
    projects,
    project_members,
    project_invites,
    project_settings,
    project_termbase_subscriptions,
    org_settings,
    events,
    files,
    cells,
    cell_validators,
    cell_waivers,
    cell_audio,
    cell_backtranslations,
    comments,
    assignments,
    assignment_cells,
    diarization_jobs,
    file_source_blobs,
    checkpoints,
    snapshots,
    cell_word_morph
TO app_runtime;

-- ─────────────────────── access helper ──────────────────────────────────────

-- app_user_can_access_project: returns TRUE if the user identified by
-- current_setting('app.user_id') has ANY access path to the given project.
-- Missing / non-numeric setting → 0 → returns FALSE (fail-closed).
--
-- The four paths mirror auth-worker/src/services/project-permissions.ts
-- resolveProjectRoleInternal at ACCESS level only.  We do not evaluate
-- archived_at here: RLS is a data backstop, not a business-rule gate; the
-- worker layer already handles archive visibility.
CREATE OR REPLACE FUNCTION app_user_can_access_project(p_project_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT EXISTS (
    -- Extract the numeric user id from the session GUC (fail-closed: 0 matches nothing).
    WITH uid AS (
      SELECT COALESCE(
        NULLIF(current_setting('app.user_id', true), '')::bigint,
        0
      ) AS id
    )
    SELECT 1 FROM uid WHERE uid.id <> 0 AND (
      -- Path 1: direct project_members row
      EXISTS (
        SELECT 1 FROM project_members pm
         WHERE pm.project_id = p_project_id AND pm.user_id = uid.id
      )
      OR
      -- Path 2: group grant (group_project_grants ∩ group_members)
      EXISTS (
        SELECT 1 FROM group_project_grants gpg
          JOIN group_members gm ON gm.group_id = gpg.group_id
         WHERE gpg.project_id = p_project_id AND gm.user_id = uid.id
      )
      OR
      -- Path 3: org-wide membership (when project has an org)
      EXISTS (
        SELECT 1 FROM projects pr
          JOIN org_members om ON om.org_id = pr.org_id
         WHERE pr.id = p_project_id AND pr.org_id IS NOT NULL AND om.user_id = uid.id
      )
      OR
      -- Path 4: creator fallback
      EXISTS (
        SELECT 1 FROM projects pr
         WHERE pr.id = p_project_id AND pr.created_by = uid.id
      )
    )
  )
$$;

GRANT EXECUTE ON FUNCTION app_user_can_access_project(TEXT) TO app_runtime;

-- ─────────────────────── RLS policies ───────────────────────────────────────
-- One USING clause per table that answers: "can the current user see this row?"
-- No WITH CHECK clause — write-side project-scoping is enforced by worker logic.
-- FORCE ROW LEVEL SECURITY: applies even to the table owner when acting through
-- this role — but note that the owner role still bypasses RLS when connected
-- directly (Postgres default), which is correct: migrations/admin use the owner.

-- cells
ALTER TABLE cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE cells FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_cells_project_access ON cells;
CREATE POLICY rls_cells_project_access ON cells
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));

-- events
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_events_project_access ON events;
CREATE POLICY rls_events_project_access ON events
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));

-- files
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_files_project_access ON files;
CREATE POLICY rls_files_project_access ON files
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));

-- comments
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_comments_project_access ON comments;
CREATE POLICY rls_comments_project_access ON comments
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));

-- cell_validators
ALTER TABLE cell_validators ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_validators FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_cell_validators_project_access ON cell_validators;
CREATE POLICY rls_cell_validators_project_access ON cell_validators
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));

-- cell_audio
ALTER TABLE cell_audio ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_audio FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_cell_audio_project_access ON cell_audio;
CREATE POLICY rls_cell_audio_project_access ON cell_audio
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));

-- project_settings
ALTER TABLE project_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_project_settings_project_access ON project_settings;
CREATE POLICY rls_project_settings_project_access ON project_settings
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));

-- snapshots
ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_snapshots_project_access ON snapshots;
CREATE POLICY rls_snapshots_project_access ON snapshots
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));
