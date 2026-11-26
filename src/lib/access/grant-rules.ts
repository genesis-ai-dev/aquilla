/**
 * AQU-2320 (spec §3.4): which roles a place accepts, and whether the person
 * giving access may grant there at all — and up to which role.
 *
 * The auth-worker imports this module (the team-role route's
 * `TEAM_SCOPE_ROLES`, the Give access dry run, and the `grantable` map on
 * GET /orgs/:id/access), and so does the Give access dialog. The picker
 * therefore cannot offer a role or a place the server would refuse.
 *
 * The caps mirror the write routes the dialog submits through:
 *   org     POST /orgs/:id/members            org Owner only
 *   team    POST + PATCH /orgs/:id/groups/:g/members
 *                                             org Maintainer+, never above
 *                                             their own org role, and not on a
 *                                             team that holds a project role
 *                                             above theirs (pen test 2026-11-17)
 *   project POST /projects/:p/members         Project lead+ on the project,
 *                                             never above their own role there
 *   lane    the same route, narrowed to one lane
 * Invites: an org invite caps at Maintainer (Owner is never handed over by a
 * link, AQU-952); project and lane invites cap at Contributor
 * (LINK_ROLE_CAP); there is no team invite.
 *
 * Pure and dependency-free on purpose: the worker cannot import the SPA's
 * i18n-bound `roles.ts`, so the ladder values are spelled out here.
 */

export type GrantScopeType = "org" | "team" | "project" | "lane"

const OWNER = 700
const MAINTAINER = 600
const PROJECT_LEAD = 500
const CONTRIBUTOR = 400
const REVIEWER = 300
const COMMENTER = 200
const VIEWER = 100

/** Spec §3.4: the roles each kind of place carries, highest first. */
export const SCOPE_ROLES: Readonly<Record<GrantScopeType, readonly number[]>> = {
  org: [OWNER, MAINTAINER],
  team: [MAINTAINER, PROJECT_LEAD, VIEWER],
  project: [PROJECT_LEAD, CONTRIBUTOR, REVIEWER, COMMENTER, VIEWER],
  lane: [CONTRIBUTOR, REVIEWER, VIEWER],
}

/** Highest role an email invite may carry at each kind of place. `null` = no invite exists there. */
export const INVITE_ROLE_CAP: Readonly<Record<GrantScopeType, number | null>> = {
  org: MAINTAINER,
  team: null,
  project: CONTRIBUTOR,
  lane: CONTRIBUTOR,
}

/** Why someone may not give access at a place. */
export type GrantDenial = "owner_only" | "maintainer_only" | "lead_only" | "team_above_you"

/** `cap` is the highest role this person may grant there: their own role at that place. */
export type PlaceGrantability = { ok: true; cap: number } | { ok: false; denial: GrantDenial }

export interface GranterRoles {
  /** Effective org role (a platform admin reads as Owner, as the write routes treat them once elevated). */
  orgRole: number | null
  /** Project and lane places: effective role on the project. */
  projectRole?: number | null
  /** Team places: the highest role the team holds on any of its projects. */
  teamTopProjectRole?: number | null
}

export function placeGrantability(type: GrantScopeType, roles: GranterRoles): PlaceGrantability {
  const org = roles.orgRole ?? 0
  if (type === "org") return org >= OWNER ? { ok: true, cap: org } : { ok: false, denial: "owner_only" }
  if (type === "team") {
    if (org < MAINTAINER) return { ok: false, denial: "maintainer_only" }
    // Joining a team is receiving its project grants; nobody hands those out above their own level.
    if ((roles.teamTopProjectRole ?? 0) > org) return { ok: false, denial: "team_above_you" }
    return { ok: true, cap: org }
  }
  const project = roles.projectRole ?? 0
  return project >= PROJECT_LEAD ? { ok: true, cap: project } : { ok: false, denial: "lead_only" }
}

/**
 * The roles a picker offers at a place: the place's own rungs, none above the
 * granter's cap there, and for an email invite none above the invite cap.
 */
export function offeredRoles(type: GrantScopeType, cap: number, opts: { invite?: boolean } = {}): number[] {
  const inviteCap = opts.invite ? INVITE_ROLE_CAP[type] : undefined
  if (inviteCap === null) return []
  return SCOPE_ROLES[type].filter((role) => role <= cap && (inviteCap === undefined || role <= inviteCap))
}

/**
 * AQU-2321: why a grant cannot be removed or have its role changed here.
 * The rules mirror the routes the Places lens writes through:
 *   org     DELETE /orgs/:id/members/:u, POST /orgs/:id/members
 *                         Owner only, never yourself
 *   team    DELETE + PATCH /orgs/:id/groups/:g/members/:u
 *                         org Maintainer+; a role change stays at or below
 *                         your own and cannot touch someone above you
 *   project DELETE /projects/:p/members/:u   Maintainer+ on the project
 *           POST /projects/:p/members        Project lead+ (role change)
 *                         both refuse a member at or above you unless you are Owner
 *   lane    lane staffing owns lane rows (AQU-2322); this slice does not write them
 * Invites are cancelled by whoever may send them there (org: Owner, project
 * and lane: Project lead+).
 */
export type EditDenial =
  | GrantDenial
  | "maintainer_on_project"
  | "target_outranks"
  | "self"
  | "lane_needs_staffing"

export type EditCheck = { ok: true } | { ok: false; denial: EditDenial; cap: number | null }

export interface EditTarget {
  /** Their role on the row being changed or removed. */
  roleLevel: number
  /** The row is the viewer's own. */
  isSelf: boolean
  /** A pending invite rather than an account. */
  invite?: boolean
}

const capOf = (place: PlaceGrantability) => (place.ok ? place.cap : null)

/** May this viewer remove this row at this place? `place` is the grantable entry for it. */
export function removalCheck(type: GrantScopeType, place: PlaceGrantability, target: EditTarget): EditCheck {
  if (target.invite) return place.ok ? { ok: true } : { ok: false, denial: place.denial, cap: null }
  if (type === "lane") return { ok: false, denial: "lane_needs_staffing", cap: capOf(place) }
  if (type === "team") {
    // Removing someone from a team hands nothing out, so the pen-test cap on
    // joining (team_above_you) does not apply; the route asks only for Maintainer+.
    return place.ok || place.denial === "team_above_you" ? { ok: true } : { ok: false, denial: place.denial, cap: null }
  }
  if (!place.ok) return { ok: false, denial: place.denial, cap: null }
  if (type === "org") return target.isSelf ? { ok: false, denial: "self", cap: place.cap } : { ok: true }
  if (place.cap < MAINTAINER) return { ok: false, denial: "maintainer_on_project", cap: place.cap }
  if (place.cap < OWNER && target.roleLevel >= place.cap) return { ok: false, denial: "target_outranks", cap: place.cap }
  return { ok: true }
}

/**
 * The roles a direct row may be changed to: the place's rungs at or below
 * the viewer's cap there. A Project lead's list stops at Project lead.
 */
export function roleChangeOptions(
  type: GrantScopeType,
  place: PlaceGrantability,
  target: EditTarget,
): { ok: true; roles: number[] } | { ok: false; denial: EditDenial; cap: number | null } {
  if (type === "lane") return { ok: false, denial: "lane_needs_staffing", cap: capOf(place) }
  if (!place.ok) return { ok: false, denial: place.denial, cap: null }
  if (target.isSelf && type !== "team") return { ok: false, denial: "self", cap: place.cap }
  const outranked = type === "team" ? target.roleLevel > place.cap : place.cap < OWNER && target.roleLevel >= place.cap
  if (type !== "org" && outranked) return { ok: false, denial: "target_outranks", cap: place.cap }
  return { ok: true, roles: offeredRoles(type, place.cap) }
}
