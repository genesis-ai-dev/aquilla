// FRO-476: mirror sync engine — the single propagation function every
// trigger (lazy pull on file open, push accelerator, manual "check now")
// funnels into. See the linked-projects design spec §5 for the full
// contract; this module is the tracer-bullet implementation for
// `consumes: 'source'` links (slice 1).
//
// mirrorSync(db, downstreamProjectId):
//   1. Load the link (upstream id, mode, consumes, cursor). Short-circuits
//      for clone mode / no link (nothing to do).
//   2. Freshness probe: max LANE-RELEVANT upstream server_seq vs cursor. If
//      not behind, return immediately (no DB writes).
//   3. Delta = upstream events in the lane set, server_seq > cursor, folded
//      to latest-per-cell (a seq window, not per-event work).
//   4. For each new upstream file: emit file.mirror.
//   5. For each folded cell: hash-equal → skip (no event, no write);
//      upstream-deleted → tombstone mirror; else → content mirror.
//   6. Batch all mirror events through the canonical events INSERT +
//      buildEventProjectionStmts (front-door — same projection code the live
//      HTTP path uses), respecting BATCH_LIMIT.
//   7. Cursor = GREATEST(cursor, head); emit link.cursor.advance only when
//      the fold produced at least one cell/file mirror.
//
// Idempotent + resumable: mirror event ids are deterministic
// (hash(downstreamProjectId + upstreamEventId)), so a crashed or re-run sync
// dedupes via the events PK; the projection's monotonic upstream_seq guard
// makes application order-insensitive; the cursor write only ever advances.
//
// This module calls buildEventProjectionStmts directly (in-process) rather
// than going through authorize()/POST /events — there is no client JWT for a
// server-authored mirror event, and this *is* the front door for this kind
// (the projection function), matching the "front-door events, never raw
// inserts" rule applied to server-authored writes elsewhere (see
// docs/superpowers/specs/2026-07-06-… §11 for the analogous adapter-service
// contract).

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
import { buildEventProjectionStmts, contentHash, type PersistedEvent } from './event-projection'
import { buildBulkEventInsertStmt, allocateSeqRange, type SeqEventInsertRow } from './event-insert'
import type { EventPayloads } from './types'

const BATCH_LIMIT = 100
const MIRROR_AUTHOR = 'link-sync'
const MIRROR_SCHEMA_VERSION = 1

/** Lane-relevant kinds for `consumes: 'source'` links (slice 1). Comments,
 *  audio attaches, back-translations, and validations never mirror — a probe
 *  that counted them would make every downstream read "behind" after any
 *  upstream noise event. */
const LANE_KINDS_SOURCE = [
  'source.cell.create',
  'source.cell.commit',
  'source.cell.delete',
  'source.cell.mirror',
  'cell.retime',
  'cast.assign',
  'file.create',
] as const

export interface LinkRow {
  id: string
  source_project_id: string | null
  source_link_mode: string | null
  source_link_consumes: string | null
  source_link_gate: string | null
  source_link_cursor: number
}

export async function loadLink(db: AquillaDb, downstreamProjectId: string): Promise<LinkRow | null> {
  return db
    .prepare(
      `SELECT id, source_project_id, source_link_mode, source_link_consumes,
              source_link_gate, source_link_cursor
       FROM projects WHERE id = ?`,
    )
    .bind(downstreamProjectId)
    .first<LinkRow>()
}

/** Max lane-relevant upstream server_seq — the cheap freshness probe (§4). */
export async function laneRelevantHeadSeq(db: AquillaDb, upstreamProjectId: string): Promise<number> {
  const kindList = LANE_KINDS_SOURCE.map((k) => `'${k}'`).join(', ')
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(server_seq), 0) AS head
       FROM events WHERE project_id = ? AND kind IN (${kindList})`,
    )
    .bind(upstreamProjectId)
    .first<{ head: number | string }>()
  return Number(row?.head ?? 0)
}

interface UpstreamDeltaRow {
  id: string
  file_id: string | null
  cell_id: string | null
  kind: string
  payload: string
  server_seq: number
}

interface FoldedCell {
  /** The UPSTREAM file id (the delta is read from upstream events). Convert
   *  via deterministicDownstreamFileId() before writing to the downstream's
   *  own `cells`/`files` rows — see that function's doc comment for why. */
  fileId: string
  cellId: string
  eventId: string
  seq: number
  deleted: boolean
  value: string
  valueHtml: string | null
  type: string | null
  canonicalRef: string | null
  anchorCellId: string | null
  startMs: number | null
  endMs: number | null
}

/** Deterministic uuid-shaped hash of an arbitrary key. Not cryptographic —
 *  only needs to be stable + collision-unlikely across its keyspace, which
 *  is what the callers below rely on (events PK idempotency; files PK
 *  identity). */
function deterministicUuid(key: string): string {
  // djb2-style multi-lane hash (reusing the existing content-hash primitive
  // with different seeds) folded into a UUIDv4-shaped string.
  const h1 = contentHash(key)
  const h2 = contentHash(`${key}\0salt2`)
  const h3 = contentHash(`${h1}${h2}`)
  const h4 = contentHash(`${h2}${h1}`)
  const hex = (h1 + h2 + h3 + h4).slice(0, 32).padEnd(32, '0')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${'89ab'[parseInt(hex[16] ?? '0', 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  )
}

/** Deterministic mirror event id: uuid-shaped hash of
 *  (downstreamProjectId, upstreamEventId) so replays/dual-triggers dedupe
 *  via the events PK idempotency path (readExistingEventIds/ON CONFLICT). */
export function deterministicMirrorEventId(downstreamProjectId: string, upstreamEventId: string): string {
  return deterministicUuid(`${downstreamProjectId}\0${upstreamEventId}`)
}

/**
 * Deterministic downstream file id for a mirrored upstream file.
 *
 * `files.id` is a GLOBAL primary key (no `project_id` in its uniqueness,
 * unlike `cells`/`chain_claims`/etc., which are all `(project_id, file_id,
 * …)`) — so a mirrored file CANNOT reuse the upstream's raw file id without
 * colliding with the upstream's own `files` row. Every downstream gets its
 * own deterministic id derived from (downstreamProjectId, upstreamFileId),
 * stable across re-syncs (so a re-run finds the SAME downstream file row,
 * not a duplicate) and distinct per downstream (so N downstreams of one
 * upstream never collide with each other either).
 *
 * `cell_id` has no such problem — `cells`' PK already includes
 * `project_id`, so the same `cell_id` string can and does appear in both
 * projects' `cells` rows, keyed apart by `project_id`. Only the file
 * identity needs this indirection.
 */
export function deterministicDownstreamFileId(downstreamProjectId: string, upstreamFileId: string): string {
  return deterministicUuid(`file\0${downstreamProjectId}\0${upstreamFileId}`)
}

/** Fold upstream lane events (server_seq > cursor) to latest-per-cell state,
 *  plus the set of new file ids seen. A seq window, not per-event work. */
async function loadDelta(
  db: AquillaDb,
  upstreamProjectId: string,
  sinceSeq: number,
): Promise<{ cells: Map<string, FoldedCell>; fileIds: Set<string> }> {
  const kindList = LANE_KINDS_SOURCE.map((k) => `'${k}'`).join(', ')
  const { results } = await db
    .prepare(
      `SELECT id, file_id, cell_id, kind, payload, server_seq
       FROM events
       WHERE project_id = ? AND server_seq > ? AND kind IN (${kindList})
       ORDER BY server_seq ASC`,
    )
    .bind(upstreamProjectId, sinceSeq)
    .all<UpstreamDeltaRow>()

  const cells = new Map<string, FoldedCell>()
  const fileIds = new Set<string>()

  for (const row of results) {
    if (!row.file_id) continue
    fileIds.add(row.file_id)
    if (!row.cell_id) continue
    const key = `${row.file_id}\0${row.cell_id}`
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.kind === 'source.cell.create' || row.kind === 'source.cell.mirror') {
      cells.set(key, {
        fileId: row.file_id,
        cellId: row.cell_id,
        eventId: row.id,
        seq: row.server_seq,
        deleted: false,
        value: typeof payload.value === 'string' ? payload.value : '',
        valueHtml: typeof payload.valueHtml === 'string' ? payload.valueHtml : null,
        type: typeof payload.type === 'string' ? payload.type : null,
        canonicalRef: typeof payload.canonicalRef === 'string' ? payload.canonicalRef : null,
        anchorCellId: typeof payload.anchorCellId === 'string' ? payload.anchorCellId : null,
        startMs: typeof payload.startMs === 'number' ? payload.startMs : null,
        endMs: typeof payload.endMs === 'number' ? payload.endMs : null,
      })
    } else if (row.kind === 'source.cell.commit') {
      const prev = cells.get(key)
      cells.set(key, {
        fileId: row.file_id,
        cellId: row.cell_id,
        eventId: row.id,
        seq: row.server_seq,
        deleted: false,
        value: typeof payload.value === 'string' ? payload.value : '',
        valueHtml: typeof payload.valueHtml === 'string' ? payload.valueHtml : null,
        type: prev?.type ?? null,
        canonicalRef: prev?.canonicalRef ?? null,
        anchorCellId: prev?.anchorCellId ?? null,
        startMs: prev?.startMs ?? null,
        endMs: prev?.endMs ?? null,
      })
    } else if (row.kind === 'source.cell.delete') {
      const prev = cells.get(key)
      cells.set(key, {
        fileId: row.file_id,
        cellId: row.cell_id,
        eventId: row.id,
        seq: row.server_seq,
        deleted: true,
        value: '',
        valueHtml: null,
        type: prev?.type ?? null,
        canonicalRef: prev?.canonicalRef ?? null,
        anchorCellId: prev?.anchorCellId ?? null,
        startMs: prev?.startMs ?? null,
        endMs: prev?.endMs ?? null,
      })
    }
    // cell.retime / cast.assign / file.create: structural-only kinds that
    // move the lane-relevant head but don't fold into FoldedCell content in
    // slice 1 (per spec §15 open question — "mirror metadata always, or only
    // before downstream has diverged?"). They still count toward `head` so
    // the freshness probe and cursor advance correctly; a future slice can
    // extend the fold to carry timing/cast deltas.
  }

  return { cells, fileIds }
}

/** Existing local mirror state per cell — used for the hash-equal no-op
 *  check and to know which upstream file ids are already mirrored. */
async function loadLocalMirrorState(
  db: AquillaDb,
  downstreamProjectId: string,
  cellKeys: readonly { fileId: string; cellId: string }[],
): Promise<Map<string, { contentHash: string | null; upstreamSeq: number | null }>> {
  const state = new Map<string, { contentHash: string | null; upstreamSeq: number | null }>()
  if (cellKeys.length === 0) return state
  const placeholders = cellKeys.map(() => '(?, ?)').join(', ')
  const binds: unknown[] = [downstreamProjectId]
  for (const k of cellKeys) binds.push(k.fileId, k.cellId)
  const { results } = await db
    .prepare(
      `SELECT file_id, cell_id, content_hash, upstream_seq FROM cells
       WHERE project_id = ? AND side = 'source' AND (file_id, cell_id) IN (${placeholders})`,
    )
    .bind(...binds)
    .all<{ file_id: string; cell_id: string; content_hash: string | null; upstream_seq: number | string | null }>()
  for (const r of results) {
    state.set(`${r.file_id}\0${r.cell_id}`, {
      contentHash: r.content_hash,
      upstreamSeq: r.upstream_seq == null ? null : Number(r.upstream_seq),
    })
  }
  return state
}

export interface MirrorSyncResult {
  ranSync: boolean
  cellsMirrored: number
  filesMirrored: number
  fromSeq: number
  toSeq: number
  skippedHashEqual: number
}

const NOOP_RESULT: MirrorSyncResult = {
  ranSync: false,
  cellsMirrored: 0,
  filesMirrored: 0,
  fromSeq: 0,
  toSeq: 0,
  skippedHashEqual: 0,
}

/**
 * Run one mirror sync for `downstreamProjectId`. Safe to call repeatedly —
 * a no-op when not behind, resumable/idempotent when a prior run partially
 * committed. Callers are responsible for single-flighting per downstream
 * (see project-do.ts's /__link-sync endpoint) — this function does not lock
 * anything itself.
 */
export async function mirrorSync(db: AquillaDb, downstreamProjectId: string): Promise<MirrorSyncResult> {
  const link = await loadLink(db, downstreamProjectId)
  if (!link || !link.source_project_id) return NOOP_RESULT
  // Clone mode: one-time snapshot at creation, then independent forever.
  // Never runs a mirror sync (§2 — a clone must never show upstream drift).
  if (link.source_link_mode === 'clone') return NOOP_RESULT
  // NULL mode = legacy/self-contained link (pre-FRO-476 `source_project_id`
  // without link metadata) — treated as clone (no sync) until explicitly
  // re-linked with mode='live'.
  if (link.source_link_mode !== 'live') return NOOP_RESULT

  const upstreamProjectId = link.source_project_id
  const cursor = Number(link.source_link_cursor ?? 0)
  const head = await laneRelevantHeadSeq(db, upstreamProjectId)
  if (head <= cursor) return NOOP_RESULT

  const { cells: folded, fileIds: deltaFileIds } = await loadDelta(db, upstreamProjectId, cursor)

  // Which of the delta's upstream file ids are genuinely new to the
  // downstream (need a file.mirror) vs already present. The downstream
  // never stores the upstream's raw file id (files.id is a GLOBAL PK — see
  // deterministicDownstreamFileId's doc comment), so the existence check
  // compares by the DETERMINISTIC downstream id derived from each upstream
  // file id. `IN (${placeholders})` — the codebase's consistent convention
  // for id-list lookups (see readExistingEventIds/prefetchChainWinners in
  // route.ts) — rather than `= ANY(?)`, whose array-binding semantics
  // through the shim are unproven.
  const deltaFileIdList = [...deltaFileIds]
  const downstreamFileIdOf = new Map<string, string>() // upstream file id -> downstream file id
  for (const upstreamFileId of deltaFileIdList) {
    downstreamFileIdOf.set(upstreamFileId, deterministicDownstreamFileId(downstreamProjectId, upstreamFileId))
  }
  let existingDownstreamFileIdSet = new Set<string>()
  if (deltaFileIdList.length > 0) {
    const downstreamIds = deltaFileIdList.map((id) => downstreamFileIdOf.get(id)!)
    const placeholders = downstreamIds.map(() => '?').join(', ')
    const existingFiles = await db
      .prepare(`SELECT id FROM files WHERE project_id = ? AND id IN (${placeholders})`)
      .bind(downstreamProjectId, ...downstreamIds)
      .all<{ id: string }>()
    existingDownstreamFileIdSet = new Set(existingFiles.results.map((r) => r.id))
  }
  const newUpstreamFileIds = deltaFileIdList.filter(
    (upstreamFileId) => !existingDownstreamFileIdSet.has(downstreamFileIdOf.get(upstreamFileId)!),
  )

  const localState = await loadLocalMirrorState(
    db,
    downstreamProjectId,
    [...folded.values()].map((c) => ({ fileId: downstreamFileIdOf.get(c.fileId) ?? deterministicDownstreamFileId(downstreamProjectId, c.fileId), cellId: c.cellId })),
  )

  const now = Date.now()
  const eventRows: SeqEventInsertRow[] = []
  const persistedForProjection: PersistedEvent[] = []
  let skippedHashEqual = 0

  // 1. file.mirror for new upstream files. `fileId` in the event envelope +
  // payload is the DOWNSTREAM's deterministic id, never the upstream's raw
  // id (files.id global-PK constraint — see deterministicDownstreamFileId).
  if (newUpstreamFileIds.length > 0) {
    const newFilePlaceholders = newUpstreamFileIds.map(() => '?').join(', ')
    const upstreamFiles = await db
      .prepare(`SELECT id, name, meta FROM files WHERE project_id = ? AND id IN (${newFilePlaceholders})`)
      .bind(upstreamProjectId, ...newUpstreamFileIds)
      .all<{ id: string; name: string; meta: string | null }>()
    for (const f of upstreamFiles.results) {
      const downstreamFileId = downstreamFileIdOf.get(f.id) ?? deterministicDownstreamFileId(downstreamProjectId, f.id)
      const eventId = deterministicMirrorEventId(downstreamProjectId, `file:${f.id}`)
      const payload: EventPayloads['file.mirror'] = {
        fileId: downstreamFileId,
        name: f.name,
        meta: f.meta ? (JSON.parse(f.meta) as Record<string, unknown>) : undefined,
        upstream: { projectId: upstreamProjectId, eventId: f.id, seq: head },
      }
      eventRows.push({
        id: eventId,
        schemaVersion: MIRROR_SCHEMA_VERSION,
        projectId: downstreamProjectId,
        fileId: downstreamFileId,
        cellId: null,
        parentId: null,
        kind: 'file.mirror',
        author: MIRROR_AUTHOR,
        payloadJson: JSON.stringify(payload),
        clientTs: now,
        serverTs: now,
        serverSeq: 0, // placeholder; replaced with allocated seq below
      })
      persistedForProjection.push({
        id: eventId,
        schemaVersion: MIRROR_SCHEMA_VERSION,
        projectId: downstreamProjectId,
        fileId: downstreamFileId,
        cellId: null,
        parentId: null,
        kind: 'file.mirror',
        author: MIRROR_AUTHOR,
        payload,
        clientTs: now,
        serverTs: now,
      })
    }
  }

  // 2. source.cell.mirror per folded cell — hash-equal skips entirely.
  // `fileId` on the emitted event is the DOWNSTREAM's deterministic file id
  // (same reasoning as file.mirror above); `cellId` is unchanged — cells'
  // PK includes project_id, so the same cell_id string safely appears in
  // both projects' `cells` rows.
  let cellsMirrored = 0
  for (const cell of folded.values()) {
    const downstreamFileId = downstreamFileIdOf.get(cell.fileId) ?? deterministicDownstreamFileId(downstreamProjectId, cell.fileId)
    const key = `${downstreamFileId}\0${cell.cellId}`
    const local = localState.get(key)

    if (cell.deleted) {
      // Tombstone — always emit (idempotent via deterministic id + monotonic
      // guard); hash suppression doesn't apply to deletes.
      const eventId = deterministicMirrorEventId(downstreamProjectId, cell.eventId)
      const payload: EventPayloads['source.cell.mirror'] = {
        value: '',
        deleted: true,
        upstream: {
          projectId: upstreamProjectId,
          cellId: cell.cellId,
          eventId: cell.eventId,
          seq: cell.seq,
          side: 'source',
          contentHash: contentHash(''),
        },
      }
      pushMirrorEvent(eventRows, persistedForProjection, {
        eventId, downstreamProjectId, fileId: downstreamFileId, cellId: cell.cellId, payload, now,
      })
      cellsMirrored++
      continue
    }

    const newHash = contentHash(cell.value)
    if (local && local.contentHash === newHash) {
      // No-op suppression (§5): content unchanged (e.g. whitespace-normalized
      // re-import). upstream_event_id is allowed to lag on unchanged content
      // — §6 staleness is hash-aware, so this is harmless.
      skippedHashEqual++
      continue
    }

    const eventId = deterministicMirrorEventId(downstreamProjectId, cell.eventId)
    const payload: EventPayloads['source.cell.mirror'] = {
      value: cell.value,
      valueHtml: cell.valueHtml ?? undefined,
      type: cell.type ?? undefined,
      canonicalRef: cell.canonicalRef ?? undefined,
      anchorCellId: cell.anchorCellId,
      startMs: cell.startMs ?? undefined,
      endMs: cell.endMs ?? undefined,
      upstream: {
        projectId: upstreamProjectId,
        cellId: cell.cellId,
        eventId: cell.eventId,
        seq: cell.seq,
        side: 'source',
        contentHash: newHash,
      },
    }
    pushMirrorEvent(eventRows, persistedForProjection, {
      eventId, downstreamProjectId, fileId: downstreamFileId, cellId: cell.cellId, payload, now,
    })
    cellsMirrored++
  }

  const filesMirrored = newUpstreamFileIds.length
  const totalMirrors = cellsMirrored + filesMirrored

  if (totalMirrors === 0) {
    // Nothing to mirror (every changed cell hash-suppressed, no new files) —
    // advance the cursor directly, no link.cursor.advance event (§4: "no log
    // spam from unmirrored upstream noise").
    await advanceCursor(db, downstreamProjectId, head)
    return { ranSync: true, cellsMirrored: 0, filesMirrored: 0, fromSeq: cursor, toSeq: head, skippedHashEqual }
  }

  // Allocate real server_seqs for the mirror event batch and commit through
  // the front door (canonical events INSERT + buildEventProjectionStmts —
  // the same projection code the live HTTP path uses).
  const baseSeq = await allocateSeqRange(db, downstreamProjectId, eventRows.length)
  for (let i = 0; i < eventRows.length; i++) {
    eventRows[i]!.serverSeq = baseSeq + i
    persistedForProjection[i]!.serverSeq = baseSeq + i
  }

  const allStmts: AquillaStatement[] = [buildBulkEventInsertStmt(db, eventRows)]
  for (const event of persistedForProjection) {
    buildEventProjectionStmts(db, event, allStmts, { deferFileCounters: true })
  }

  // link.cursor.advance — audit record, no cells projection, emitted only
  // because the fold was non-empty.
  const cursorEventId = deterministicMirrorEventId(downstreamProjectId, `cursor:${upstreamProjectId}:${cursor}:${head}`)
  const cursorPayload: EventPayloads['link.cursor.advance'] = {
    upstreamProjectId,
    fromSeq: cursor,
    toSeq: head,
    cellCount: totalMirrors,
  }
  const cursorSeq = await allocateSeqRange(db, downstreamProjectId, 1)
  allStmts.push(
    buildBulkEventInsertStmt(db, [
      {
        id: cursorEventId,
        schemaVersion: MIRROR_SCHEMA_VERSION,
        projectId: downstreamProjectId,
        fileId: null,
        cellId: null,
        parentId: null,
        kind: 'link.cursor.advance',
        author: MIRROR_AUTHOR,
        payloadJson: JSON.stringify(cursorPayload),
        clientTs: now,
        serverTs: now,
        serverSeq: cursorSeq,
      },
    ]),
  )

  // Batch in BATCH_LIMIT-sized chunks (same convention as route.ts/rebuild.ts).
  for (let i = 0; i < allStmts.length; i += BATCH_LIMIT) {
    await db.batch(allStmts.slice(i, i + BATCH_LIMIT))
  }

  // Recompute file counters for touched files, set-based (rebuild.ts style —
  // deferFileCounters above skipped the per-event recompute). Downstream
  // file ids throughout (files.id is a global PK — see
  // deterministicDownstreamFileId's doc comment).
  const touchedFiles = new Set<string>()
  for (const c of folded.values()) {
    touchedFiles.add(downstreamFileIdOf.get(c.fileId) ?? deterministicDownstreamFileId(downstreamProjectId, c.fileId))
  }
  for (const upstreamFileId of newUpstreamFileIds) {
    touchedFiles.add(downstreamFileIdOf.get(upstreamFileId)!)
  }
  for (const fileId of touchedFiles) {
    await db
      .prepare(
        `UPDATE files SET
           cell_count = (SELECT COUNT(DISTINCT cell_id) FROM cells WHERE project_id = ? AND file_id = ?),
           word_count = (SELECT COALESCE(SUM(word_count), 0) FROM cells WHERE project_id = ? AND file_id = ? AND side = 'target'),
           updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .bind(downstreamProjectId, fileId, downstreamProjectId, fileId, now, fileId, downstreamProjectId)
      .run()
  }

  // Cursor write: GREATEST(cursor, head) at the very end (§5) — a crashed or
  // overtaken sync can only under-claim progress, never over-claim it.
  await advanceCursor(db, downstreamProjectId, head)

  return {
    ranSync: true,
    cellsMirrored,
    filesMirrored,
    fromSeq: cursor,
    toSeq: head,
    skippedHashEqual,
  }
}

function pushMirrorEvent(
  eventRows: SeqEventInsertRow[],
  persisted: PersistedEvent[],
  args: {
    eventId: string
    downstreamProjectId: string
    fileId: string
    cellId: string
    payload: EventPayloads['source.cell.mirror']
    now: number
  },
): void {
  eventRows.push({
    id: args.eventId,
    schemaVersion: MIRROR_SCHEMA_VERSION,
    projectId: args.downstreamProjectId,
    fileId: args.fileId,
    cellId: args.cellId,
    parentId: null,
    kind: 'source.cell.mirror',
    author: MIRROR_AUTHOR,
    payloadJson: JSON.stringify(args.payload),
    clientTs: args.now,
    serverTs: args.now,
    serverSeq: 0,
  })
  persisted.push({
    id: args.eventId,
    schemaVersion: MIRROR_SCHEMA_VERSION,
    projectId: args.downstreamProjectId,
    fileId: args.fileId,
    cellId: args.cellId,
    parentId: null,
    kind: 'source.cell.mirror',
    author: MIRROR_AUTHOR,
    payload: args.payload,
    clientTs: args.now,
    serverTs: args.now,
  })
}

async function advanceCursor(db: AquillaDb, downstreamProjectId: string, head: number): Promise<void> {
  await db
    .prepare(`UPDATE projects SET source_link_cursor = GREATEST(source_link_cursor, ?) WHERE id = ?`)
    .bind(head, downstreamProjectId)
    .run()
}
