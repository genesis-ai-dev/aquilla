// AQU-2355 — today's access, computed from the raw tables in one pass.
//
// The dry-run report (access-report.ts) compares two AccessComputations. This
// file builds the "before" one the way the live code decides it today, so a
// migration only has to say what its writes change:
//
//   * effective project role: the live resolver's max-wins
//     (db/shared/project-roles.ts `resolveProjectRoleSharedInternal`): a direct
//     `project_members` row, the highest attached team's `group_project_grants`
//     role, an org role at Maintainer+ (or, below that, the AQU-1274 lift over a
//     team path with no direct row), and the creator at Owner. Team-member roles
//     (`group_members.role_level`) are not read, exactly as the live resolver
//     does not (AQU-2454). Platform admins are not modelled: they come from an
//     env allowlist, not from the tables.
//   * visible lanes: the read wall (src/lib/lanes/read-wall.ts) — Maintainer+
//     reads every lane; below that, the lanes they hold a grant row for at
//     Viewer or above. Only current (non-archived) target lanes are reported.
//   * future lanes: `rules.futureLanes` decides, so the "before" rule (AQU-1781)
//     and the "after" rule (AQU-2355) are both stated here, next to each other.
//
// Loading is separate (`loadRawAccessTables`) and only reads.

import type { AccessComputation, FutureLanes, OrgInfo, ProjectAccess, ProjectInfo, UserInfo } from "./access-report"

export const VIEWER = 100
export const MAINTAINER = 600
export const OWNER = 700

export interface RawAccessTables {
  orgs: Array<{ id: number; name: string | null }>
  projects: Array<{ id: string; name: string; org_id: number | null; created_by: number; archived: boolean }>
  /** Target lanes only, archived included. */
  lanes: Array<{ id: string; project_id: string; name: string; archived: boolean; position: number }>
  users: Array<{ id: number; username: string }>
  projectMembers: Array<{ project_id: string; user_id: number; role_level: number }>
  orgMembers: Array<{ org_id: number; user_id: number; role_level: number }>
  groups: Array<{ id: number; org_id: number; name: string; legacy_uuid: string | null }>
  groupMembers: Array<{ group_id: number; user_id: number; role_level: number | null }>
  groupProjectGrants: Array<{ group_id: number; project_id: string; role_level: number; lanes_explicit: boolean }>
  groupProjectLanes: Array<{ group_id: number; project_id: string; lane_id: string }>
  laneGrants: Array<{ project_id: string; user_id: number; lane: string; role_level: number }>
  /** `project_member_scopes` rows with kind = 'lane'. */
  laneScopes: Array<{ project_id: string; user_id: number; value: string }>
}

/** Lookups every computation needs, built once. */
export interface AccessIndex {
  raw: RawAccessTables
  projectById: Map<string, RawAccessTables["projects"][number]>
  /** projectId → target lanes (archived included), display order. */
  lanesByProject: Map<string, RawAccessTables["lanes"]>
  direct: Map<string, number>
  /** `${user}:${project}` → highest attachment role among their teams. */
  teamRole: Map<string, number>
  /** `${user}:${project}` → highest GREATEST(attachment, member role) — the wall-member level. */
  teamWallRole: Map<string, number>
  orgRole: Map<string, number>
  grants: Map<string, Map<string, number>>
  scopes: Map<string, Set<string>>
  /** projectId → teams attached. */
  attachments: Map<string, RawAccessTables["groupProjectGrants"]>
  membersByGroup: Map<number, RawAccessTables["groupMembers"]>
  teamLanes: Map<string, Set<string>>
}

const key = (userId: number, projectId: string) => `${userId}:${projectId}`

export function indexAccessTables(raw: RawAccessTables): AccessIndex {
  const projectById = new Map(raw.projects.map((p) => [p.id, p]))
  const lanesByProject = new Map<string, RawAccessTables["lanes"]>()
  for (const lane of [...raw.lanes].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))) {
    const list = lanesByProject.get(lane.project_id) ?? []
    list.push(lane)
    lanesByProject.set(lane.project_id, list)
  }
  const direct = new Map(raw.projectMembers.map((m) => [key(m.user_id, m.project_id), Number(m.role_level)]))
  const membersByGroup = new Map<number, RawAccessTables["groupMembers"]>()
  for (const gm of raw.groupMembers) {
    const list = membersByGroup.get(gm.group_id) ?? []
    list.push(gm)
    membersByGroup.set(gm.group_id, list)
  }
  const attachments = new Map<string, RawAccessTables["groupProjectGrants"]>()
  const teamRole = new Map<string, number>()
  const teamWallRole = new Map<string, number>()
  for (const gpg of raw.groupProjectGrants) {
    const list = attachments.get(gpg.project_id) ?? []
    list.push(gpg)
    attachments.set(gpg.project_id, list)
    for (const gm of membersByGroup.get(gpg.group_id) ?? []) {
      const k = key(gm.user_id, gpg.project_id)
      teamRole.set(k, Math.max(teamRole.get(k) ?? 0, Number(gpg.role_level)))
      const wall = Math.max(Number(gpg.role_level), Number(gm.role_level ?? 0))
      teamWallRole.set(k, Math.max(teamWallRole.get(k) ?? 0, wall))
    }
  }
  const orgRole = new Map(raw.orgMembers.map((m) => [`${m.user_id}:${m.org_id}`, Number(m.role_level)]))
  const grants = new Map<string, Map<string, number>>()
  for (const g of raw.laneGrants) {
    const k = key(g.user_id, g.project_id)
    const m = grants.get(k) ?? new Map<string, number>()
    m.set(g.lane, Number(g.role_level))
    grants.set(k, m)
  }
  const scopes = new Map<string, Set<string>>()
  for (const s of raw.laneScopes) {
    const k = key(s.user_id, s.project_id)
    const set = scopes.get(k) ?? new Set<string>()
    set.add(s.value)
    scopes.set(k, set)
  }
  const teamLanes = new Map<string, Set<string>>()
  for (const row of raw.groupProjectLanes) {
    const k = `${row.group_id}:${row.project_id}`
    const set = teamLanes.get(k) ?? new Set<string>()
    set.add(row.lane_id)
    teamLanes.set(k, set)
  }
  return {
    raw,
    projectById,
    lanesByProject,
    direct,
    teamRole,
    teamWallRole,
    orgRole,
    grants,
    scopes,
    attachments,
    membersByGroup,
    teamLanes,
  }
}

/** The live resolver's answer for one pair, or null. */
export function resolveRole(idx: AccessIndex, userId: number, projectId: string): { level: number; source: string } | null {
  const project = idx.projectById.get(projectId)
  if (!project) return null
  const k = key(userId, projectId)
  const contributions: Array<{ level: number; source: string; priority: number }> = []
  const direct = idx.direct.get(k)
  if (direct != null) contributions.push({ level: direct, source: "direct", priority: 4 })
  const team = idx.teamRole.get(k)
  if (team != null) contributions.push({ level: team, source: "team", priority: 3 })
  if (project.org_id != null) {
    const org = idx.orgRole.get(`${userId}:${project.org_id}`)
    if (org != null) {
      // orgPathContribution (AQU-435 / AQU-1274).
      if (org >= MAINTAINER) contributions.push({ level: org, source: "org", priority: 2 })
      else if (direct == null && team != null) contributions.push({ level: org, source: "org (AQU-1274 lift)", priority: 2 })
    }
  }
  if (Number(project.created_by) === userId) contributions.push({ level: OWNER, source: "creator", priority: 1 })
  if (contributions.length === 0) return null
  contributions.sort((a, b) => b.level - a.level || b.priority - a.priority)
  return { level: contributions[0]!.level, source: contributions[0]!.source }
}

/** Current target lanes of a project, display order. */
export function currentLanes(idx: AccessIndex, projectId: string): RawAccessTables["lanes"] {
  return (idx.lanesByProject.get(projectId) ?? []).filter((l) => !l.archived)
}

/** The lanes the read wall shows this person today. */
export function visibleLanes(idx: AccessIndex, userId: number, projectId: string, role: number | null): string[] {
  const lanes = currentLanes(idx, projectId)
  if (role == null) return []
  if (role >= MAINTAINER) return lanes.map((l) => l.id)
  const held = idx.grants.get(key(userId, projectId))
  if (!held) return []
  return lanes.filter((l) => (held.get(l.id) ?? 0) >= VIEWER).map((l) => l.id)
}

/** The level `projectWallMembersSql` (db/shared/lane-grants.ts) gives this person. */
export function wallMemberLevel(idx: AccessIndex, userId: number, projectId: string): number | null {
  const k = key(userId, projectId)
  const d = idx.direct.get(k)
  const t = idx.teamWallRole.get(k)
  if (d == null && t == null) return null
  return Math.max(d ?? 0, t ?? 0)
}

export interface FutureRule {
  name: string
  futureLanes(idx: AccessIndex, userId: number, projectId: string, role: number | null): { reach: FutureLanes; reason: string | null }
}

/**
 * BEFORE AQU-2355: `grantNewLaneStmt` (AQU-1781). A lane created later is
 * granted to every wall member at 100–599 with no kind='lane' scope row who
 * already holds a grant on every OTHER target lane, archived included. On a
 * project with no target lane that holds vacuously, and stays true for every
 * lane after (each new lane is granted, so they hold all of them).
 */
export const AQU_1781_RULE: FutureRule = {
  name: "AQU-1781: a new lane goes to anyone below Maintainer who holds every other lane",
  futureLanes(idx, userId, projectId, role) {
    if (role != null && role >= MAINTAINER) return { reach: "every", reason: "Maintainer or Owner" }
    const wall = wallMemberLevel(idx, userId, projectId)
    if (wall == null || wall < VIEWER || wall >= MAINTAINER) return { reach: "none", reason: null }
    if ((idx.scopes.get(key(userId, projectId))?.size ?? 0) > 0) return { reach: "none", reason: null }
    const held = idx.grants.get(key(userId, projectId)) ?? new Map<string, number>()
    const all = idx.lanesByProject.get(projectId) ?? []
    if (!all.every((l) => held.has(l.id))) return { reach: "none", reason: null }
    const viaTeam = !idx.direct.has(key(userId, projectId))
    return {
      reach: "every",
      reason: all.length === 0
        ? "AQU-1781 rule (project has no target lane yet)"
        : `AQU-1781 rule: holds every lane, no lane scope${viaTeam ? " (team path)" : ""}`,
    }
  },
}

/**
 * AFTER AQU-2355: only Maintainer and Owner reach every later lane. The one
 * implicit grant left is a project's FIRST target lane (`grantFirstTargetLaneStmt`),
 * for the members the AQU-1781 rule would have granted it to — nobody can hold
 * a lane that does not exist yet, so on a lane-less project this is what keeps
 * them from losing the lane the first translation creates.
 */
export const AQU_2355_RULE: FutureRule = {
  name: "AQU-2355: later lanes reach Maintainer and Owner only; a lane-less project's first lane reaches its members",
  futureLanes(idx, userId, projectId, role) {
    if (role != null && role >= MAINTAINER) return { reach: "every", reason: "Maintainer or Owner" }
    if ((idx.lanesByProject.get(projectId) ?? []).length > 0) return { reach: "none", reason: null }
    const wall = wallMemberLevel(idx, userId, projectId)
    if (wall == null || wall < VIEWER || wall >= MAINTAINER) return { reach: "none", reason: null }
    if ((idx.scopes.get(key(userId, projectId))?.size ?? 0) > 0) return { reach: "none", reason: null }
    return { reach: "first-only", reason: "first lane of a lane-less project" }
  },
}

/** Every person with any path into a live project. */
export function accessPairs(idx: AccessIndex): Array<{ userId: number; projectId: string }> {
  const seen = new Set<string>()
  const out: Array<{ userId: number; projectId: string }> = []
  const add = (userId: number, projectId: string) => {
    const p = idx.projectById.get(projectId)
    if (!p || p.archived) return
    const k = key(userId, projectId)
    if (seen.has(k)) return
    seen.add(k)
    out.push({ userId, projectId })
  }
  for (const m of idx.raw.projectMembers) add(Number(m.user_id), m.project_id)
  for (const gpg of idx.raw.groupProjectGrants) {
    for (const gm of idx.membersByGroup.get(gpg.group_id) ?? []) add(Number(gm.user_id), gpg.project_id)
  }
  const projectsByOrg = new Map<number, string[]>()
  for (const p of idx.raw.projects) {
    if (p.org_id == null || p.archived) continue
    const list = projectsByOrg.get(Number(p.org_id)) ?? []
    list.push(p.id)
    projectsByOrg.set(Number(p.org_id), list)
  }
  for (const om of idx.raw.orgMembers) {
    if (Number(om.role_level) < MAINTAINER) continue
    for (const projectId of projectsByOrg.get(Number(om.org_id)) ?? []) add(Number(om.user_id), projectId)
  }
  for (const p of idx.raw.projects) add(Number(p.created_by), p.id)
  return out
}

/** One AccessComputation for the report, under a future-lanes rule. */
export function computeAccess(raw: RawAccessTables, rule: FutureRule): AccessComputation {
  const idx = indexAccessTables(raw)
  const access: ProjectAccess[] = []
  const userIds = new Set<number>()
  for (const { userId, projectId } of accessPairs(idx)) {
    const role = resolveRole(idx, userId, projectId)
    if (!role) continue
    const future = rule.futureLanes(idx, userId, projectId, role.level)
    access.push({
      userId,
      projectId,
      role: role.level,
      roleSource: role.source,
      lanes: visibleLanes(idx, userId, projectId, role.level),
      futureLanes: future.reach,
      futureReason: future.reason,
    })
    userIds.add(userId)
  }
  const orgs: OrgInfo[] = raw.orgs.map((o) => ({ id: Number(o.id), name: o.name?.trim() || `org ${o.id}` }))
  const projects: ProjectInfo[] = raw.projects
    .filter((p) => !p.archived)
    .map((p) => ({
      id: p.id,
      name: p.name,
      orgId: p.org_id == null ? null : Number(p.org_id),
      lanes: currentLanes(idx, p.id).map((l) => ({ id: l.id, name: l.name })),
    }))
  const users: UserInfo[] = raw.users.filter((u) => userIds.has(Number(u.id))).map((u) => ({ id: Number(u.id), username: u.username }))
  return { orgs, projects, users, access }
}

/** Minimal query surface: `pg`'s Client and a test double both fit. */
export interface ReadQuery {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>
}

function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "t" || v === "true"
}

/** Read every table the computation needs. SELECTs only. */
export async function loadRawAccessTables(db: ReadQuery): Promise<RawAccessTables> {
  const rows = async (sql: string) => (await db.query(sql)).rows
  const num = (v: unknown) => Number(v)
  return {
    orgs: (await rows(`SELECT id, name FROM organizations`)).map((r) => ({ id: num(r.id), name: (r.name as string | null) ?? null })),
    projects: (await rows(`SELECT id, name, org_id, created_by, archived_at IS NOT NULL AS archived FROM projects`)).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? r.id),
      org_id: r.org_id == null ? null : num(r.org_id),
      created_by: num(r.created_by),
      archived: bool(r.archived),
    })),
    lanes: (
      await rows(
        `SELECT id, project_id, COALESCE(NULLIF(btrim(name), ''), NULLIF(btrim(language), ''), NULLIF(legacy_tag, ''), '(default lane)') AS name,
                archived_at IS NOT NULL AS archived, position
           FROM lanes WHERE role = 'target'`,
      )
    ).map((r) => ({ id: String(r.id), project_id: String(r.project_id), name: String(r.name), archived: bool(r.archived), position: num(r.position) })),
    users: (await rows(`SELECT id, username FROM users`)).map((r) => ({ id: num(r.id), username: String(r.username) })),
    projectMembers: (await rows(`SELECT project_id, user_id, role_level FROM project_members`)).map((r) => ({
      project_id: String(r.project_id),
      user_id: num(r.user_id),
      role_level: num(r.role_level),
    })),
    orgMembers: (await rows(`SELECT org_id, user_id, role_level FROM org_members`)).map((r) => ({
      org_id: num(r.org_id),
      user_id: num(r.user_id),
      role_level: num(r.role_level),
    })),
    groups: (await rows(`SELECT id, org_id, name, legacy_uuid FROM groups`)).map((r) => ({
      id: num(r.id),
      org_id: num(r.org_id),
      name: String(r.name),
      legacy_uuid: (r.legacy_uuid as string | null) ?? null,
    })),
    groupMembers: (await rows(`SELECT group_id, user_id, role_level FROM group_members`)).map((r) => ({
      group_id: num(r.group_id),
      user_id: num(r.user_id),
      role_level: r.role_level == null ? null : num(r.role_level),
    })),
    groupProjectGrants: (await rows(`SELECT group_id, project_id, role_level, lanes_explicit FROM group_project_grants`)).map((r) => ({
      group_id: num(r.group_id),
      project_id: String(r.project_id),
      role_level: num(r.role_level),
      lanes_explicit: bool(r.lanes_explicit),
    })),
    groupProjectLanes: (await rows(`SELECT group_id, project_id, lane_id FROM group_project_lanes`)).map((r) => ({
      group_id: num(r.group_id),
      project_id: String(r.project_id),
      lane_id: String(r.lane_id),
    })),
    laneGrants: (await rows(`SELECT project_id, user_id, lane, role_level FROM project_member_lane_roles`)).map((r) => ({
      project_id: String(r.project_id),
      user_id: num(r.user_id),
      lane: String(r.lane),
      role_level: num(r.role_level),
    })),
    laneScopes: (await rows(`SELECT project_id, user_id, value FROM project_member_scopes WHERE kind = 'lane'`)).map((r) => ({
      project_id: String(r.project_id),
      user_id: num(r.user_id),
      value: String(r.value),
    })),
  }
}
