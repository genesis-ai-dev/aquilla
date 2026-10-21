// Shared helpers for the progress-sync routers (routes/monday.ts,
// routes/airtable.ts — AQU-804). Pure moves out of the Monday router, so both
// gate and notify exactly the same way. Kept in a leading-underscore file so
// it reads as an internal helper module, not a router of its own.

import type { Context } from "hono"
import type { AuthHonoEnv } from "../middleware/auth"
import { ROLE, type Env } from "../types"
import { getEffectiveOrgRole } from "../services/org-permissions"
import { resolveProjectRole } from "../services/project-permissions"
import { notifySyncWorkerOfSyncLinkChange } from "../services/sync-worker-notify"

/** Managing a connection or a link takes a maintainer; any member can view. */
export const MANAGE_MIN_ROLE = ROLE.MAINTAINER

export async function getProjectOrgId(env: Env, projectId: string): Promise<number | null> {
  const row = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ org_id: number | null }>()
  return row?.org_id ?? null
}

/** Guard: caller must have >= minRole on the org. Returns role or an error Response. */
export async function orgGuard(
  c: Context<AuthHonoEnv>,
  minRole: number | null,
): Promise<{ orgId: number } | Response> {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getEffectiveOrgRole(c.env, orgId, c.get("user"))
  if (role == null) return c.json({ error: "no access to org" }, 403)
  if (minRole != null && role < minRole) {
    return c.json({ error: `org role >= maintainer (${minRole}) required` }, 403)
  }
  return { orgId }
}

/** Guard: caller must have >= minRole on the project. */
export async function projectGuard(
  c: Context<AuthHonoEnv>,
  minRole: number | null,
): Promise<{ projectId: string } | Response> {
  const projectId = c.req.param("projectId") ?? ""
  if (!projectId) return c.json({ error: "invalid projectId" }, 400)
  const role = await resolveProjectRole(c.env, c.get("user"), projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  if (minRole != null && role.level < minRole) {
    return c.json({ error: `project role >= maintainer (${minRole}) required` }, 403)
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
