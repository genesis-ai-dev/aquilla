-- AQU-1107 / AQU-435: floor the RLS org path at Maintainer+.
--
-- Migration 0034's app_user_can_access_project Path 3 treated ANY org_members
-- row as project access. That predates AQU-435: org membership is oversight
-- for Maintainer+ (role_level >= 600), not a blanket grant. A Contributor
-- reaches a project only via project_members, a group grant, or creator.
--
-- CREATE OR REPLACE so existing databases pick up the floor without dropping
-- the function (policies keep calling it by name).

CREATE OR REPLACE FUNCTION app_user_can_access_project(p_project_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT EXISTS (
    WITH uid AS (
      SELECT COALESCE(
        NULLIF(current_setting('app.user_id', true), '')::bigint,
        0
      ) AS id
    )
    SELECT 1 FROM uid WHERE uid.id <> 0 AND (
      EXISTS (
        SELECT 1 FROM project_members pm
         WHERE pm.project_id = p_project_id AND pm.user_id = uid.id
      )
      OR
      EXISTS (
        SELECT 1 FROM group_project_grants gpg
          JOIN group_members gm ON gm.group_id = gpg.group_id
         WHERE gpg.project_id = p_project_id AND gm.user_id = uid.id
      )
      OR
      -- Path 3: org-wide oversight — Maintainer+ only (AQU-435 / AQU-1107)
      EXISTS (
        SELECT 1 FROM projects pr
          JOIN org_members om ON om.org_id = pr.org_id
         WHERE pr.id = p_project_id
           AND pr.org_id IS NOT NULL
           AND om.user_id = uid.id
           AND om.role_level >= 600
      )
      OR
      EXISTS (
        SELECT 1 FROM projects pr
         WHERE pr.id = p_project_id AND pr.created_by = uid.id
      )
    )
  )
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_user_can_access_project(TEXT) TO app_runtime;
  END IF;
END
$$;
