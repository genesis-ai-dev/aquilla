// Shared helpers for the progress-sync routers (routes/monday.ts,
// routes/airtable.ts — AQU-804; routes/langquest.ts — AQU-2105). Pure moves out
// of the Monday router, so all three gate and notify exactly the same way. Kept
// in a leading-underscore file so it reads as an internal helper module, not a
// router of its own.
//
// OPS-49 (OPSEC review 2026-10-26): these two guards are the ONLY authorization
// decision the three integration routers make, and both resolvers below hand a
// platform admin the top of the ladder on every tenant — getEffectiveOrgRole
// returns max(membership, 700) and resolveProjectRole contributes
// { source: "platform", level: 700 }. So an un-elevated admin JWT satisfied
// every MAINTAINER floor in all three routers.
//
// What that reaches is not another un-gated write. These routes decide WHERE a
// project's progress leaves Aquilla and ON WHOSE credential: the push payload
// carries the project and file names, each language, the per-lane completion
// figures, the last-activity date and `translators` — the comma-joined
// usernames of every member at CONTRIBUTOR+ (lib/monday/metrics.ts). That is
// the D2+D3 linkage §2 of docs/OPSEC.md names as the asset a state actor wants.
// The link outlives the session that wrote it and the five-minute cron keeps
// pushing, so this is OPS-44's category — a capability that ESCAPES the
// session — not a one-shot write AQU-2003's read-only posture could price.
//
// The rule, stated once here rather than at 38 call sites: **an asserted role
// floor is not satisfied by platform-admin power unless the session is
// elevated.** A guard called with `minRole == null` is the member-level status
// read the SPA makes on every project open, and keeps AQU-2003's posture
// unchanged — an un-elevated operator can still SEE that another tenant's
// project is linked, exactly as they can already open it read-only.

import type { Context } from "hono"
import type { AuthHonoEnv } from "../middleware/auth"
import { ROLE, type Env } from "../types"
import { getEffectiveOrgRole } from "../services/org-permissions"
import { resolveProjectRole } from "../services/project-permissions"
import {
  orgLevelWithoutUnelevatedAdmin,
  roleWithoutUnelevatedAdmin,
} from "../services/elevation-gate"
import { notifySyncWorkerOfSyncLinkChange } from "../services/sync-worker-notify"

/** Managing a connection or a link takes a maintainer; any member can view. */
export const MANAGE_MIN_ROLE = ROLE.MAINTAINER

/**
 * The 403 for a caller who misses `minRole`, distinguishing the two reasons so
 * an operator is told to elevate rather than told they have no access.
 *
 * `genuine` is the level left after OPS-49's de-escalation, `effective` the one
 * that included platform-admin power. When only the latter cleared the floor,
 * elevation is the thing missing — and `elevation-gate.ts` already owns that
 * wording. Otherwise the message is byte-identical to the pre-OPS-49 one, so
 * nothing an ordinary member sees changes.
 */
function floorDenial(
  c: Context<AuthHonoEnv>,
  scope: "org" | "project",
  minRole: number,
  genuine: number | null,
  effective: number,
): Response {
  if ((genuine ?? -1) < minRole && effective >= minRole) {
    return c.json(
      {
        error: `elevation required to manage this ${scope}'s integrations with platform-admin access`,
      },
      403,
    )
  }
  return c.json({ error: `${scope} role >= maintainer (${minRole}) required` }, 403)
}

export async function getProjectOrgId(env: Env, projectId: string): Promise<number | null> {
  const row = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ org_id: number | null }>()
  return row?.org_id ?? null
}

/**
 * Guard: caller must have >= minRole on the org. Returns the org id or an error
 * Response.
 *
 * OPS-49: when `minRole` is asserted, platform-admin power is stripped unless
 * the session is elevated, so an un-elevated operator clears the floor only on
 * an org where they hold a genuine membership grant. `minRole == null` — the
 * connection-status read — is left on AQU-2003's posture.
 */
export async function orgGuard(
  c: Context<AuthHonoEnv>,
  minRole: number | null,
): Promise<{ orgId: number } | Response> {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const user = c.get("user")
  const effective = await getEffectiveOrgRole(c.env, orgId, user)
  if (effective == null) return c.json({ error: "no access to org" }, 403)
  if (minRole == null) return { orgId }
  const genuine = await orgLevelWithoutUnelevatedAdmin(c, orgId, user, effective)
  if ((genuine ?? -1) < minRole) return floorDenial(c, "org", minRole, genuine, effective)
  return { orgId }
}

/**
 * Guard: caller must have >= minRole on the project.
 *
 * OPS-49: same rule as {@link orgGuard} — an asserted floor is not satisfied by
 * un-elevated platform-admin power, while the member-level link read is not
 * narrowed.
 */
export async function projectGuard(
  c: Context<AuthHonoEnv>,
  minRole: number | null,
): Promise<{ projectId: string } | Response> {
  const projectId = c.req.param("projectId") ?? ""
  if (!projectId) return c.json({ error: "invalid projectId" }, 400)
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  if (minRole == null) return { projectId }
  const genuine = await roleWithoutUnelevatedAdmin(c, user, projectId, role)
  if ((genuine?.level ?? -1) < minRole) {
    return floorDenial(c, "project", minRole, genuine?.level ?? null, role.level)
  }
  return { projectId }
}

/**
 * AQU-1828: the project's DO caches "this project has no progress-sync link"
 * so it stops nudging identity on every edit. Any change to a link row has to
 * drop that cache, or a freshly linked project would not start pushing until
 * the DO's backstop TTL lapsed. Best-effort: `executionCtx` is absent in some
 * test harnesses, and the link row itself is already durable.
 */
export function notifyLinkChangedBestEffort(
  c: {
    env: Parameters<typeof notifySyncWorkerOfSyncLinkChange>[0]
    executionCtx: { waitUntil(promise: Promise<unknown>): void }
  },
  projectId: string,
): void {
  const notifyPromise = notifySyncWorkerOfSyncLinkChange(c.env, projectId)
  try {
    c.executionCtx.waitUntil(notifyPromise)
  } catch {
    void notifyPromise
  }
}
