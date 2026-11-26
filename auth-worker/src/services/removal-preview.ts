/**
 * AQU-2321: the Remove dry run — Give access's dry run (grant-preview.ts) in
 * reverse. Pure; the route loads the world and the person.
 *
 *   withoutGrants  the person's grant set after the removal routes run. Each
 *                  removal drops exactly what its route deletes: an org row
 *                  also takes every team membership in the org (DELETE
 *                  /orgs/:id/members/:u deletes them), a team membership takes
 *                  the team's project rows, a project row is the direct row only.
 *   previewRemoval what they lose (projects nothing else opens) and what they
 *                  keep (projects another grant still opens, with that grant
 *                  named), both read off resolveFromGrants before and after —
 *                  the resolver, not a second reading of it. A removal never demotes what another
 *                  grant still gives: the kept role is whatever that grant gives.
 *
 * AQU-2322: a lane grant is one project_member_lane_roles row. Removing it
 * deletes that row only, unless it is the last lane of someone whose only way
 * into the project is lane grants: then the project row goes too (see
 * endsMembership). `lanes` says, per lane removed, their role there before and
 * after, read the way the lane read wall reads it.
 */
import type { AccessGrant } from "../../../db/shared/access-grants"
import { removalCheck, type EditDenial } from "../../../src/lib/access/grant-rules"
import type { ScopeRef } from "./access-payload"
import {
  effectiveFrom,
  grantabilityAt,
  laneRoleAt,
  locatePlace,
  resolveAt,
  roleWord,
  type EffectiveRole,
  type GrantTarget,
  type Granter,
  type OrgWorld,
} from "./grant-preview"
import { laneRowIsGrant, narrowedToLanes, type PersonOnProject } from "./lane-shape"

/** A grant row the Places lens can remove. */
export interface GrantRef {
  type: "org" | "team" | "project" | "lane"
  id: string
}

export interface RemovedGrant {
  grant: GrantRef
  path: ScopeRef[]
  /** The row's role; null for a team membership that carries no team role. */
  roleLevel: number | null
  /** AQU-2322: a project row removed because the last lane grant that opened it goes. */
  withLastLane?: true
}

export interface KeptAccess {
  project: ScopeRef
  roleBefore: number
  /** What the surviving grant gives. Never lowered by this removal beyond what that grant gives. */
  after: EffectiveRole
  /** The grant that keeps them here, when it is one this lens can name and remove. */
  grant: GrantRef | null
  grantedAt: string | null
  /** May this viewer remove that grant too. */
  removable: boolean
}

/** AQU-2322: one removed lane grant, and their role in that lane before and after. */
export interface LaneRemoval {
  lane: ScopeRef
  before: number | null
  /** Non-null: the lane still opens (the project role does that while the read wall is off). */
  after: number | null
}

export interface RemovalPreview {
  person: { userId: string; displayName: string }
  invite: boolean
  removes: RemovedGrant[]
  /** Projects (for an invite: places) they can no longer open. */
  loses: ScopeRef[]
  keeps: KeptAccess[]
  /** An org removal also takes them off these teams. */
  leavesTeams: ScopeRef[]
  guest: { before: boolean; after: boolean }
  /** AQU-2322: lane grants removed. Empty when none are. */
  lanes: LaneRemoval[]
  /** AQU-2322: LANE_READ_WALL is on. */
  wallOn: boolean
}

export type RemovalCode = EditDenial | "not_held"

export interface RemovalRefusal {
  status: 403 | 409
  code: RemovalCode
  message: string
  place: ScopeRef
  roleLevel: number | null
  cap: number | null
}

const DENIAL_REASON: Record<EditDenial, string> = {
  owner_only: "only an Owner can remove someone from the organization",
  maintainer_only: "only an org Maintainer or Owner can remove someone from a team",
  lead_only: "only a Project lead or above on this project can change it",
  team_above_you: "this team holds a project role above yours",
  maintainer_on_project: "only a Maintainer or above on this project can remove its members",
  target_outranks: "they hold a role at or above yours there",
  self: "you cannot remove your own access here",
}

type Account = Extract<GrantTarget, { kind: "account" }>
type LaneRow = Account["laneGrants"][number]

function heldRow(grants: readonly AccessGrant[], ref: GrantRef, orgId: string): AccessGrant | undefined {
  if (ref.type === "org") return grants.find((g) => g.scopeType === "org" && g.scopeId === orgId)
  if (ref.type === "team") return grants.find((g) => g.scopeType === "team" && g.scopeId === ref.id)
  if (ref.type === "lane") return undefined
  return grants.find((g) => g.scopeType === "project" && g.scopeId === ref.id && g.source === "direct")
}

function holds(grants: readonly AccessGrant[], ref: GrantRef, orgId: string): boolean {
  if (heldRow(grants, ref, orgId)) return true
  // A team membership without a team role shows only as the team's project rows.
  return ref.type === "team" && grants.some((g) => g.viaTeamId === ref.id)
}

/** The grant set after the removal routes run. A lane ref removes no access_grants row. */
export function withoutGrants(world: OrgWorld, grants: readonly AccessGrant[], refs: readonly GrantRef[]): AccessGrant[] {
  return grants.filter((g) => !refs.some((ref) => {
    if (ref.type === "org") {
      // The org route deletes org_members and every group_members row in the org.
      return (g.scopeType === "org" && g.scopeId === world.org.id) || g.scopeType === "team" || g.viaTeamId != null
    }
    if (ref.type === "team") return (g.scopeType === "team" && g.scopeId === ref.id) || g.viaTeamId === ref.id
    if (ref.type === "lane") return false
    return g.scopeType === "project" && g.scopeId === ref.id && g.source === "direct"
  }))
}

/** The rows lane-shape.ts reads, for one person on one project. */
export function personOnProject(world: OrgWorld, target: Account, laneRows: readonly LaneRow[], projectId: string): PersonOnProject {
  const org = target.grants.find((g) => g.scopeType === "org" && g.scopeId === world.org.id)
  return {
    projectRows: target.grants.filter((g) => g.scopeType === "project" && g.scopeId === projectId),
    orgLevel: org?.roleLevel ?? null,
    laneRows: laneRows.filter((g) => g.projectId === projectId),
    currentLaneIds: world.lanes.filter((l) => l.projectId === projectId).map((l) => l.id),
  }
}

/**
 * Lane grants are their only way into this project, and after the removal
 * none is left: the bare membership would still open the project, so it goes.
 */
function endsMembership(world: OrgWorld, target: Account, rowsAfter: readonly LaneRow[], projectId: string): boolean {
  if (!narrowedToLanes(personOnProject(world, target, target.laneGrants, projectId))) return false
  const after = personOnProject(world, target, rowsAfter, projectId)
  return !after.laneRows.some((row) => laneRowIsGrant(after, row))
}

/** The grant behind an effective role, as a row this lens can name. */
function sourceGrant(world: OrgWorld, after: EffectiveRole, projectId: string): GrantRef | null {
  if (after.source === "direct") return { type: "project", id: projectId }
  if (after.source === "org") return { type: "org", id: world.org.id }
  // A team the viewer cannot see comes back as the project itself: nameless, so not offered.
  if (after.source === "team" && after.via.type === "team") return { type: "team", id: after.via.id }
  return null
}

const capText = (cap: number | null) => (cap == null ? "" : ` (your role there: ${roleWord(cap)})`)

export function previewRemoval(
  world: OrgWorld,
  granter: Granter,
  target: Account,
  refs: readonly GrantRef[],
): { ok: true; preview: RemovalPreview } | { ok: false; refusal: RemovalRefusal } | { ok: false; notFound: true } {
  const isSelf = target.userId === granter.userId
  const removes: RemovedGrant[] = []
  const removedLaneRows: LaneRow[] = []
  const laneRefs: { ref: GrantRef; lane: ScopeRef; projectId: string }[] = []
  for (const ref of refs) {
    const located = locatePlace(world, ref)
    if (!located) return { ok: false, notFound: true }
    const placeRef = located.path[located.path.length - 1]
    const laneRow = ref.type === "lane"
      ? target.laneGrants.find((g) => g.projectId === located.projectId && g.laneId === ref.id)
      : undefined
    const roleLevel = ref.type === "lane" ? (laneRow?.roleLevel ?? null) : (heldRow(target.grants, ref, world.org.id)?.roleLevel ?? null)
    const fail = (status: RemovalRefusal["status"], code: RemovalCode, why: string, cap: number | null) => ({
      ok: false as const,
      refusal: {
        status,
        code,
        message: `cannot remove ${target.displayName} from ${ref.type} "${placeRef.name}": ${why}`,
        place: placeRef,
        roleLevel,
        cap,
      },
    })
    const held = ref.type === "lane" ? laneRow != null : holds(target.grants, ref, world.org.id)
    if (!held) return fail(409, "not_held", "they hold no grant there", null)
    // AQU-2322: a lane row is weighed by the person's role on the project too,
    // so a Project lead cannot take a lane from a peer whose team lane rows sit
    // at Contributor.
    const projectLevel = ref.type === "lane" && located.projectId ? (resolveAt(world, target.grants, located.projectId)?.level ?? 0) : 0
    const check = removalCheck(ref.type, grantabilityAt(world, granter, ref, located.projectId), { roleLevel: Math.max(roleLevel ?? 0, projectLevel), isSelf })
    if (!check.ok) {
      return fail(check.denial === "self" ? 409 : 403, check.denial, `${DENIAL_REASON[check.denial]}${capText(check.cap)}`, check.cap)
    }
    removes.push({ grant: ref, path: located.path, roleLevel })
    if (laneRow && located.projectId) {
      removedLaneRows.push(laneRow)
      laneRefs.push({ ref, lane: placeRef, projectId: located.projectId })
    }
  }

  // AQU-2322: the last lane grant of someone whose only way in is lane grants
  // takes the membership with it, so only someone who may remove project
  // members may remove it.
  const rowsAfter = target.laneGrants.filter((g) => !removedLaneRows.includes(g))
  const allRefs: GrantRef[] = [...refs]
  for (const projectId of new Set(laneRefs.map((l) => l.projectId))) {
    if (allRefs.some((r) => r.type === "project" && r.id === projectId)) continue
    if (!endsMembership(world, target, rowsAfter, projectId)) continue
    const ref: GrantRef = { type: "project", id: projectId }
    const located = locatePlace(world, ref)
    const row = heldRow(target.grants, ref, world.org.id)
    if (!located || !row) continue
    const check = removalCheck("project", grantabilityAt(world, granter, ref, projectId), { roleLevel: row.roleLevel, isSelf })
    if (!check.ok) {
      const placeRef = located.path[located.path.length - 1]
      return {
        ok: false,
        refusal: {
          status: check.denial === "self" ? 409 : 403,
          code: check.denial,
          message: `cannot remove ${target.displayName}'s last language on project "${placeRef.name}": that also ends their project membership, and ${DENIAL_REASON[check.denial]}${capText(check.cap)}`,
          place: placeRef,
          roleLevel: row.roleLevel,
          cap: check.cap,
        },
      }
    }
    allRefs.push(ref)
    removes.push({ grant: ref, path: located.path, roleLevel: row.roleLevel, withLastLane: true })
  }

  const before = target.grants
  const after = withoutGrants(world, before, allRefs)
  const removedOnly = before.filter((g) => !after.includes(g))
  const loses: ScopeRef[] = []
  const keeps: KeptAccess[] = []
  for (const project of world.projects) {
    const ref: ScopeRef = { type: "project", id: project.id, name: project.name }
    const was = effectiveFrom(world, resolveAt(world, before, project.id), ref)
    if (!was) continue
    // Only projects the removed grants reached are part of this answer.
    if (resolveAt(world, removedOnly, project.id) == null) continue
    // Read from the after-set itself: a level that holds can still change its source.
    const now = effectiveFrom(world, resolveAt(world, after, project.id), ref)
    if (!now) {
      loses.push(ref)
      continue
    }
    const grant = sourceGrant(world, now, project.id)
    const row = grant ? heldRow(after, grant, world.org.id) : undefined
    const removable = grant != null && removalCheck(
      grant.type,
      grantabilityAt(world, granter, grant, grant.type === "project" ? project.id : undefined),
      { roleLevel: row?.roleLevel ?? 0, isSelf },
    ).ok
    keeps.push({ project: ref, roleBefore: was.roleLevel, after: now, grant, grantedAt: row?.grantedAt ?? null, removable })
  }

  const lanes: LaneRemoval[] = laneRefs.map(({ ref, lane, projectId }) => ({
    lane,
    before: laneRoleAt(world, before, target.laneGrants, projectId, ref.id),
    after: laneRoleAt(world, after, rowsAfter, projectId, ref.id),
  }))

  const teamIds = new Set(before.flatMap((g) => (g.scopeType === "team" ? [g.scopeId] : g.viaTeamId ? [g.viaTeamId] : [])))
  const leavesTeams = refs.some((r) => r.type === "org")
    ? world.teams.filter((t) => teamIds.has(t.id)).map((t): ScopeRef => ({ type: "team", id: t.id, name: t.name }))
    : []
  const guestBefore = !target.isOrgMember
  return {
    ok: true,
    preview: {
      person: { userId: target.userId, displayName: target.displayName },
      invite: false,
      removes,
      loses,
      keeps,
      leavesTeams,
      guest: { before: guestBefore, after: guestBefore || refs.some((r) => r.type === "org") },
      lanes,
      wallOn: world.wallOn === true,
    },
  }
}
