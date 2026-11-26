/**
 * AQU-2318: the Places lens on GET /orgs/:id/access.
 *
 * The tree is the places the viewer can see (org, their teams, projects,
 * target language lanes). Each place carries the grants set there and the
 * ancestor grants the resolver says reach it — one row per person's org
 * grant, one row per team grant. This does not decide who can open a place;
 * it shows the answer resolveFromGrants / the lane read wall already give.
 */
import { orgPathContribution, ORG_WIDE_ACCESS_FLOOR } from "../../../db/shared/project-roles"
import { laneDisplayNameSql } from "../../../db/shared/lanes"
import { laneReadWallEnabled, visibleLaneTags } from "../../../src/lib/lanes/read-wall"
import type { Env } from "../types"
import type { ScopePath, ScopeRef } from "./access-payload"

export interface DirectGrantee {
  userId: string
  displayName: string
  roleLevel: number
  email?: string | null
  isGuest?: boolean
  /** Winning row at this place. Invites are not accounts. */
  source?: "direct" | "creator" | "invite"
  pendingInvite?: { expiresAt: string | null }
}

/** A grant on an ancestor that resolves to this place. */
export interface InheritedSource {
  kind: "person" | "team"
  roleLevel: number
  from: ScopeRef
  userId?: string
  displayName?: string
  email?: string | null
  isGuest?: boolean
  /** Team grants: how many people are on the team. Not added into the row count. */
  memberCount?: number
}

export interface AccessTreeNode {
  scope: ScopeRef
  children: AccessTreeNode[]
  directGrantees: DirectGrantee[]
  inherited: InheritedSource[]
}

export interface PlaceGrant {
  userId: string
  userName: string
  email: string | null
  scopeType: string
  scopeId: string
  roleLevel: number
  source: string
  viaTeamId: string | null
}

interface TeamRow { id: string; name: string }
interface ProjectRow { id: string; name: string }
interface LaneRow { projectId: string; id: string; name: string; legacyTag: string | null }
interface LaneGrantRow { projectId: string; userId: string; laneId: string; roleLevel: number }
interface Attachment {
  teamId: string
  projectId: string
  roleLevel: number
  lanesExplicit: boolean
  laneIds: string[]
}
interface Invite {
  /**
   * Stable, non-redeemable id for the row: a hash of the token. The token is a
   * bearer credential (an open link is redeemable by any account), so it never
   * leaves loadPlaceExtras.
   */
  ref: string
  roleLevel: number
  email: string | null
  expiresAt: string | null
  /** Project invites only. Empty = the whole project. */
  lanes: string[]
}

export interface PlaceAssembly {
  org: ScopeRef
  seesOrg: boolean
  viewerId: string
  /** Projects whose roster this viewer may list. */
  visibleProjectIds: ReadonlySet<string>
  /** Effective project role of the viewer, for the lane read wall. */
  viewerProjectRole: ReadonlyMap<string, number | null>
  wallFlag: string | undefined
  grants: readonly PlaceGrant[]
  teams: readonly TeamRow[]
  projects: readonly ProjectRow[]
  memberIds: ReadonlySet<string>
  extras: PlaceExtras
}

export interface PlaceExtras {
  lanes: LaneRow[]
  laneGrants: LaneGrantRow[]
  attachments: Attachment[]
  memberCount: Map<string, number>
  viewerTeamIds: Set<string>
  /** Users named on a lane grant who have no access_grants row. */
  laneUsers: Map<string, { name: string; email: string | null }>
  orgInvites: Invite[]
  projectInvites: Map<string, Invite[]>
}

const byName = (a: { displayName?: string; from?: ScopeRef }, b: { displayName?: string; from?: ScopeRef }) =>
  (a.displayName ?? a.from?.name ?? "").localeCompare(b.displayName ?? b.from?.name ?? "")

function laneFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true"
}

function asIso(value: string | Date | null): string | null {
  if (value == null) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

async function inviteRef(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function parseLaneList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

export async function loadPlaceExtras(env: Env, orgId: number, viewerId: string): Promise<PlaceExtras> {
  // Two waves: one request's pool is eight statements (AQU-2613). Eight at
  // once is the cap, and this read already shares the pool with the route.
  const [lanesRes, laneGrantRes, attachRes, laneSetRes] = await Promise.all([
      env.AQUILLA_PG.prepare(
        `SELECT l.project_id AS project_id, l.id AS id, l.legacy_tag AS legacy_tag,
                ${laneDisplayNameSql("l")} AS name
           FROM lanes l
           JOIN projects p ON p.id = l.project_id
          WHERE p.org_id = ? AND p.archived_at IS NULL
            AND l.archived_at IS NULL AND l.role = 'target'
          ORDER BY l.position, name`,
      ).bind(orgId).all<{ project_id: string; id: string; legacy_tag: string | null; name: string }>(),
      env.AQUILLA_PG.prepare(
        `SELECT r.project_id AS project_id, r.user_id AS user_id, r.lane AS lane, r.role_level AS role_level
           FROM project_member_lane_roles r
           JOIN projects p ON p.id = r.project_id
          WHERE p.org_id = ? AND p.archived_at IS NULL`,
      ).bind(orgId).all<{ project_id: string; user_id: number | string; lane: string; role_level: number }>(),
      env.AQUILLA_PG.prepare(
        `SELECT gpg.group_id AS group_id, gpg.project_id AS project_id,
                gpg.role_level AS role_level, gpg.lanes_explicit AS lanes_explicit
           FROM group_project_grants gpg
           JOIN groups g ON g.id = gpg.group_id
          WHERE g.org_id = ?`,
      ).bind(orgId).all<{
        group_id: number | string
        project_id: string
        role_level: number
        lanes_explicit: boolean | number | string
      }>(),
      env.AQUILLA_PG.prepare(
        `SELECT gpl.group_id AS group_id, gpl.project_id AS project_id, gpl.lane_id AS lane_id
           FROM group_project_lanes gpl
           JOIN projects p ON p.id = gpl.project_id
          WHERE p.org_id = ? AND p.archived_at IS NULL`,
      ).bind(orgId).all<{ group_id: number | string; project_id: string; lane_id: string }>(),
    ])
  const [countRes, memberRes, orgInviteRes, projectInviteRes] = await Promise.all([
      env.AQUILLA_PG.prepare(
        `SELECT gm.group_id AS group_id, COUNT(*) AS n
           FROM group_members gm
           JOIN groups g ON g.id = gm.group_id
          WHERE g.org_id = ?
          GROUP BY gm.group_id`,
      ).bind(orgId).all<{ group_id: number | string; n: number | string }>(),
      env.AQUILLA_PG.prepare(
        `SELECT gm.group_id AS group_id
           FROM group_members gm
           JOIN groups g ON g.id = gm.group_id
          WHERE g.org_id = ? AND gm.user_id = ?`,
      ).bind(orgId, viewerId).all<{ group_id: number | string }>(),
      env.AQUILLA_PG.prepare(
        `SELECT token, role_level, email, expires_at
           FROM org_invites
          WHERE org_id = ? AND used_by IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      ).bind(orgId).all<{ token: string; role_level: number; email: string | null; expires_at: string | Date | null }>(),
      env.AQUILLA_PG.prepare(
        `SELECT i.token AS token, i.project_id AS project_id, i.role_level AS role_level,
                i.email AS email, i.expires_at AS expires_at, i.scope_lanes AS scope_lanes
           FROM project_invites i
           JOIN projects p ON p.id = i.project_id
          WHERE p.org_id = ? AND p.archived_at IS NULL
            AND i.used_by IS NULL AND (i.expires_at IS NULL OR i.expires_at > now())`,
      ).bind(orgId).all<{
        token: string
        project_id: string
        role_level: number
        email: string | null
        expires_at: string | Date | null
        scope_lanes: string | null
      }>(),
    ])

  const laneIdsByAttachment = new Map<string, string[]>()
  for (const row of laneSetRes.results ?? []) {
    const key = `${row.group_id}:${row.project_id}`
    const list = laneIdsByAttachment.get(key) ?? []
    list.push(row.lane_id)
    laneIdsByAttachment.set(key, list)
  }
  const attachments: Attachment[] = (attachRes.results ?? []).map((row) => ({
    teamId: String(row.group_id),
    projectId: row.project_id,
    roleLevel: Number(row.role_level),
    lanesExplicit: laneFlag(row.lanes_explicit),
    laneIds: laneIdsByAttachment.get(`${row.group_id}:${row.project_id}`) ?? [],
  }))

  const laneGrants: LaneGrantRow[] = (laneGrantRes.results ?? []).map((row) => ({
    projectId: row.project_id,
    userId: String(row.user_id),
    laneId: row.lane,
    roleLevel: Number(row.role_level),
  }))

  const projectInvites = new Map<string, Invite[]>()
  for (const row of projectInviteRes.results ?? []) {
    const invite: Invite = {
      ref: await inviteRef(row.token),
      roleLevel: Number(row.role_level),
      email: row.email,
      expiresAt: asIso(row.expires_at),
      lanes: parseLaneList(row.scope_lanes),
    }
    const list = projectInvites.get(row.project_id) ?? []
    list.push(invite)
    projectInvites.set(row.project_id, list)
  }

  return {
    lanes: (lanesRes.results ?? []).map((row) => ({
      projectId: row.project_id,
      id: row.id,
      name: row.name,
      legacyTag: row.legacy_tag,
    })),
    laneGrants,
    attachments,
    memberCount: new Map((countRes.results ?? []).map((row) => [String(row.group_id), Number(row.n)])),
    viewerTeamIds: new Set((memberRes.results ?? []).map((row) => String(row.group_id))),
    laneUsers: await laneUsersMissing(env, laneGrants),
    orgInvites: await Promise.all((orgInviteRes.results ?? []).map(async (row) => ({
      ref: await inviteRef(row.token),
      roleLevel: Number(row.role_level),
      email: row.email,
      expiresAt: asIso(row.expires_at),
      lanes: [],
    }))),
    projectInvites,
  }
}

async function laneUsersMissing(env: Env, grants: LaneGrantRow[]): Promise<PlaceExtras["laneUsers"]> {
  const ids = [...new Set(grants.map((g) => g.userId))]
  const users = new Map<string, { name: string; email: string | null }>()
  if (ids.length === 0) return users
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT id, username, email FROM users WHERE id::TEXT IN (${ids.map(() => "?").join(", ")})`,
  ).bind(...ids).all<{ id: number | string; username: string; email: string | null }>()
  for (const row of results ?? []) users.set(String(row.id), { name: row.username, email: row.email })
  return users
}

/** Org and team crumbs the viewer cannot see lose their names. Their own team stays. */
export function redactUnseenPlaces(
  path: ScopePath,
  seesOrg: boolean,
  visibleTeamIds: ReadonlySet<string>,
): ScopePath {
  if (seesOrg) return path
  return path.map((crumb) => {
    const hidden = crumb.type === "org" || (crumb.type === "team" && !visibleTeamIds.has(crumb.id))
    return hidden ? { type: crumb.type, id: crumb.id, name: "", hidden: true } : crumb
  })
}

function inviteGrantee(invite: Invite): DirectGrantee {
  return {
    userId: `invite:${invite.ref}`,
    // An open link has no name; never fall back to the token.
    displayName: invite.email ?? "Invite link",
    email: invite.email,
    roleLevel: invite.roleLevel,
    isGuest: false,
    source: "invite",
    pendingInvite: { expiresAt: invite.expiresAt },
  }
}

export function assembleAccessTree(input: PlaceAssembly): { tree: AccessTreeNode[]; visibleTeamIds: Set<string> } {
  const { extras } = input
  const wallOn = laneReadWallEnabled(input.wallFlag)
  const visibleTeamIds = new Set<string>()
  if (input.seesOrg) {
    for (const team of input.teams) visibleTeamIds.add(team.id)
  } else {
    for (const teamId of extras.viewerTeamIds) {
      const opensVisibleProject = extras.attachments.some(
        (a) => a.teamId === teamId && input.visibleProjectIds.has(a.projectId),
      )
      if (opensVisibleProject) visibleTeamIds.add(teamId)
    }
  }

  const orgGrants = input.grants.filter((g) => g.scopeType === "org")
  const personById = new Map(input.grants.map((g) => [g.userId, g]))

  const directOf = (list: PlaceGrant[]): DirectGrantee[] => {
    const best = new Map<string, DirectGrantee>()
    for (const g of list) {
      const row: DirectGrantee = {
        userId: g.userId,
        displayName: g.userName,
        roleLevel: g.roleLevel,
        email: g.email,
        isGuest: !input.memberIds.has(g.userId),
        source: g.source === "creator" ? "creator" : "direct",
      }
      const prev = best.get(g.userId)
      if (!prev || row.roleLevel > prev.roleLevel) best.set(g.userId, row)
    }
    return [...best.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  const withInvites = (rows: DirectGrantee[], invites: Invite[]): DirectGrantee[] =>
    [...rows, ...invites.map(inviteGrantee)].sort((a, b) => a.displayName.localeCompare(b.displayName))

  const personSource = (g: PlaceGrant, roleLevel: number, from: ScopeRef): InheritedSource => ({
    kind: "person",
    roleLevel,
    from,
    userId: g.userId,
    displayName: g.userName,
    email: g.email,
    isGuest: !input.memberIds.has(g.userId),
  })

  const teamSource = (team: TeamRow, roleLevel: number): InheritedSource => ({
    kind: "team",
    roleLevel,
    from: { type: "team", id: team.id, name: team.name },
    displayName: team.name,
    memberCount: extras.memberCount.get(team.id) ?? 0,
  })

  const hasDirect = (userId: string, projectId: string) =>
    input.grants.some((g) => g.userId === userId && g.scopeType === "project" && g.scopeId === projectId && g.source === "direct")
  const hasGroup = (userId: string, projectId: string) =>
    input.grants.some((g) => g.userId === userId && g.scopeType === "project" && g.scopeId === projectId && g.source === "team")

  const orgPeopleReaching = (projectId: string | null): InheritedSource[] => {
    if (!input.seesOrg) return []
    const rows: InheritedSource[] = []
    for (const g of orgGrants) {
      const level = projectId == null
        ? (g.roleLevel >= ORG_WIDE_ACCESS_FLOOR ? g.roleLevel : null)
        : orgPathContribution({
            orgLevel: g.roleLevel,
            hasDirectGrant: hasDirect(g.userId, projectId),
            hasGroupGrant: hasGroup(g.userId, projectId),
          })
      if (level == null) continue
      rows.push(personSource(g, level, input.org))
    }
    return rows.sort(byName)
  }

  const teamsOn = (projectId: string): Attachment[] =>
    extras.attachments.filter((a) => a.projectId === projectId && visibleTeamIds.has(a.teamId))

  const teamRows = (attachments: Attachment[]): InheritedSource[] =>
    attachments
      .map((a) => {
        const team = input.teams.find((t) => t.id === a.teamId)
        return team ? teamSource(team, a.roleLevel) : null
      })
      .filter((row): row is InheritedSource => row != null)
      .sort(byName)

  const projectDirect = (projectId: string) =>
    input.grants.filter((g) => g.scopeType === "project" && g.scopeId === projectId && g.source !== "team")

  const grantAppliesToLane = (g: PlaceGrant, lane: LaneRow): boolean => {
    if (!wallOn || g.roleLevel >= ORG_WIDE_ACCESS_FLOOR) return true
    return extras.laneGrants.some(
      (row) => row.projectId === lane.projectId && row.userId === g.userId && row.laneId === lane.id && row.roleLevel >= 100,
    )
  }

  const attachmentApplies = (a: Attachment, laneId: string) =>
    !a.lanesExplicit || a.laneIds.includes(laneId)

  const inviteMatchesLane = (invite: Invite, lane: LaneRow) =>
    invite.lanes.length > 0 && invite.lanes.some((token) => token === lane.id || token === lane.legacyTag)

  const laneNodes = (project: ProjectRow): AccessTreeNode[] => {
    const lanes = extras.lanes.filter((lane) => lane.projectId === project.id)
    const viewerGrants = extras.laneGrants
      .filter((row) => row.projectId === project.id && row.userId === input.viewerId)
      .map((row) => ({ lane: row.laneId, level: row.roleLevel }))
    const visible = visibleLaneTags({
      enabled: wallOn,
      role: input.viewerProjectRole.get(project.id) ?? 0,
      laneGrants: viewerGrants,
    })
    const shown = visible == null ? lanes : lanes.filter((lane) => visible.has(lane.id))
    const projectRef: ScopeRef = { type: "project", id: project.id, name: project.name }
    const invites = extras.projectInvites.get(project.id) ?? []
    return shown.map((lane): AccessTreeNode => {
      const laneRef: ScopeRef = { type: "lane", id: lane.id, name: lane.name }
      const granted = new Map<string, DirectGrantee>()
      for (const row of extras.laneGrants) {
        if (row.projectId !== project.id || row.laneId !== lane.id) continue
        const known = personById.get(row.userId) ?? extras.laneUsers.get(row.userId)
        if (!known) continue
        const name = "userName" in known ? known.userName : known.name
        const email = known.email
        granted.set(row.userId, {
          userId: row.userId,
          displayName: name,
          email,
          roleLevel: row.roleLevel,
          isGuest: !input.memberIds.has(row.userId),
          source: "direct",
        })
      }
      const direct = withInvites(
        [...granted.values()],
        invites.filter((invite) => inviteMatchesLane(invite, lane)),
      )
      // A creator who also holds a project_members row is two view rows for one
      // grant at this project. Collapse them the same way Granted here does,
      // or the lane lists that person twice under "via project".
      const viaProject: InheritedSource[] = directOf(
        projectDirect(project.id).filter((g) => grantAppliesToLane(g, lane)),
      ).map((person) => ({
        kind: "person",
        roleLevel: person.roleLevel,
        from: projectRef,
        userId: person.userId,
        displayName: person.displayName,
        email: person.email,
        isGuest: person.isGuest,
      }))
      const viaTeam = teamRows(teamsOn(project.id).filter((a) => attachmentApplies(a, lane.id)))
      const viaOrg = orgPeopleReaching(project.id).filter((row) => {
        if (!wallOn || row.roleLevel >= ORG_WIDE_ACCESS_FLOOR) return true
        return extras.laneGrants.some(
          (g) => g.projectId === project.id && g.userId === row.userId && g.laneId === lane.id && g.roleLevel >= 100,
        )
      })
      return {
        scope: laneRef,
        children: [],
        directGrantees: direct,
        inherited: [...viaProject, ...viaTeam, ...viaOrg],
      }
    })
  }

  const projectNode = (project: ProjectRow): AccessTreeNode => {
    const wholeProjectInvites = (extras.projectInvites.get(project.id) ?? []).filter((invite) => invite.lanes.length === 0)
    return {
      scope: { type: "project", id: project.id, name: project.name },
      directGrantees: withInvites(directOf(projectDirect(project.id)), wholeProjectInvites),
      inherited: [...orgPeopleReaching(project.id), ...teamRows(teamsOn(project.id))],
      children: laneNodes(project),
    }
  }

  const visibleProjects = input.projects.filter((p) => input.visibleProjectIds.has(p.id))
  const projectsForTeam = (teamId: string) => {
    const ids = new Set(extras.attachments.filter((a) => a.teamId === teamId).map((a) => a.projectId))
    return visibleProjects.filter((p) => ids.has(p.id)).map(projectNode)
  }

  const teamNode = (team: TeamRow): AccessTreeNode => ({
    scope: { type: "team", id: team.id, name: team.name },
    directGrantees: directOf(input.grants.filter((g) => g.scopeType === "team" && g.scopeId === team.id)),
    inherited: orgPeopleReaching(null),
    children: projectsForTeam(team.id),
  })

  const shownTeams = input.teams.filter((t) => visibleTeamIds.has(t.id))
  const attachedAnywhere = new Set(extras.attachments.map((a) => a.projectId))
  const looseProjects = visibleProjects.filter((p) => !attachedAnywhere.has(p.id)).map(projectNode)

  if (input.seesOrg) {
    const inShownTeam = new Set(
      extras.attachments.filter((a) => visibleTeamIds.has(a.teamId)).map((a) => a.projectId),
    )
    return {
      visibleTeamIds,
      tree: [{
        scope: input.org,
        directGrantees: withInvites(
          directOf(orgGrants),
          extras.orgInvites,
        ),
        inherited: [],
        children: [
          ...shownTeams.map(teamNode),
          ...visibleProjects.filter((p) => !inShownTeam.has(p.id)).map(projectNode),
        ],
      }],
    }
  }

  // No org roster: the org node and every team they are not on are absent.
  // A project they can open that sits in none of those teams is its own root.
  const underShownTeam = new Set(
    extras.attachments.filter((a) => visibleTeamIds.has(a.teamId)).map((a) => a.projectId),
  )
  return {
    visibleTeamIds,
    tree: [
      ...shownTeams.map(teamNode),
      ...looseProjects,
      ...visibleProjects.filter((p) => !underShownTeam.has(p.id) && attachedAnywhere.has(p.id)).map(projectNode),
    ],
  }
}
