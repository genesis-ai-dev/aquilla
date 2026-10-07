// AQU-476: mirror sync trigger route.
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
//
// AQU-1563: one request still brings a link fully up to date, however large
// the upstream, but not in one invocation. Each DO call folds a bounded slice
// (LINK_SYNC_INVOCATION_BUDGET_MS of windows, cursor saved per window) and
// answers `more`; this route calls again until the link is caught up, so the
// work behind one request is spread over invocations whose CPU time and memory
// do not grow with the upstream.

import { verifyTokenForProject } from '../auth'
import { LINK_SYNC_INVOCATION_BUDGET_MS, mirrorSync, type MirrorSyncResult } from './link-sync'

export interface LinkSyncRouteEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  ProjectSync?: DurableObjectNamespace
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/link\/sync$/

/**
 * AQU-1563: the most bounded sync invocations one request chains before it
 * answers anyway, with `more: true` (the cursor is saved, so any later trigger
 * resumes). At one window per invocation that is a million-event upstream —
 * a ceiling on a runaway, not a size anything real reaches.
 */
export const MAX_LINK_SYNC_ROUNDS = 500

/** A ProjectSync invocation answered non-2xx; its text is the DO's body. */
class LinkSyncInvocationError extends Error {}

/**
 * Call `runOnce` until it reports the link caught up (`more: false`) or
 * `maxRounds` calls have run, and answer with the rounds' combined result.
 * Every call makes progress (mirrorSync always folds at least one window), and
 * a call that finds nothing left to do — another trigger finished the sync in
 * between — ends the loop like any caught-up answer.
 */
export async function syncUntilCaughtUp(
  runOnce: () => Promise<MirrorSyncResult>,
  maxRounds: number = MAX_LINK_SYNC_ROUNDS,
): Promise<MirrorSyncResult> {
  let total = await runOnce()
  for (let round = 1; total.more && round < maxRounds; round++) {
    const next = await runOnce()
    total = {
      ranSync: total.ranSync || next.ranSync,
      cellsMirrored: total.cellsMirrored + next.cellsMirrored,
      filesMirrored: total.filesMirrored + next.filesMirrored,
      fromSeq: total.fromSeq,
      toSeq: next.ranSync ? next.toSeq : total.toSeq,
      skippedHashEqual: total.skippedHashEqual + next.skippedHashEqual,
      windows: total.windows + next.windows,
      more: next.more,
    }
  }
  return total
}

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

  const projectId = decodeURIComponent(match[1])

  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) {
    return new Response('missing Authorization header', { status: 401 })
  }
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const { ProjectSync, SYNC_SECRET_KEY, AQUILLA_PG } = env
  let runOnce: () => Promise<MirrorSyncResult>
  if (ProjectSync) {
    // Route through the downstream's ProjectSync DO for single-flight
    // serialization (see project-do.ts's /__link-sync handler).
    const stub = ProjectSync.get(ProjectSync.idFromName(projectId))
    runOnce = async () => {
      const res = await stub.fetch(
        `http://do.internal/__link-sync?project=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${SYNC_SECRET_KEY}` },
        },
      )
      if (!res.ok) throw new LinkSyncInvocationError(await res.text().catch(() => ''))
      return (await res.json()) as MirrorSyncResult
    }
  } else {
    // No DO bound (dev/test without the DO namespace) — run in-process.
    // No single-flight guarantee in this mode; acceptable for local/test use.
    runOnce = () => mirrorSync(AQUILLA_PG, projectId, { budgetMs: LINK_SYNC_INVOCATION_BUDGET_MS })
  }

  let result: MirrorSyncResult
  try {
    result = await syncUntilCaughtUp(runOnce)
  } catch (err) {
    // Windows that finished before the failure stay committed, cursor
    // included, so the caller's retry resumes rather than starts over.
    if (err instanceof LinkSyncInvocationError) {
      return new Response(`link sync failed: ${err.message}`, { status: 502 })
    }
    throw err
  }

  return Response.json({ projectId, ...result })
}
