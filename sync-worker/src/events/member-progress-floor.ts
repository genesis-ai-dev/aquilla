// Shared member-progress-floor resolver for sync-worker routes (AQU-498).
//
// Mirrors export-floor.ts's resolveExportFloor, but reads the
// `memberProgressViewMinRole` key AQU-485 introduced (org Settings →
// RosterProgressSection) instead of `exportMinRole`. The client-side gate
// (ProjectOverview's SectionVisibilityGate) is the primary UX gate — this is
// the defense-in-depth server-side check for the per-member activity read
// endpoint, so a below-floor caller can't bypass the client gate by hitting
// the API directly.
//
// Unlike exportMinRole (whose absence means "no server gate"), this floor
// ALWAYS applies — defaulting to MAINTAINER (600) when unset, matching
// DEFAULT_MEMBER_PROGRESS_VIEW_MIN_ROLE in the client's useOrgSettings hook.
//
// AQU-1771: a project may make the floor STRICTER than its org's (its own
// `memberProgressViewMinRole` setting), never looser — the floor is the higher
// of the two, read the same way as the auth-worker (db/shared/visibility-floors).

import {
  DEFAULT_VISIBILITY_FLOOR,
  effectiveVisibilityFloor,
  loadProjectVisibilityOverride,
  orgVisibilityFloor,
} from "../../../db/shared/visibility-floors"

/**
 * The member-progress floor that applies to a project: its org's
 * memberProgressViewMinRole, raised by the project's own stricter value.
 *
 * The org part is ROLE.MAINTAINER (600) when:
 *   - the project has no org, OR
 *   - the org has no settings row, OR
 *   - memberProgressViewMinRole is missing, non-numeric, or outside the
 *     valid ladder (100–700).
 */
export async function resolveMemberProgressFloor(db: AquillaDb, projectId: string): Promise<number> {
  const [orgFloor, own] = await Promise.all([
    resolveOrgMemberProgressFloor(db, projectId),
    loadProjectVisibilityOverride(db, projectId),
  ])
  return effectiveVisibilityFloor(orgFloor, own.memberProgressViewMinRole)
}

async function resolveOrgMemberProgressFloor(db: AquillaDb, projectId: string): Promise<number> {
  const project = await db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | null }>()

  if (!project?.org_id) return DEFAULT_VISIBILITY_FLOOR

  const settings = await db
    .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
    .bind(project.org_id)
    .first<{ settings: string }>()

  if (!settings) return DEFAULT_VISIBILITY_FLOOR

  try {
    const parsed = JSON.parse(settings.settings) as Record<string, unknown> | null
    return orgVisibilityFloor(parsed, "memberProgressViewMinRole")
  } catch {
    return DEFAULT_VISIBILITY_FLOOR
  }
}
