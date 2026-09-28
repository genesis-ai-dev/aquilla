-- 0117_access_grants_view.sql — AQU-1352 P1 (spec §3, §5).
--
-- One read shape for every project/org grant. Behavior-preserving: no table
-- changes, no caller switched yet. db/shared/access-grants.ts reads this view
-- and resolveFromGrants reproduces resolveProjectRoleShared exactly.
--
-- Rows:
--   org_members                        -> scope 'org',     source 'direct'
--   project_members                    -> scope 'project', source 'direct'
--   group_members x group_project_grants -> scope 'project', source 'team'
--   projects.created_by                -> scope 'project', source 'creator', 700
--
-- Lane and file scopes are NOT here (owned by the lane-permissions work).
-- Archived projects stay in the view; the resolver applies archived_at the
-- same way the current resolver does. Platform admin is env-driven
-- (ADMIN_EMAILS), so it is not a row.
CREATE OR REPLACE VIEW access_grants AS
  SELECT om.user_id::BIGINT            AS user_id,
         'org'::TEXT                   AS scope_type,
         om.org_id::TEXT               AS scope_id,
         om.role_level::INT            AS role_level,
         'direct'::TEXT                AS source,
         NULL::BIGINT                  AS via_team_id,
         om.granted_by::BIGINT         AS granted_by,
         om.granted_at                 AS granted_at
    FROM org_members om
  UNION ALL
  SELECT pm.user_id::BIGINT, 'project'::TEXT, pm.project_id::TEXT,
         pm.role_level::INT, 'direct'::TEXT, NULL::BIGINT,
         pm.granted_by::BIGINT, pm.granted_at
    FROM project_members pm
  UNION ALL
  SELECT gm.user_id::BIGINT, 'project'::TEXT, gpg.project_id::TEXT,
         gpg.role_level::INT, 'team'::TEXT, gpg.group_id::BIGINT,
         gpg.granted_by::BIGINT, gpg.granted_at
    FROM group_project_grants gpg
    JOIN group_members gm ON gm.group_id = gpg.group_id
  UNION ALL
  SELECT p.created_by::BIGINT, 'project'::TEXT, p.id::TEXT,
         700::INT, 'creator'::TEXT, NULL::BIGINT,
         NULL::BIGINT, p.created_at
    FROM projects p
   WHERE p.created_by IS NOT NULL;

GRANT SELECT ON access_grants TO app_runtime;
