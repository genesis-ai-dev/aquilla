-- Migration 0209: a lane grant remembers when a team is its only source (AQU-2355).
--
-- WHY. Under the lane read wall a member below Maintainer reads a lane only
-- through a `project_member_lane_roles` row, and the team paths copy a team's
-- lanes into those rows. AQU-2351 (AQU-2355, AQU-2354) requires that removing
-- someone from a team, or unlinking a team from a lane, removes exactly the
-- access the team gave and nothing else. For someone who is ALSO a direct
-- member, the rows alone cannot say which lanes came from the team.
--
-- WHAT. `team_group_id` is the team a row exists because of. NULL means a
-- direct grant — and every row written before this migration, so nothing
-- existing is ever removed by a team change on that basis (a team-only member
-- is rebuilt from their remaining teams anyway). Additive; no data is written.
--
-- DEPLOY ORDER. Apply before the workers that write the column. On a PR
-- preview (shared dev database, no migrations) the team and lane-grant write
-- paths answer 500 until this is on dev.

ALTER TABLE project_member_lane_roles
  ADD COLUMN IF NOT EXISTS team_group_id BIGINT;
