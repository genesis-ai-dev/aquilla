// FRO-476: mirror sync trigger route.
//
//   POST /api/v1/projects/:projectId/link/sync
//
// Runs one mirror sync (link-sync.ts) for the given downstream project.
// Any member ≥ viewer(100) may trigger it lazily (§12 permissions table —
// the writes themselves are server-authored, not the caller's authority);
// the route just kicks the server-side engine, same auth shape as
// stale-source-route.ts.
//
// Single-flight: when ProjectSync is bound, the actual sync runs INSIDE the
// downstream's ProjectSync Durable Object (serialized — the DO's single-
// threaded execution model gives single-flight for free, see project-do.ts's
// /__link-sync handler) so two concurrent triggers (push + lazy pull) can't
// interleave folds. Falls back to running in-process (no single-flight
// guarantee) when ProjectSync isn't bound — dev/test envs without the DO.

import { verifyTokenForProject } from '../auth'
import { mirrorSync, type MirrorSyncResult } from './link-sync'

export interface LinkSyncRouteEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  ProjectSync?: DurableObjectNamespace
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/link\/sync$/

export async function handleLinkSyncRequest(
  request: Request,
  env: LinkSyncRouteEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== 'POST') return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  if (!env.AQUILLA_PG) {
    return new Response('AQUILLA_PG binding not configured', { status: 500 })
  }

  const projectId = decodeURIComponent(match[1]!)

  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) {
    return new Response('missing Authorization header', { status: 401 })
  }
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  let result: MirrorSyncResult
  if (env.ProjectSync) {
    // Route through the downstream's ProjectSync DO for single-flight
    // serialization (see project-do.ts's /__link-sync handler).
    const id = env.ProjectSync.idFromName(projectId)
    const stub = env.ProjectSync.get(id)
    const res = await stub.fetch(
      `http://do.internal/__link-sync?project=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.SYNC_SECRET_KEY}` },
      },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return new Response(`link sync failed: ${body}`, { status: 502 })
    }
    result = (await res.json()) as MirrorSyncResult
  } else {
    // No DO bound (dev/test without the DO namespace) — run in-process.
    // No single-flight guarantee in this mode; acceptable for local/test use.
    result = await mirrorSync(env.AQUILLA_PG, projectId)
  }

  return Response.json({ projectId, ...result })
}
