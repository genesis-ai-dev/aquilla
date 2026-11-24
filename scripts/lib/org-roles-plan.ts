// AQU-2352 — what "organization roles are Member, Maintainer and Owner" writes,
// as a pure plan over the raw tables (access-snapshot.ts, AQU-2355).
//
// Migration 0210 does three things, and this file plans each of them the way
// the SQL does, so scripts/org-roles-migration.test.ts can prove the two equal:
//
//   1. Everyone the AQU-1274 lift raises today keeps that level as their own:
//      their lane-grant rows on that project are raised to it and become
//      direct, and they get a direct project row at it. Each pair is recorded
//      in `org_role_lift_grants` (`liftGrantRecords`), so AQU-2354 can delete
//      exactly these grants once their team carries the role.
//   2. Every org row at 101–599 becomes Member (100).
//   3. Pending org invites at 101–599 become Member.
//
// The report also needs the state "lift removed, nothing compensated" — that
// is what the dry run calls "without the fix" — to list each person and lane
// whose role would drop and the grant that fixes it. The lift only ever fires
// with an org row below Maintainer, so "org rows at 100" and "lift removed"
// resolve identically (100 never beats a team attachment), and the
// AQU-2355 resolver (`resolveRole`) answers both.

import { indexAccessTables, MAINTAINER, resolveRole, VIEWER, type RawAccessTables } from "./access-snapshot"

export const ORG_MEMBER = 100

/** What the report needs beyond the access tables. */
export interface OrgRoleExtras {
  /** `org_settings.settings` → `rosterViewMinRole`, per org that set one. */
  rosterFloors: Map<number, number>
  /** `org_settings.settings` → `memberProgressViewMinRole`, per org that set one. */
  progressFloors: Map<number, number>
  /** Unused org invites (expired ones included; their row is still accepted-checked). */
  pendingOrgInvites: Array<{ token: string; org_id: number; role_level: number; email: string | null; expired: boolean }>
  /** When each org was created and when each org row was granted, for the cross-check. */
  orgCreatedAt: Map<number, string | null>
  orgMemberGrantedAt: Map<string, string | null>
}

export const DEFAULT_ROSTER_VIEW_MIN_ROLE = MAINTAINER

export interface OrgRowChange {
  orgId: number
  userId: number
  from: number
  to: number
}

export interface LaneFix {
  laneId: string
  archived: boolean
  /** The grant row's level today. */
  grantBefore: number
  /** Lane role today: max(project role, grant). */
  laneRoleBefore: number
  /** Lane role once the lift is gone and nothing is compensated. */
  laneRoleWithoutFix: number
  /** The grant row's level after 0210. */
  grantAfter: number
  /** The row's `team_group_id` today (0209); null for a direct row. */
  teamGroupIdBefore: number | null
  /** It was a team's row (0209) and becomes direct. */
  becomesDirect: boolean
}

export interface LiftedPair {
  orgId: number
  userId: number
  projectId: string
  projectArchived: boolean
  orgLevel: number
  teamLevel: number
  /** Their teams attached to the project: the paths the lift raises. */
  teamGroupIds: number[]
  /** The project role today (the lift's) and without the fix (the team's). */
  roleBefore: number
  roleWithoutFix: number
  lanes: LaneFix[]
}

export interface MembersPageLoss {
  orgId: number
  userId: number
  orgLevel: number
  floor: number
}

export interface OrgRolesPlan {
  orgRowChanges: OrgRowChange[]
  /** Org rows below Member: left alone, listed. */
  belowMember: OrgRowChange[]
  lifted: LiftedPair[]
  membersPageLosses: MembersPageLoss[]
  /**
   * Who loses the org-wide named member progress (the org's assignment
   * workload, `GET /usage/org/:orgId`): `canViewNamedProgress` checks the ORG
   * role against both floors, so `floor` is the higher of the two.
   */
  namedProgressLosses: MembersPageLoss[]
  inviteChanges: Array<{ token: string; orgId: number; from: number; email: string | null; expired: boolean }>
}

/** The level a lane shows this person, or null when the read wall hides it. */
export function laneRole(projectRole: number | null, grant: number | null | undefined): number | null {
  if (projectRole == null) return null
  if (projectRole >= MAINTAINER) return projectRole
  if (grant == null || grant < VIEWER) return null
  return Math.max(projectRole, grant)
}

export function planOrgRoles(raw: RawAccessTables, extras: OrgRoleExtras): OrgRolesPlan {
  const idx = indexAccessTables(raw)
  const orgRowChanges: OrgRowChange[] = []
  const belowMember: OrgRowChange[] = []
  for (const om of raw.orgMembers) {
    const level = Number(om.role_level)
    if (level > ORG_MEMBER && level < MAINTAINER) {
      orgRowChanges.push({ orgId: om.org_id, userId: om.user_id, from: level, to: ORG_MEMBER })
    } else if (level < ORG_MEMBER) {
      belowMember.push({ orgId: om.org_id, userId: om.user_id, from: level, to: level })
    }
  }
  orgRowChanges.sort((a, b) => a.orgId - b.orgId || a.userId - b.userId)

  const lifted: LiftedPair[] = []
  for (const p of raw.projects) {
    if (p.org_id == null) continue
    for (const c of orgRowChanges) {
      if (c.orgId !== p.org_id) continue
      const k = `${c.userId}:${p.id}`
      if (idx.direct.has(k)) continue
      const team = idx.teamRole.get(k)
      if (team == null || c.from <= team) continue
      const grants = idx.grants.get(k) ?? new Map<string, number>()
      const rowTeam = new Map(
        raw.laneGrants
          .filter((g) => g.project_id === p.id && Number(g.user_id) === c.userId)
          .map((g) => [g.lane, g.team_group_id ?? null]),
      )
      const lanes: LaneFix[] = []
      for (const lane of idx.lanesByProject.get(p.id) ?? []) {
        const grant = grants.get(lane.id)
        if (grant == null || grant < VIEWER) continue
        const teamGroupIdBefore = rowTeam.get(lane.id) ?? null
        lanes.push({
          laneId: lane.id,
          archived: lane.archived,
          grantBefore: grant,
          laneRoleBefore: laneRole(c.from, grant)!,
          // Without the fix the project role is the team attachment's.
          laneRoleWithoutFix: laneRole(team, grant)!,
          grantAfter: Math.max(grant, c.from),
          teamGroupIdBefore: teamGroupIdBefore == null ? null : Number(teamGroupIdBefore),
          becomesDirect: teamGroupIdBefore != null,
        })
      }
      const teamLevel = team
      const teamGroupIds = [
        ...new Set(
          (idx.attachments.get(p.id) ?? [])
            .filter((g) => (idx.membersByGroup.get(g.group_id) ?? []).some((m) => Number(m.user_id) === c.userId))
            .map((g) => Number(g.group_id)),
        ),
      ].sort((a, b) => a - b)
      lifted.push({
        orgId: c.orgId,
        userId: c.userId,
        projectId: p.id,
        projectArchived: p.archived,
        orgLevel: c.from,
        teamLevel,
        teamGroupIds,
        roleBefore: resolveRole(idx, c.userId, p.id)?.level ?? c.from,
        roleWithoutFix: teamLevel,
        lanes,
      })
    }
  }
  lifted.sort((a, b) => a.orgId - b.orgId || a.userId - b.userId || a.projectId.localeCompare(b.projectId))

  const membersPageLosses: MembersPageLoss[] = []
  for (const c of orgRowChanges) {
    const floor = extras.rosterFloors.get(c.orgId) ?? DEFAULT_ROSTER_VIEW_MIN_ROLE
    if (c.from >= floor && c.to < floor) membersPageLosses.push({ orgId: c.orgId, userId: c.userId, orgLevel: c.from, floor })
  }
  const namedProgressLosses: MembersPageLoss[] = []
  for (const c of orgRowChanges) {
    const floor = Math.max(
      extras.rosterFloors.get(c.orgId) ?? DEFAULT_ROSTER_VIEW_MIN_ROLE,
      extras.progressFloors.get(c.orgId) ?? DEFAULT_ROSTER_VIEW_MIN_ROLE,
    )
    if (c.from >= floor && c.to < floor) namedProgressLosses.push({ orgId: c.orgId, userId: c.userId, orgLevel: c.from, floor })
  }

  const inviteChanges = extras.pendingOrgInvites
    .filter((i) => i.role_level > ORG_MEMBER && i.role_level < MAINTAINER)
    .map((i) => ({ token: i.token, orgId: i.org_id, from: i.role_level, email: i.email, expired: i.expired }))

  return { orgRowChanges, belowMember, lifted, membersPageLosses, namedProgressLosses, inviteChanges }
}

/** One entry of `org_role_lift_grants.lanes`, keyed as the JSON is: a lane row 0210 changed, as it was before. */
export interface LiftGrantLane {
  lane: string
  prior_level: number
  prior_team_group_id: number | null
}

/** One `org_role_lift_grants` row: what 0210 records for a lifted pair. */
export interface LiftGrantRecord {
  projectId: string
  userId: number
  orgLevel: number
  teamGroupIds: number[]
  /** 0210 inserted the project_members row (false: one existed, ON CONFLICT skipped it). */
  createdProjectGrant: boolean
  /**
   * The target-lane rows 0210 raised to the org level or made direct, by lane
   * id, with their level and team before. 0210 only updates rows, so each existed.
   */
  lanes: LiftGrantLane[]
}

/** The rows 0210 writes to `org_role_lift_grants`, one per lifted pair. */
export function liftGrantRecords(plan: OrgRolesPlan): LiftGrantRecord[] {
  return plan.lifted.map((p) => ({
    projectId: p.projectId,
    userId: p.userId,
    orgLevel: p.orgLevel,
    teamGroupIds: p.teamGroupIds,
    // The lift only fires with no direct row, so 0210 inserts one for every pair.
    createdProjectGrant: true,
    lanes: p.lanes
      .filter((l) => l.grantAfter !== l.grantBefore || l.becomesDirect)
      .map((l) => ({ lane: l.laneId, prior_level: l.grantBefore, prior_team_group_id: l.teamGroupIdBefore }))
      .sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)),
  }))
}

/** The tables as they read once 0210 has run. */
export function applyPlanToRaw(raw: RawAccessTables, plan: OrgRolesPlan): RawAccessTables {
  const orgTo = new Map(plan.orgRowChanges.map((c) => [`${c.orgId}:${c.userId}`, c.to]))
  const laneTo = new Map<string, number>()
  for (const pair of plan.lifted) {
    for (const l of pair.lanes) laneTo.set(`${pair.projectId}:${pair.userId}:${l.laneId}`, l.grantAfter)
  }
  // Every target-lane row of a lifted pair becomes direct (team_group_id NULL).
  return {
    ...raw,
    orgMembers: raw.orgMembers.map((m) => {
      const to = orgTo.get(`${m.org_id}:${m.user_id}`)
      return to == null ? m : { ...m, role_level: to }
    }),
    projectMembers: [
      ...raw.projectMembers,
      ...plan.lifted.map((p) => ({ project_id: p.projectId, user_id: p.userId, role_level: p.orgLevel })),
    ],
    laneGrants: raw.laneGrants.map((g) => {
      const to = laneTo.get(`${g.project_id}:${g.user_id}:${g.lane}`)
      return to == null ? g : { ...g, role_level: to, team_group_id: null }
    }),
  }
}

/** "Lift removed, nothing compensated": only the org rows change. */
export function withoutFixRaw(raw: RawAccessTables, plan: OrgRolesPlan): RawAccessTables {
  return applyPlanToRaw(raw, { ...plan, lifted: [] })
}

/**
 * Every lane role, per person/project/lane, under a set of tables — what the
 * dry run compares before vs after so a lane-level drop that keeps the lane
 * visible (Project Lead → Contributor on it) is caught too.
 */
export function laneRoles(raw: RawAccessTables): Map<string, number> {
  const idx = indexAccessTables(raw)
  const out = new Map<string, number>()
  const seen = new Set<string>()
  const pairs: Array<[number, string]> = []
  for (const m of raw.projectMembers) pairs.push([Number(m.user_id), m.project_id])
  for (const g of raw.groupProjectGrants) for (const gm of idx.membersByGroup.get(g.group_id) ?? []) pairs.push([Number(gm.user_id), g.project_id])
  for (const [userId, projectId] of pairs) {
    const k = `${userId}:${projectId}`
    if (seen.has(k)) continue
    seen.add(k)
    const project = idx.projectById.get(projectId)
    if (!project || project.archived) continue
    const role = resolveRole(idx, userId, projectId)?.level ?? null
    if (role == null || role >= MAINTAINER) continue
    const grants = idx.grants.get(k)
    for (const lane of idx.lanesByProject.get(projectId) ?? []) {
      if (lane.archived) continue
      const level = laneRole(role, grants?.get(lane.id))
      if (level != null) out.set(`${k}:${lane.id}`, level)
    }
  }
  return out
}

/** Lane roles that drop from `before` to `after` (a lane hidden counts as a drop). */
export function laneRoleDrops(before: Map<string, number>, after: Map<string, number>): Array<{ key: string; from: number; to: number | null }> {
  const drops: Array<{ key: string; from: number; to: number | null }> = []
  for (const [key, from] of before) {
    const to = after.get(key) ?? null
    if (to == null || to < from) drops.push({ key, from, to })
  }
  return drops
}

// ---------------------------------------------------------------------------

/** Minimal query surface: `pg`'s Client and a test double both fit. */
export interface ReadQuery {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>
}

/** Read what the plan needs beyond the access tables. SELECTs only. */
export async function loadOrgRoleExtras(db: ReadQuery): Promise<OrgRoleExtras> {
  const rosterFloors = new Map<number, number>()
  const progressFloors = new Map<number, number>()
  for (const r of (await db.query(`SELECT org_id, settings FROM org_settings`)).rows) {
    try {
      const parsed = JSON.parse(String(r.settings ?? "{}")) as Record<string, unknown>
      // Same validation as auth-worker extractRoleFloor.
      const floor = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 100 && v <= 700
      if (floor(parsed.rosterViewMinRole)) rosterFloors.set(Number(r.org_id), parsed.rosterViewMinRole as number)
      if (floor(parsed.memberProgressViewMinRole)) progressFloors.set(Number(r.org_id), parsed.memberProgressViewMinRole as number)
    } catch {
      // An unreadable blob reads as the default, as in the worker.
    }
  }
  const pendingOrgInvites = (
    await db.query(
      `SELECT token, org_id, role_level, email, (expires_at IS NOT NULL AND expires_at < now()) AS expired
         FROM org_invites WHERE used_at IS NULL`,
    )
  ).rows.map((r) => ({
    token: String(r.token),
    org_id: Number(r.org_id),
    role_level: Number(r.role_level),
    email: (r.email as string | null) ?? null,
    expired: r.expired === true || r.expired === "t",
  }))
  const orgCreatedAt = new Map<number, string | null>()
  for (const r of (await db.query(`SELECT id, created_at FROM organizations`)).rows) {
    orgCreatedAt.set(Number(r.id), r.created_at == null ? null : new Date(r.created_at as string).toISOString())
  }
  const orgMemberGrantedAt = new Map<string, string | null>()
  for (const r of (await db.query(`SELECT org_id, user_id, granted_at FROM org_members`)).rows) {
    orgMemberGrantedAt.set(`${Number(r.org_id)}:${Number(r.user_id)}`, r.granted_at == null ? null : new Date(r.granted_at as string).toISOString())
  }
  return { rosterFloors, progressFloors, pendingOrgInvites, orgCreatedAt, orgMemberGrantedAt }
}
