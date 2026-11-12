import type { AquillaDb } from '../../../db/shim/postgres'
import type { ImportedTrackPublication } from '../../../shared/timeline-import'
export type { ImportedTrackPublication } from '../../../shared/timeline-import'
import { ROLE } from './role-policy'
import { DEFAULT_TRACK_IDS, resolveAllowTrackEditing } from './track-editing-authority'
import { allocateSeqRange, buildBulkEventInsertStmt, buildSettleSeqRangeStmt } from './event-insert'
import { buildEventProjectionStmts, type PersistedEvent } from './event-projection'

interface PublicationArgs {
  projectId: string
  fileId: string
  author: string
  role: number
  clientTs: number
  publishEventId: string
  publication: ImportedTrackPublication
}

type Result = { ok: true } | { ok: false; status: number; reason: string }
const refuse = (status: number, reason: string): Result => ({ ok: false, status, reason })
const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/
const TRACK_ID = /^[A-Za-z0-9_-]{1,64}$/
class PublicationConflict extends Error {}

function validPublication(value: unknown): value is ImportedTrackPublication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => ![
    'contentFileId', 'trackId', 'eventId', 'name', 'overwrite',
  ].includes(key))) return false
  if (typeof p.contentFileId !== 'string' || !FILE_ID.test(p.contentFileId)
    || typeof p.trackId !== 'string' || !TRACK_ID.test(p.trackId)
    || ['recording', 'generatedVoice'].includes(p.trackId)
    || typeof p.eventId !== 'string' || !FILE_ID.test(p.eventId)
    || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120) return false
  if (p.overwrite === undefined) return true
  if (!p.overwrite || typeof p.overwrite !== 'object' || Array.isArray(p.overwrite)) return false
  const overwrite = p.overwrite as Record<string, unknown>
  return Object.keys(overwrite).every(key => ['contentFileId', 'segmentCount'].includes(key))
    && (overwrite.contentFileId === null || (
      typeof overwrite.contentFileId === 'string' && FILE_ID.test(overwrite.contentFileId)))
    && Number.isSafeInteger(overwrite.segmentCount)
    && (overwrite.segmentCount as number) >= 0
}

interface FileRow {
  id: string
  role: string
  anchor_file_id: string | null
  deleted_at: number | null
  meta: { trackOverrides?: Record<string, {
    kind?: string; contentFileId?: string; name?: string
  }> } | null
}

/** Caller authenticates the parent-file JWT. Lock the parent before checking
 * the preview or revealing a child, so two publications cannot overwrite each
 * other's track without explicit consent. Never replay a projection after a
 * receipt exists: a later rename or replacement must survive a lost response.
 */
export async function publishImportedTrack(
  db: AquillaDb,
  args: PublicationArgs,
): Promise<Result> {
  const p = args.publication
  if (!validPublication(p) || typeof args.publishEventId !== 'string'
    || !FILE_ID.test(args.publishEventId)
    || p.eventId === args.publishEventId || p.contentFileId === args.fileId) {
    return refuse(400, 'invalid text track publication')
  }
  if (args.role < ROLE.MAINTAINER) return refuse(403, 'text track import requires maintainer')
  if (!(await resolveAllowTrackEditing(db, args.projectId))) {
    return refuse(403, 'timeline track editing is not enabled for this project')
  }
  if (!db.transaction) return refuse(503, 'atomic text track publication is unavailable')
  const seqBase = await allocateSeqRange(db, args.projectId, 2)
  const result = await db.transaction<Result>(async tx => {
    const parent = await tx.prepare(
      `SELECT id, role, anchor_file_id, deleted_at, meta::jsonb AS meta FROM files
        WHERE id = ? AND project_id = ? FOR UPDATE`,
    ).bind(args.fileId, args.projectId).first<FileRow>()
    if (!parent || parent.deleted_at !== null
      || ['audio-cues', 'timeline-content'].includes(parent.role)) {
      return refuse(409, 'media timeline is unavailable')
    }
    const receipts = await tx.prepare(
      `SELECT id, project_id, file_id, kind, payload::jsonb AS payload FROM events
        WHERE id IN (?, ?)`,
    ).bind(p.eventId, args.publishEventId).all<{
      id: string; project_id: string; file_id: string; kind: string
      payload: { trackId?: string; patch?: { contentFileId?: string; name?: string } }
    }>()
    if (receipts.results.length) {
      const binding = receipts.results.find(row => row.id === p.eventId)
      const reveal = receipts.results.find(row => row.id === args.publishEventId)
      const same = binding?.project_id === args.projectId
        && binding.file_id === args.fileId && binding.kind === 'file.track.set'
        && binding.payload.trackId === p.trackId
        && binding.payload.patch?.contentFileId === p.contentFileId
        && binding.payload.patch.name === p.name
        && reveal?.project_id === args.projectId
        && reveal.file_id === p.contentFileId && reveal.kind === 'file.restore'
      await buildSettleSeqRangeStmt(tx, args.projectId, seqBase).run()
      return same ? { ok: true } : refuse(409, 'publication event is already used')
    }
    const existing = parent.meta?.trackOverrides?.[p.trackId]
    const derived = DEFAULT_TRACK_IDS.has(p.trackId)
    const kind = derived ? p.trackId : existing?.kind ?? 'source-subtitles'
    if (!['source-subtitles', 'target-subtitles'].includes(kind)) {
      return refuse(400, 'only text tracks can receive captions')
    }
    if (!p.overwrite && (existing || derived)) {
      return refuse(409, 'existing track requires explicit overwrite')
    }
    if (p.overwrite) {
      if (!derived && !existing) return refuse(409, 'selected track no longer exists')
      const currentId = existing?.contentFileId ?? null
      if (currentId !== p.overwrite.contentFileId) {
        return refuse(409, 'track content changed after preview')
      }
      const count = await tx.prepare(
        `SELECT COUNT(*) AS count FROM cells
          WHERE project_id = ? AND file_id = ? AND side = ?`,
      ).bind(args.projectId, currentId ?? args.fileId, 'source')
        .first<{ count: number | string }>()
      if (Number(count?.count) !== p.overwrite.segmentCount) {
        return refuse(409, 'segment count changed after preview')
      }
    }
    const child = await tx.prepare(
      `SELECT id, role, anchor_file_id, deleted_at, meta::jsonb AS meta FROM files
        WHERE id = ? AND project_id = ? FOR UPDATE`,
    ).bind(p.contentFileId, args.projectId).first<FileRow>()
    if (!child || child.role !== 'timeline-content'
      || child.anchor_file_id !== args.fileId || child.deleted_at === null) {
      return refuse(409, 'caption content is not a staged file for this timeline')
    }
    const cue = await tx.prepare(
      `SELECT cell_id FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'source' LIMIT 1`,
    ).bind(args.projectId, p.contentFileId).first<{ cell_id: string }>()
    if (!cue) return refuse(409, 'caption content is empty')
    const now = Date.now()
    const events: PersistedEvent[] = [{
      id: p.eventId, schemaVersion: 1, projectId: args.projectId,
      fileId: args.fileId, cellId: null, parentId: null,
      kind: 'file.track.set', author: args.author, clientTs: args.clientTs,
      serverTs: now,
      payload: { trackId: p.trackId, patch: {
        ...(derived ? {} : { kind }), name: p.name, contentFileId: p.contentFileId,
      } },
    } as PersistedEvent<'file.track.set'>, {
      id: args.publishEventId, schemaVersion: 1, projectId: args.projectId,
      fileId: p.contentFileId, cellId: null, parentId: null,
      kind: 'file.restore', author: args.author, clientTs: args.clientTs,
      serverTs: now + 1, payload: {},
    }]
    const inserted = await buildBulkEventInsertStmt(tx, events.map((event, index) => ({
      id: event.id, schemaVersion: 1, projectId: args.projectId,
      fileId: event.fileId ?? null, cellId: null, parentId: null,
      kind: event.kind, author: args.author, payloadJson: JSON.stringify(event.payload),
      clientTs: args.clientTs, serverTs: event.serverTs, serverSeq: seqBase + index,
    }))).run()
    // A different parent transaction may claim either globally unique event
    // id after our receipt read. Roll back both inserts before any projection.
    if (inserted.meta.changes !== events.length) {
      throw new PublicationConflict('publication event is already used')
    }
    const statements: AquillaStatement[] = []
    for (const event of events) buildEventProjectionStmts(tx, event, statements)
    // Execute on the existing transaction, never a nested batch transaction.
    for (const statement of statements) await statement.run()
    await buildSettleSeqRangeStmt(tx, args.projectId, seqBase).run()
    return { ok: true }
  }).catch((err: unknown) => {
    if (err instanceof PublicationConflict) return refuse(409, err.message)
    throw err
  })
  if (!result.ok) await buildSettleSeqRangeStmt(db, args.projectId, seqBase).run()
  return result
}
