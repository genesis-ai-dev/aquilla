/**
 * AQU-2320: the Give access dry run. Pure — every input is already loaded
 * (grant-preview-load.ts does the reads), so the same functions answer the
 * route and the tests.
 *
 * Three steps, kept separate so a later slice can run the middle one in
 * reverse for removal ("what does this person lose / keep"):
 *
 *   checkGrant   may this granter make this grant? Uses the shared rule in
 *                src/lib/access/grant-rules.ts — the same one the dialog uses
 *                to decide what to offer — plus the per-target caps the write
 *                routes apply (self grant, target outranks you).
 *   withGrant    the target's grant set as it would be after the write. Each
 *                place has one row per person, so a grant at a place REPLACES
 *                their row there, exactly as the upserts in the write routes do.
 *   diffAccess   before vs after, per project, through resolveFromGrants — the
 *                resolver itself, not a second reading of it. Direction-free:
 *                removal is diffAccess(current, current minus the grant).
 */
import { resolveFromGrants, type AccessGrant, type ResolvedRole } from "../../../db/shared/access-grants"
import { ORG_WIDE_ACCESS_FLOOR } from "../../../db/shared/project-roles"
import {
  INVITE_ROLE_CAP,
  SCOPE_ROLES,
  placeGrantability,
  type GrantDenial,
  type GrantScopeType,
  type PlaceGrantability,
} from "../../../src/lib/access/grant-rules"
import type { ScopeRef } from "./access-payload"

/** The org's places as this granter can see them, plus what the resolver needs. */
export interface OrgWorld {
  org: ScopeRef
  teams: { id: string; name: string }[]
  /** Projects the granter can see. Changes elsewhere are never reported. */
  projects: { id: string; name: string }[]
  lanes: { id: string; projectId: string; name: string }[]
  /** group_project_grants: a team member reaches the project at this role. */
  attachments: { teamId: string; projectId: string; roleLevel: number }[]
  /** AQU-2322: LANE_READ_WALL is on. Off, a lane grant narrows nothing yet. */
  wallOn?: boolean
  /**
   * AQU-2322: the lanes this granter's Places lens shows (under the read wall
   * a Project lead sees only their own). A preview names or counts no other
   * lane. Absent: every lane in `lanes`.
   */
  visibleLaneIds?: ReadonlySet<string>
}

export interface Granter {
  userId: string
  orgRole: number | null
  /** Effective role per project, for project and lane places. */
  projectRoles: ReadonlyMap<string, number | null>
}

export type GrantTarget =
  | {
      kind: "account"
      userId: string
      displayName: string
      /** Holds an org_members row. Without one they are a Guest. */
      isOrgMember: boolean
      /** Their access_grants rows inside this org. */
      grants: AccessGrant[]
      /** project_member_lane_roles rows inside this org. */
      laneGrants: { projectId: string; laneId: string; roleLevel: number }[]
    }
  | { kind: "invite"; email: string }

export interface GrantProposal {
  place: { type: GrantScopeType; id: string }
  roleLevel: number
}

export type RefusalCode =
  | GrantDenial
  | "role_not_offered"
  | "above_cap"
  | "above_invite_cap"
  | "no_team_invite"
  | "self_grant"
  | "target_outranks"

export interface GrantRefusal {
  status: 400 | 403 | 409
  code: RefusalCode
  /** Names the place, the role asked for and the cap, so the denial explains itself. */
  message: string
  place: ScopeRef
  roleLevel: number
  cap: number | null
}

/** One place's effective role and the place that gives it. */
export interface EffectiveRole {
  roleLevel: number
  source: "direct" | "team" | "org" | "creator" | "lane"
  via: ScopeRef
}

export interface ProjectChange {
  project: ScopeRef
  before: EffectiveRole | null
  after: EffectiveRole | null
}

export interface GrantPreview {
  /** Outermost first: org › team, org › project, org › project › lane. */
  placePath: ScopeRef[]
  roleLevel: number
  invite: boolean
  /** Effective role at the place being granted, before and after. */
  here: { before: EffectiveRole | null; after: EffectiveRole | null }
  /** The role on the row this write overwrites at this place, when they already hold one. */
  replaces: number | null
  /** Every visible project whose effective role moves. */
  changes: ProjectChange[]
  /** Nothing moves: the person already holds this role (or more) here. */
  redundant: boolean
  guest: { before: boolean; after: boolean }
  /** Team grants reach projects attached to the team later, too. */
  includesFutureProjects: boolean
  /**
   * AQU-2322, lane grants only. `siblingsClosed`: after this grant some other
   * lane of the project, among those the granter can see, stays closed to
   * them under the read wall. `wallOn` false: the wall is off, so those lanes
   * are not restricted yet.
   */
  lane: { wallOn: boolean; siblingsClosed: boolean } | null
}

type LaneRow = { projectId: string; laneId: string; roleLevel: number }

/**
 * AQU-2322: their role inside one lane, the way the read wall answers it. The
 * project must open (a lane row alone opens nothing). Below Maintainer, with
 * the wall on, a lane opens only through a row of Viewer or above. Inside a
 * lane the role is the higher of the project role and the lane row.
 */
export function laneRoleAt(
  world: OrgWorld,
  grants: readonly AccessGrant[],
  laneGrants: readonly LaneRow[],
  projectId: string,
  laneId: string,
  wallOn: boolean = world.wallOn === true,
): number | null {
  const project = resolveAt(world, grants, projectId)
  if (!project) return null
  const row = laneGrants.find((g) => g.projectId === projectId && g.laneId === laneId && g.roleLevel >= 100)
  if (!wallOn || project.level >= 600) return Math.max(project.level, row?.roleLevel ?? 0)
  return row ? Math.max(project.level, row.roleLevel) : null
}

/** The lane rows after one lane is granted at a role: that row is written or overwritten, no other. */
export function withLaneRow(laneGrants: readonly LaneRow[], row: LaneRow): LaneRow[] {
  return [...laneGrants.filter((g) => !(g.projectId === row.projectId && g.laneId === row.laneId)), row]
}

/** Lanes of the project this granter can see, other than `laneId`. */
export function siblingLanes(world: OrgWorld, projectId: string, laneId: string): OrgWorld["lanes"] {
  return world.lanes.filter((l) => l.projectId === projectId && l.id !== laneId && (world.visibleLaneIds?.has(l.id) ?? true))
}

const ROLE_WORD: Record<number, string> = {
  700: "Owner",
  600: "Maintainer",
  500: "Project lead",
  400: "Contributor",
  300: "Reviewer",
  200: "Commenter",
  100: "Viewer",
}
export const roleWord = (level: number | null | undefined) => (level == null ? "none" : (ROLE_WORD[level] ?? `level ${level}`))

const DENIAL_REASON: Record<GrantDenial, string> = {
  owner_only: "only an Owner can grant here",
  maintainer_only: "only an org Maintainer or Owner can grant on a team",
  lead_only: "only a Project lead or above on this project can grant here",
  team_above_you: "this team holds a project role above yours",
}

/** The place and its ancestors, or null when it is not one this granter can see. */
export function locatePlace(world: OrgWorld, place: GrantProposal["place"]): { path: ScopeRef[]; projectId?: string } | null {
  if (place.type === "org") return place.id === world.org.id ? { path: [world.org] } : null
  if (place.type === "team") {
    const team = world.teams.find((t) => t.id === place.id)
    return team ? { path: [world.org, { type: "team", id: team.id, name: team.name }] } : null
  }
  const lane = place.type === "lane" ? world.lanes.find((l) => l.id === place.id) : undefined
  const projectId = place.type === "lane" ? lane?.projectId : place.id
  const project = world.projects.find((p) => p.id === projectId)
  if (!project) return null
  const projectRef: ScopeRef = { type: "project", id: project.id, name: project.name }
  if (place.type === "project") return { path: [world.org, projectRef], projectId: project.id }
  if (!lane) return null
  return { path: [world.org, projectRef, { type: "lane", id: lane.id, name: lane.name }], projectId: project.id }
}

/** Highest role a team holds on any project. Joining the team receives it. */
export function teamTopProjectRole(world: Pick<OrgWorld, "attachments">, teamId: string): number {
  return world.attachments.filter((a) => a.teamId === teamId).reduce((top, a) => Math.max(top, a.roleLevel), 0)
}

export function grantabilityAt(world: Pick<OrgWorld, "attachments">, granter: Granter, place: GrantProposal["place"], projectId?: string): PlaceGrantability {
  return placeGrantability(place.type, {
    orgRole: granter.orgRole,
    projectRole: projectId ? (granter.projectRoles.get(projectId) ?? null) : null,
    teamTopProjectRole: place.type === "team" ? teamTopProjectRole(world, place.id) : null,
  })
}

interface PlaceNode { scope: ScopeRef; children: readonly PlaceNode[] }

/**
 * May this viewer give access at each place of their tree, and up to which
 * role. Keyed `type:id` (placeParam). Shipped on GET /orgs/:id/access so the
 * dialog greys a place for the same reason the dry run would refuse it.
 */
export function grantableMap(
  tree: readonly PlaceNode[],
  granter: Granter,
  attachments: OrgWorld["attachments"],
): Record<string, PlaceGrantability> {
  const out: Record<string, PlaceGrantability> = {}
  const world = { attachments }
  const walk = (nodes: readonly PlaceNode[], projectId?: string) => {
    for (const node of nodes) {
      const { type, id } = node.scope
      const pid = type === "project" ? id : projectId
      out[`${type}:${id}`] = grantabilityAt(world, granter, { type, id }, pid)
      walk(node.children, pid)
    }
  }
  walk(tree)
  return out
}

function attachedTeams(world: OrgWorld, projectId: string): string[] {
  return world.attachments.filter((a) => a.projectId === projectId).map((a) => a.teamId)
}

export function resolveAt(world: OrgWorld, grants: readonly AccessGrant[], projectId: string): ResolvedRole | null {
  return resolveFromGrants(grants, {
    projectId,
    orgId: world.org.id,
    archivedAt: null,
    isPlatformAdmin: false,
    attachedTeamIds: attachedTeams(world, projectId),
  })
}

export function effectiveFrom(world: OrgWorld, resolved: ResolvedRole | null, projectRef: ScopeRef): EffectiveRole | null {
  const top = resolved?.chain[0]
  if (!resolved || !top) return null
  if (top.source === "group") {
    const teamId = top.grant?.viaTeamId ?? null
    const team = world.teams.find((t) => t.id === teamId)
    const via: ScopeRef = team ? { type: "team", id: team.id, name: team.name } : projectRef
    return { roleLevel: resolved.level, source: "team", via }
  }
  if (top.source === "org") return { roleLevel: resolved.level, source: "org", via: world.org }
  if (top.source === "creator") return { roleLevel: resolved.level, source: "creator", via: projectRef }
  return { roleLevel: resolved.level, source: "direct", via: projectRef }
}

/**
 * Per-project effective roles before and after. Only levels are compared, so
 * a new direct row that ties an inherited one is "no change" — the redundant
 * case the dialog has to name.
 */
export function diffAccess(world: OrgWorld, before: readonly AccessGrant[], after: readonly AccessGrant[]): ProjectChange[] {
  const changes: ProjectChange[] = []
  for (const project of world.projects) {
    const ref: ScopeRef = { type: "project", id: project.id, name: project.name }
    const was = effectiveFrom(world, resolveAt(world, before, project.id), ref)
    const now = effectiveFrom(world, resolveAt(world, after, project.id), ref)
    if ((was?.roleLevel ?? null) !== (now?.roleLevel ?? null)) changes.push({ project: ref, before: was, after: now })
  }
  return changes
}

/** The target's grants after the write: their row at this place is replaced, as the upserts do. */
export function withGrant(world: OrgWorld, userId: string, grants: readonly AccessGrant[], proposal: GrantProposal, projectId?: string): AccessGrant[] {
  const row = (scopeType: AccessGrant["scopeType"], scopeId: string): AccessGrant => ({
    userId,
    scopeType,
    scopeId,
    roleLevel: proposal.roleLevel,
    source: "direct",
    viaTeamId: null,
    grantedBy: null,
    grantedAt: null,
  })
  const { place } = proposal
  if (place.type === "org") {
    return [...grants.filter((g) => !(g.scopeType === "org" && g.scopeId === world.org.id)), row("org", world.org.id)]
  }
  if (place.type === "team") {
    const onTeam = grants.some((g) => (g.scopeType === "team" && g.scopeId === place.id) || g.viaTeamId === place.id)
    const kept = grants.filter((g) => !(g.scopeType === "team" && g.scopeId === place.id))
    // Joining the team also brings each project attachment (group_project_grants × group_members).
    const joined: AccessGrant[] = onTeam
      ? []
      : world.attachments
          .filter((a) => a.teamId === place.id)
          .map((a) => ({ ...row("project", a.projectId), roleLevel: a.roleLevel, source: "team" as const, viaTeamId: place.id }))
    return [...kept, ...joined, row("team", place.id)]
  }
  const pid = projectId ?? place.id
  if (place.type === "lane") {
    // AQU-2322: a lane grant adds one lane row and leaves every other grant as
    // it is. Only someone the project does not open yet also gets the
    // membership that opens it, at the lane role.
    return resolveAt(world, grants, pid) != null ? [...grants] : [...grants, row("project", pid)]
  }
  const kept = grants.filter((g) => !(g.scopeType === "project" && g.scopeId === pid && g.source === "direct"))
  return [...kept, row("project", pid)]
}

function refusal(status: GrantRefusal["status"], code: RefusalCode, message: string, place: ScopeRef, roleLevel: number, cap: number | null): GrantRefusal {
  return { status, code, message, place, roleLevel, cap }
}

/** Mirrors the write route the dialog will submit to. The UI never offers a refused grant; this is the boundary. */
export function checkGrant(
  world: OrgWorld,
  granter: Granter,
  target: GrantTarget,
  proposal: GrantProposal,
  located: { path: ScopeRef[]; projectId?: string },
): { ok: true; cap: number } | { ok: false; refusal: GrantRefusal } {
  const { place } = proposal
  const placeRef = located.path[located.path.length - 1]
  const named = `${place.type} "${placeRef.name}"`
  const role = roleWord(proposal.roleLevel)
  const fail = (status: GrantRefusal["status"], code: RefusalCode, why: string, cap: number | null) =>
    ({ ok: false as const, refusal: refusal(status, code, `cannot grant ${role} at ${named}: ${why}`, placeRef, proposal.roleLevel, cap) })

  const grantable = grantabilityAt(world, granter, place, located.projectId)
  const ownRole = place.type === "org" || place.type === "team"
    ? granter.orgRole
    : (granter.projectRoles.get(located.projectId ?? "") ?? null)
  if (!grantable.ok) return fail(403, grantable.denial, `${DENIAL_REASON[grantable.denial]} (your role there: ${roleWord(ownRole)})`, ownRole)
  const cap = grantable.cap

  if (!SCOPE_ROLES[place.type].includes(proposal.roleLevel)) {
    const offered = SCOPE_ROLES[place.type].map((r) => roleWord(r)).join(", ")
    return fail(400, "role_not_offered", `a ${place.type} offers ${offered}`, cap)
  }
  if (proposal.roleLevel > cap) return fail(403, "above_cap", `that is above your own role there (${roleWord(cap)})`, cap)

  if (target.kind === "invite") {
    const inviteCap = INVITE_ROLE_CAP[place.type]
    if (inviteCap === null) return fail(409, "no_team_invite", "an invitation can go to an organization, project or lane, not a team", cap)
    if (proposal.roleLevel > inviteCap) {
      return fail(403, "above_invite_cap", `an invitation carries at most ${roleWord(inviteCap)}`, inviteCap)
    }
    return { ok: true, cap }
  }

  if (place.type !== "team" && target.userId === granter.userId) return fail(409, "self_grant", "you cannot change your own access", cap)
  if (place.type === "project") {
    const existing = target.grants.find((g) => g.scopeType === "project" && g.scopeId === located.projectId && g.source === "direct")
    if (existing && cap < 700 && existing.roleLevel >= cap) {
      return fail(403, "target_outranks", `${target.displayName} already holds ${roleWord(existing.roleLevel)} there, at or above your role (${roleWord(cap)})`, cap)
    }
  }
  if (place.type === "lane" && located.projectId) {
    // AQU-2322: a lane row is theirs whatever path opens the project, so the
    // cap reads their effective project role (a team Project lead's lane rows
    // sit at Contributor), not only a direct row.
    const level = resolveAt(world, target.grants, located.projectId)?.level ?? 0
    if (cap < 700 && level >= cap) {
      return fail(403, "target_outranks", `${target.displayName} already holds ${roleWord(level)} on this project, at or above your role (${roleWord(cap)})`, cap)
    }
  }
  if (place.type === "team") {
    const current = target.grants.find((g) => g.scopeType === "team" && g.scopeId === place.id)
    if (current && current.roleLevel > cap) {
      return fail(403, "target_outranks", `${target.displayName} holds ${roleWord(current.roleLevel)} on this team, above your role (${roleWord(cap)})`, cap)
    }
  }
  // AQU-2322: a lane grant to someone already on the project is additive (it
  // writes one lane row and never touches their other lanes), so it is not
  // refused any more.
  return { ok: true, cap }
}

/** The person's own row at this place — the one the write's upsert overwrites. */
function existingRowAt(grants: readonly AccessGrant[], proposal: GrantProposal, orgId: string, projectId?: string): number | null {
  const { place } = proposal
  const row = place.type === "org"
    ? grants.find((g) => g.scopeType === "org" && g.scopeId === orgId)
    : place.type === "team"
      ? grants.find((g) => g.scopeType === "team" && g.scopeId === place.id)
      : grants.find((g) => g.scopeType === "project" && g.scopeId === projectId && g.source === "direct")
  return row?.roleLevel ?? null
}

/** Effective role at the granted place itself. */
function hereRole(world: OrgWorld, grants: readonly AccessGrant[], proposal: GrantProposal, located: { path: ScopeRef[]; projectId?: string }): EffectiveRole | null {
  const placeRef = located.path[located.path.length - 1]
  const org = grants.find((g) => g.scopeType === "org" && g.scopeId === world.org.id)
  const orgWide = org && org.roleLevel >= ORG_WIDE_ACCESS_FLOOR ? { roleLevel: org.roleLevel, source: "org" as const, via: world.org } : null
  if (proposal.place.type === "org") return org ? { roleLevel: org.roleLevel, source: "direct", via: world.org } : null
  if (proposal.place.type === "team") {
    const team = grants.find((g) => g.scopeType === "team" && g.scopeId === proposal.place.id)
    const onTeam = team ? { roleLevel: team.roleLevel, source: "direct" as const, via: placeRef } : null
    if (onTeam && orgWide) return onTeam.roleLevel >= orgWide.roleLevel ? onTeam : orgWide
    return onTeam ?? orgWide
  }
  const projectRef = located.path.find((s) => s.type === "project") ?? placeRef
  return effectiveFrom(world, resolveAt(world, grants, located.projectId ?? ""), projectRef)
}

export function previewGrant(
  world: OrgWorld,
  granter: Granter,
  target: GrantTarget,
  proposal: GrantProposal,
): { ok: true; preview: GrantPreview } | { ok: false; refusal: GrantRefusal } | { ok: false; notFound: true } {
  const located = locatePlace(world, proposal.place)
  if (!located) return { ok: false, notFound: true }
  const checked = checkGrant(world, granter, target, proposal, located)
  if (!checked.ok) return checked

  const userId = target.kind === "account" ? target.userId : `invite:${target.email}`
  const before = target.kind === "account" ? target.grants : []
  const after = withGrant(world, userId, before, proposal, located.projectId)
  const changes = diffAccess(world, before, after)

  const lane = proposal.place.type === "lane" && located.projectId
    ? laneAnswer(world, target, proposal, located.projectId, before, after, located.path[located.path.length - 1])
    : null
  const here = lane
    ? lane.here
    : { before: hereRole(world, before, proposal, located), after: hereRole(world, after, proposal, located) }
  const wasGuest = target.kind === "invite" || !target.isOrgMember
  const replaces = lane ? lane.replaces : existingRowAt(before, proposal, world.org.id, located.projectId)
  return {
    ok: true,
    preview: {
      placePath: located.path,
      roleLevel: proposal.roleLevel,
      invite: target.kind === "invite",
      here,
      replaces,
      changes,
      redundant:
        changes.length === 0 &&
        here.before != null &&
        here.before.roleLevel >= proposal.roleLevel &&
        (replaces == null || replaces === proposal.roleLevel),
      guest: { before: wasGuest, after: wasGuest && proposal.place.type !== "org" },
      includesFutureProjects: proposal.place.type === "team",
      lane: lane ? { wallOn: world.wallOn === true, siblingsClosed: lane.siblingsClosed } : null,
    },
  }
}

/** AQU-2322: a lane grant's own before/after, the row it overwrites, and whether sibling lanes stay closed. */
function laneAnswer(
  world: OrgWorld,
  target: GrantTarget,
  proposal: GrantProposal,
  projectId: string,
  before: readonly AccessGrant[],
  after: readonly AccessGrant[],
  laneRef: ScopeRef,
): { here: GrantPreview["here"]; replaces: number | null; siblingsClosed: boolean } {
  const laneId = proposal.place.id
  const rowsBefore = target.kind === "account" ? target.laneGrants : []
  const rowsAfter = withLaneRow(rowsBefore, { projectId, laneId, roleLevel: proposal.roleLevel })
  const at = (grants: readonly AccessGrant[], rows: readonly LaneRow[]): EffectiveRole | null => {
    const level = laneRoleAt(world, grants, rows, projectId, laneId)
    return level == null ? null : { roleLevel: level, source: "lane", via: laneRef }
  }
  // Read as if the wall were on. With it off nothing is closed yet, and the
  // preview says the other lanes are not restricted yet instead.
  const siblingsClosed = siblingLanes(world, projectId, laneId)
    .some((l) => laneRoleAt(world, after, rowsAfter, projectId, l.id, true) == null)
  const existing = rowsBefore.find((g) => g.projectId === projectId && g.laneId === laneId)
  return {
    here: { before: at(before, rowsBefore), after: at(after, rowsAfter) },
    replaces: existing?.roleLevel ?? null,
    siblingsClosed,
  }
}
