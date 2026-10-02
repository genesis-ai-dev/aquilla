// AQU-1566 (option b): a linked video's captions become the file's own rows.
//
// A YouTube "Link video only" import is a time-ordered file with a linked
// picture and zero rows. Captions attached on the timeline used to live only
// in a hidden `timeline-content` file, so the Text view, the footer and every
// progress number stayed at zero. This operation copies those cues into the
// parent as ordinary source rows, exactly as "Import a caption export" would
// have written them, and re-kinds the parent to the caption format (a
// non-subtitle kind gets the dubbing 3-row layout and Free timing).
//
// Two callers, one transaction shape (modelled on import-track-publication.ts):
//   - new captions: the client stages a hidden, deleted content file and then
//     asks for it to be promoted (no `trackId`);
//   - an existing track: the client names the track; the same transaction
//     retires it (`file.track.set` patch null) and deletes its content file.
//
// Maintainer only, and deliberately NOT gated on `allowTrackEditing` (Sam's
// ruling): turning a file's first captions into its rows is not restructuring
// a timeline. The parent's `file.create` re-genesis id is the receipt that
// makes a lost response safe to retry. Every write is an event with its normal
// projection, so rebuild.ts reproduces the kind, meta, rows, the removed track
// and the deleted content file.

import type { AquillaDb } from '../../../db/shim/postgres'
import type { CaptionRowsPromotion } from '../../../shared/timeline-import'
export type { CaptionRowsPromotion } from '../../../shared/timeline-import'
import { ROLE } from './role-policy'
import { DEFAULT_TRACK_IDS } from './track-editing-authority'
import { allocateSeqRange, buildBulkEventInsertStmt, buildSettleSeqRangeStmt } from './event-insert'
import {
  buildBulkSourceCellCreateStmt,
  buildEventProjectionStmts,
  fileCountersRecomputeStmt,
  type PersistedEvent,
} from './event-projection'
import { fullProgressRecomputeStmts } from './progress-projection'
import type { EventPayloads } from './types'

interface PromotionArgs {
  projectId: string
  fileId: string
  author: string
  role: number
  clientTs: number
  promotion: CaptionRowsPromotion
}

type Result = { ok: true; cellCount: number } | { ok: false; status: number; reason: string }
const refuse = (status: number, reason: string): Result => ({ ok: false, status, reason })
const ID = /^[A-Za-z0-9_-]{1,200}$/
const TRACK_ID = /^[A-Za-z0-9_-]{1,64}$/
const CAPTION_KINDS = new Set(['vtt', 'srt', 'sbv'])
const HIDDEN_ROLES = new Set(['audio-cues', 'timeline-content'])
/** Rows per multi-row INSERT. Cells bind ~24 values a row, so 750 rows stay
 *  far under postgres.js's 65,534-parameter ceiling. */
const BULK_ROWS = 750
const META = "COALESCE(NULLIF(meta, ''), '{}')::jsonb"
class PromotionConflict extends Error {}

function validPromotion(value: unknown): value is CaptionRowsPromotion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => ![
    'contentFileId', 'trackId', 'genesisEventId', 'retireEventId', 'deleteEventId',
  ].includes(key))) return false
  const id = (v: unknown) => typeof v === 'string' && ID.test(v)
  if (!id(p.contentFileId) || !id(p.genesisEventId)) return false
  if (p.trackId === undefined) {
    return p.retireEventId === undefined && p.deleteEventId === undefined
  }
  if (typeof p.trackId !== 'string' || !TRACK_ID.test(p.trackId)) return false
  if (!id(p.retireEventId) || !id(p.deleteEventId)) return false
  const ids = [p.genesisEventId, p.retireEventId, p.deleteEventId]
  return new Set(ids).size === ids.length
}

interface FileRow {
  id: string
  name: string
  role: string | null
  kind: string | null
  book_code: string | null
  source_file_id: string | null
  anchor_file_id: string | null
  deleted_at: number | string | null
  event_id: string
  meta: Record<string, unknown> | null
}

interface CueRow {
  cell_id: string
  value: string
  value_html: string | null
  type: string | null
  canonical_ref: string | null
  start_ms: number | string | null
  end_ms: number | string | null
  sequence_index: number | string | null
  medium: string | null
  metadata: Record<string, unknown> | string | null
}

type TrackOverrides = Record<string, { kind?: string; contentFileId?: string } | undefined>

const num = (value: number | string | null) => value === null ? undefined : Number(value)
const objectRecord = (value: unknown): Record<string, unknown> | undefined => {
  const parsed = typeof value === 'string' ? (() => {
    try { return JSON.parse(value) as unknown } catch { return undefined }
  })() : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : undefined
}

function liveSourceCount(db: AquillaDb, projectId: string, fileId: string) {
  return db.prepare(
    `SELECT COUNT(*) AS count FROM cells
      WHERE project_id = ? AND file_id = ? AND side = 'source' AND tombstoned_at IS NULL`,
  ).bind(projectId, fileId).first<{ count: number | string }>()
    .then(row => Number(row?.count ?? 0))
}

/** Caller authenticates the parent-file JWT (PROJECT_LEAD+ for /import). */
export async function promoteCaptionsToRows(
  db: AquillaDb,
  args: PromotionArgs,
): Promise<Result> {
  const p = args.promotion
  if (!validPromotion(p) || p.contentFileId === args.fileId) {
    return refuse(400, 'invalid caption rows promotion')
  }
  if (args.role < ROLE.MAINTAINER) return refuse(403, 'turning captions into rows requires maintainer')
  if (!db.transaction) return refuse(503, 'atomic caption promotion is unavailable')
  // Sized outside the transaction (the seq range is allocated on its own
  // connection, as every import write does); re-checked under the locks below.
  const expected = await liveSourceCount(db, args.projectId, p.contentFileId)
  const seqBase = await allocateSeqRange(db, args.projectId, expected + (p.trackId ? 3 : 1))
  const result = await db.transaction<Result>(async tx => {
    const parent = await tx.prepare(
      `SELECT id, name, role, kind, book_code, source_file_id, anchor_file_id,
              deleted_at, event_id, ${META} AS meta
         FROM files WHERE id = ? AND project_id = ? FOR UPDATE`,
    ).bind(args.fileId, args.projectId).first<FileRow>()
    if (!parent || parent.deleted_at !== null || HIDDEN_ROLES.has(parent.role ?? '')) {
      return refuse(409, 'media timeline is unavailable')
    }
    // Receipt first: after a successful promotion the parent has rows, so a
    // retried request must be answered before the "no rows yet" refusal.
    const expectedReceipts = new Map<string, { fileId: string; kind: string }>([
      [p.genesisEventId, { fileId: args.fileId, kind: 'file.create' }],
      ...(p.trackId ? [
        [p.retireEventId!, { fileId: args.fileId, kind: 'file.track.set' }],
        [p.deleteEventId!, { fileId: p.contentFileId, kind: 'file.delete' }],
      ] as const : []),
    ])
    const receipts = await tx.prepare(
      `SELECT id, project_id, file_id, kind FROM events
        WHERE id IN (${[...expectedReceipts.keys()].map(() => '?').join(', ')})`,
    ).bind(...expectedReceipts.keys()).all<{
      id: string; project_id: string; file_id: string; kind: string
    }>()
    if (receipts.results.length) {
      const same = receipts.results.some(row => row.id === p.genesisEventId)
        && receipts.results.every(row => {
          const want = expectedReceipts.get(row.id)
          return row.project_id === args.projectId
            && row.file_id === want?.fileId && row.kind === want.kind
        })
      if (!same) return refuse(409, 'promotion event is already used')
      await buildSettleSeqRangeStmt(tx, args.projectId, seqBase).run()
      return { ok: true, cellCount: await liveSourceCount(tx, args.projectId, args.fileId) }
    }
    const parentMeta = parent.meta ?? {}
    if (typeof parentMeta.coreMediaUrl !== 'string' || !parentMeta.coreMediaUrl.trim()) {
      return refuse(409, 'only a file linked to a video can take its captions as rows')
    }
    if (await liveSourceCount(tx, args.projectId, args.fileId) > 0) {
      return refuse(409, 'this file already has rows')
    }
    const child = await tx.prepare(
      `SELECT id, name, role, kind, book_code, source_file_id, anchor_file_id,
              deleted_at, event_id, ${META} AS meta
         FROM files WHERE id = ? AND project_id = ? FOR UPDATE`,
    ).bind(p.contentFileId, args.projectId).first<FileRow>()
    if (!child || child.role !== 'timeline-content' || child.anchor_file_id !== args.fileId) {
      return refuse(409, 'caption content is not a file of this timeline')
    }
    if (!CAPTION_KINDS.has(child.kind ?? '')) {
      return refuse(400, 'only caption tracks can become rows')
    }
    const overrides = (parentMeta.trackOverrides ?? {}) as TrackOverrides
    const boundTrack = Object.entries(overrides)
      .find(([, override]) => override?.contentFileId === p.contentFileId)?.[0]
    if (p.trackId) {
      const override = overrides[p.trackId]
      const kind = DEFAULT_TRACK_IDS.has(p.trackId) ? p.trackId : override?.kind
      if (child.deleted_at !== null || override?.contentFileId !== p.contentFileId) {
        return refuse(409, 'that caption track changed, reload and try again')
      }
      if (kind !== 'source-subtitles') return refuse(400, 'only caption tracks can become rows')
    } else if (child.deleted_at === null || boundTrack !== undefined) {
      return refuse(409, 'caption content is not a staged file for this timeline')
    }
    const cues = await tx.prepare(
      `SELECT cell_id, value, value_html, type, canonical_ref, start_ms, end_ms,
              sequence_index, medium, metadata
         FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'source' AND tombstoned_at IS NULL
        ORDER BY start_ms ASC NULLS LAST, sequence_index ASC NULLS LAST, cell_id ASC`,
    ).bind(args.projectId, p.contentFileId).all<CueRow>()
    if (cues.results.length === 0) return refuse(409, 'caption content is empty')
    if (cues.results.length !== expected) return refuse(409, 'the captions changed, try again')

    const childMeta = child.meta ?? {}
    const kind = child.kind!
    const parserVersion = typeof childMeta.parserVersion === 'string'
      ? childMeta.parserVersion : undefined
    const manifest = objectRecord(childMeta.aquillaImport)
    // Keep everything the file already carries (coreMediaUrl, timingMode,
    // trackOverrides, languages). The parent's own parser stamp and manifest
    // described a zero-row video link; they must not outlive the rows that
    // replace them, even when the content carries none of its own.
    const projectionMeta: Record<string, unknown> = { ...parentMeta }
    delete projectionMeta.aquillaImport
    delete projectionMeta.parserVersion
    Object.assign(projectionMeta, { orderedBy: 'time', importFormat: kind },
      parserVersion ? { parserVersion } : {}, manifest ? { aquillaImport: manifest } : {})
    let serverTs = Date.now()
    const genesis: PersistedEvent<'file.create'> = {
      id: p.genesisEventId, schemaVersion: 1, projectId: args.projectId,
      fileId: args.fileId, cellId: null, parentId: parent.event_id,
      kind: 'file.create', author: args.author, clientTs: args.clientTs,
      serverTs: serverTs++,
      payload: {
        name: parent.name, fileType: kind, kind,
        ...(parent.role ? { role: parent.role } : {}),
        ...(parent.book_code ? { bookCode: parent.book_code } : {}),
        ...(parent.source_file_id ? { sourceFileId: parent.source_file_id } : {}),
        ...(parent.anchor_file_id ? { anchorFileId: parent.anchor_file_id } : {}),
        importFormat: kind, orderedBy: 'time',
        ...(parserVersion ? { parserVersion } : {}),
        ...(manifest ? { importManifest: manifest } : {}),
        projectionMeta,
      },
    }
    // Fresh row ids: a cue id must never exist in two files at once, and the
    // content file keeps its (now deleted) rows for history.
    let anchorCellId: string | null = null
    const cellEvents: PersistedEvent<'source.cell.create'>[] = cues.results.map(cue => {
      const cellId = crypto.randomUUID()
      const metadata = objectRecord(cue.metadata)
      const startMs = num(cue.start_ms)
      const endMs = num(cue.end_ms)
      const sequenceIndex = num(cue.sequence_index)
      const payload: EventPayloads['source.cell.create'] = {
        cellId, anchorCellId, value: cue.value,
        ...(cue.value_html !== null ? { valueHtml: cue.value_html } : {}),
        ...(cue.type !== null ? { type: cue.type } : {}),
        ...(cue.canonical_ref !== null ? { canonicalRef: cue.canonical_ref } : {}),
        ...(startMs !== undefined ? { startMs } : {}),
        ...(endMs !== undefined ? { endMs } : {}),
        ...(sequenceIndex !== undefined ? { sequenceIndex } : {}),
        ...(cue.medium !== null ? { medium: cue.medium } : {}),
        ...(metadata ? { metadata } : {}),
      }
      anchorCellId = cellId
      return {
        id: crypto.randomUUID(), schemaVersion: 1, projectId: args.projectId,
        fileId: args.fileId, cellId, parentId: null, kind: 'source.cell.create',
        author: args.author, clientTs: args.clientTs, serverTs: serverTs++, payload,
      }
    })
    const lifecycle: PersistedEvent[] = p.trackId ? [{
      id: p.retireEventId!, schemaVersion: 1, projectId: args.projectId,
      fileId: args.fileId, cellId: null, parentId: null, kind: 'file.track.set',
      author: args.author, clientTs: args.clientTs, serverTs: serverTs++,
      payload: { trackId: p.trackId, patch: null },
    } as PersistedEvent<'file.track.set'>, {
      id: p.deleteEventId!, schemaVersion: 1, projectId: args.projectId,
      fileId: p.contentFileId, cellId: null, parentId: null, kind: 'file.delete',
      author: args.author, clientTs: args.clientTs, serverTs: serverTs++, payload: {},
    } as PersistedEvent<'file.delete'>] : []
    const events: PersistedEvent[] = [genesis, ...cellEvents, ...lifecycle]
    let inserted = 0
    for (let i = 0; i < events.length; i += BULK_ROWS) {
      const chunk = events.slice(i, i + BULK_ROWS)
      const write = await buildBulkEventInsertStmt(tx, chunk.map((event, j) => ({
        id: event.id, schemaVersion: 1, projectId: args.projectId,
        fileId: event.fileId ?? null, cellId: event.cellId ?? null,
        parentId: event.parentId ?? null, kind: event.kind, author: args.author,
        payloadJson: JSON.stringify(event.payload), clientTs: args.clientTs,
        serverTs: event.serverTs, serverSeq: seqBase + i + j,
      }))).run()
      inserted += write.meta.changes
    }
    // Another parent transaction may claim one of the client-minted ids after
    // the receipt read. Roll everything back before any projection lands.
    if (inserted !== events.length) throw new PromotionConflict('promotion event is already used')

    const statements: AquillaStatement[] = []
    buildEventProjectionStmts(tx, genesis, statements)
    for (let i = 0; i < cellEvents.length; i += BULK_ROWS) {
      statements.push(buildBulkSourceCellCreateStmt(tx, cellEvents.slice(i, i + BULK_ROWS)))
    }
    for (const event of lifecycle) buildEventProjectionStmts(tx, event, statements)
    // "Download original" returns the caption file the rows came from. Only a
    // caption original is copied: an aligned script's .txt would make the
    // export route treat this subtitle file as plain text.
    statements.push(tx.prepare(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       SELECT ?, project_id, format, raw_source, r2_key, size_bytes, ?
         FROM file_source_blobs
        WHERE file_id = ? AND project_id = ? AND format IN ('vtt', 'srt', 'sbv')
       ON CONFLICT (file_id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         format     = EXCLUDED.format,
         raw_source = EXCLUDED.raw_source,
         r2_key     = EXCLUDED.r2_key,
         size_bytes = EXCLUDED.size_bytes,
         created_at = EXCLUDED.created_at`,
    ).bind(args.fileId, serverTs, p.contentFileId, args.projectId))
    statements.push(
      fileCountersRecomputeStmt(tx, args.projectId, args.fileId, serverTs),
      ...fullProgressRecomputeStmts(tx, args.projectId, args.fileId, serverTs),
      buildSettleSeqRangeStmt(tx, args.projectId, seqBase),
    )
    // Execute on the existing transaction, never a nested batch transaction.
    for (const statement of statements) await statement.run()
    return { ok: true, cellCount: cellEvents.length }
  }).catch((err: unknown) => {
    if (err instanceof PromotionConflict) return refuse(409, err.message)
    throw err
  })
  if (!result.ok) await buildSettleSeqRangeStmt(db, args.projectId, seqBase).run()
  return result
}
