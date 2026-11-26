/**
 * AQU-2322: which `project_member_lane_roles` rows the access page draws as
 * lane grants, and which project rows it draws as lanes instead.
 *
 * Presentation only. Nothing here decides who can read what: the resolver
 * (access_grants) opens the project and the lane read wall reads the rows.
 *
 * A row is bookkeeping, not a lane grant, when the person reads every current
 * target lane of the project (the planner gives an unscoped member one row
 * per lane, and a new lane is granted to whoever already reads all the others
 * — db/shared/lane-grants.ts) and a project-level path already gives them at
 * least that row's role. Every other row is a lane grant: it names a lane the
 * person was put on, or raises their role on one lane.
 *
 * A direct project row is drawn as lane grants ("Contributor · Spanish") when
 * it is the person's only way into the project, sits below Project lead (the
 * highest role a lane carries is Contributor), and their rows name some of
 * the project's lanes but not all of them. That row is what opens the project
 * for a lane-granted person; on its own it is not a grant to the whole project.
 */
import { ORG_WIDE_ACCESS_FLOOR } from "../../../db/shared/project-roles"

const PROJECT_LEAD = 500
const VIEWER = 100

/** One person's standing on one project, as the rows say. */
export interface PersonOnProject {
  /** access_grants project rows for this person on this project (direct, team, creator). */
  projectRows: readonly { roleLevel: number; source: string }[]
  /** Their org role in the project's org, when they hold one. */
  orgLevel: number | null
  /** Their lane rows on this project. */
  laneRows: readonly { laneId: string; roleLevel: number }[]
  /** The project's current target lanes. */
  currentLaneIds: readonly string[]
}

const opens = (row: { roleLevel: number }) => row.roleLevel >= VIEWER

/** They hold a readable row on every current target lane (and the project has one). */
export function coversEveryLane(p: PersonOnProject): boolean {
  if (p.currentLaneIds.length === 0) return false
  return p.currentLaneIds.every((id) => p.laneRows.some((row) => row.laneId === id && opens(row)))
}

/** The highest role a project-level path gives them: a project row, or an org role that opens every project. */
function projectPathLevel(p: PersonOnProject): number {
  const rows = p.projectRows.reduce((top, row) => Math.max(top, row.roleLevel), 0)
  const org = p.orgLevel != null && p.orgLevel >= ORG_WIDE_ACCESS_FLOOR ? p.orgLevel : 0
  return Math.max(rows, org)
}

/** Is this lane row a lane grant (true), or the lanes a project-level grant already gives (false)? */
export function laneRowIsGrant(p: PersonOnProject, row: { laneId: string; roleLevel: number }): boolean {
  if (!opens(row) || !p.currentLaneIds.includes(row.laneId)) return false
  return !(coversEveryLane(p) && projectPathLevel(p) >= row.roleLevel)
}

/** Is their direct project row drawn as the lane grants it carries? */
export function narrowedToLanes(p: PersonOnProject): boolean {
  const direct = p.projectRows.filter((row) => row.source === "direct")
  if (direct.length === 0 || direct.some((row) => row.roleLevel >= PROJECT_LEAD)) return false
  if (p.projectRows.some((row) => row.source !== "direct")) return false
  if (p.orgLevel != null && p.orgLevel >= ORG_WIDE_ACCESS_FLOOR) return false
  if (coversEveryLane(p)) return false
  return p.laneRows.some((row) => opens(row) && p.currentLaneIds.includes(row.laneId))
}

/** The same two answers, for every person and project in an org. */
export interface LaneShape {
  isLaneGrant(row: { userId: string; projectId: string; laneId: string; roleLevel: number }): boolean
  narrowed(userId: string, projectId: string): boolean
}

export function buildLaneShape(input: {
  /** Every access_grants row in the org, before any viewer filtering. */
  grants: readonly { userId: string; scopeType: string; scopeId: string; roleLevel: number; source: string }[]
  laneGrants: readonly { userId: string; projectId: string; laneId: string; roleLevel: number }[]
  lanes: readonly { projectId: string; id: string }[]
}): LaneShape {
  const lanesOf = new Map<string, string[]>()
  for (const lane of input.lanes) lanesOf.set(lane.projectId, [...(lanesOf.get(lane.projectId) ?? []), lane.id])
  const orgLevel = new Map<string, number>()
  for (const g of input.grants) {
    if (g.scopeType === "org") orgLevel.set(g.userId, Math.max(orgLevel.get(g.userId) ?? 0, g.roleLevel))
  }
  const cache = new Map<string, PersonOnProject>()
  const person = (userId: string, projectId: string): PersonOnProject => {
    const key = `${userId}:${projectId}`
    const hit = cache.get(key)
    if (hit) return hit
    const built: PersonOnProject = {
      projectRows: input.grants.filter((g) => g.userId === userId && g.scopeType === "project" && g.scopeId === projectId),
      orgLevel: orgLevel.get(userId) ?? null,
      laneRows: input.laneGrants.filter((r) => r.userId === userId && r.projectId === projectId),
      currentLaneIds: lanesOf.get(projectId) ?? [],
    }
    cache.set(key, built)
    return built
  }
  return {
    isLaneGrant: (row) => laneRowIsGrant(person(row.userId, row.projectId), row),
    narrowed: (userId, projectId) => narrowedToLanes(person(userId, projectId)),
  }
}
