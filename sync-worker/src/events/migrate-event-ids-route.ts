// GET /migrate/event-ids?projectId=…&after=<seq>&limit=N — delta-sync support.
//
// Re-syncing a legacy project: the operator computes the full set of
// deterministic event ids for the CURRENT legacy state, but only needs to POST
// the events NOT already in Postgres. This endpoint returns the ids already present
// for a project (paginated by server_seq) so the CLI can diff locally and send
// only the delta to /migrate/ingest. Unchanged giant → 0 to send; a project
// with 200 new edits → 200 events. It also makes completing a partially-ingested
// project cheap (only the missing tail is re-sent).
//
// Paginated by server_seq (the per-project unique ordering key) so even a
// 137k-event project streams in bounded chunks rather than one giant response.
// Gated on SYNC_SECRET_KEY — same trust tier as /migrate/ingest.

import { secureCompare } from '../lib/secure-compare'

const PATH = '/migrate/event-ids'
const MAX_LIMIT = 50000

export interface MigrateEventIdsEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

export async function handleMigrateEventIdsRequest(
  request: Request,
  env: MigrateEventIdsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== PATH) return null
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!secureCompare(request.headers.get('Authorization') ?? '', `Bearer ${env.SYNC_SECRET_KEY}`)) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })

  const projectId = url.searchParams.get('projectId')
  if (!projectId) return new Response('projectId query param required', { status: 400 })
  const after = Number(url.searchParams.get('after') ?? '0') || 0
  const limit = Math.min(Number(url.searchParams.get('limit') ?? String(MAX_LIMIT)) || MAX_LIMIT, MAX_LIMIT)

  // server_seq is UNIQUE per project and ≥1 for assigned events, so it's a clean
  // forward cursor. Ordering by it gives stable, gap-free pagination.
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT id, server_seq FROM events
     WHERE project_id = ? AND server_seq > ?
     ORDER BY server_seq ASC
     LIMIT ?`,
  )
    .bind(projectId, after, limit)
    .all<{ id: string; server_seq: number }>()

  const results = rows.results ?? []
  const ids = results.map((r) => r.id)
  const lastSeq = results.length ? results[results.length - 1].server_seq : after
  const more = results.length === limit
  return Response.json({ ids, lastSeq, more })
}
