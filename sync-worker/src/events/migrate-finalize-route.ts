// POST /migrate/finalize — recompute every file's rollup counters for a project
// in ONE set-based UPDATE, after a deferFileCounters ingest.
//
// The inline projection recomputes a file's counters on EVERY cell event (an
// O(N²)-per-file scan that the profiler showed was ~67% of all migration query
// time). With deferFileCounters the ingest skips that; this endpoint runs the
// same aggregates once across all files in the project — correlated subqueries
// scan each file's cells a single time, so total cost is O(total cells), one
// statement. Result is identical to the incremental path (the counters are pure
// aggregates over the final cells). Gated on ADMIN_SECRET, with SYNC_SECRET_KEY
// still accepted — see lib/admin-auth.ts.
//
// Idempotent: pure recompute from current cells, safe to call any number of times.

import { projectFileCountersRecomputeStmt } from './event-projection'
import { fullProgressRecomputeStmts } from './progress-projection'
import { isAuthorizedAdminBearer } from '../lib/admin-auth'

const PATH = '/migrate/finalize'

export interface MigrateFinalizeEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}

export async function handleMigrateFinalizeRequest(
  request: Request,
  env: MigrateFinalizeEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== PATH) return null
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!isAuthorizedAdminBearer(request.headers.get('Authorization') ?? '', env)) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  const projectId = (body as { projectId?: unknown })?.projectId
  if (typeof projectId !== 'string') return new Response('body must be { projectId }', { status: 400 })

  try {
    // One shared builder with the live projection and the rebuild — see
    // projectFileCountersRecomputeStmt for why three copies was a hazard.
    const res = await projectFileCountersRecomputeStmt(env.AQUILLA_PG, projectId, Date.now()).run()
    const { results: files } = await env.AQUILLA_PG
      .prepare('SELECT id FROM files WHERE project_id = ?')
      .bind(projectId)
      .all<{ id: string }>()
    for (const file of files) {
      await env.AQUILLA_PG.batch(fullProgressRecomputeStmts(env.AQUILLA_PG, projectId, file.id, Date.now()))
    }
    return Response.json({ ok: true, filesUpdated: res.meta?.changes ?? null, progressUpdated: files.length })
  } catch (err) {
    return Response.json({ error: `finalize failed: ${String(err)}` }, { status: 500 })
  }
}
