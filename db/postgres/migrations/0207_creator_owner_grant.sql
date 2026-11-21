-- AQU-2357: a project's creator holds an ordinary Owner grant.
--
-- projects.created_by stays history. It is not an access path. This migration
-- writes the Owner row the creator path used to imply, then drops that path
-- from the access_grants view and from the RLS helper.
--
-- Idempotent. A creator who already has role_level >= 700 is left alone. A
-- lower row on the same (project, user) is raised to 700, because the unique
-- key is one row per person and the old path forced Owner via max-wins.

INSERT INTO project_members (project_id, user_id, role_level, granted_by)
SELECT p.id, p.created_by, 700, p.created_by
  FROM projects p
 WHERE p.created_by IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM project_members pm
      WHERE pm.project_id = p.id
        AND pm.user_id = p.created_by
        AND pm.role_level >= 700
   )
ON CONFLICT (project_id, user_id) DO UPDATE
  SET role_level = 700
  WHERE project_members.role_level < 700;

-- Same view as 0121, without the creator UNION. created_by is not a grant.
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
  SELECT gm.user_id::BIGINT, 'team'::TEXT, gm.group_id::TEXT,
         gm.role_level::INT, 'direct'::TEXT, NULL::BIGINT,
         gm.added_by::BIGINT, gm.added_at
    FROM group_members gm
   WHERE gm.role_level IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT ON access_grants TO app_runtime;
  END IF;
END
$$;

-- Same helper as 0083, without the created_by path.
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
      -- Org-wide oversight — Maintainer+ only (AQU-435 / AQU-1107)
      EXISTS (
        SELECT 1 FROM projects pr
          JOIN org_members om ON om.org_id = pr.org_id
         WHERE pr.id = p_project_id
           AND pr.org_id IS NOT NULL
           AND om.user_id = uid.id
           AND om.role_level >= 600
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
