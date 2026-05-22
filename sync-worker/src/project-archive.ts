// Admin handler for project-level archive notifications. Called by
// identity after it flips projects.archived_at so the live ProjectSync DO
// can notify connected clients.
//
// Durable project archive state belongs to identity/project rows. The
// sync-worker keeps no R2 archive marker and no per-file archive state.
//
// Auth: Bearer ${SYNC_SECRET_KEY}, same as /admin/files/*.

export interface ProjectArchiveEnv {
  ProjectSync?: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

export interface ArchiveMarker {
  archivedAt: string | null
  deletedBy: string | null
}

/** Broadcast hook — overridable in tests so we don't need a DO runtime. */
export type ProjectArchiveBroadcaster = (
  env: ProjectArchiveEnv,
  projectId: string,
  marker: ArchiveMarker
) => Promise<void>

/**
 * Handles POST /admin/projects/:projectId/archive. Returns null when the
 * path isn't a project-archive route so the caller can fall through.
 *
 * The broadcast function is mandatory — the real sync-worker supplies one
 * that routes to ProjectSync (see archive-broadcast.ts). Tests supply a
 * stub so they don't need a DO runtime.
 */
export async function handleProjectArchiveRequest(
  request: Request,
  env: ProjectArchiveEnv,
  broadcastFn: ProjectArchiveBroadcaster
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/admin\/projects\/([^/]+)\/archive$/)
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
  let body: ArchiveMarker
  try {
    body = (await request.json()) as ArchiveMarker
  } catch {
    return new Response("bad request", { status: 400 })
  }

  try {
    await broadcastFn(env, projectId, body)
  } catch (err) {
    console.warn(`[project-archive] ProjectSync notify failed for ${projectId}:`, err)
  }

  return Response.json({ ok: true })
}
