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
