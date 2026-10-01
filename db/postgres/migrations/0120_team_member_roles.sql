-- 0120_team_member_roles.sql — AQU-1352 P2 (spec §3.1, §3.4, §3.5).
--
-- Teams become containers with a team-scope role.
--   role_level NULL     = legacy member: access comes only from the per-project
--                         group_project_grants rows (today's behavior, unchanged).
--   role_level NOT NULL = a team-scope grant that flows to every project
--                         attached to the team, and lets a lead (>= 500) create
--                         projects into the team.
-- Every existing row stays NULL, so no effective role changes.
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS role_level INTEGER NULL;

ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_role_level_check;
ALTER TABLE group_members ADD CONSTRAINT group_members_role_level_check
  CHECK (role_level IS NULL OR role_level IN (100, 200, 300, 400, 500, 600, 700));
