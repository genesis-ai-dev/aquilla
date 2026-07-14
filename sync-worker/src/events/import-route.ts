// POST /import — bulk source-import fast path.
//
// The generic POST /events route does, per event, two DB reads (idempotency
// lookup + AD-2 first-child-of-parent guard) before the projection write. For
// a 31k-verse eBible that's ~62k subrequests, so the client is forced to drip
// 100 events per request — hundreds of round trips, minutes of latency.
//
// A *fresh* source import has a known shape: one `file.create` plus N genesis
// `source.cell.create` events (parent_id = null, unique cell ids, no prior
// siblings). For that shape the per-event guards are unnecessary:
//   - idempotency: the `events` INSERT is `INSERT OR IGNORE` and the `cells`
//     projection is an upsert, so replaying a chunk is naturally safe.
//   - parent-chain: a genesis create with no existing sibling always wins.
//
// So this route skips both reads and writes the same rows the dispatcher
// would, but SET-BASED: one server_seq range allocation per request
// (event-insert.ts allocateSeqRange), then multi-row INSERTs for the events
// log and the cells projection. The Postgres shim executes batch statements
// as sequential round trips, so the old 2-statements-per-cell shape cost
// ~3000 round trips (~100s of wall clock) per 1500-cell chunk; the bulk
// shape is ~6 statements per chunk. Rows stay byte-identical to the
// dispatcher's (buildBulkSourceCellCreateStmt mirrors the single-row case).
//
// Auth mirrors authorize(): a valid `aud=sync` token scoped to (projectId,
// fileId), role >= PROJECT_LEAD (source.* is importer/lead-only per
// role-policy.ts). Author is bound to the token, never the request body.

import { verifyTokenForDoc } from '../auth'
import { ROLE } from './role-policy'
import { withCors } from '../cors'
import {
  buildEventProjectionStmts,
  buildBulkSourceCellCreateStmt,
  fileCountersRecomputeStmt,
  type PersistedEvent,
} from './event-projection'
import { allocateSeqRange, buildBulkEventInsertStmt } from './event-insert'
import { fullProgressRecomputeStmts } from './progress-projection'
import { notifyProjectDoFileProgressChanged } from '../project-progress-broadcast'

/** Rows per multi-row INSERT. Bounded by postgres.js's 65,534-bind-param
 *  ceiling: events rows bind 12 params, cells rows 20 → 1000 rows stays an
 *  order of magnitude under it while keeping SQL text small. */
const BULK_ROWS = 1000

async function runImportBatch(
  db: AquillaDb,
  stmts: AquillaStatement[],
): Promise<void> {
  if (stmts.length === 0) return
  if (db.batchPipelined) {
    await db.batchPipelined(stmts)
    return
  }
  await db.batch(stmts)
}

export interface ImportRouteEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  ProjectSync?: DurableObjectNamespace
}

interface ImportFileMeta {
  name: string
  fileType?: string
  role?: string
  kind?: string
  bookCode?: string
  sourceFileId?: string
  anchorFileId?: string
  r2Key?: string
  importFormat?: string
  parserVersion?: string
  sourceLanguage?: string
  targetLanguage?: string
  sourceTextDirection?: 'ltr' | 'rtl'
  targetTextDirection?: 'ltr' | 'rtl'
  /** Timeline-segment-model order lens ('time' | 'sequence') → files.meta. */
  orderedBy?: string
}

interface ImportCell {
  /** Client-minted event id (UUIDv7) — also the cell's chain head. */
  id: string
  cellId: string
  anchorCellId?: string | null
  value: string
  valueHtml?: string
  type?: string
  canonicalRef?: string
  startMs?: number
  endMs?: number
  // Timeline-segment-model (Scope A) — projected create-time onto the cell.
  sequenceIndex?: number
  medium?: string
  // Extensible per-cell metadata bucket (OBS frame attachments today),
  // persisted to cells.metadata JSONB by buildBulkSourceCellCreateStmt.
  metadata?: Record<string, unknown>
}

interface ImportBody {
  projectId: string
  fileId: string
  /** Present only on the first chunk → emits the genesis file.create. */
  file?: { id: string } & ImportFileMeta
  cells: ImportCell[]
  clientTs?: number
  /** Raw bytes of the source file for formats that need round-trip fidelity
   *  (USFM today). Sent once with the first chunk alongside `file`. Stored in
   *  `file_source_blobs`; the export route serialises this back with current
   *  cell values substituted. */
  rawSource?: string
  /** Tag for which parser/serializer pair to use on export. Required when
   *  rawSource is set. Currently only "usfm". */
  rawSourceFormat?: string
  /** Empty final request sent after concurrent source chunks finish. It emits
   * one accurate realtime progress invalidation and writes no cell events. */
  complete?: boolean
}

function isImportBody(x: unknown): x is ImportBody {
  if (typeof x !== 'object' || x === null) return false
  const b = x as Record<string, unknown>
  return (
    typeof b.projectId === 'string' &&
    typeof b.fileId === 'string' &&
    Array.isArray(b.cells) &&
    (b.complete === undefined || typeof b.complete === 'boolean')
  )
}

/**
 * POST /import
 *
 * Body: { projectId, fileId, file?, cells: ImportCell[], clientTs? }
 * Returns: { accepted: number, fileId } | error
 * Returns null if the URL doesn't match (chainable in the fetch dispatcher).
 */
export async function handleBulkImportRequest(
  request: Request,
  env: ImportRouteEnv,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/import') return null
  if (request.method !== 'POST') {
    return withCors(new Response('method not allowed', { status: 405 }), request)
  }
  if (!env.SYNC_SECRET_KEY) {
    return withCors(new Response('SYNC_SECRET_KEY not configured', { status: 500 }), request)
  }
  if (!env.AQUILLA_PG) {
    return withCors(new Response('AQUILLA_PG binding not configured', { status: 500 }), request)
  }
  const db = env.AQUILLA_PG

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return withCors(new Response('invalid JSON body', { status: 400 }), request)
  }
  if (!isImportBody(body)) {
    return withCors(
      new Response('body must be { projectId, fileId, cells[] }', { status: 400 }),
      request,
    )
  }

  // Auth: token must be scoped to this (project, file) and hold a source-write
  // role. Source-side writes are PROJECT_LEAD+ (importer authority).
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const auth = await verifyTokenForDoc(
    token,
    { projectId: body.projectId, fileId: body.fileId },
    env.SYNC_SECRET_KEY,
  )
  if (!auth.ok) {
    return withCors(new Response(auth.reason, { status: auth.status }), request)
  }
  if (auth.claims.role < ROLE.PROJECT_LEAD) {
    return withCors(new Response('role too low for source import', { status: 403 }), request)
  }

  // The browser sends this empty, authenticated marker only after every
  // concurrent data chunk has settled. Source chunks intentionally perform no
  // full-file scans; finalize all derived counters exactly once here. The
  // statements are self-healing and idempotent, so retrying this request is
  // safe after a dropped response or a partial import.
  if (body.complete && !body.file && body.cells.length === 0) {
    const finalizedAt = Date.now()
    try {
      await runImportBatch(db, [
        fileCountersRecomputeStmt(db, body.projectId, body.fileId, finalizedAt),
        ...fullProgressRecomputeStmts(db, body.projectId, body.fileId, finalizedAt),
      ])
    } catch (err) {
      return withCors(
        Response.json({ error: `Import finalization failed: ${String(err)}` }, { status: 500 }),
        request,
      )
    }
    if (env.ProjectSync) {
      const notify = notifyProjectDoFileProgressChanged(
        env,
        body.projectId,
        body.fileId,
        false,
      ).catch((err) => {
        console.warn(`[import] ProjectSync completion notify failed for ${body.projectId}/${body.fileId}:`, err)
      })
      if (ctx) ctx.waitUntil(notify)
      else void notify
    }
    return withCors(Response.json({ accepted: 0, fileId: body.fileId }), request)
  }

  const author =
    typeof auth.claims.username === 'string' && auth.claims.username.trim() !== ''
      ? auth.claims.username
      : `user:${auth.claims.userId}`
  const clientTs = typeof body.clientTs === 'number' ? body.clientTs : Date.now()

  let serverTs = Date.now()

  const stmts: AquillaStatement[] = []

  // file.create (first chunk only).
  let fileEvent: PersistedEvent | null = null
  if (body.file) {
    const f = body.file
    fileEvent = {
      id: f.id,
      schemaVersion: 1,
      projectId: body.projectId,
      fileId: body.fileId,
      cellId: null,
      parentId: null,
      kind: 'file.create',
      author,
      payload: {
        name: f.name,
        fileType: f.fileType,
        role: f.role,
        kind: f.kind,
        bookCode: f.bookCode,
        sourceFileId: f.sourceFileId,
        anchorFileId: f.anchorFileId,
        r2Key: f.r2Key,
        importFormat: f.importFormat,
        parserVersion: f.parserVersion,
        sourceLanguage: f.sourceLanguage,
        targetLanguage: f.targetLanguage,
        sourceTextDirection: f.sourceTextDirection,
        targetTextDirection: f.targetTextDirection,
        ...(f.orderedBy !== undefined ? { orderedBy: f.orderedBy } : {}),
      },
      clientTs,
      serverTs: serverTs++,
    }
    buildEventProjectionStmts(db, fileEvent, stmts)

    // Side-car raw source for round-trip-fidelity formats. Only written on the
    // first chunk (when `file` is present). UPSERT so re-imports replace.
    if (body.rawSource !== undefined && body.rawSourceFormat) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(file_id) DO UPDATE SET
               project_id = excluded.project_id,
               format     = excluded.format,
               raw_source = excluded.raw_source,
               created_at = excluded.created_at`,
          )
          .bind(body.fileId, body.projectId, body.rawSourceFormat, body.rawSource, Date.now()),
      )
    }
  }

  // source.cell.create per cell — genesis (parent_id = null), chained by
  // anchorCellId in the payload.
  const cellEvents: PersistedEvent[] = []
  for (const cell of body.cells) {
    if (typeof cell.id !== 'string' || typeof cell.cellId !== 'string') {
      return withCors(
        new Response('each cell needs string id + cellId', { status: 400 }),
        request,
      )
    }
    const cellEvent: PersistedEvent = {
      id: cell.id,
      schemaVersion: 1,
      projectId: body.projectId,
      fileId: body.fileId,
      cellId: cell.cellId,
      parentId: null,
      kind: 'source.cell.create',
      author,
      payload: {
        cellId: cell.cellId,
        anchorCellId: cell.anchorCellId ?? null,
        value: cell.value ?? '',
        ...(cell.valueHtml !== undefined ? { valueHtml: cell.valueHtml } : {}),
        ...(cell.type !== undefined ? { type: cell.type } : {}),
        ...(cell.canonicalRef !== undefined ? { canonicalRef: cell.canonicalRef } : {}),
        ...(cell.startMs !== undefined ? { startMs: cell.startMs } : {}),
        ...(cell.endMs !== undefined ? { endMs: cell.endMs } : {}),
        ...(cell.sequenceIndex !== undefined ? { sequenceIndex: cell.sequenceIndex } : {}),
        ...(cell.medium !== undefined ? { medium: cell.medium } : {}),
        ...(cell.metadata !== undefined ? { metadata: cell.metadata } : {}),
      },
      clientTs,
      serverTs: serverTs++,
    }
    cellEvents.push(cellEvent)
  }

  try {
    // One counter bump reserves a contiguous server_seq block for every event
    // in this request (file.create first, then cells in payload order — the
    // same ordering the old per-statement allocator produced).
    const allEvents = fileEvent ? [fileEvent, ...cellEvents] : cellEvents
    if (allEvents.length > 0) {
      const seqBase = await allocateSeqRange(db, body.projectId, allEvents.length)
      for (let i = 0; i < allEvents.length; i += BULK_ROWS) {
        const chunk = allEvents.slice(i, i + BULK_ROWS)
        stmts.push(
          buildBulkEventInsertStmt(
            db,
            chunk.map((e, j) => ({
              id: e.id,
              schemaVersion: e.schemaVersion,
              projectId: e.projectId,
              fileId: e.fileId ?? null,
              cellId: e.cellId ?? null,
              parentId: e.parentId ?? null,
              kind: e.kind,
              author: e.author,
              payloadJson: JSON.stringify(e.payload),
              clientTs: e.clientTs,
              serverTs: e.serverTs,
              serverSeq: seqBase + i + j,
            })),
          ),
        )
      }
    }

    // Cells projection, multi-row. All full-file counters are deferred to the
    // explicit completion request after every concurrent chunk settles.
    for (let i = 0; i < cellEvents.length; i += BULK_ROWS) {
      stmts.push(buildBulkSourceCellCreateStmt(db, cellEvents.slice(i, i + BULK_ROWS)))
    }

    // Keep each data request to the event log + direct projections only. The
    // pipelined transaction removes avoidable Hyperdrive↔Neon round trips while
    // retaining the same atomic ordering and rollback behavior.
    await runImportBatch(db, stmts)
  } catch (err) {
    return withCors(
      Response.json({ error: `DB batch failed: ${String(err)}` }, { status: 500 }),
      request,
    )
  }

  // The first chunk is the only one that creates a file. Notify once here;
  // later chunks are intentionally silent so a large import cannot turn into
  // a flood of editor revalidations for every connected collaborator.
  if ((body.file || body.complete) && env.ProjectSync) {
    const notify = notifyProjectDoFileProgressChanged(
      env,
      body.projectId,
      body.fileId,
      Boolean(body.file),
    ).catch((err) => {
      console.warn(`[import] ProjectSync notify failed for ${body.projectId}/${body.fileId}:`, err)
    })
    if (ctx) ctx.waitUntil(notify)
    else void notify
  }

  return withCors(Response.json({ accepted: body.cells.length, fileId: body.fileId }), request)
}
