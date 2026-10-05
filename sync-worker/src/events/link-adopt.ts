// AQU-1679: a link that follows INTO a file the project already has.
//
// The mirror (link-sync.ts) identifies a line by the upstream's cell id and a
// file by an id derived from the upstream's. A project that imported the same
// material on its own shares neither, so linking it could only ever add a
// second copy of the file — linked, but with none of the team's translations.
//
// When the Project Lead chooses "replace the source in my existing file", the
// link request records the pair on `projects.source_link_adopt` (migration
// 0137, db/shared/source-link-adopt.ts) and this module does the joining, once
// per file, before the mirror's forward fold:
//
//   1. Match the upstream file's lines to the file's own lines by content and
//      position (db/shared/link-file-match.ts).
//   2. For every matched pair, write one `source.cell.mirror` onto the file's
//      OWN cell, carrying the upstream's current text and naming the upstream
//      cell it now stands in for. The projection stores that name in
//      `cells.upstream_cell_id`, so the mapping is rebuilt from the event log
//      like every other projected column.
//
// From then on the forward fold resolves an upstream cell of that file through
// the mapping (`loadAdoptedCellIds`) and writes onto the project's cell. The
// target side is never touched: translations, validations, comments and
// recordings are keyed on cell ids this module does not change.
//
// Only `consumes: 'source'` links adopt. A chain link's source is the
// upstream's TRANSLATION, which an independently imported file cannot match.

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
import {
  buildEventProjectionStmts,
  contentHash,
  fileCountersRecomputeStmt,
  type PersistedEvent,
} from './event-projection'
import {
  allocateSeqRange,
  buildBulkEventInsertStmt,
  buildBulkEventInsertStmts,
  buildSettleSeqRangeStmt,
  type SeqEventInsertRow,
} from './event-insert'
import { fullProgressRecomputeStmts } from './progress-projection'
import type { EventPayloads } from './types'
import { loadFileSourceLines, matchLinkedFileLines } from '../../../db/shared/link-file-match'
import {
  serializeSourceLinkAdoption,
  type SourceLinkAdoption,
} from '../../../db/shared/source-link-adopt'

const BATCH_LIMIT = 100
const ADOPT_AUTHOR = 'link-sync'
const ADOPT_SCHEMA_VERSION = 1
/** Matched lines written per round: one bounded read of the upstream's rows and
 *  one bounded run of writes, whatever the file's size. */
const ADOPT_CHUNK_LINES = 500

/**
 * The adopted files' cell mapping: `<this project's file id>\0<upstream cell
 * id>` → this project's cell id.
 *
 * Read one file at a time off the primary key's (project_id, file_id) prefix.
 * A database that predates migration 0137 has no such column and no adopted
 * files either, so a failed read answers "no mapping" rather than failing the
 * sync that asked.
 */
export async function loadAdoptedCellIds(
  db: AquillaDb,
  projectId: string,
  fileIds: readonly string[],
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>()
  for (const fileId of fileIds) {
    try {
      const { results } = await db
        .prepare(
          `SELECT cell_id, upstream_cell_id FROM cells
            WHERE project_id = ? AND file_id = ? AND side = 'source' AND upstream_cell_id IS NOT NULL`,
        )
        .bind(projectId, fileId)
        .all<{ cell_id: string; upstream_cell_id: string }>()
      for (const row of results) mapping.set(`${fileId}\0${row.upstream_cell_id}`, row.cell_id)
    } catch {
      return new Map()
    }
  }
  return mapping
}

export interface RunAdoptionArgs {
  downstreamProjectId: string
  upstreamProjectId: string
  adoption: SourceLinkAdoption
  /** The raw column this run decided from — every write compares against it. */
  expectedRaw: string
  /**
   * The run's fenced lane-relevant upstream head. The upstream's `cells` rows
   * read here reflect at least every event up to it, so it is the provenance
   * each adopted row is stamped with: the forward fold then has nothing older
   * to say about the row, and anything newer applies.
   */
  head: number
  /** `deterministicMirrorEventId` bound to the downstream — passed in so this
   *  module does not import link-sync.ts, which imports it. */
  mirrorEventId: (key: string) => string
  outOfBudget: () => boolean
}

export interface RunAdoptionOutcome {
  /**
   * 'done' — nothing is pending any more. 'more' — out of budget with files
   * still pending. 'changed' — the record changed under this run (a re-link or
   * a detach); the caller stops and the next sync re-reads it.
   */
  status: 'done' | 'more' | 'changed'
  /** The record as this run left it, or null when no file is adopted. */
  adoption: SourceLinkAdoption | null
  cellsMirrored: number
  filesAdopted: number
}

interface UpstreamLineRow {
  cell_id: string
  value: string | null
  value_html: string | null
  type: string | null
  canonical_ref: string | null
  anchor_cell_id: string | null
  start_ms: number | string | null
  end_ms: number | string | null
  metadata: Record<string, unknown> | null
  event_id: string
  hidden_at: number | string | null
}

/**
 * Match and join every pending file, one at a time, saving the record after
 * each so an interrupted run resumes at the next file.
 *
 * A file that can no longer be joined — either side was deleted since the link
 * request checked it, or the two no longer hold the same material — is dropped
 * from the record instead. The upstream file then arrives as an ordinary
 * mirrored copy beside the project's own, which is what the link did before
 * this option existed and loses nothing.
 */
export async function runAdoption(db: AquillaDb, args: RunAdoptionArgs): Promise<RunAdoptionOutcome> {
  const { downstreamProjectId, upstreamProjectId, head, mirrorEventId } = args
  let adoption: SourceLinkAdoption | null = args.adoption
  let expectedRaw: string | null = args.expectedRaw
  let cellsMirrored = 0
  let filesAdopted = 0
  let attempted = 0

  for (const upstreamFileId of args.adoption.pending) {
    if (!adoption) break
    // Always at least one file per call, so a small budget still makes progress.
    if (attempted++ > 0 && args.outOfBudget()) {
      return { status: 'more', adoption, cellsMirrored, filesAdopted }
    }
    const fileId = adoption.files[upstreamFileId]
    let joined = false
    if (fileId) {
      const mirrored = await adoptFile(db, {
        downstreamProjectId, upstreamProjectId, upstreamFileId, fileId, head, mirrorEventId,
      })
      joined = mirrored !== null
      cellsMirrored += mirrored ?? 0
    }

    const files: Record<string, string> = { ...adoption.files }
    if (!joined) delete files[upstreamFileId]
    const next: SourceLinkAdoption | null =
      Object.keys(files).length === 0
        ? null
        : { files, pending: adoption.pending.filter((id) => id !== upstreamFileId) }
    const nextRaw = next ? serializeSourceLinkAdoption(next) : null
    const written = await db
      .prepare(
        `UPDATE projects SET source_link_adopt = ?
          WHERE id = ? AND source_link_adopt IS NOT DISTINCT FROM ?`,
      )
      .bind(nextRaw, downstreamProjectId, expectedRaw)
      .run()
    if (Number(written.meta?.changes ?? 0) === 0) {
      return { status: 'changed', adoption, cellsMirrored, filesAdopted }
    }
    adoption = next
    expectedRaw = nextRaw
    if (joined) filesAdopted++
  }
  return { status: 'done', adoption, cellsMirrored, filesAdopted }
}

/**
 * Join one file. Returns the number of mirror events written, or null when the
 * file cannot be joined (see runAdoption).
 */
async function adoptFile(
  db: AquillaDb,
  args: {
    downstreamProjectId: string
    upstreamProjectId: string
    upstreamFileId: string
    fileId: string
    head: number
    mirrorEventId: (key: string) => string
  },
): Promise<number | null> {
  const { downstreamProjectId, upstreamProjectId, upstreamFileId, fileId, head, mirrorEventId } = args

  const live = await db
    .prepare(
      `SELECT project_id FROM files
        WHERE deleted_at IS NULL AND ((project_id = ? AND id = ?) OR (project_id = ? AND id = ?))`,
    )
    .bind(upstreamProjectId, upstreamFileId, downstreamProjectId, fileId)
    .all<{ project_id: string }>()
  const liveIn = new Set(live.results.map((row) => row.project_id))
  if (!liveIn.has(upstreamProjectId) || !liveIn.has(downstreamProjectId)) {
    console.warn(`link adopt: ${fileId} or its upstream ${upstreamFileId} is gone; linking it as a separate file`)
    return null
  }

  const upstreamLines = await loadFileSourceLines(db, upstreamProjectId, upstreamFileId)
  const localLines = await loadFileSourceLines(db, downstreamProjectId, fileId)
  const match = matchLinkedFileLines(upstreamLines, localLines)
  if (!match.canReplace) {
    console.warn(
      `link adopt: ${fileId} no longer matches its upstream ${upstreamFileId} ` +
        `(${match.same} of ${Math.max(match.upstreamLines, match.localLines)} lines); linking it as a separate file`,
    )
    return null
  }

  // An upstream line with no counterpart here arrives through the forward fold
  // as a new cell under its own id. A matched line that FOLLOWS such a line
  // upstream is re-anchored on it, so the new line slots in where the upstream
  // has it instead of forking the order. Every other matched line keeps the
  // anchor it has — the file's own order, which its own unmatched lines hang
  // off.
  const paired = new Set(match.pairs.map((pair) => pair.upstreamCellId))
  const now = Date.now()
  let mirrored = 0

  for (let start = 0; start < match.pairs.length; start += ADOPT_CHUNK_LINES) {
    const chunk = match.pairs.slice(start, start + ADOPT_CHUNK_LINES)
    const rows = await db
      .prepare(
        `SELECT cell_id, value, value_html, type, canonical_ref, anchor_cell_id,
                start_ms, end_ms, metadata, event_id, hidden_at
           FROM cells
          WHERE project_id = ? AND file_id = ? AND side = 'source' AND target_lang = ''
            AND tombstoned_at IS NULL AND cell_id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .bind(upstreamProjectId, upstreamFileId, ...chunk.map((pair) => pair.upstreamCellId))
      .all<UpstreamLineRow>()
    const rowOf = new Map(rows.results.map((row) => [row.cell_id, row]))

    const eventRows: SeqEventInsertRow[] = []
    const persisted: PersistedEvent[] = []
    for (const pair of chunk) {
      // Deleted upstream between the match and this read: the forward fold's
      // own delete finds no mapping for it and leaves the file's line alone.
      const row = rowOf.get(pair.upstreamCellId)
      if (!row) continue
      const value = row.value ?? ''
      const anchor = row.anchor_cell_id
      const payload: EventPayloads['source.cell.mirror'] = {
        value,
        valueHtml: row.value_html ?? undefined,
        type: row.type ?? undefined,
        canonicalRef: row.canonical_ref ?? undefined,
        anchorCellId: anchor && !paired.has(anchor) ? anchor : null,
        startMs: row.start_ms == null ? undefined : Number(row.start_ms),
        endMs: row.end_ms == null ? undefined : Number(row.end_ms),
        metadata: row.metadata ?? undefined,
        // A line the upstream lead parked arrives parked, as it does on any
        // first sync. A visible one says nothing, so a line this project's own
        // lead parked stays parked.
        hidden: row.hidden_at != null ? true : undefined,
        adopt: true,
        upstream: {
          projectId: upstreamProjectId,
          cellId: pair.upstreamCellId,
          eventId: row.event_id,
          seq: head,
          side: 'source',
          contentHash: contentHash(value),
        },
      }
      // Keyed on the upstream head event as well as the pair, so re-adopting
      // the file after the upstream moved on is a new event, and a re-run of
      // this same adoption is an exact replay the events PK drops.
      const eventId = mirrorEventId(`adopt:${fileId}:${pair.cellId}:${row.event_id}`)
      const envelope = {
        id: eventId,
        schemaVersion: ADOPT_SCHEMA_VERSION,
        projectId: downstreamProjectId,
        fileId,
        cellId: pair.cellId,
        parentId: null,
        kind: 'source.cell.mirror' as const,
        author: ADOPT_AUTHOR,
        clientTs: now,
        serverTs: now,
      }
      eventRows.push({ ...envelope, payloadJson: JSON.stringify(payload), serverSeq: 0 })
      persisted.push({ ...envelope, payload })
    }
    if (eventRows.length === 0) continue

    const baseSeq = await allocateSeqRange(db, downstreamProjectId, eventRows.length)
    for (let i = 0; i < eventRows.length; i++) {
      eventRows[i].serverSeq = baseSeq + i
      persisted[i].serverSeq = baseSeq + i
    }
    const stmts: AquillaStatement[] = buildBulkEventInsertStmts(db, eventRows)
    for (const event of persisted) {
      buildEventProjectionStmts(db, event, stmts, { deferFileCounters: true })
    }
    // The audit record that closes this round into a batch "Upstream changes"
    // can show (link-cursor-batches-route.ts reads batches as the seq runs
    // between these records) — a line whose text the replace changed is
    // flagged for review like any upstream edit, and the panel finds what it
    // changed to through its batch.
    const cursorPayload: EventPayloads['link.cursor.advance'] = {
      upstreamProjectId,
      fromSeq: 0,
      toSeq: head,
      cellCount: eventRows.length,
    }
    const cursorSeq = await allocateSeqRange(db, downstreamProjectId, 1)
    stmts.push(
      buildBulkEventInsertStmt(db, [
        {
          id: mirrorEventId(`adopt-batch:${upstreamProjectId}:${fileId}:${head}:${start}`),
          schemaVersion: ADOPT_SCHEMA_VERSION,
          projectId: downstreamProjectId,
          fileId: null,
          cellId: null,
          parentId: null,
          kind: 'link.cursor.advance',
          author: ADOPT_AUTHOR,
          payloadJson: JSON.stringify(cursorPayload),
          clientTs: now,
          serverTs: now,
          serverSeq: cursorSeq,
        },
      ]),
      buildSettleSeqRangeStmt(db, downstreamProjectId, baseSeq),
      buildSettleSeqRangeStmt(db, downstreamProjectId, cursorSeq),
    )
    for (let i = 0; i < stmts.length; i += BATCH_LIMIT) {
      const batch = stmts.slice(i, i + BATCH_LIMIT)
      if (db.batchPipelined) await db.batchPipelined(batch)
      else await db.batch(batch)
    }
    mirrored += eventRows.length
  }

  await db.batch([
    fileCountersRecomputeStmt(db, downstreamProjectId, fileId, now),
    ...fullProgressRecomputeStmts(db, downstreamProjectId, fileId, now),
  ])
  return mirrored
}
