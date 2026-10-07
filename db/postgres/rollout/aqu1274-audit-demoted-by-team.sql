-- AQU-1274 — audit: who was silently demoted by a team attachment?
--
-- Read-only. Run against the target environment BEFORE/AFTER shipping the
-- resolver fix to see which memberships it changes. No migration accompanies
-- AQU-1274: the fix is in the resolver (db/shared/project-roles.ts ::
-- orgPathContribution), so every affected user is corrected the moment it
-- deploys and no rows need rewriting.
--
-- The affected population is a user who, on a given project:
--   * holds an org role BELOW the maintainer floor (600) — at or above it the
--     org path already contributed, so they were never demoted;
--   * reaches the project through a team (group) attachment whose role_level
--     is LOWER than that org role;
--   * has NO direct `project_members` row — an explicit per-person grant is a
--     deliberate restriction and still wins.
--
-- `was_resolved` is what they got before the fix, `now_resolved` what they get
-- after. Naladda on Pattani Malay Bible is expected in this list at 400 → 500.

SELECT
  o.id                                  AS org_id,
  o.name                                AS org_name,
  u.id                                  AS user_id,
  u.username,
  u.email,
  p.id                                  AS project_id,
  p.name                                AS project_name,
  g.name                                AS team_name,
  om.role_level                         AS org_role,
  MAX(gpg.role_level)                   AS team_role,
  MAX(gpg.role_level)                   AS was_resolved,
  om.role_level                         AS now_resolved
FROM org_members om
JOIN users         u   ON u.id = om.user_id
JOIN organizations o   ON o.id = om.org_id
JOIN projects      p   ON p.org_id = om.org_id AND p.archived_at IS NULL
JOIN group_project_grants gpg ON gpg.project_id = p.id
JOIN groups        g   ON g.id = gpg.group_id
JOIN group_members gm  ON gm.group_id = gpg.group_id AND gm.user_id = om.user_id
WHERE om.role_level < 600                      -- below the AQU-435 access floor
  AND p.created_by <> om.user_id               -- creator path would give 700 anyway
  AND NOT EXISTS (                             -- no deliberate per-project grant
    SELECT 1 FROM project_members pm
     WHERE pm.project_id = p.id AND pm.user_id = om.user_id
  )
GROUP BY o.id, o.name, u.id, u.username, u.email, p.id, p.name, g.name, om.role_level
HAVING MAX(gpg.role_level) < om.role_level     -- the team was demoting them
ORDER BY o.name, u.username, p.name;
