// POST /import/reconcile — safe source re-import for an existing file.
//
// Re-import is intentionally a different operation from genesis /import:
// incoming units are matched to the existing source projection, matched units
// retain their cell_id, absent incoming units are retained, and target rows are
// never overwritten. This preserves lane translations, comments, assignments,
// audio, and every other table keyed by the logical cell id.
//
// The route writes one atomic transaction. A synthetic file-level chain claim
// makes concurrent re-imports all-or-nothing; ordinary per-cell claims prevent
// a re-import from overwriting a concurrent source edit. Losing source events
// remain as stale siblings in history, matching the normal AD-2 contract.

import { verifyTokenForDoc } from '../auth'
import { withCors } from '../cors'
import { notifyProjectDoFileProgressChanged } from '../project-progress-broadcast'
import {
  buildChainClaimStmt,
  eventQualifiedParentKey,
  parentKeyOf,
  readClaimWinners,
  slotKey,
  type ChainSlot,
} from './chain-claims'
import { allocateSeqRange, type SeqEventInsertRow } from './event-insert'
import { contentHash, fileCountersRecomputeStmt, type PersistedEvent } from './event-projection'
import { fullProgressRecomputeStmts } from './progress-projection'
import { ROLE } from './role-policy'
import type { EventPayloads } from './types'

const PATH = '/import/reconcile'
const BULK_ROWS = 750
export const MAX_RECONCILE_CELLS = 50_000
const FILE_CLAIM_CELL_ID = '__aquilla_file_reimport__'

export interface ReconcileRouteEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  ProjectSync?: DurableObjectNamespace
}

interface ReconcileFileMeta {
  id: string
  name: string
  fileType?: string
  role?: string
  kind?: string
  bookCode?: string
  importFormat?: string
  parserVersion?: string
  sourceLanguage?: string
  targetLanguage?: string
  sourceTextDirection?: 'ltr' | 'rtl'
  targetTextDirection?: 'ltr' | 'rtl'
  orderedBy?: string
  importManifest?: Record<string, unknown>
}

export interface ReconcileImportCell {
  id: string
  cellId: string
  anchorCellId?: string | null
  value: string
  valueHtml?: string
  type?: string
  canonicalRef?: string
  startMs?: number
  endMs?: number
  sequenceIndex?: number
  medium?: string
  metadata?: Record<string, unknown>
}

interface ReconcileTarget {
  id: string
  cellId: string
  parentId: string
  value: string
  targetLang?: string
}

interface ReconcileBody {
  projectId: string
  fileId: string
  file: ReconcileFileMeta
  cells: ReconcileImportCell[]
  targets?: ReconcileTarget[]
  artifactId?: string
  rawSourceFormat?: string
  clientTs?: number
}

export interface ExistingImportCell {
  cellId: string
  eventId: string
  value: string
  valueHtml: string | null
  type: string | null
  canonicalRef: string | null
  anchorCellId: string | null
  startMs: number | null
  endMs: number | null
  sequenceIndex: number | null
  medium: string | null
  metadata: Record<string, unknown>
}

export interface ReconcilePlannedCell {
  incoming: ReconcileImportCell
  originalCellId: string
  finalCellId: string
  parentId: string | null
  changed: boolean
  matchKind: 'unit-key' | 'cell-id' | 'canonical-ref' | 'new'
}

export interface ReconciliationPlan {
  cells: ReconcilePlannedCell[]
  retainedMissing: string[]
}

interface ExistingFileRow {
  id: string
  name: string
  role: string | null
  kind: string | null
  book_code: string | null
  source_file_id: string | null
  anchor_file_id: string | null
  event_id: string
  meta: unknown
  deleted_at: number | null
}

function objectRecord(value: unknown): Record<string, unknown> {
  let current = value
  // A bounded loop accepts metadata double-encoded by older postgres.js
  // projections without allowing adversarial nested JSON strings to recurse.
  for (let depth = 0; depth < 3 && typeof current === 'string'; depth += 1) {
    try {
      current = JSON.parse(current) as unknown
    } catch {
      return {}
    }
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {}
}

function unitKey(metadata: unknown): string | null {
  const value = objectRecord(metadata).aquillaImport
  const key = objectRecord(value).unitKey
  return typeof key === 'string' && key.trim() ? key.trim() : null
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function nullableString(value: string | undefined): string | null {
  return value === undefined ? null : value
}

function nullableNumber(value: number | undefined): number | null {
  return value === undefined ? null : value
}

function sameProjectedSource(
  incoming: ReconcileImportCell,
  existing: ExistingImportCell,
  mappedAnchor: string | null,
): boolean {
  return existing.value === (incoming.value ?? '')
    && existing.valueHtml === nullableString(incoming.valueHtml)
    && existing.type === nullableString(incoming.type)
    && existing.canonicalRef === nullableString(incoming.canonicalRef)
    && existing.anchorCellId === mappedAnchor
    && existing.startMs === nullableNumber(incoming.startMs)
    && existing.endMs === nullableNumber(incoming.endMs)
    && existing.sequenceIndex === nullableNumber(incoming.sequenceIndex)
    && existing.medium === nullableString(incoming.medium)
    && stableJson(existing.metadata) === stableJson(incoming.metadata ?? {})
}

function uniqueIndex<T>(items: T[], keyOf: (item: T) => string | null): Map<string, T> {
  const result = new Map<string, T>()
  const duplicates = new Set<string>()
  for (const item of items) {
    const key = keyOf(item)
    if (!key) continue
    if (result.has(key)) duplicates.add(key)
    else result.set(key, item)
  }
  for (const duplicate of duplicates) result.delete(duplicate)
  return result
}

/** Pure, deterministic identity reconciliation used by the route and tests. */
export function planImportReconciliation(
  incoming: ReconcileImportCell[],
  existing: ExistingImportCell[],
): ReconciliationPlan {
  const incomingUnitKeys = new Set<string>()
  const incomingCellIds = new Set<string>()
  for (const cell of incoming) {
    const key = unitKey(cell.metadata)
    if (!key) throw new Error('every re-imported cell needs metadata.aquillaImport.unitKey')
    if (key.length > 1024) throw new Error(`unit key is too long: ${key.slice(0, 80)}`)
    if (incomingUnitKeys.has(key)) throw new Error(`duplicate incoming unit key: ${key}`)
    if (!cell.cellId) throw new Error('every re-imported cell needs a cellId')
    if (incomingCellIds.has(cell.cellId)) throw new Error(`duplicate incoming cell id: ${cell.cellId}`)
    incomingUnitKeys.add(key)
    incomingCellIds.add(cell.cellId)
  }

  const existingByUnitKey = uniqueIndex(existing, (cell) => unitKey(cell.metadata))
  const duplicateExistingKeys = new Set<string>()
  for (const cell of existing) {
    const key = unitKey(cell.metadata)
    if (key && !existingByUnitKey.has(key)) duplicateExistingKeys.add(key)
  }
  for (const key of incomingUnitKeys) {
    if (duplicateExistingKeys.has(key)) {
      throw new Error(`existing file has ambiguous duplicate unit key: ${key}`)
    }
  }

  const existingByCellId = new Map(existing.map((cell) => [cell.cellId, cell]))
  const existingByCanonicalRef = uniqueIndex(existing, (cell) => cell.canonicalRef?.trim() || null)
  const usedExisting = new Set<string>()
  const preliminary = incoming.map((cell) => {
    const key = unitKey(cell.metadata)!
    let matched = existingByUnitKey.get(key)
    let matchKind: ReconcilePlannedCell['matchKind'] = 'unit-key'
    if (!matched) {
      matched = existingByCellId.get(cell.cellId)
      matchKind = 'cell-id'
    }
    if (!matched && cell.canonicalRef?.trim()) {
      matched = existingByCanonicalRef.get(cell.canonicalRef.trim())
      matchKind = 'canonical-ref'
    }
    if (matched && usedExisting.has(matched.cellId)) {
      throw new Error(`multiple incoming units resolve to existing cell ${matched.cellId}`)
    }
    if (matched) usedExisting.add(matched.cellId)
    return {
      incoming: cell,
      existing: matched,
      finalCellId: matched?.cellId ?? (
        existingByCellId.has(cell.cellId) ? crypto.randomUUID() : cell.cellId
      ),
      parentId: matched?.eventId ?? null,
      matchKind: matched ? matchKind : 'new' as const,
    }
  })

  const finalIdByIncomingId = new Map(preliminary.map((cell) => [cell.incoming.cellId, cell.finalCellId]))
  const cells: ReconcilePlannedCell[] = preliminary.map((cell) => {
    const mappedAnchor = cell.incoming.anchorCellId
      ? finalIdByIncomingId.get(cell.incoming.anchorCellId)
        ?? (existingByCellId.has(cell.incoming.anchorCellId) ? cell.incoming.anchorCellId : null)
      : null
    const normalizedIncoming: ReconcileImportCell = {
      ...cell.incoming,
      cellId: cell.finalCellId,
      anchorCellId: mappedAnchor,
      // Parser-owned keys replace their prior values, while user/workflow
      // metadata (for example cast_name) survives a source re-import.
      metadata: cell.existing
        ? { ...cell.existing.metadata, ...(cell.incoming.metadata ?? {}) }
        : cell.incoming.metadata,
    }
    return {
      incoming: normalizedIncoming,
      originalCellId: cell.incoming.cellId,
      finalCellId: cell.finalCellId,
      parentId: cell.parentId,
      changed: cell.existing
        ? !sameProjectedSource(normalizedIncoming, cell.existing, mappedAnchor)
        : true,
      matchKind: cell.matchKind,
    }
  })

  return {
    cells,
    retainedMissing: existing.filter((cell) => !usedExisting.has(cell.cellId)).map((cell) => cell.cellId),
  }
}

function isBody(value: unknown): value is ReconcileBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  if (typeof body.projectId !== 'string' || !body.projectId.trim()) return false
  if (typeof body.fileId !== 'string' || !body.fileId.trim()) return false
  if (!body.file || typeof body.file !== 'object' || Array.isArray(body.file)) return false
  const file = body.file as Record<string, unknown>
  if (typeof file.id !== 'string' || !file.id.trim()) return false
  if (typeof file.name !== 'string' || !file.name.trim()) return false
  if (!Array.isArray(body.cells)) return false
  if (body.targets !== undefined && !Array.isArray(body.targets)) return false
  if (body.artifactId !== undefined && typeof body.artifactId !== 'string') return false
  if (body.rawSourceFormat !== undefined && typeof body.rawSourceFormat !== 'string') return false
  if (body.clientTs !== undefined && (typeof body.clientTs !== 'number' || !Number.isFinite(body.clientTs))) return false

  const optionalNumber = (entry: unknown): boolean =>
    entry === undefined || (typeof entry === 'number' && Number.isFinite(entry))
  const optionalString = (entry: unknown): boolean => entry === undefined || typeof entry === 'string'
  const cellsValid = body.cells.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const cell = entry as Record<string, unknown>
    return typeof cell.id === 'string' && Boolean(cell.id)
      && typeof cell.cellId === 'string' && Boolean(cell.cellId)
      && typeof cell.value === 'string'
      && (cell.anchorCellId === undefined || cell.anchorCellId === null || typeof cell.anchorCellId === 'string')
      && optionalString(cell.valueHtml)
      && optionalString(cell.type)
      && optionalString(cell.canonicalRef)
      && optionalString(cell.medium)
      && optionalNumber(cell.startMs)
      && optionalNumber(cell.endMs)
      && optionalNumber(cell.sequenceIndex)
      && Boolean(cell.metadata && typeof cell.metadata === 'object' && !Array.isArray(cell.metadata))
  })
  if (!cellsValid) return false

  return (body.targets as unknown[] | undefined)?.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const target = entry as Record<string, unknown>
    return typeof target.id === 'string' && Boolean(target.id)
      && typeof target.cellId === 'string' && Boolean(target.cellId)
      && typeof target.value === 'string'
      && optionalString(target.parentId)
      && optionalString(target.targetLang)
  }) ?? true
}

async function firstExistingEventId(db: AquillaDb, ids: string[]): Promise<string | null> {
  const unique = [...new Set(ids)]
  for (let offset = 0; offset < unique.length; offset += 5_000) {
    const chunk = unique.slice(offset, offset + 5_000)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const row = await db.prepare(`SELECT id FROM events WHERE id IN (${placeholders}) LIMIT 1`)
      .bind(...chunk).first<{ id: string }>()
    if (row) return row.id
  }
  return null
}

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

function sourcePayload(cell: ReconcileImportCell): EventPayloads['source.cell.create'] {
  return {
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
  }
}

function fileClaimGate(): string {
  return `EXISTS (
    SELECT 1 FROM chain_claims fc
     WHERE fc.project_id = ? AND fc.file_id = ? AND fc.cell_id = ?
       AND fc.parent_key = ? AND fc.event_id = ?
  )`
}

function buildBulkCellClaims(
  db: AquillaDb,
  events: PersistedEvent<'source.cell.create'>[],
  fileClaim: ChainSlot,
  fileEventId: string,
): AquillaStatement {
  const values = events.map(() => '(?, ?, ?, ?, ?)').join(', ')
  const binds: unknown[] = []
  for (const event of events) {
    binds.push(
      event.projectId,
      event.fileId,
      event.cellId,
      eventQualifiedParentKey(event.parentId, event.kind, event.payload),
      event.id,
    )
  }
  binds.push(fileClaim.projectId, fileClaim.fileId, fileClaim.cellId, fileClaim.parentKey, fileEventId)
  return db.prepare(
    `INSERT INTO chain_claims (project_id, file_id, cell_id, parent_key, event_id)
     SELECT v.project_id, v.file_id, v.cell_id, v.parent_key, v.event_id
     FROM (VALUES ${values}) AS v(project_id, file_id, cell_id, parent_key, event_id)
     WHERE ${fileClaimGate()}
     ON CONFLICT (project_id, file_id, cell_id, parent_key) DO NOTHING`,
  ).bind(...binds)
}

function buildCellClaimAssertion(
  db: AquillaDb,
  events: PersistedEvent<'source.cell.create'>[],
): AquillaStatement {
  const values = events.map(() => '(?, ?, ?, ?, ?)').join(', ')
  const binds: unknown[] = []
  for (const event of events) {
    binds.push(
      event.projectId,
      event.fileId,
      event.cellId,
      eventQualifiedParentKey(event.parentId, event.kind, event.payload),
      event.id,
    )
  }
  return db.prepare(
     `SELECT CASE
       WHEN COUNT(*) = ${events.length} THEN 1
       ELSE CAST(COUNT(*)::text || '-re-import-cell-claim-conflict' AS INTEGER)
     END AS all_claims_won
     FROM (VALUES ${values}) AS v(project_id, file_id, cell_id, parent_key, event_id)
     JOIN chain_claims cc
       ON cc.project_id = v.project_id AND cc.file_id = v.file_id
      AND cc.cell_id = v.cell_id AND cc.parent_key = v.parent_key
      AND cc.event_id = v.event_id`,
  ).bind(...binds)
}

function buildGatedEventInsert(
  db: AquillaDb,
  rows: SeqEventInsertRow[],
  fileClaim: ChainSlot,
  fileEventId: string,
): AquillaStatement {
  const cols = 12
  const values = rows.map(() => `(${Array(cols).fill('?').join(', ')})`).join(', ')
  const binds: unknown[] = []
  for (const row of rows) {
    binds.push(
      row.id, row.schemaVersion, row.projectId, row.fileId, row.cellId, row.parentId,
      row.kind, row.author, row.payloadJson, row.clientTs, row.serverTs, row.serverSeq,
    )
  }
  binds.push(fileClaim.projectId, fileClaim.fileId, fileClaim.cellId, fileClaim.parentKey, fileEventId)
  return db.prepare(
    `INSERT INTO events (
       id, schema_version, project_id, file_id, cell_id, parent_id, kind,
       author, payload, client_ts, server_ts, server_seq
     )
     SELECT v.id, v.schema_version::integer, v.project_id, v.file_id, v.cell_id,
       v.parent_id, v.kind, v.author, v.payload::jsonb, v.client_ts::bigint,
       v.server_ts::bigint, v.server_seq::bigint
     FROM (VALUES ${values}) AS v(
       id, schema_version, project_id, file_id, cell_id, parent_id, kind,
       author, payload, client_ts, server_ts, server_seq
     ) WHERE ${fileClaimGate()}
     ON CONFLICT (id) DO NOTHING`,
  ).bind(...binds)
}

function buildGatedSourceUpsert(
  db: AquillaDb,
  events: PersistedEvent<'source.cell.create'>[],
  fileClaim: ChainSlot,
  fileEventId: string,
): AquillaStatement {
  const values = events.map(() => `(${Array(24).fill('?').join(', ')})`).join(', ')
  const binds: unknown[] = []
  for (const event of events) {
    const payload = event.payload as EventPayloads['source.cell.create']
    const value = payload.value ?? ''
    binds.push(
      event.projectId, event.fileId, event.cellId, value, payload.valueHtml ?? null,
      payload.type ?? null, payload.canonicalRef ?? null, payload.anchorCellId ?? null,
      event.id, event.author, event.serverTs, countWords(value), contentHash(value),
      payload.startMs ?? null, payload.endMs ?? null, payload.medium ?? null,
      payload.sequenceIndex ?? null, payload.transcription ?? null, payload.cameraState ?? null,
      payload.metadata == null ? null : JSON.stringify(payload.metadata),
      event.projectId, event.fileId, event.cellId,
      eventQualifiedParentKey(event.parentId, event.kind, event.payload),
    )
  }
  binds.push(fileClaim.projectId, fileClaim.fileId, fileClaim.cellId, fileClaim.parentKey, fileEventId)
  return db.prepare(
    `INSERT INTO cells (
       project_id, file_id, cell_id, side, target_lang, value, value_html, type,
       canonical_ref, anchor_cell_id, event_id, source_event_id,
       last_editor, last_edit_at, validated, word_count, content_hash,
       start_ms, end_ms, medium, sequence_index, transcription, camera_state, metadata
     )
     SELECT v.project_id, v.file_id, v.cell_id, 'source', '', v.value, v.value_html, v.type,
       v.canonical_ref, v.anchor_cell_id, v.event_id, NULL,
       v.author, v.server_ts::bigint, 0, v.word_count::integer, v.content_hash,
       v.start_ms::bigint, v.end_ms::bigint, v.medium, v.sequence_index::double precision,
       v.transcription, v.camera_state, v.metadata::jsonb
     FROM (VALUES ${values}) AS v(
       project_id, file_id, cell_id, value, value_html, type, canonical_ref, anchor_cell_id,
       event_id, author, server_ts, word_count, content_hash, start_ms, end_ms, medium,
       sequence_index, transcription, camera_state, metadata,
       claim_project_id, claim_file_id, claim_cell_id, claim_parent_key
     )
     WHERE ${fileClaimGate()}
       AND EXISTS (
         SELECT 1 FROM chain_claims cc
          WHERE cc.project_id = v.claim_project_id AND cc.file_id = v.claim_file_id
            AND cc.cell_id = v.claim_cell_id AND cc.parent_key = v.claim_parent_key
            AND cc.event_id = v.event_id
       )
     ON CONFLICT(project_id, file_id, cell_id, side, target_lang) DO UPDATE SET
       value = excluded.value, value_html = excluded.value_html, type = excluded.type,
       canonical_ref = excluded.canonical_ref, anchor_cell_id = excluded.anchor_cell_id,
       event_id = excluded.event_id, source_event_id = NULL,
       last_editor = excluded.last_editor, last_edit_at = excluded.last_edit_at,
       word_count = excluded.word_count, content_hash = excluded.content_hash,
       start_ms = excluded.start_ms, end_ms = excluded.end_ms, medium = excluded.medium,
       sequence_index = excluded.sequence_index, transcription = excluded.transcription,
       camera_state = excluded.camera_state, metadata = excluded.metadata`,
  ).bind(...binds)
}

function buildTargetEventInsert(
  db: AquillaDb,
  rows: SeqEventInsertRow[],
  laneByEventId: Map<string, string>,
  fileClaim: ChainSlot,
  fileEventId: string,
): AquillaStatement {
  const values = rows.map(() => `(${Array(13).fill('?').join(', ')})`).join(', ')
  const binds: unknown[] = []
  for (const row of rows) {
    binds.push(
      row.id, row.schemaVersion, row.projectId, row.fileId, row.cellId, row.parentId,
      row.kind, row.author, row.payloadJson, row.clientTs, row.serverTs, row.serverSeq,
      laneByEventId.get(row.id) ?? '',
    )
  }
  binds.push(fileClaim.projectId, fileClaim.fileId, fileClaim.cellId, fileClaim.parentKey, fileEventId)
  return db.prepare(
    `INSERT INTO events (
       id, schema_version, project_id, file_id, cell_id, parent_id, kind,
       author, payload, client_ts, server_ts, server_seq
     )
     SELECT v.id, v.schema_version::integer, v.project_id, v.file_id, v.cell_id, v.parent_id, v.kind,
       v.author, v.payload::jsonb, v.client_ts::bigint, v.server_ts::bigint, v.server_seq::bigint
     FROM (VALUES ${values}) AS v(
       id, schema_version, project_id, file_id, cell_id, parent_id, kind,
       author, payload, client_ts, server_ts, server_seq, target_lang
     )
     WHERE ${fileClaimGate()}
       AND EXISTS (
         SELECT 1 FROM cells source
          WHERE source.project_id = v.project_id AND source.file_id = v.file_id
            AND source.cell_id = v.cell_id AND source.side = 'source'
            AND source.target_lang = '' AND source.event_id = v.parent_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM cells target
          WHERE target.project_id = v.project_id AND target.file_id = v.file_id
            AND target.cell_id = v.cell_id AND target.side = 'target'
            AND target.target_lang = v.target_lang
       )
     ON CONFLICT (id) DO NOTHING`,
  ).bind(...binds)
}

function buildGatedTargetInsert(
  db: AquillaDb,
  events: PersistedEvent<'target.cell.commit'>[],
  fileClaim: ChainSlot,
  fileEventId: string,
): AquillaStatement {
  const values = events.map(() => `(${Array(12).fill('?').join(', ')})`).join(', ')
  const binds: unknown[] = []
  for (const event of events) {
    const payload = event.payload as EventPayloads['target.cell.commit']
    const value = payload.value ?? ''
    binds.push(
      event.projectId, event.fileId, event.cellId, payload.targetLang ?? '', value,
      payload.valueHtml ?? null, event.id, payload.sourceEventId ?? null,
      event.author, event.serverTs, countWords(value), contentHash(value),
    )
  }
  binds.push(fileClaim.projectId, fileClaim.fileId, fileClaim.cellId, fileClaim.parentKey, fileEventId)
  return db.prepare(
    `INSERT INTO cells (
       project_id, file_id, cell_id, side, target_lang, value, value_html, type,
       canonical_ref, anchor_cell_id, event_id, source_event_id,
       last_editor, last_edit_at, validated, word_count, content_hash, ai_drafted
     )
     SELECT v.project_id, v.file_id, v.cell_id, 'target', v.target_lang, v.value,
       v.value_html, NULL, NULL, NULL, v.event_id, v.source_event_id,
       v.author, v.server_ts::bigint, 0, v.word_count::integer, v.content_hash, 0
     FROM (VALUES ${values}) AS v(
       project_id, file_id, cell_id, target_lang, value, value_html, event_id,
       source_event_id, author, server_ts, word_count, content_hash
     )
     WHERE ${fileClaimGate()}
       AND EXISTS (
         SELECT 1 FROM cells source
          WHERE source.project_id = v.project_id AND source.file_id = v.file_id
            AND source.cell_id = v.cell_id AND source.side = 'source'
            AND source.target_lang = '' AND source.event_id = v.source_event_id
       )
     ON CONFLICT(project_id, file_id, cell_id, side, target_lang) DO NOTHING`,
  ).bind(...binds)
}

function mergeFileMeta(existing: unknown, incoming: ReconcileFileMeta): Record<string, unknown> {
  const meta = { ...objectRecord(existing) }
  if (incoming.sourceLanguage) meta.sourceLanguage = incoming.sourceLanguage
  if (incoming.targetLanguage) meta.targetLanguage = incoming.targetLanguage
  if (incoming.sourceTextDirection) meta.sourceTextDirection = incoming.sourceTextDirection
  if (incoming.targetTextDirection) meta.targetTextDirection = incoming.targetTextDirection
  if (incoming.orderedBy) meta.orderedBy = incoming.orderedBy
  if (incoming.importManifest) meta.aquillaImport = incoming.importManifest
  if (incoming.importFormat) meta.importFormat = incoming.importFormat
  if (incoming.parserVersion) meta.parserVersion = incoming.parserVersion
  return meta
}

async function runBatch(db: AquillaDb, statements: AquillaStatement[]): Promise<void> {
  if (statements.length === 0) return
  if (db.batchPipelined) await db.batchPipelined(statements)
  else await db.batch(statements)
}

export async function handleImportReconcileRequest(
  request: Request,
  env: ReconcileRouteEnv,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== PATH) return null
  if (request.method !== 'POST') return withCors(new Response('method not allowed', { status: 405 }), request)
  if (!env.SYNC_SECRET_KEY) return withCors(new Response('SYNC_SECRET_KEY not configured', { status: 500 }), request)
  if (!env.AQUILLA_PG) return withCors(new Response('AQUILLA_PG binding not configured', { status: 500 }), request)

  let unknownBody: unknown
  try {
    unknownBody = await request.json()
  } catch {
    return withCors(new Response('invalid JSON body', { status: 400 }), request)
  }
  if (!isBody(unknownBody)) {
    return withCors(new Response('invalid re-import body', { status: 400 }), request)
  }
  const body = unknownBody
  if (body.cells.length > MAX_RECONCILE_CELLS) {
    return withCors(new Response(`re-import exceeds ${MAX_RECONCILE_CELLS} cells`, { status: 413 }), request)
  }
  const requestEventIds = [body.file.id, ...body.cells.map((cell) => cell.id), ...(body.targets ?? []).map((target) => target.id)]
  if (new Set(requestEventIds).size !== requestEventIds.length) {
    return withCors(new Response('re-import event ids must be unique', { status: 400 }), request)
  }

  const authHeader = request.headers.get('Authorization') ?? ''
  const auth = await verifyTokenForDoc(
    authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null,
    { projectId: body.projectId, fileId: body.fileId },
    env.SYNC_SECRET_KEY,
  )
  if (!auth.ok) return withCors(new Response(auth.reason, { status: auth.status }), request)
  if (auth.claims.role < ROLE.PROJECT_LEAD) {
    return withCors(new Response('role too low for source re-import', { status: 403 }), request)
  }

  const db = env.AQUILLA_PG
  const replay = await db.prepare(
    `SELECT id FROM events WHERE id = ? AND project_id = ? AND file_id = ? AND kind = 'file.create'`,
  ).bind(body.file.id, body.projectId, body.fileId).first<{ id: string }>()
  if (replay) {
    return withCors(Response.json({
      fileId: body.fileId,
      replayed: true,
      matched: 0,
      added: 0,
      changed: 0,
      unchanged: 0,
      retainedMissing: 0,
      importedTargets: 0,
    }), request)
  }
  const eventCollision = await db.prepare(`SELECT project_id, file_id FROM events WHERE id = ?`)
    .bind(body.file.id).first<{ project_id: string; file_id: string | null }>()
  if (eventCollision) return withCors(new Response('re-import event id already exists', { status: 409 }), request)
  const childEventCollision = await firstExistingEventId(db, requestEventIds.slice(1))
  if (childEventCollision) {
    return withCors(new Response(`re-import child event id already exists: ${childEventCollision}`, { status: 409 }), request)
  }

  const file = await db.prepare(
    `SELECT id, name, role, kind, book_code, source_file_id, anchor_file_id,
            event_id, meta, deleted_at
       FROM files WHERE id = ? AND project_id = ?`,
  ).bind(body.fileId, body.projectId).first<ExistingFileRow>()
  if (!file) return withCors(new Response('file not found', { status: 404 }), request)
  if (file.deleted_at != null) return withCors(new Response('cannot re-import a deleted file', { status: 409 }), request)

  const existingRows = await db.prepare(
    `SELECT cell_id, event_id, value, value_html, type, canonical_ref, anchor_cell_id,
            start_ms, end_ms, sequence_index, medium, metadata
       FROM cells
      WHERE project_id = ? AND file_id = ? AND side = 'source' AND target_lang = ''`,
  ).bind(body.projectId, body.fileId).all<{
    cell_id: string
    event_id: string
    value: string
    value_html: string | null
    type: string | null
    canonical_ref: string | null
    anchor_cell_id: string | null
    start_ms: number | null
    end_ms: number | null
    sequence_index: number | null
    medium: string | null
    metadata: unknown
  }>()
  const existing: ExistingImportCell[] = existingRows.results.map((row) => ({
    cellId: row.cell_id,
    eventId: row.event_id,
    value: row.value,
    valueHtml: row.value_html,
    type: row.type,
    canonicalRef: row.canonical_ref,
    anchorCellId: row.anchor_cell_id,
    startMs: row.start_ms == null ? null : Number(row.start_ms),
    endMs: row.end_ms == null ? null : Number(row.end_ms),
    sequenceIndex: row.sequence_index == null ? null : Number(row.sequence_index),
    medium: row.medium,
    metadata: objectRecord(row.metadata),
  }))

  let plan: ReconciliationPlan
  try {
    plan = planImportReconciliation(body.cells, existing)
  } catch (error) {
    return withCors(new Response(error instanceof Error ? error.message : String(error), { status: 409 }), request)
  }

  let artifact: { r2_key: string; size_bytes: number; metadata: unknown } | null = null
  if (body.artifactId) {
    artifact = await db.prepare(
      `SELECT r2_key, size_bytes, metadata FROM artifacts
        WHERE id::text = ? AND project_id = ? AND file_id = ? AND kind = 'source'`,
    ).bind(body.artifactId, body.projectId, body.fileId)
      .first<{ r2_key: string; size_bytes: number; metadata: unknown }>()
    if (!artifact) return withCors(new Response('source artifact not found', { status: 409 }), request)
  }
  if (Boolean(body.artifactId) !== Boolean(body.rawSourceFormat)) {
    return withCors(new Response('artifactId and rawSourceFormat must be provided together', { status: 400 }), request)
  }

  const author = typeof auth.claims.username === 'string' && auth.claims.username.trim()
    ? auth.claims.username
    : `user:${auth.claims.userId}`
  const clientTs = typeof body.clientTs === 'number' ? body.clientTs : Date.now()
  let serverTs = Date.now()
  const mergedMeta = mergeFileMeta(file.meta, body.file)
  const filePayload: EventPayloads['file.create'] = {
    name: file.name,
    fileType: body.file.fileType ?? file.kind ?? file.role ?? 'codex',
    role: file.role ?? body.file.role,
    kind: file.kind ?? body.file.kind,
    bookCode: file.book_code ?? body.file.bookCode,
    sourceFileId: file.source_file_id ?? undefined,
    anchorFileId: file.anchor_file_id ?? undefined,
    importFormat: typeof mergedMeta.importFormat === 'string' ? mergedMeta.importFormat : undefined,
    parserVersion: typeof mergedMeta.parserVersion === 'string' ? mergedMeta.parserVersion : undefined,
    sourceLanguage: typeof mergedMeta.sourceLanguage === 'string' ? mergedMeta.sourceLanguage : undefined,
    targetLanguage: typeof mergedMeta.targetLanguage === 'string' ? mergedMeta.targetLanguage : undefined,
    sourceTextDirection: mergedMeta.sourceTextDirection === 'ltr' || mergedMeta.sourceTextDirection === 'rtl'
      ? mergedMeta.sourceTextDirection : undefined,
    targetTextDirection: mergedMeta.targetTextDirection === 'ltr' || mergedMeta.targetTextDirection === 'rtl'
      ? mergedMeta.targetTextDirection : undefined,
    orderedBy: typeof mergedMeta.orderedBy === 'string' ? mergedMeta.orderedBy : undefined,
    importManifest: objectRecord(mergedMeta.aquillaImport),
    projectionMeta: mergedMeta,
  }
  const fileEvent: PersistedEvent<'file.create'> = {
    id: body.file.id,
    schemaVersion: 1,
    projectId: body.projectId,
    fileId: body.fileId,
    cellId: null,
    parentId: file.event_id,
    kind: 'file.create',
    author,
    payload: filePayload,
    clientTs,
    serverTs: serverTs++,
  }

  const sourceEvents: PersistedEvent<'source.cell.create'>[] = plan.cells
    .filter((cell) => cell.changed)
    .map((cell) => ({
      id: cell.incoming.id,
      schemaVersion: 1,
      projectId: body.projectId,
      fileId: body.fileId,
      cellId: cell.finalCellId,
      parentId: cell.parentId,
      kind: 'source.cell.create',
      author,
      payload: sourcePayload(cell.incoming),
      clientTs,
      serverTs: serverTs++,
    }))
  const sourceEventByIncomingCell = new Map(plan.cells.map((cell) => [
    cell.originalCellId,
    cell.changed ? cell.incoming.id : cell.parentId!,
  ]))
  const finalCellByIncomingCell = new Map(plan.cells.map((cell) => [cell.originalCellId, cell.finalCellId]))

  const existingTargetRows = await db.prepare(
    `SELECT cell_id, target_lang FROM cells WHERE project_id = ? AND file_id = ? AND side = 'target'`,
  ).bind(body.projectId, body.fileId).all<{ cell_id: string; target_lang: string }>()
  const existingTargets = new Set(existingTargetRows.results.map((row) => `${row.cell_id}\0${row.target_lang}`))
  const targetEvents: PersistedEvent<'target.cell.commit'>[] = []
  for (const target of body.targets ?? []) {
    if (!target.id || !target.cellId || typeof target.value !== 'string') {
      return withCors(new Response('each target needs string id, cellId, and value', { status: 400 }), request)
    }
    const finalCellId = finalCellByIncomingCell.get(target.cellId)
    const sourceEventId = sourceEventByIncomingCell.get(target.cellId)
    const targetLang = target.targetLang ?? ''
    if (!finalCellId || !sourceEventId) {
      return withCors(new Response('each target must reference a source unit in this re-import', { status: 400 }), request)
    }
    if (existingTargets.has(`${finalCellId}\0${targetLang}`)) continue
    existingTargets.add(`${finalCellId}\0${targetLang}`)
    targetEvents.push({
      id: target.id,
      schemaVersion: 1,
      projectId: body.projectId,
      fileId: body.fileId,
      cellId: finalCellId,
      parentId: sourceEventId,
      kind: 'target.cell.commit',
      author,
      payload: {
        value: target.value,
        sourceEventId,
        ...(targetLang ? { targetLang } : {}),
      },
      clientTs,
      serverTs: serverTs++,
    })
  }

  const fileClaim: ChainSlot = {
    projectId: body.projectId,
    fileId: body.fileId,
    cellId: FILE_CLAIM_CELL_ID,
    parentKey: parentKeyOf(file.event_id),
  }
  const allEventCount = 1 + sourceEvents.length + targetEvents.length
  const seqBase = await allocateSeqRange(db, body.projectId, allEventCount)
  const sourceRows: SeqEventInsertRow[] = [fileEvent, ...sourceEvents].map((event, index) => ({
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId,
    cellId: event.cellId,
    parentId: event.parentId,
    kind: event.kind,
    author: event.author,
    payloadJson: JSON.stringify(event.payload),
    clientTs: event.clientTs,
    serverTs: event.serverTs,
    serverSeq: seqBase + index,
  }))
  const targetRows: SeqEventInsertRow[] = targetEvents.map((event, index) => ({
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId,
    cellId: event.cellId,
    parentId: event.parentId,
    kind: event.kind,
    author: event.author,
    payloadJson: JSON.stringify(event.payload),
    clientTs: event.clientTs,
    serverTs: event.serverTs,
    serverSeq: seqBase + sourceRows.length + index,
  }))

  const statements: AquillaStatement[] = [buildChainClaimStmt(db, fileClaim, fileEvent.id)]
  for (let offset = 0; offset < sourceEvents.length; offset += BULK_ROWS) {
    statements.push(buildBulkCellClaims(
      db,
      sourceEvents.slice(offset, offset + BULK_ROWS),
      fileClaim,
      fileEvent.id,
    ))
  }
  // Claims are inserted before any event/projection writes. If even one cell
  // lost to a concurrent source edit (or the file-level claim was lost), make
  // the transaction fail so no partial re-import or sidecar switch can land.
  for (let offset = 0; offset < sourceEvents.length; offset += BULK_ROWS) {
    statements.push(buildCellClaimAssertion(db, sourceEvents.slice(offset, offset + BULK_ROWS)))
  }
  for (let offset = 0; offset < sourceRows.length; offset += BULK_ROWS) {
    statements.push(buildGatedEventInsert(db, sourceRows.slice(offset, offset + BULK_ROWS), fileClaim, fileEvent.id))
  }
  statements.push(db.prepare(
    `UPDATE files SET
       role = ?, kind = ?, book_code = ?, source_file_id = ?, anchor_file_id = ?,
       event_id = ?, meta = ?, updated_at = ?
     WHERE id = ? AND project_id = ? AND ${fileClaimGate()}`,
  ).bind(
    file.role ?? body.file.role ?? null,
    file.kind ?? body.file.kind ?? body.file.fileType ?? null,
    file.book_code ?? body.file.bookCode ?? null,
    file.source_file_id,
    file.anchor_file_id,
    fileEvent.id,
    JSON.stringify(mergedMeta),
    serverTs,
    body.fileId,
    body.projectId,
    fileClaim.projectId, fileClaim.fileId, fileClaim.cellId, fileClaim.parentKey, fileEvent.id,
  ))
  for (let offset = 0; offset < sourceEvents.length; offset += BULK_ROWS) {
    statements.push(buildGatedSourceUpsert(db, sourceEvents.slice(offset, offset + BULK_ROWS), fileClaim, fileEvent.id))
  }
  if (artifact && body.rawSourceFormat) {
    statements.push(db.prepare(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       SELECT ?, ?, ?, NULL, ?, ?, ? WHERE ${fileClaimGate()}
       ON CONFLICT (file_id) DO UPDATE SET
         project_id = EXCLUDED.project_id, format = EXCLUDED.format, raw_source = NULL,
         r2_key = EXCLUDED.r2_key, size_bytes = EXCLUDED.size_bytes, created_at = EXCLUDED.created_at`,
    ).bind(
      body.fileId, body.projectId, body.rawSourceFormat, artifact.r2_key,
      Number(artifact.size_bytes), serverTs,
      fileClaim.projectId, fileClaim.fileId, fileClaim.cellId, fileClaim.parentKey, fileEvent.id,
    ))
  }
  const laneByTargetEvent = new Map(targetEvents.map((event) => [
    event.id,
    (event.payload as EventPayloads['target.cell.commit']).targetLang ?? '',
  ]))
  for (let offset = 0; offset < targetRows.length; offset += BULK_ROWS) {
    statements.push(buildTargetEventInsert(
      db,
      targetRows.slice(offset, offset + BULK_ROWS),
      laneByTargetEvent,
      fileClaim,
      fileEvent.id,
    ))
  }
  for (let offset = 0; offset < targetEvents.length; offset += BULK_ROWS) {
    statements.push(buildGatedTargetInsert(db, targetEvents.slice(offset, offset + BULK_ROWS), fileClaim, fileEvent.id))
  }
  statements.push(fileCountersRecomputeStmt(db, body.projectId, body.fileId, serverTs))
  statements.push(...fullProgressRecomputeStmts(db, body.projectId, body.fileId, serverTs))

  try {
    await runBatch(db, statements)
  } catch (error) {
    if (String(error).includes('re-import-cell-claim-conflict')) {
      return withCors(new Response('file changed during re-import; review and try again', { status: 409 }), request)
    }
    return withCors(Response.json({ error: `Re-import failed: ${String(error)}` }, { status: 500 }), request)
  }
  const winners = await readClaimWinners(db, [fileClaim])
  if (winners.get(slotKey(fileClaim)) !== fileEvent.id) {
    return withCors(new Response('file changed during re-import; review and try again', { status: 409 }), request)
  }

  if (env.ProjectSync) {
    const notify = notifyProjectDoFileProgressChanged(env, body.projectId, body.fileId, false).catch((error) => {
      console.warn(`[re-import] ProjectSync notify failed for ${body.projectId}/${body.fileId}:`, error)
    })
    if (ctx) ctx.waitUntil(notify)
    else void notify
  }

  const matched = plan.cells.filter((cell) => cell.matchKind !== 'new').length
  const added = plan.cells.length - matched
  const changed = plan.cells.filter((cell) => cell.changed).length
  return withCors(Response.json({
    fileId: body.fileId,
    replayed: false,
    matched,
    added,
    changed,
    unchanged: plan.cells.length - changed,
    retainedMissing: plan.retainedMissing.length,
    importedTargets: targetEvents.length,
  }), request)
}
