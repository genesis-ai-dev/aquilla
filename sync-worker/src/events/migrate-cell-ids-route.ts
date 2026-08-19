// GET /migrate/cell-ids?projectId=…&fileId=…&after=<cellId>&limit=N
//
// Deletion-by-absence support for the Codex migration (AQU-910). /migrate/event-ids
// tells the CLI which events already landed, but an event id is a one-way UUIDv5
// — it can't enumerate the cells a previous migration materialized. To retract a
// cell Codex has since removed from its notebook ENTIRELY (a hard delete, or a
// heading/verse merged away), the CLI needs the projection's current cells so it
// can diff them against the cells today's parse produces.
//
// Scoped to one file per call: reconciliation is file-scoped by design (a delete
// must never cross a file boundary), and a file is a naturally bounded page.
// Sides are collapsed per cell so the keyset cursor (`cell_id`) is unique — a
// cell has both a source and a target row, and a cursor that could land between
// them would skip one.
//
// Gated on SYNC_SECRET_KEY — same trust tier as /migrate/ingest and
// /migrate/event-ids.

import { secureCompare } from '../lib/secure-compare'

const PATH = '/migrate/cell-ids'
const MAX_LIMIT = 50000

export interface MigrateCellIdsEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

export async function handleMigrateCellIdsRequest(
  request: Request,
  env: MigrateCellIdsEnv,
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
  const fileId = url.searchParams.get('fileId')
  if (!fileId) return new Response('fileId query param required', { status: 400 })
  const after = url.searchParams.get('after') ?? ''
  const limit = Math.min(Number(url.searchParams.get('limit') ?? String(MAX_LIMIT)) || MAX_LIMIT, MAX_LIMIT)

  const rows = await env.AQUILLA_PG.prepare(
    `SELECT cell_id,
            MAX(CASE WHEN side = 'source' THEN 1 ELSE 0 END) AS has_source,
            MAX(CASE WHEN side = 'target' THEN 1 ELSE 0 END) AS has_target
     FROM cells
     WHERE project_id = ? AND file_id = ? AND cell_id > ?
     GROUP BY cell_id
     ORDER BY cell_id ASC
     LIMIT ?`,
  )
    .bind(projectId, fileId, after, limit)
    .all<{ cell_id: string; has_source: number | string; has_target: number | string }>()

  const results = rows.results ?? []
  const cells = results.map((r) => ({
    cellId: r.cell_id,
    hasSource: Number(r.has_source) === 1,
    hasTarget: Number(r.has_target) === 1,
  }))
  const lastCellId = results.length ? results[results.length - 1].cell_id : after
  const more = results.length === limit
  return Response.json({ cells, lastCellId, more })
}
