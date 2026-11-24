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
--      team attachment on a project of that org, no direct project row;
--      archived projects included, so unarchiving one later restores what
--      they had — keeps that level as their own. A project's creator is no
--      exception: since 0207 (AQU-2357) `projects.created_by` grants nothing,
--      and a creator still holding 0207's Owner row has a direct row anyway:
--      a. each of their target-lane grant rows on that project at Viewer or above
--         is raised to the org level if lower, and becomes a direct grant
--         (`team_group_id` NULL), so a later team change neither lowers nor
--         removes it;
--      b. they get a direct `project_members` row at the org level, so the
--         project role (which most checks still read until AQU-2353) and the
--         access itself survive a team change exactly as before.
--      c. each pair is recorded in `org_role_lift_grants` (below), so AQU-2354
--         can later move this access onto their team and delete exactly
--         these grants.
--      Their readable lanes do not change: the read wall shows below-Maintainer
--      members only the lanes they hold rows for, and no row is added.
--   2. Every org row at 101–599 becomes Member (100). A row below 100 is left
--      alone (never rounds up); the dry run lists any.
--   3. Pending org invites at 101–599 become Member, so accepting one cannot
--      write a 200–500 org row again (the accept route also refuses to).
--
-- DRY RUN. `scripts/neon-org-roles.ts` computes the same plan read-only and
-- writes the per-org report: every org row that changes, each person and lane
-- whose role would drop without step 1 and the grant that fixes it, how many
-- pairs step 1c records, who loses the org Members page, and the totals. Read
-- it before applying, on the database you are about to apply to.
-- scripts/org-roles-migration.test.ts proves this file's result equals that
-- plan.
--
-- DEPLOY ORDER. Production fails closed on a pending migration and dev applies
-- migrations before it deploys, so this runs before the AQU-2352 code. The old
-- code on migrated data: org rows are 100, so the old lift adds nothing, and
-- the direct rows from step 1 give everyone it raised the same role. The new
-- code on unmigrated data (a PR preview on the shared dev database only)
-- would drop the people step 1 lists to their team role until this runs.
-- Idempotent: a second run finds no org row at 101–599 and writes nothing.
-- Requires 0209 (`team_group_id`) and 0207 (the creator's Owner row).

-- The record of step 1 (Luke, 2026-11-23, AQU-2486 q22). The grants step 1
-- writes are temporary: AQU-2354 moves this access onto the person's team
-- (their member role there becomes `org_level`), then undoes exactly what
-- step 1 wrote, only where the team path gives the same role or higher, and
-- drops this table once it is empty. Step 1 writes `granted_by NULL,
-- granted_at now()`, as other migrations do, so the rows themselves cannot be
-- told apart later; this table is how they are found. One row per lifted pair:
--
--   org_level              the org role the lift raised them to; the level of
--                          the direct project row.
--   team_group_ids         their teams attached to the project: the paths the
--                          lift raised (every one below org_level).
--   created_project_grant  true when step 1b inserted the project_members row;
--                          false when one already existed and ON CONFLICT
--                          skipped it, so that row is not 0210's to delete.
--   lanes                  each target-lane row step 1a changed, as it was
--                          before: [{"lane", "prior_level",
--                          "prior_team_group_id"}], `[]` when none. Step 1a
--                          wrote (GREATEST(prior_level, org_level), NULL).
--
-- Undoing it: AQU-2354 deletes the project row where created_project_grant is
-- true, and restores each lane row to its prior level and team where the team
-- path does not cover it. It deletes a lane row only where no prior row
-- existed, and that never happens for these: step 1a only updates rows that
-- exist, so every row in `lanes` existed before 0210.
--
-- AQU-2718 (project grants below Maintainer become lane grants) must keep this
-- record current: when it turns a recorded project row into lane rows, it
-- notes here which lane rows came from it. Only migrations read or write this
-- table: no app_runtime grant and no RLS policy.
CREATE TABLE IF NOT EXISTS org_role_lift_grants (
    project_id            TEXT        NOT NULL,
    user_id               BIGINT      NOT NULL,
    org_level             INTEGER     NOT NULL,
    team_group_ids        BIGINT[],
    created_project_grant BOOLEAN     NOT NULL,
    lanes                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

-- One statement, so steps 1 and 2 read the same snapshot: the lift is
-- computed from the org rows as they were, `raised` reads the lane rows as
-- they were before 1a updates them, and the record (1c) reads what 1a and 1b
-- returned.
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
     AND NOT EXISTS (
       SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = om.user_id
     )
), raised AS (
  SELECT r.project_id, r.user_id, r.lane, l.org_level,
         r.role_level AS prior_level, r.team_group_id AS prior_team_group_id
    FROM project_member_lane_roles r
    JOIN lifted l ON l.project_id = r.project_id AND l.user_id = r.user_id
   WHERE r.role_level >= 100
     AND (r.role_level < l.org_level OR r.team_group_id IS NOT NULL)
     AND EXISTS (
       SELECT 1 FROM lanes ln
        WHERE ln.project_id = r.project_id AND ln.id = r.lane AND ln.role = 'target'
     )
), lane_rows AS (
  UPDATE project_member_lane_roles r
     SET role_level = GREATEST(x.prior_level, x.org_level),
         team_group_id = NULL
    FROM raised x
   WHERE r.project_id = x.project_id
     AND r.user_id = x.user_id
     AND r.lane = x.lane
  RETURNING r.project_id, r.user_id, r.lane, x.prior_level, x.prior_team_group_id
), direct_rows AS (
  INSERT INTO project_members (project_id, user_id, role_level, granted_by, granted_at)
  SELECT project_id, user_id, org_level, NULL, now()
    FROM lifted
  ON CONFLICT (project_id, user_id) DO NOTHING
  RETURNING project_id, user_id
), recorded AS (
  INSERT INTO org_role_lift_grants
         (project_id, user_id, org_level, team_group_ids, created_project_grant, lanes)
  SELECT l.project_id, l.user_id, l.org_level,
         ARRAY(
           SELECT DISTINCT gpg.group_id
             FROM group_project_grants gpg
             JOIN group_members gm ON gm.group_id = gpg.group_id
            WHERE gpg.project_id = l.project_id AND gm.user_id = l.user_id
            ORDER BY gpg.group_id
         ),
         EXISTS (
           SELECT 1 FROM direct_rows d
            WHERE d.project_id = l.project_id AND d.user_id = l.user_id
         ),
         COALESCE((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'lane', lr.lane,
                      'prior_level', lr.prior_level,
                      'prior_team_group_id', lr.prior_team_group_id
                    ) ORDER BY lr.lane)
             FROM lane_rows lr
            WHERE lr.project_id = l.project_id AND lr.user_id = l.user_id
         ), '[]'::jsonb)
    FROM lifted l
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
