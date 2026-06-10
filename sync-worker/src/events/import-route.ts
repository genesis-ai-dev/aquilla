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
// So this route skips both reads and just builds + batches the same statements
// the dispatcher would (it reuses `buildEventProjectionStmts` verbatim, so the
// rows are byte-identical). server_seq comes from the shared per-project
// allocator (event-insert.ts). The client streams cells in large chunks; each
// request does real work (dozens of DB batches) instead of a single
// 100-event hop.
//
// Auth mirrors authorize(): a valid `aud=sync` token scoped to (projectId,
// fileId), role >= PROJECT_LEAD (source.* is importer/lead-only per
// role-policy.ts). Author is bound to the token, never the request body.

import { verifyTokenForDoc } from '../auth'
import { ROLE } from './role-policy'
import { withCors } from '../cors'
import {
  buildEventProjectionStmts,
  fileCountersRecomputeStmt,
  type PersistedEvent,
} from './event-projection'
import { buildEventInsertStmt } from './event-insert'

const BATCH_LIMIT = 100

export interface ImportRouteEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
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
}

function isImportBody(x: unknown): x is ImportBody {
  if (typeof x !== 'object' || x === null) return false
  const b = x as Record<string, unknown>
  return (
    typeof b.projectId === 'string' &&
    typeof b.fileId === 'string' &&
    Array.isArray(b.cells)
  )
}

/** Append the canonical events-row INSERT for one persisted event, mirroring
 *  handlers/cell-events.ts so bulk-import rows match dispatcher rows exactly.
 *  server_seq comes from the shared per-project allocator (event-insert.ts);
 *  id-replays are skipped via ON CONFLICT (id) DO NOTHING. */
function pushEventInsert(db: AquillaDb, e: PersistedEvent, stmts: AquillaStatement[]): void {
  stmts.push(
    buildEventInsertStmt(db, {
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
    }),
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

  const author =
    typeof auth.claims.username === 'string' && auth.claims.username.trim() !== ''
      ? auth.claims.username
      : `user:${auth.claims.userId}`
  const clientTs = typeof body.clientTs === 'number' ? body.clientTs : Date.now()

  let serverTs = Date.now()

  const stmts: AquillaStatement[] = []

  // file.create (first chunk only).
  if (body.file) {
    const f = body.file
    const fileEvent: PersistedEvent = {
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
        ...(f.orderedBy !== undefined ? { orderedBy: f.orderedBy } : {}),
      },
      clientTs,
      serverTs: serverTs++,
    }
    pushEventInsert(db, fileEvent, stmts)
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
      },
      clientTs,
      serverTs: serverTs++,
    }
    pushEventInsert(db, cellEvent, stmts)
    // Defer per-cell file-counter recomputes (cell_count, word_count, etc.)
    // to avoid O(cells²) UPDATE overhead on Postgres. A single recompute runs
    // after all cells have been inserted instead of once per cell. This prevents
    // the first chunk from taking tens of seconds and appearing "stuck at 0%"
    // when importing large Bibles (FRO-135).
    buildEventProjectionStmts(db, cellEvent, stmts, { deferFileCounters: true })
  }

  // One final file-counter recompute per (project, file) pair: counts all cells
  // in the DB that belong to this file (including those from prior chunks of the
  // same import if the client retries). Self-healing by design — always correct.
  stmts.push(fileCountersRecomputeStmt(db, body.projectId, body.fileId, serverTs))

  // Commit in batch-limit chunks. file.create contributes 2 statements
  // (event + files INSERT); each cell contributes 2 statements (event + cells
  // INSERT); the single trailing file-counter recompute is 1 statement.
  try {
    for (let i = 0; i < stmts.length; i += BATCH_LIMIT) {
      await db.batch(stmts.slice(i, i + BATCH_LIMIT))
    }
  } catch (err) {
    return withCors(
      Response.json({ error: `DB batch failed: ${String(err)}` }, { status: 500 }),
      request,
    )
  }

  return withCors(Response.json({ accepted: body.cells.length, fileId: body.fileId }), request)
}
