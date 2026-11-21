-- Migration 0210: organization roles are Member, Maintainer and Owner (AQU-2352).
--
-- WHY. AQU-2351 D-j: at org level a person is a Member (100: in the
-- directory, opens nothing by membership alone), a Maintainer (600) or an
-- Owner (700). Viewer through Project Lead (200–500) are not stored at org
-- level any more. They already opened nothing by themselves (AQU-435); their
-- one effect was the AQU-1274 "lift": with no direct project row, an org role
-- below Maintainer raised a team path into the project to the org level (an
-- org Project Lead on a team attached at Contributor resolved to Project
-- Lead). The code in AQU-2352 removes that lift.
--
-- WHAT, in this order (the lift is computed before any org row changes):
--
--   1. Everyone the lift raises today — org role 101–599 above their best
--      team attachment on a project of that org, no direct project row, not
--      the creator; archived projects included, so unarchiving one later
--      restores what they had — keeps that level as their own:
--      a. each of their target-lane grant rows on that project at Viewer or above
--         is raised to the org level if lower, and becomes a direct grant
--         (`team_group_id` NULL), so a later team change neither lowers nor
--         removes it;
--      b. they get a direct `project_members` row at the org level, so the
--         project role (which most checks still read until AQU-2353) and the
--         access itself survive a team change exactly as before.
--      Their readable lanes do not change: the read wall shows below-Maintainer
--      members only the lanes they hold rows for, and no row is added.
--   2. Every org row at 101–599 becomes Member (100). A row below 100 is left
--      alone (never rounds up); the dry run lists any.
--   3. Pending org invites at 101–599 become Member, so accepting one cannot
--      write a 200–500 org row again (the accept route also refuses to).
--
-- DRY RUN. `scripts/neon-org-roles.ts` computes the same plan read-only and
-- writes the per-org report: every org row that changes, each person and lane
-- whose role would drop without step 1 and the grant that fixes it, who loses
-- the org Members page, and the totals. Read it before applying, on the
-- database you are about to apply to. scripts/org-roles-migration.test.ts
-- proves this file's result equals that plan.
--
-- DEPLOY ORDER. Production fails closed on a pending migration and dev applies
-- migrations before it deploys, so this runs before the AQU-2352 code. The old
-- code on migrated data: org rows are 100, so the old lift adds nothing, and
-- the direct rows from step 1 give everyone it raised the same role. The new
-- code on unmigrated data (a PR preview on the shared dev database only)
-- would drop the people step 1 lists to their team role until this runs.
-- Idempotent: a second run finds no org row at 101–599 and writes nothing.
-- Requires 0209 (`team_group_id`).

-- One statement, so steps 1 and 2 read the same snapshot: the lift is
-- computed from the org rows as they were.
WITH lifted AS (
  SELECT p.id AS project_id, om.user_id, om.role_level AS org_level
    FROM org_members om
    JOIN projects p ON p.org_id = om.org_id
    JOIN (
      SELECT gpg.project_id, gm.user_id, MAX(gpg.role_level) AS team_level
        FROM group_project_grants gpg
        JOIN group_members gm ON gm.group_id = gpg.group_id
       GROUP BY gpg.project_id, gm.user_id
    ) t ON t.project_id = p.id AND t.user_id = om.user_id
   WHERE om.role_level > 100
     AND om.role_level < 600
     AND om.role_level > t.team_level
     AND p.created_by IS DISTINCT FROM om.user_id
     AND NOT EXISTS (
       SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = om.user_id
     )
), lane_rows AS (
  UPDATE project_member_lane_roles r
     SET role_level = GREATEST(r.role_level, l.org_level),
         team_group_id = NULL
    FROM lifted l
   WHERE r.project_id = l.project_id
     AND r.user_id = l.user_id
     AND r.role_level >= 100
     AND (r.role_level < l.org_level OR r.team_group_id IS NOT NULL)
     AND EXISTS (
       SELECT 1 FROM lanes ln
        WHERE ln.project_id = r.project_id AND ln.id = r.lane AND ln.role = 'target'
     )
  RETURNING 1
), direct_rows AS (
  INSERT INTO project_members (project_id, user_id, role_level, granted_by, granted_at)
  SELECT project_id, user_id, org_level, NULL, now()
    FROM lifted
  ON CONFLICT (project_id, user_id) DO NOTHING
  RETURNING 1
)
UPDATE org_members
   SET role_level = 100
 WHERE role_level > 100
   AND role_level < 600;

UPDATE org_invites
   SET role_level = 100
 WHERE used_at IS NULL
   AND role_level > 100
   AND role_level < 600;
