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
 */
import type { AccessGrant } from "../../../db/shared/access-grants"
import { removalCheck, type EditDenial } from "../../../src/lib/access/grant-rules"
import type { ScopeRef } from "./access-payload"
import {
  effectiveFrom,
  grantabilityAt,
  locatePlace,
  resolveAt,
  roleWord,
  type EffectiveRole,
  type GrantTarget,
  type Granter,
  type OrgWorld,
} from "./grant-preview"

/** A grant row the Places lens can remove. Lane rows belong to lane staffing (AQU-2322). */
export interface GrantRef {
  type: "org" | "team" | "project"
  id: string
}

export interface RemovedGrant {
  grant: GrantRef
  path: ScopeRef[]
  /** The row's role; null for a team membership that carries no team role. */
  roleLevel: number | null
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
  lane_needs_staffing: "a language's members change from the project's lane staffing",
}

type Account = Extract<GrantTarget, { kind: "account" }>

function heldRow(grants: readonly AccessGrant[], ref: GrantRef, orgId: string): AccessGrant | undefined {
  if (ref.type === "org") return grants.find((g) => g.scopeType === "org" && g.scopeId === orgId)
  if (ref.type === "team") return grants.find((g) => g.scopeType === "team" && g.scopeId === ref.id)
  return grants.find((g) => g.scopeType === "project" && g.scopeId === ref.id && g.source === "direct")
}

function holds(grants: readonly AccessGrant[], ref: GrantRef, orgId: string): boolean {
  if (heldRow(grants, ref, orgId)) return true
  // A team membership without a team role shows only as the team's project rows.
  return ref.type === "team" && grants.some((g) => g.viaTeamId === ref.id)
}

/** The grant set after the removal routes run. */
export function withoutGrants(world: OrgWorld, grants: readonly AccessGrant[], refs: readonly GrantRef[]): AccessGrant[] {
  return grants.filter((g) => !refs.some((ref) => {
    if (ref.type === "org") {
      // The org route deletes org_members and every group_members row in the org.
      return (g.scopeType === "org" && g.scopeId === world.org.id) || g.scopeType === "team" || g.viaTeamId != null
    }
    if (ref.type === "team") return (g.scopeType === "team" && g.scopeId === ref.id) || g.viaTeamId === ref.id
    return g.scopeType === "project" && g.scopeId === ref.id && g.source === "direct"
  }))
}

/** The grant behind an effective role, as a row this lens can name. */
function sourceGrant(world: OrgWorld, after: EffectiveRole, projectId: string): GrantRef | null {
  if (after.source === "direct") return { type: "project", id: projectId }
  if (after.source === "org") return { type: "org", id: world.org.id }
  // A team the viewer cannot see comes back as the project itself: nameless, so not offered.
  if (after.source === "team" && after.via.type === "team") return { type: "team", id: after.via.id }
  return null
}

export function previewRemoval(
  world: OrgWorld,
  granter: Granter,
  target: Account,
  refs: readonly GrantRef[],
): { ok: true; preview: RemovalPreview } | { ok: false; refusal: RemovalRefusal } | { ok: false; notFound: true } {
  const isSelf = target.userId === granter.userId
  const removes: RemovedGrant[] = []
  for (const ref of refs) {
    const located = locatePlace(world, ref)
    if (!located) return { ok: false, notFound: true }
    const placeRef = located.path[located.path.length - 1]
    const row = heldRow(target.grants, ref, world.org.id)
    const roleLevel = row?.roleLevel ?? null
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
    if (!holds(target.grants, ref, world.org.id)) return fail(409, "not_held", "they hold no grant there", null)
    const check = removalCheck(ref.type, grantabilityAt(world, granter, ref, located.projectId), { roleLevel: roleLevel ?? 0, isSelf })
    if (!check.ok) {
      const cap = check.cap == null ? "" : ` (your role there: ${roleWord(check.cap)})`
      return fail(check.denial === "self" ? 409 : 403, check.denial, `${DENIAL_REASON[check.denial]}${cap}`, check.cap)
    }
    removes.push({ grant: ref, path: located.path, roleLevel })
  }

  const before = target.grants
  const after = withoutGrants(world, before, refs)
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
    },
  }
}
