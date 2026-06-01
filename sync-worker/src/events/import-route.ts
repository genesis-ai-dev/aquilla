// POST /import — bulk source-import fast path.
//
// The generic POST /events route does, per event, two D1 reads (idempotency
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
// rows are byte-identical). One read remains: MAX(server_seq) once per request.
// The client streams cells in large chunks; each request does real work
// (dozens of D1 batches) instead of a single 100-event hop.
//
// Auth mirrors authorize(): a valid `aud=sync` token scoped to (projectId,
// fileId), role >= PROJECT_LEAD (source.* is importer/lead-only per
// role-policy.ts). Author is bound to the token, never the request body.

import { verifyTokenForDoc } from '../auth'
import { ROLE } from './role-policy'
import { withCors } from '../cors'
import { buildEventProjectionStmts, type PersistedEvent } from './event-projection'

const D1_BATCH_LIMIT = 100

export interface ImportRouteEnv {
  AQUILLA_DB?: D1Database
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

// server_seq is derived atomically inside the INSERT via a correlated
// subquery against the same `events` row's project_id. SQLite/D1 evaluates
// the SELECT and the INSERT in one statement, and D1 serialises writes at
// the primary, so two concurrent batches can no longer both compute the
// same MAX before either commits — the second batch's subquery sees the
// first batch's just-inserted rows and picks the next free seq. Within a
// single batch the same effect holds: D1 batches execute statements
// sequentially in a transaction, so statement N's subquery sees statement
// N-1's row. INSERT OR IGNORE still skips id-replays (the subquery is
// evaluated but the row is dropped, so no seq gap leaks).
const EVENT_INSERT_SQL = `INSERT OR IGNORE INTO events (
  id, schema_version, project_id, file_id, cell_id, parent_id, kind,
  author, payload, client_ts, server_ts, server_seq
)
SELECT ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + 1`

/** Append the canonical events-row INSERT for one persisted event, mirroring
 *  handlers/cell-events.ts so bulk-import rows match dispatcher rows exactly. */
function pushEventInsert(db: D1Database, e: PersistedEvent, stmts: D1PreparedStatement[]): void {
  stmts.push(
    db
      .prepare(EVENT_INSERT_SQL)
      .bind(
        e.id,
        e.projectId,
        e.fileId ?? null,
        e.cellId ?? null,
        e.parentId ?? null,
        e.kind,
        e.author,
        JSON.stringify(e.payload),
        e.clientTs,
        e.serverTs,
        e.projectId,
      ),
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
  if (!env.AQUILLA_DB) {
    return withCors(new Response('AQUILLA_DB binding not configured', { status: 500 }), request)
  }
  const db = env.AQUILLA_DB

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

  const stmts: D1PreparedStatement[] = []

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
      },
      clientTs,
      serverTs: serverTs++,
    }
    pushEventInsert(db, cellEvent, stmts)
    buildEventProjectionStmts(db, cellEvent, stmts)
  }

  // Commit in D1-batch-limit chunks. file.create + each cell contribute 2
  // statements (event insert + projection), so a chunk holds ~50 cells.
  try {
    for (let i = 0; i < stmts.length; i += D1_BATCH_LIMIT) {
      await db.batch(stmts.slice(i, i + D1_BATCH_LIMIT))
    }
  } catch (err) {
    return withCors(
      Response.json({ error: `D1 batch failed: ${String(err)}` }, { status: 500 }),
      request,
    )
  }

  return withCors(Response.json({ accepted: body.cells.length, fileId: body.fileId }), request)
}
