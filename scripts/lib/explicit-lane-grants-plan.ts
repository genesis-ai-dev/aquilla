// AQU-2355 — what the "lane grants list their lanes" migration writes, as a
// pure plan over the raw tables (access-snapshot.ts).
//
// The behaviour change is in code: no lane created later reaches anyone below
// Maintainer (db/shared/lane-grants.ts). The visible lanes of a person are
// their lane-grant rows today, and nothing here touches those rows, so nobody
// loses or gains a lane. The data the migration writes is the one place
// "every lane, forever" is still stored:
//
//   * a team attachment with `lanes_explicit = false` (pre-AQU-1813 and
//     Codex-created) becomes explicit: `group_project_lanes` gets one row per
//     target lane of the project, archived included (a living attachment
//     covered those, so a restored lane still reaches the team), and the flag
//     is set true.
//
// The dry run also lists, per org and project, every person who stops
// receiving later lanes (the AQU-1781 rule) — the list AQU-2355 asks to share
// with partners before rollout — and the D-d cross-check counts.

import type { GrantAdded } from "./access-report"
import { currentLanes, indexAccessTables, MAINTAINER, type AccessIndex, type RawAccessTables } from "./access-snapshot"

export interface TeamLaneLink {
  groupId: number
  projectId: string
  laneIds: string[]
  /** The attachment's role, for the reader. */
  roleLevel: number
  projectArchived: boolean
}

export interface ExplicitLaneGrantsPlan {
  /** Attachments with lanes_explicit = false, and the lanes each gets. */
  teamLinks: TeamLaneLink[]
}

export function planExplicitLaneGrants(raw: RawAccessTables): ExplicitLaneGrantsPlan {
  const idx = indexAccessTables(raw)
  const teamLinks: TeamLaneLink[] = []
  for (const gpg of raw.groupProjectGrants) {
    if (gpg.lanes_explicit) continue
    const stored = idx.teamLanes.get(`${gpg.group_id}:${gpg.project_id}`) ?? new Set<string>()
    const project = idx.projectById.get(gpg.project_id)
    teamLinks.push({
      groupId: gpg.group_id,
      projectId: gpg.project_id,
      laneIds: (idx.lanesByProject.get(gpg.project_id) ?? [])
        .map((l) => l.id)
        .filter((id) => !stored.has(id)),
      roleLevel: gpg.role_level,
      projectArchived: project?.archived ?? false,
    })
  }
  teamLinks.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.groupId - b.groupId)
  return { teamLinks }
}

/** The tables as they read once the plan is applied. */
export function applyPlanToRaw(raw: RawAccessTables, plan: ExplicitLaneGrantsPlan): RawAccessTables {
  const flipped = new Set(plan.teamLinks.map((t) => `${t.groupId}:${t.projectId}`))
  return {
    ...raw,
    groupProjectGrants: raw.groupProjectGrants.map((g) =>
      flipped.has(`${g.group_id}:${g.project_id}`) ? { ...g, lanes_explicit: true } : g,
    ),
    groupProjectLanes: [
      ...raw.groupProjectLanes,
      ...plan.teamLinks.flatMap((t) => t.laneIds.map((lane_id) => ({ group_id: t.groupId, project_id: t.projectId, lane_id }))),
    ],
  }
}

/** The plan's writes, as report rows. Archived projects are left out of the report but are still written. */
export function planGrantsAdded(raw: RawAccessTables, plan: ExplicitLaneGrantsPlan): GrantAdded[] {
  const idx = indexAccessTables(raw)
  const groups = new Map(raw.groups.map((g) => [g.id, g]))
  return plan.teamLinks
    .filter((t) => !t.projectArchived)
    .map((t) => {
      const g = groups.get(t.groupId)
      const members = idx.membersByGroup.get(t.groupId)?.length ?? 0
      return {
        orgId: idx.projectById.get(t.projectId)?.org_id ?? null,
        projectId: t.projectId,
        kind: "team → lanes (was: every lane, forever)",
        subject: g ? `team "${g.name}"${g.legacy_uuid ? " (Codex)" : ""}` : `team ${t.groupId}`,
        laneIds: t.laneIds,
        roleLevel: t.roleLevel,
        detail:
          `${members} member(s). Sets lanes_explicit = true.` +
          (t.laneIds.length === 0 ? " Project has no target lane yet: the attachment lists none, and its first lane is linked when created." : ""),
      }
    })
}

// ---------------------------------------------------------------------------
// D-d cross-check (AQU-2351): direct project grants on live projects,
// creators excluded, by role, and whether each reached every later lane.

export interface DdCounts {
  byBucket: Array<{
    bucket: string
    grants: number
    everyLaneForever: number
    walled: number
    oneLaneProjects: number
    multiLaneProjects: number
    multiLaneByOrg: Record<string, number>
    noLaneProjects: number
  }>
  /** Alternative reading of "every lane": no kind='lane' scope row at all. */
  noScopeRow: Record<string, number>
  /** Alternative reading: holds a grant on every current target lane. */
  holdsEveryCurrentLane: Record<string, number>
}

function bucketOf(level: number): string {
  if (level >= 700) return "Owner 700"
  if (level >= MAINTAINER) return "Maintainer 600"
  if (level >= 200) return "200–500"
  if (level >= 100) return "Viewer 100"
  return "below 100"
}

/** The AQU-1781 eligibility of one direct grant, independent of org/creator role. */
function directEveryLane(idx: AccessIndex, userId: number, projectId: string, level: number): boolean {
  if (level >= MAINTAINER) return true
  const k = `${userId}:${projectId}`
  if ((idx.scopes.get(k)?.size ?? 0) > 0) return false
  const held = idx.grants.get(k) ?? new Map<string, number>()
  return (idx.lanesByProject.get(projectId) ?? []).every((l) => held.has(l.id))
}

export function ddCrossCheck(raw: RawAccessTables): DdCounts {
  const idx = indexAccessTables(raw)
  const orgName = new Map(raw.orgs.map((o) => [o.id, o.name?.trim() || `org ${o.id}`]))
  const buckets = new Map<string, DdCounts["byBucket"][number]>()
  const noScopeRow: Record<string, number> = {}
  const holdsAll: Record<string, number> = {}
  for (const pm of raw.projectMembers) {
    const project = idx.projectById.get(pm.project_id)
    if (!project || project.archived) continue
    if (Number(project.created_by) === Number(pm.user_id)) continue
    const bucket = bucketOf(pm.role_level)
    const row = buckets.get(bucket) ?? {
      bucket,
      grants: 0,
      everyLaneForever: 0,
      walled: 0,
      oneLaneProjects: 0,
      multiLaneProjects: 0,
      multiLaneByOrg: {},
      noLaneProjects: 0,
    }
    row.grants++
    const every = directEveryLane(idx, pm.user_id, pm.project_id, pm.role_level)
    if (every) row.everyLaneForever++
    else row.walled++
    const laneCount = currentLanes(idx, pm.project_id).length
    if (every) {
      if (laneCount === 0) row.noLaneProjects++
      else if (laneCount === 1) row.oneLaneProjects++
      else {
        row.multiLaneProjects++
        const name = project.org_id == null ? "(no org)" : (orgName.get(project.org_id) ?? `org ${project.org_id}`)
        row.multiLaneByOrg[name] = (row.multiLaneByOrg[name] ?? 0) + 1
      }
    }
    buckets.set(bucket, row)
    const k = `${pm.user_id}:${pm.project_id}`
    if ((idx.scopes.get(k)?.size ?? 0) === 0) noScopeRow[bucket] = (noScopeRow[bucket] ?? 0) + 1
    const held = idx.grants.get(k) ?? new Map<string, number>()
    if (currentLanes(idx, pm.project_id).every((l) => held.has(l.id))) holdsAll[bucket] = (holdsAll[bucket] ?? 0) + 1
  }
  const order = ["Viewer 100", "200–500", "Maintainer 600", "Owner 700", "below 100"]
  return {
    byBucket: [...buckets.values()].sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket)),
    noScopeRow,
    holdsEveryCurrentLane: holdsAll,
  }
}

// ---------------------------------------------------------------------------
// AQU-2355 review (finding 3): grants a team change cannot place.
//
// Since 0209 a grant row records the team it exists because of, and leaving
// that team removes it. Rows written before 0209 say nothing (NULL), so for a
// DIRECT member they are treated as direct and survive a team change, even
// where a team gave them. This counts the rows that could be such a case —
// a direct member's NULL-tagged row on a lane one of their teams covers — so
// Luke can decide whether AQU-2354's migration backfills `team_group_id`.
// Read-only; nothing here changes behaviour.

export interface UntaggedTeamLaneRows {
  rows: number
  people: number
  byOrg: Array<{ org: string; rows: number; people: number; projects: number }>
}

export function untaggedTeamLaneRows(raw: RawAccessTables): UntaggedTeamLaneRows {
  const idx = indexAccessTables(raw)
  const orgName = new Map(raw.orgs.map((o) => [o.id, o.name?.trim() || `org ${o.id}`]))
  const covers = (userId: number, projectId: string, lane: string): boolean => {
    for (const gpg of idx.attachments.get(projectId) ?? []) {
      if (!(idx.membersByGroup.get(gpg.group_id) ?? []).some((gm) => Number(gm.user_id) === userId)) continue
      if (!gpg.lanes_explicit) return true
      if (idx.teamLanes.get(`${gpg.group_id}:${projectId}`)?.has(lane)) return true
    }
    return false
  }
  const byOrg = new Map<string, { rows: number; people: Set<number>; projects: Set<string> }>()
  const people = new Set<string>()
  let rows = 0
  for (const g of raw.laneGrants) {
    if (g.team_group_id != null) continue
    const project = idx.projectById.get(g.project_id)
    if (!project || project.archived) continue
    if (!idx.direct.has(`${g.user_id}:${g.project_id}`)) continue
    if (!covers(Number(g.user_id), g.project_id, g.lane)) continue
    rows++
    people.add(`${g.user_id}`)
    const org = project.org_id == null ? "(no org)" : (orgName.get(project.org_id) ?? `org ${project.org_id}`)
    const entry = byOrg.get(org) ?? { rows: 0, people: new Set<number>(), projects: new Set<string>() }
    entry.rows++
    entry.people.add(Number(g.user_id))
    entry.projects.add(g.project_id)
    byOrg.set(org, entry)
  }
  return {
    rows,
    people: people.size,
    byOrg: [...byOrg.entries()]
      .map(([org, e]) => ({ org, rows: e.rows, people: e.people.size, projects: e.projects.size }))
      .sort((a, b) => b.rows - a.rows || a.org.localeCompare(b.org)),
  }
}
