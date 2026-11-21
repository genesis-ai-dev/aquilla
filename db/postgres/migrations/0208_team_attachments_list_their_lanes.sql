-- Migration 0208: a team attachment lists its lanes (AQU-2355).
--
-- WHY. AQU-2351 rule 2: no grant means "every lane, forever". A lane grant
-- grants only the lanes it lists; every lane, including ones created later,
-- comes only from project or org Maintainer or Owner. The one place that
-- meaning is still stored is a team attachment with `lanes_explicit = false`
-- (pre-AQU-1813, and the Codex sync before AQU-2355), which the team paths
-- read as "every target lane the project has when the team changes".
--
-- WHAT. Each such attachment gets one `group_project_lanes` row per CURRENT
-- (non-archived) target lane of its project — the lanes it covers today —
-- and the flag is set true. The column's default becomes true, so a writer
-- that forgets to name it still stores an explicit (possibly empty) list.
-- Nothing here touches `project_member_lane_roles`: a member's readable
-- lanes are those rows under the read wall, so nobody gains or loses a lane.
--
-- DRY RUN. `scripts/neon-explicit-lane-grants.ts` computes the same plan
-- read-only and writes the per-org report (who loses — nobody — who gains,
-- who stops receiving later lanes, every row added). Read it before applying,
-- on the database you are about to apply to. scripts/explicit-lane-grants
-- -migration.test.ts proves this file's result equals that plan.
--
-- DEPLOY ORDER. Either order is safe. The code in AQU-2355 still honours a
-- `lanes_explicit = false` row until this runs (auth-worker
-- services/lane-grants.ts `teamLaneAccess`), and stops only lane creation from
-- auto-granting. Idempotent: a second run inserts nothing and updates nothing.

INSERT INTO group_project_lanes (group_id, project_id, lane_id)
SELECT gpg.group_id, gpg.project_id, l.id
  FROM group_project_grants gpg
  JOIN lanes l
    ON l.project_id = gpg.project_id
   AND l.role = 'target'
   AND l.archived_at IS NULL
 WHERE gpg.lanes_explicit = false
ON CONFLICT DO NOTHING;

UPDATE group_project_grants
   SET lanes_explicit = true
 WHERE lanes_explicit = false;

ALTER TABLE group_project_grants
  ALTER COLUMN lanes_explicit SET DEFAULT true;
