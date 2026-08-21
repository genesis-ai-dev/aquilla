// [Pen test 2026-08-17] admin handler for project-member role-change
// notifications. Companion to member-removed.ts: identity calls this right
// after it upserts a project_members row with a NEW role_level, so a live
// ProjectSync DO connection's cached role (captured once at WS /connect,
// see project-do.ts ConnectionState) is updated in place instead of staying
// stale for the rest of the socket's life.
//
// WHY: focus.claim/focus.renew gate on conn.role (AQU pen test 2026-08-10).
// Without this hook, demoting a connected write-capable member to a
// read-only role (viewer/commenter) doesn't take effect until they
// reconnect — they can keep holding/renewing the edit lock indefinitely
// after the demotion. Actual content writes are unaffected (POST /events
// re-resolves the caller's role fresh on every request), so this closes a
// griefing/UX-integrity gap, not a data-write bypass.
//
// Deliberately an in-place role update, not an eject: forcing a reconnect
// for every ordinary role change (e.g. a promotion) would be unnecessary
// disruption for something that isn't a security boundary on its own.
//
// Auth: Bearer ${SYNC_SECRET_KEY}, same as /admin/files/* and the other
// project-scoped admin hooks.

import { serviceBearerMatches } from "./lib/service-auth"

export interface MemberRoleChangedEnv {
  ProjectSync?: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

export interface MemberRoleChangedMarker {
  /** Numeric identity user id — matches sync-token claims.userId. */
  userId: number
  /** Presence identity (username); lets the DO match dev/older sockets too. */
  username?: string
  /** New project role level for this user. */
  role: number
}

/** Notifier hook — overridable in tests so we don't need a DO runtime. */
export type MemberRoleChangedNotifier = (
  env: MemberRoleChangedEnv,
  projectId: string,
  marker: MemberRoleChangedMarker,
) => Promise<void>

/** Real notifier: forwards to the per-project ProjectSync DO. */
export const notifyProjectDoMemberRoleChanged: MemberRoleChangedNotifier = async (
  env,
  projectId,
  marker,
): Promise<void> => {
  if (!env.ProjectSync) {
    throw new Error("ProjectSync DO not bound")
  }
  const id = env.ProjectSync.idFromName(projectId)
  const stub = env.ProjectSync.get(id)
  const res = await stub.fetch("http://do.internal/__member-role-changed", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      project: projectId,
      userId: marker.userId,
      role: marker.role,
      ...(marker.username ? { username: marker.username } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(`DO returned HTTP ${res.status}`)
  }
}

/**
 * Handles POST /admin/projects/:projectId/member-role-changed. Returns null
 * when the path isn't a member-role-changed route so the caller can fall
 * through.
 *
 * Best-effort by contract: a DO notify failure logs and still returns 200 —
 * this is a live-session acceleration on top of the hard guarantee (every
 * write re-resolves role fresh), so the identity-side role change must never
 * be blocked on it.
 */
export async function handleMemberRoleChangedRequest(
  request: Request,
  env: MemberRoleChangedEnv,
  notifyFn: MemberRoleChangedNotifier,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/admin\/projects\/([^/]+)\/member-role-changed$/)
  if (!match) return null
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 })
  }

  if (!serviceBearerMatches(request.headers.get("Authorization"), env)) {
    return new Response("unauthorized", { status: 401 })
  }

  const projectId = decodeURIComponent(match[1])
  let body: MemberRoleChangedMarker
  try {
    body = (await request.json()) as MemberRoleChangedMarker
  } catch {
    return new Response("bad request", { status: 400 })
  }
  if (typeof body.userId !== "number" || typeof body.role !== "number") {
    return new Response("userId (number) and role (number) required", { status: 400 })
  }

  try {
    await notifyFn(env, projectId, body)
  } catch (err) {
    console.warn(`[member-role-changed] ProjectSync notify failed for ${projectId}:`, err)
  }

  return Response.json({ ok: true })
}
