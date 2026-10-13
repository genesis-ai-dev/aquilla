// AQU-1322: admin power applies only while elevated, on project membership
// writes. OPS-44 extends the same rule to the sync-token mint and the
// merge-sibling fold.
//
// resolveProjectRole adds a { source: "platform", level: 700 } contribution for
// every platform admin, and platform has the lowest tie PRIORITY — but priority
// only breaks ties. 700 outranks every genuine grant below owner, so
// `source === "platform"` does NOT imply the caller has no genuine grant: an
// operator who is a real org Maintainer (600) of the project resolves
// "platform" too. projectElevationDenial accepts that imprecision and refuses
// them (fail-closed, and they can elevate); roleWithoutUnelevatedAdmin below
// does not, because the paths it guards include opening a project for ordinary
// work, where refusing an operator their own project is not acceptable.
//
// The org-side twin is resolveOrgWriteRole in routes/orgs.ts.

import type { Context } from "hono"
import type { AuthHonoEnv } from "../middleware/auth"
import { hasActiveElevation } from "../middleware/platform-admin"
import { resolveGenuineProjectRole } from "./project-permissions"
import { getOrgMemberRole } from "./org-permissions"
import type { AuthUser, RoleResolution } from "../types"

/**
 * A 403 Response when `callerRole` rests on platform-admin power and the
 * request carries no active elevation; null when the write may proceed.
 */
export async function projectElevationDenial(
  c: Context<AuthHonoEnv>,
  callerRole: { source: string },
  /**
   * What the caller was about to do, spliced into the 403 as
   * "elevation required to ${action} with platform-admin access". Defaults to
   * the membership wording the eleven original AQU-1322 call sites emit, so
   * their responses are byte-identical; OPS-44's new sites name their own act.
   */
  action = "manage project membership",
): Promise<Response | null> {
  if (callerRole.source !== "platform") return null
  if (await hasActiveElevation(c)) return null
  return c.json(
    { error: `elevation required to ${action} with platform-admin access` },
    403,
  )
}

/**
 * OPS-44: `callerRole` with cross-tenant platform-admin power removed, unless
 * this session is elevated.
 *
 * Returns `callerRole` unchanged when it rests on a genuine grant, or when the
 * session is elevated (admin power is licensed then). Otherwise returns the
 * caller's GENUINE role — their override / group / org / creator grant — which
 * is null when platform power was their only path.
 *
 * Why not simply 403 on `source === "platform"`, the way the eleven AQU-1322
 * membership sites do: platform contributes level 700, which outranks every
 * genuine grant below owner, so that source also describes an operator who is
 * a real Maintainer of this project's own org. Refusing them would lock
 * operators out of their own projects rather than out of other tenants'. The
 * superpower is what needs elevation, not the request.
 */
export async function roleWithoutUnelevatedAdmin(
  c: Context<AuthHonoEnv>,
  user: AuthUser,
  projectId: string,
  callerRole: RoleResolution,
): Promise<RoleResolution | null> {
  if (callerRole.source !== "platform") return callerRole
  if (await hasActiveElevation(c)) return callerRole
  return resolveGenuineProjectRole(c.env, user, projectId)
}

/**
 * OPS-44, org-side twin of {@link roleWithoutUnelevatedAdmin}: the caller's org
 * level with cross-tenant platform-admin power removed, unless elevated.
 *
 * `getEffectiveOrgRole` returns `Math.max(membership ?? 0, 700)` for a platform
 * operator and plain membership for everyone else, so the genuine membership
 * row IS the de-escalated answer — for a non-admin the two are already equal,
 * which is why this needs no admin check of its own.
 */
export async function orgLevelWithoutUnelevatedAdmin(
  c: Context<AuthHonoEnv>,
  orgId: number,
  user: AuthUser,
  effectiveLevel: number | null,
): Promise<number | null> {
  if (effectiveLevel == null) return null
  if (await hasActiveElevation(c)) return effectiveLevel
  return getOrgMemberRole(c.env, orgId, user.id)
}
