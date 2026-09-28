-- 0119_access_grants_view_v2.sql — AQU-1352 P2 (spec §3, §5).
--
-- Replaces the 0117 view:
--   1. WITH (security_invoker = true). 0117 ran with the owner's rights, which
--      bypasses the AQU-289 RLS backstop on the underlying tables.
--   2. Adds team-scope rows (scope_type 'team', scope_id = group id) for
--      group_members with a non-NULL role_level (migration 0118).
-- Existing rows and columns are unchanged.
CREATE OR REPLACE VIEW access_grants WITH (security_invoker = true) AS
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
   WHERE p.created_by IS NOT NULL
  UNION ALL
  SELECT gm.user_id::BIGINT, 'team'::TEXT, gm.group_id::TEXT,
         gm.role_level::INT, 'direct'::TEXT, NULL::BIGINT,
         gm.added_by::BIGINT, gm.added_at
    FROM group_members gm
   WHERE gm.role_level IS NOT NULL;

GRANT SELECT ON access_grants TO app_runtime;
