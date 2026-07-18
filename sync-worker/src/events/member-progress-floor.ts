// Shared member-progress-floor resolver for sync-worker routes (AQU-498).
//
// Mirrors export-floor.ts's resolveExportFloor exactly, but reads the
// `memberProgressViewMinRole` key AQU-485 introduced (org Settings →
// RosterProgressSection) instead of `exportMinRole`. The client-side gate
// (ProjectOverview's SectionVisibilityGate, keyed off useOrgSettings'
// canViewMemberProgress) is the primary UX gate — this is the defense-in-depth
// server-side check for the new per-member activity read endpoint, so a
// below-floor caller can't bypass the client gate by hitting the API directly.
//
// Unlike exportMinRole (whose absence means "no server gate"), this floor
// ALWAYS applies — defaulting to MAINTAINER (600) when unset, matching
// DEFAULT_MEMBER_PROGRESS_VIEW_MIN_ROLE in the client's useOrgSettings hook.

import { ROLE } from "./role-policy"

/**
 * Look up the org's memberProgressViewMinRole setting for the project's org.
 *
 * Returns ROLE.MAINTAINER (600) as the safe default when:
 *   - the project has no org, OR
 *   - the org has no settings row, OR
 *   - memberProgressViewMinRole is missing, non-numeric, or outside the
 *     valid ladder (100–700).
 */
export async function resolveMemberProgressFloor(db: AquillaDb, projectId: string): Promise<number> {
  const project = await db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | null }>()

  if (!project?.org_id) return ROLE.MAINTAINER

  const settings = await db
    .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
    .bind(project.org_id)
    .first<{ settings: string }>()

  if (!settings) return ROLE.MAINTAINER

  try {
    const parsed = JSON.parse(settings.settings)
    const raw = parsed?.memberProgressViewMinRole
    if (typeof raw !== "number" || !Number.isFinite(raw)) return ROLE.MAINTAINER
    if (raw < ROLE.VIEWER || raw > ROLE.OWNER) return ROLE.MAINTAINER
    return raw
  } catch {
    return ROLE.MAINTAINER
  }
}
