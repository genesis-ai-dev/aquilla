// FRO-346: admin handler for project-member-removal notifications. Called by
// identity right after it deletes a project_members row so the live
// ProjectSync DO can eject the removed user's sockets and denylist their
// still-valid (≤15 min) tokens. Mirrors project-archive.ts.
//
// Auth: Bearer ${SYNC_SECRET_KEY}, same as /admin/files/* and the archive hook.

export interface MemberRemovedEnv {
  ProjectSync?: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

export interface MemberRemovedMarker {
  /** Numeric identity user id — matches sync-token claims.userId. */
  userId: number
  /** Presence identity (username); lets the DO match dev/older sockets too. */
  username?: string
}

/** Notifier hook — overridable in tests so we don't need a DO runtime. */
export type MemberRemovedNotifier = (
  env: MemberRemovedEnv,
  projectId: string,
  marker: MemberRemovedMarker,
) => Promise<void>

/** Real notifier: forwards to the per-project ProjectSync DO. */
export const notifyProjectDoMemberRemoved: MemberRemovedNotifier = async (
  env,
  projectId,
  marker,
): Promise<void> => {
  if (!env.ProjectSync) {
    throw new Error("ProjectSync DO not bound")
  }
  const id = env.ProjectSync.idFromName(projectId)
  const stub = env.ProjectSync.get(id)
  const res = await stub.fetch("http://do.internal/__member-removed", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      project: projectId,
      userId: marker.userId,
      ...(marker.username ? { username: marker.username } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(`DO returned HTTP ${res.status}`)
  }
}

/**
 * Handles POST /admin/projects/:projectId/member-removed. Returns null when
 * the path isn't a member-removed route so the caller can fall through.
 *
 * Best-effort by contract: a DO notify failure logs and still returns 200 —
 * the denylist/eject is an acceleration on top of the hard guarantees
 * (mint-time re-resolution + the POST /events membership re-check), so the
 * identity-side removal must never be blocked on it.
 */
export async function handleMemberRemovedRequest(
  request: Request,
  env: MemberRemovedEnv,
  notifyFn: MemberRemovedNotifier,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/admin\/projects\/([^/]+)\/member-removed$/)
  if (!match) return null
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 })
  }

  const auth = request.headers.get("Authorization") ?? ""
  const expected = env.SYNC_SECRET_KEY ? `Bearer ${env.SYNC_SECRET_KEY}` : null
  if (!expected || auth !== expected) {
    return new Response("unauthorized", { status: 401 })
  }

  const projectId = decodeURIComponent(match[1])
  let body: MemberRemovedMarker
  try {
    body = (await request.json()) as MemberRemovedMarker
  } catch {
    return new Response("bad request", { status: 400 })
  }
  if (typeof body.userId !== "number") {
    return new Response("userId (number) required", { status: 400 })
  }

  try {
    await notifyFn(env, projectId, body)
  } catch (err) {
    console.warn(`[member-removed] ProjectSync notify failed for ${projectId}:`, err)
  }

  return Response.json({ ok: true })
}
