// FRO-478: "Upstream changes" review panel read route.
//
//   GET /api/v1/projects/:projectId/link/cursor-batches
//
// `link.cursor.advance` (FRO-476 §4) is a project-level, non-chain-mutating
// audit record — `fileId`/`cellId` are both NULL on the event row — so
// neither the file-scoped `read-route.ts` (`GET /events`, requires
// `fileId`) nor `cell-history-read-route.ts` (requires `fileId` + `cellId`)
// can retrieve it. This is the "small read extension" the design spec
// anticipated (§9.5): a project-scoped list of mirror-sync batches, each
// with the `source.cell.mirror` / `file.mirror` events that batch folded,
// so the review panel can group flagged cells by sync batch and render an
// old→new diff without a per-cell history round-trip.
//
// How batch membership is derived (no new column, pure server_seq math):
// `mirrorSync` (link-sync.ts) allocates a contiguous downstream seq range
// for a batch's mirror events, then allocates ONE MORE seq for that batch's
// `link.cursor.advance` event immediately after — so for a cursor-advance
// event at server_seq = S, its batch's mirror events are exactly the
// source.cell.mirror/file.mirror rows with
// `previousBatchSeq < server_seq < S` (previousBatchSeq = the prior
// cursor-advance event's server_seq, or 0 for the first batch). Batches are
// returned newest-first; each batch's `events` array is capped so a huge
// re-import doesn't blow up the response (the panel paginates per-batch
// detail lazily if ever needed — out of scope for v1).
//
// Auth: sync-token JWT scoped to `projectId`; viewer (100)+ — same read-only
// gate as stale-source-route.ts (§12: "see stale flags — viewer").

import { verifyTokenForProject } from '../auth'

export interface LinkCursorBatchesEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface CursorAdvanceRow {
  id: string
  payload: string
  server_seq: number
  server_ts: number
}

interface MirrorEventRow {
  id: string
  kind: string
  file_id: string | null
  cell_id: string | null
  payload: string
  server_seq: number
  server_ts: number
}

export interface LinkCursorBatch {
  /** The link.cursor.advance event's own id. */
  batchId: string
  upstreamProjectId: string
  /** Upstream seq range this batch mirrored (matches link.cursor.advance payload). */
  fromSeq: number
  toSeq: number
  cellCount: number
  serverTs: number
  /** The source.cell.mirror / file.mirror events this batch produced,
   *  newest-last (apply order) — capped at MAX_EVENTS_PER_BATCH. */
  events: Array<{
    id: string
    kind: string
    fileId: string | null
    cellId: string | null
    payload: unknown
    serverTs: number
  }>
  /** True if `events` was truncated (batch produced more than the cap). */
  truncated: boolean
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/link\/cursor-batches$/

const DEFAULT_BATCH_LIMIT = 20
const MAX_BATCH_LIMIT = 100
const MAX_EVENTS_PER_BATCH = 500

export async function handleLinkCursorBatchesRequest(
  request: Request,
  env: LinkCursorBatchesEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== 'GET') return null

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

  let limit = DEFAULT_BATCH_LIMIT
  const qLimit = url.searchParams.get('limit')
  if (qLimit !== null) {
    const parsed = parseInt(qLimit, 10)
    if (!isNaN(parsed)) limit = Math.min(MAX_BATCH_LIMIT, Math.max(1, parsed))
  }

  // Newest-first list of this project's cursor-advance records.
  const advanceRes = await env.AQUILLA_PG.prepare(
    `SELECT id, payload, server_seq, server_ts
       FROM events
      WHERE project_id = ? AND kind = 'link.cursor.advance'
      ORDER BY server_seq DESC
      LIMIT ?`,
  )
    .bind(projectId, limit)
    .all<CursorAdvanceRow>()
  const advanceRows = advanceRes.results ?? []

  if (advanceRows.length === 0) {
    return Response.json({ projectId, batches: [] })
  }

  // The floor for each batch's mirror-event window is the PRECEDING
  // cursor-advance event's server_seq (0 if none) — need the full ordered
  // list of advance seqs (not just this page) to compute floors correctly
  // at a page boundary. Cheap: just the seq column, no payload.
  const allSeqsRes = await env.AQUILLA_PG.prepare(
    `SELECT server_seq FROM events
      WHERE project_id = ? AND kind = 'link.cursor.advance'
      ORDER BY server_seq ASC`,
  )
    .bind(projectId)
    .all<{ server_seq: number }>()
  const allSeqsAsc = (allSeqsRes.results ?? []).map((r) => r.server_seq)

  const batches: LinkCursorBatch[] = []
  for (const row of advanceRows) {
    const idx = allSeqsAsc.indexOf(row.server_seq)
    const floorSeq = idx > 0 ? allSeqsAsc[idx - 1]! : 0

    let payload: { upstreamProjectId: string; fromSeq: number; toSeq: number; cellCount: number }
    try {
      payload = JSON.parse(row.payload)
    } catch {
      continue
    }

    const eventsRes = await env.AQUILLA_PG.prepare(
      `SELECT id, kind, file_id, cell_id, payload, server_seq, server_ts
         FROM events
        WHERE project_id = ?
          AND kind IN ('source.cell.mirror', 'file.mirror')
          AND server_seq > ? AND server_seq < ?
        ORDER BY server_seq ASC
        LIMIT ?`,
    )
      .bind(projectId, floorSeq, row.server_seq, MAX_EVENTS_PER_BATCH + 1)
      .all<MirrorEventRow>()
    const rawEvents = eventsRes.results ?? []
    const truncated = rawEvents.length > MAX_EVENTS_PER_BATCH
    const events = (truncated ? rawEvents.slice(0, MAX_EVENTS_PER_BATCH) : rawEvents).map((e) => ({
      id: e.id,
      kind: e.kind,
      fileId: e.file_id,
      cellId: e.cell_id,
      payload: (() => {
        try {
          return JSON.parse(e.payload)
        } catch {
          return e.payload
        }
      })(),
      serverTs: e.server_ts,
    }))

    batches.push({
      batchId: row.id,
      upstreamProjectId: payload.upstreamProjectId,
      fromSeq: payload.fromSeq,
      toSeq: payload.toSeq,
      cellCount: payload.cellCount,
      serverTs: row.server_ts,
      events,
      truncated,
    })
  }

  return Response.json({ projectId, batches })
}
