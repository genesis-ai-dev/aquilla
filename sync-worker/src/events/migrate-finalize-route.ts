// POST /migrate/finalize — recompute every file's rollup counters for a project
// in ONE set-based UPDATE, after a deferFileCounters ingest.
//
// The inline projection recomputes a file's counters on EVERY cell event (an
// O(N²)-per-file scan that the profiler showed was ~67% of all migration query
// time). With deferFileCounters the ingest skips that; this endpoint runs the
// same aggregates once across all files in the project — correlated subqueries
// scan each file's cells a single time, so total cost is O(total cells), one
// statement. Result is identical to the incremental path (the counters are pure
// aggregates over the final cells). Gated on SYNC_SECRET_KEY.
//
// Idempotent: pure recompute from current cells, safe to call any number of times.

const PATH = '/migrate/finalize'

export interface MigrateFinalizeEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

export async function handleMigrateFinalizeRequest(
  request: Request,
  env: MigrateFinalizeEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== PATH) return null
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if ((request.headers.get('Authorization') ?? '') !== `Bearer ${env.SYNC_SECRET_KEY}`) {
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
    const res = await env.AQUILLA_PG.prepare(
      `UPDATE files SET
        cell_count = (SELECT COUNT(DISTINCT cell_id) FROM cells WHERE project_id = files.project_id AND file_id = files.id),
        approved_count = (SELECT COUNT(*) FROM cells WHERE project_id = files.project_id AND file_id = files.id AND validated = 1),
        filled_count = (SELECT COUNT(*) FROM cells WHERE project_id = files.project_id AND file_id = files.id AND side = 'target' AND TRIM(value) != ''),
        word_count = (SELECT COALESCE(SUM(word_count), 0) FROM cells WHERE project_id = files.project_id AND file_id = files.id AND side = 'target'),
        last_edit_at = (SELECT MAX(last_edit_at) FROM cells WHERE project_id = files.project_id AND file_id = files.id),
        updated_at = ?
      WHERE project_id = ?`,
    )
      .bind(Date.now(), projectId)
      .run()
    return Response.json({ ok: true, filesUpdated: res.meta?.changes ?? null })
  } catch (err) {
    return Response.json({ error: `finalize failed: ${String(err)}` }, { status: 500 })
  }
}
