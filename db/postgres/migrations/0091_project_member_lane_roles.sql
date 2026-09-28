-- 0091_project_member_lane_roles.sql — AQU-730: per-lane role grants.
--
-- The third permission tier (org -> project -> LANE). REPLACES the kind='lane'
-- rows of project_member_scopes with an ADDITIVE, LEVELED grant model:
--
--   * A row grants (project_id, user_id) access to one lane at a role_level.
--   * Access to a lane below Maintainer (600) requires an explicit grant here;
--     no grant = no access (the inversion of the old scopes model, where
--     "no rows = all lanes"). Role >= 600 cascades to every lane with no grant.
--   * effectiveRoleInLane = max(base project role, this grant's role_level) —
--     a grant only ever ELEVATES capability within a lane, never demotes.
--
-- STRUCTURE ONLY. This migration creates the empty table and changes NO
-- behavior: nothing reads it until the token mint (slice 2) and the walls
-- (slices 4+) are wired. It is reversible (DROP TABLE) while the old
-- kind='lane' scope rows still exist in project_member_scopes.
--
-- DELIBERATELY NO BACKFILL HERE. Converting existing project_member_scopes
-- rows and preserving currently-unscoped below-600 members' access is a
-- separate, idempotent backfill that MUST run only AFTER the default lane is
-- eliminated (AQU-1240) — otherwise grants would store the literal '' default
-- lane, and flipping enforcement before the backfill would lock out every
-- current translator. See
-- docs/superpowers/specs/2026-09-10-lane-permissions-and-read-wall-design.md §5.
--
-- kind='file' scopes are OUT OF SCOPE for this change; they remain in
-- project_member_scopes and their enforcement is unchanged.
CREATE TABLE IF NOT EXISTS project_member_lane_roles (
    project_id TEXT    NOT NULL,
    user_id    BIGINT  NOT NULL,
    lane       TEXT    NOT NULL,          -- lanes.id. The UI shows lanes.name, never this id.
    role_level INTEGER NOT NULL,          -- the lane-specific grant level (100..700)
    granted_by BIGINT,
    granted_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (project_id, user_id, lane)
);

-- Resolve "which lanes may this user access, and does role>=600 cascade" per
-- (project,user) in one indexed lookup at token-mint time.
CREATE INDEX IF NOT EXISTS idx_pmlr_project_user
    ON project_member_lane_roles(project_id, user_id);
