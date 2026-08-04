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
  buildBulkTargetCellCommitStmt,
  fileCountersRecomputeStmt,
  type PersistedEvent,
} from './event-projection'
import { allocateSeqRange, buildBulkEventInsertStmt } from './event-insert'
import { fullProgressRecomputeStmts } from './progress-projection'
import { notifyProjectDoFileProgressChanged } from '../project-progress-broadcast'
import { MAX_BUFFERED_SOURCE_ARTIFACT_BYTES } from '../../../shared/import-contract'

/** Rows per multi-row INSERT. Bounded by postgres.js's 65,534-bind-param
 *  ceiling: events rows bind 12 params, cells rows 20 → 1000 rows stays an
 *  order of magnitude under it while keeping SQL text small. */
const BULK_ROWS = 1000
const MAX_IMPORT_ATTACHMENTS = 10_000
const MAX_IMPORT_WORD_TIMINGS = 50_000

function optionalFiniteNonNegative(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function validImportTimings(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > MAX_IMPORT_WORD_TIMINGS) return false
  return value.every((timing) => {
    if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return false
    const row = timing as Record<string, unknown>
    return (
      typeof row.word === 'string'
      && row.word.length <= 1024
      && optionalFiniteNonNegative(row.t0)
      && optionalFiniteNonNegative(row.t1)
      && typeof row.t0 === 'number'
      && typeof row.t1 === 'number'
      && row.t1 >= row.t0
      && Number.isSafeInteger(row.start)
      && Number.isSafeInteger(row.end)
      && (row.start as number) >= 0
      && (row.end as number) >= (row.start as number)
    )
  })
}

// The client chunks at 1500 cells/request (src/lib/sync/bulk-import.ts
// CHUNK). This is ~3x headroom for legitimate traffic while stopping a
// single request from fanning out into an unbounded number of bulk-INSERT
// statements against the shared Postgres (Neon) backend every project reads
// and writes through.
const MAX_CELLS_PER_REQUEST = 5000
// Per-field byte caps — generous for a single verse/segment/sentence-sized
// cell, but enough to stop one malformed/malicious cell from persisting a
// multi-MB blob into a row that every reader of the file re-fetches.
const MAX_CELL_TEXT_BYTES = 256 * 1024
const MAX_METADATA_BYTES = 64 * 1024

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

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
  /** Compact normalized-import summary; per-unit locators are cell metadata. */
  importManifest?: Record<string, unknown>
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

interface ImportTarget {
  id: string
  cellId: string
  parentId: string
  value: string
  valueHtml?: string
  targetLang?: string
}

interface ImportAudioAttachment {
  id: string
  cellId: string
  audioId: string
  url: string
  slot: 'recording' | 'generatedVoice'
  mimeType?: string
  voiceId?: string
  referenceAudioId?: string
  durationMs?: number
  trimStartMs?: number
  trimEndMs?: number
  timings?: Array<{ word: string; t0: number; t1: number; start: number; end: number }>
}

interface ImportBody {
  projectId: string
  fileId: string
  /** Present only on the first chunk → emits the genesis file.create. */
  file?: { id: string } & ImportFileMeta
  cells: ImportCell[]
  /** Bilingual genesis commits paired to source cells in this same chunk. */
  targets?: ImportTarget[]
  /** Hide the file in the same transaction that creates it. */
  stageEventId?: string
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
  /** Reveal only after every source/target chunk and artifact upload succeeds. */
  publishEventId?: string
  /** Media metadata persisted atomically with the reveal event. */
  attachments?: ImportAudioAttachment[]
}

function isImportBody(x: unknown): x is ImportBody {
  if (typeof x !== 'object' || x === null) return false
  const b = x as Record<string, unknown>
  return (
    typeof b.projectId === 'string' &&
    typeof b.fileId === 'string' &&
    Array.isArray(b.cells) &&
    (b.targets === undefined || Array.isArray(b.targets)) &&
    (b.attachments === undefined || Array.isArray(b.attachments)) &&
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
  if (body.cells.length > MAX_CELLS_PER_REQUEST) {
    return withCors(
      Response.json(
        { error: `too many cells in one request (${body.cells.length} > ${MAX_CELLS_PER_REQUEST})` },
        { status: 413 },
      ),
      request,
    )
  }
  if (body.rawSource !== undefined) {
    if (
      typeof body.rawSource !== 'string'
      || utf8Bytes(body.rawSource) > MAX_BUFFERED_SOURCE_ARTIFACT_BYTES
    ) {
      return withCors(
        Response.json(
          {
            error: 'rawSource too large or malformed',
            maxBytes: MAX_BUFFERED_SOURCE_ARTIFACT_BYTES,
          },
          { status: 413 },
        ),
        request,
      )
    }
  }
  for (const cell of body.cells) {
    if (cell.value !== undefined && typeof cell.value !== 'string') {
      return withCors(new Response('cell.value must be a string', { status: 400 }), request)
    }
    if (cell.valueHtml !== undefined && typeof cell.valueHtml !== 'string') {
      return withCors(new Response('cell.valueHtml must be a string', { status: 400 }), request)
    }
    if (
      (typeof cell.value === 'string' && utf8Bytes(cell.value) > MAX_CELL_TEXT_BYTES) ||
      (typeof cell.valueHtml === 'string' && utf8Bytes(cell.valueHtml) > MAX_CELL_TEXT_BYTES)
    ) {
      return withCors(
        Response.json({ error: 'cell text exceeds size limit', maxBytes: MAX_CELL_TEXT_BYTES }, { status: 413 }),
        request,
      )
    }
    if (cell.metadata !== undefined) {
      if (
        typeof cell.metadata !== 'object' ||
        cell.metadata === null ||
        Array.isArray(cell.metadata) ||
        utf8Bytes(JSON.stringify(cell.metadata)) > MAX_METADATA_BYTES
      ) {
        return withCors(
          Response.json(
            { error: 'cell.metadata must be a plain object within the size limit', maxBytes: MAX_METADATA_BYTES },
            { status: 400 },
          ),
          request,
        )
      }
    }
  }
  for (const target of body.targets ?? []) {
    if (
      typeof target.value !== 'string'
      || (target.valueHtml !== undefined && typeof target.valueHtml !== 'string')
    ) {
      return withCors(new Response('target value/valueHtml must be strings', { status: 400 }), request)
    }
    if (
      utf8Bytes(target.value) > MAX_CELL_TEXT_BYTES
      || (target.valueHtml !== undefined && utf8Bytes(target.valueHtml) > MAX_CELL_TEXT_BYTES)
    ) {
      return withCors(
        Response.json({ error: 'target text exceeds size limit', maxBytes: MAX_CELL_TEXT_BYTES }, { status: 413 }),
        request,
      )
    }
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

  // The browser sends this empty, authenticated marker only after every
  // concurrent data chunk has settled. Source chunks intentionally perform no
  // full-file scans; finalize all derived counters exactly once here. The
  // statements are self-healing and idempotent, so retrying this request is
  // safe after a dropped response or a partial import.
  if (body.complete && !body.file && body.cells.length === 0) {
    const finalizedAt = Date.now()
    const finalizeStmts: AquillaStatement[] = [
      fileCountersRecomputeStmt(db, body.projectId, body.fileId, finalizedAt),
      ...fullProgressRecomputeStmts(db, body.projectId, body.fileId, finalizedAt),
    ]
    try {
      if ((body.attachments?.length ?? 0) > MAX_IMPORT_ATTACHMENTS) {
        return withCors(new Response('too many media attachments', { status: 400 }), request)
      }
      const finalizeEvents: PersistedEvent[] = []
      let eventTs = finalizedAt
      for (const attachment of body.attachments ?? []) {
        if (
          typeof attachment.id !== 'string'
          || attachment.id.length === 0
          || attachment.id.length > 255
          || typeof attachment.cellId !== 'string'
          || attachment.cellId.length === 0
          || typeof attachment.audioId !== 'string'
          || attachment.audioId.length === 0
          || typeof attachment.url !== 'string'
          || !['recording', 'generatedVoice'].includes(attachment.slot)
          || attachment.cellId.length > 255
          || attachment.audioId.length > 1024
          || (attachment.mimeType !== undefined && (typeof attachment.mimeType !== 'string' || attachment.mimeType.length > 255))
          || (attachment.voiceId !== undefined && (typeof attachment.voiceId !== 'string' || attachment.voiceId.length > 255))
          || (attachment.referenceAudioId !== undefined && (typeof attachment.referenceAudioId !== 'string' || attachment.referenceAudioId.length > 1024))
          || attachment.url !== `frontier-audio://${attachment.audioId}`
          || !optionalFiniteNonNegative(attachment.durationMs)
          || !optionalFiniteNonNegative(attachment.trimStartMs)
          || !optionalFiniteNonNegative(attachment.trimEndMs)
          || !validImportTimings(attachment.timings)
          || (
            attachment.trimStartMs !== undefined
            && attachment.trimEndMs !== undefined
            && attachment.trimEndMs < attachment.trimStartMs
          )
        ) {
          return withCors(new Response('invalid media attachment', { status: 400 }), request)
        }
        finalizeEvents.push({
          id: attachment.id,
          schemaVersion: 1,
          projectId: body.projectId,
          fileId: body.fileId,
          cellId: attachment.cellId,
          parentId: null,
          kind: 'cell.audio.attach',
          author,
          payload: {
            audioId: attachment.audioId,
            url: attachment.url,
            slot: attachment.slot,
            ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
            ...(attachment.voiceId !== undefined ? { voiceId: attachment.voiceId } : {}),
            ...(attachment.referenceAudioId !== undefined ? { referenceAudioId: attachment.referenceAudioId } : {}),
            ...(attachment.durationMs !== undefined ? { durationMs: attachment.durationMs } : {}),
            ...(attachment.trimStartMs !== undefined ? { trimStartMs: attachment.trimStartMs } : {}),
            ...(attachment.trimEndMs !== undefined ? { trimEndMs: attachment.trimEndMs } : {}),
            ...(attachment.timings !== undefined ? { timings: attachment.timings } : {}),
          },
          clientTs,
          serverTs: eventTs++,
        } as PersistedEvent<'cell.audio.attach'>)
      }
      if (finalizeEvents.length > 0) {
        const cellIds = [...new Set(finalizeEvents.map((event) => event.cellId!))]
        const audioIds = [...new Set((body.attachments ?? []).map((attachment) => attachment.audioId))]
        const cellPlaceholders = cellIds.map(() => '?').join(', ')
        const audioPlaceholders = audioIds.map(() => '?').join(', ')
        const [cells, artifacts] = await Promise.all([
          db.prepare(
            `SELECT cell_id FROM cells
              WHERE project_id = ? AND file_id = ? AND side = 'source'
                AND cell_id IN (${cellPlaceholders})`,
          ).bind(body.projectId, body.fileId, ...cellIds).all<{ cell_id: string }>(),
          db.prepare(
            `SELECT audio_id FROM artifacts
              WHERE project_id = ? AND file_id = ? AND kind = 'audio'
                AND audio_id IN (${audioPlaceholders})`,
          ).bind(body.projectId, body.fileId, ...audioIds).all<{ audio_id: string }>(),
        ])
        if (new Set(cells.results.map((row) => row.cell_id)).size !== cellIds.length) {
          return withCors(new Response('media attachment refers to a cell outside this file', { status: 409 }), request)
        }
        if (new Set(artifacts.results.map((row) => row.audio_id)).size !== audioIds.length) {
          return withCors(new Response('media attachment has no matching uploaded artifact', { status: 409 }), request)
        }
      }
      if (body.publishEventId) {
        const restoreEvent: PersistedEvent<'file.restore'> = {
          id: body.publishEventId,
          schemaVersion: 1,
          projectId: body.projectId,
          fileId: body.fileId,
          cellId: null,
          parentId: null,
          kind: 'file.restore',
          author,
          payload: {},
          clientTs,
          serverTs: eventTs++,
        }
        finalizeEvents.push(restoreEvent)
      }
      if (finalizeEvents.length > 0) {
        const seqBase = await allocateSeqRange(db, body.projectId, finalizeEvents.length)
        finalizeStmts.push(buildBulkEventInsertStmt(db, finalizeEvents.map((event, index) => ({
          id: event.id,
          schemaVersion: event.schemaVersion,
          projectId: event.projectId,
          fileId: event.fileId ?? null,
          cellId: event.cellId ?? null,
          parentId: event.parentId ?? null,
          kind: event.kind,
          author: event.author,
          payloadJson: JSON.stringify(event.payload),
          clientTs: event.clientTs,
          serverTs: event.serverTs,
          serverSeq: seqBase + index,
        }))))
        for (const event of finalizeEvents) buildEventProjectionStmts(db, event, finalizeStmts)
      }
      await runImportBatch(db, finalizeStmts)
    } catch (err) {
      return withCors(
        Response.json({ error: `Import finalization failed: ${String(err)}` }, { status: 500 }),
        request,
      )
    }
    if (env.ProjectSync) {
      // AQU-744: a finalize that applied the file.restore reveal is the moment
      // the file enters the visible inventory — the create-time notification
      // fired while the row was still stage-tombstoned, so connected clients
      // must re-pull the file list NOW or a view loaded during the staged
      // window never shows the file until a hard reload.
      const notify = notifyProjectDoFileProgressChanged(
        env,
        body.projectId,
        body.fileId,
        Boolean(body.publishEventId),
      ).catch((err) => {
        console.warn(`[import] ProjectSync completion notify failed for ${body.projectId}/${body.fileId}:`, err)
      })
      if (ctx) ctx.waitUntil(notify)
      else void notify
    }
    return withCors(Response.json({ accepted: 0, fileId: body.fileId }), request)
  }

  let serverTs = Date.now()

  const stmts: AquillaStatement[] = []

  // file.create (first chunk only).
  let fileEvent: PersistedEvent | null = null
  let stageEvent: PersistedEvent<'file.delete'> | null = null
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
        ...(f.importManifest !== undefined ? { importManifest: f.importManifest } : {}),
      },
      clientTs,
      serverTs: serverTs++,
    }
    buildEventProjectionStmts(db, fileEvent, stmts)

    if (body.stageEventId) {
      stageEvent = {
        id: body.stageEventId,
        schemaVersion: 1,
        projectId: body.projectId,
        fileId: body.fileId,
        cellId: null,
        parentId: null,
        kind: 'file.delete',
        author,
        payload: {},
        clientTs,
        serverTs: serverTs++,
      }
      buildEventProjectionStmts(db, stageEvent, stmts)
    }

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

  const targetEvents: PersistedEvent<'target.cell.commit'>[] = []
  const sourceParentByCell = new Map(cellEvents.map((event) => [event.cellId, event.id]))
  for (const target of body.targets ?? []) {
    if (
      typeof target.id !== 'string'
      || typeof target.cellId !== 'string'
      || typeof target.parentId !== 'string'
      || typeof target.value !== 'string'
      || (target.valueHtml !== undefined && typeof target.valueHtml !== 'string')
      || (target.targetLang !== undefined && typeof target.targetLang !== 'string')
    ) {
      return withCors(new Response('each target needs string id, cellId, parentId, and value', { status: 400 }), request)
    }
    if (sourceParentByCell.get(target.cellId) !== target.parentId) {
      return withCors(
        new Response('each target must reference its source parent in the same import chunk', { status: 400 }),
        request,
      )
    }
    targetEvents.push({
      id: target.id,
      schemaVersion: 1,
      projectId: body.projectId,
      fileId: body.fileId,
      cellId: target.cellId,
      parentId: target.parentId,
      kind: 'target.cell.commit',
      author,
      payload: {
        value: target.value,
        ...(target.valueHtml !== undefined ? { valueHtml: target.valueHtml } : {}),
        sourceEventId: target.parentId,
        ...(target.targetLang ? { targetLang: target.targetLang } : {}),
      },
      clientTs,
      serverTs: serverTs++,
    })
  }

  try {
    // One counter bump reserves a contiguous server_seq block for every event
    // in this request (file.create first, then cells in payload order — the
    // same ordering the old per-statement allocator produced).
    const lifecycleEvents = [fileEvent, stageEvent].filter((event): event is PersistedEvent => event !== null)
    const allEvents = [...lifecycleEvents, ...cellEvents, ...targetEvents]
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
    for (let i = 0; i < targetEvents.length; i += BULK_ROWS) {
      stmts.push(buildBulkTargetCellCommitStmt(db, targetEvents.slice(i, i + BULK_ROWS)))
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
