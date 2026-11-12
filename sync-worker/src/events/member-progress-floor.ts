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
// AQU-1771: a project may make either floor STRICTER than its org's (its own
// `memberProgressViewMinRole` / `rosterViewMinRole` settings), never looser —
// each is the higher of the two, read the same way as the auth-worker
// (db/shared/visibility-floors). And a named person's progress needs the
// member-list floor too (`rosterViewMinRole`), as every auth-worker read does.

import {
  DEFAULT_VISIBILITY_FLOOR,
  effectiveVisibilityFloor,
  loadProjectVisibilityOverride,
  orgVisibilityFloor,
  type VisibilityFloorKey,
} from "../../../db/shared/visibility-floors"

/**
 * The floor for a read that shows one NAMED person's progress (the per-member
 * activity panel): the higher of the project's member-progress and
 * member-list floors (AQU-1771), as every auth-worker read of named progress
 * requires — a name is member-list information wherever it is printed. Each
 * is the org's floor raised by the project's own stricter value.
 *
 * An org part is ROLE.MAINTAINER (600) when:
 *   - the project has no org, OR
 *   - the org has no settings row, OR
 *   - the key is missing, non-numeric, or outside the valid ladder (100–700).
 */
export async function resolveNamedProgressFloor(db: AquillaDb, projectId: string): Promise<number> {
  const floors = await resolveVisibilityFloors(db, projectId)
  return Math.max(floors.memberProgressViewMinRole, floors.rosterViewMinRole)
}

/** Both floors the project enforces: its org's, each raised by its own stricter value. */
async function resolveVisibilityFloors(
  db: AquillaDb,
  projectId: string,
): Promise<Record<VisibilityFloorKey, number>> {
  const [org, own] = await Promise.all([
    resolveOrgVisibilityFloors(db, projectId),
    loadProjectVisibilityOverride(db, projectId),
  ])
  return {
    rosterViewMinRole: effectiveVisibilityFloor(org.rosterViewMinRole, own.rosterViewMinRole),
    memberProgressViewMinRole: effectiveVisibilityFloor(
      org.memberProgressViewMinRole, own.memberProgressViewMinRole,
    ),
  }
}

async function resolveOrgVisibilityFloors(
  db: AquillaDb,
  projectId: string,
): Promise<Record<VisibilityFloorKey, number>> {
  const defaults = {
    rosterViewMinRole: DEFAULT_VISIBILITY_FLOOR,
    memberProgressViewMinRole: DEFAULT_VISIBILITY_FLOOR,
  }
  const project = await db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | null }>()

  if (!project?.org_id) return defaults

  const settings = await db
    .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
    .bind(project.org_id)
    .first<{ settings: string }>()

  if (!settings) return defaults

  try {
    const parsed = JSON.parse(settings.settings) as Record<string, unknown> | null
    return {
      rosterViewMinRole: orgVisibilityFloor(parsed, "rosterViewMinRole"),
      memberProgressViewMinRole: orgVisibilityFloor(parsed, "memberProgressViewMinRole"),
    }
  } catch {
    return defaults
  }
}
