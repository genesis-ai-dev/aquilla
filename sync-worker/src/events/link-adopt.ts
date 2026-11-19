// AQU-1679: a link that follows INTO a file the project already has.
//
// The mirror (link-sync.ts) identifies a line by the upstream's cell id and a
// file by an id derived from the upstream's. A project that imported the same
// material on its own shares neither, so linking it could only ever add a
// second copy of the file — linked, but with none of the team's translations.
//
// When the Project Lead chooses "replace the source in my existing file", the
// link request records the pair on `projects.source_link_adopt` (migration
// 0140, db/shared/source-link-adopt.ts) and this module does the joining, once
// per file, before the mirror's forward fold:
//
//   1. Match the upstream file's lines to the file's own lines by content and
//      position (db/shared/link-file-match.ts).
//   2. For every matched pair, write one `source.cell.mirror` onto the file's
//      OWN cell, carrying the upstream's current text and naming the upstream
//      cell it now stands in for. The projection stores that name in
//      `cells.upstream_cell_id`, so the mapping is rebuilt from the event log
//      like every other projected column.
//      AQU-2549: a line whose text is unchanged keeps its own event id (the
//      projection's `adopt` rule), so only lines whose text changed read
//      "source changed" — also on a file imported in one step.
//
// From then on the forward fold resolves an upstream cell of that file through
// the mapping (`loadAdoptedCellIds`) and writes onto the project's cell. The
// target side is never touched: translations, validations, comments and
// recordings are keyed on cell ids this module does not change. (An IDML
// file's kept translations do have to be re-placed into the new source's style
// runs, as after a re-import; the workspace does that, not this worker — see
// src/lib/idml/link-adopted-align.ts.)
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
 * A database that predates migration 0140 has no such column and no adopted
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
  /** AQU-2549: `deterministicDownstreamFileId` bound to the downstream — the id
   *  a mirrored copy of an upstream file has here. Passed in for the same reason
   *  as `mirrorEventId`. */
  copyFileIdOf?: (upstreamFileId: string) => string
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
    const copyFileId = args.copyFileIdOf?.(upstreamFileId)
    let joined = false
    // AQU-2549: a copy that got translations of its own between the lead's
    // click and this sync is not joined: deleting it would lose the team's
    // work, and keeping it beside a joined file would leave it silently cut off
    // from the source. The copy stays the linked file, as before the click.
    if (fileId && copyFileId && copyFileId !== fileId && (await joinedCopyOf(db, downstreamProjectId, copyFileId))?.translated) {
      console.warn(`link adopt: copy ${copyFileId} has translations of its own; not joining it into ${fileId}`)
    } else if (fileId) {
      const mirrored = await adoptFile(db, {
        downstreamProjectId, upstreamProjectId, upstreamFileId, fileId, head, mirrorEventId,
      })
      joined = mirrored !== null
      cellsMirrored += mirrored ?? 0
      // AQU-2549: "Join into my existing file" — the upstream file had already
      // arrived as a mirrored copy. Now that the project's own file follows it,
      // the copy goes to Recently deleted.
      if (joined && copyFileId) {
        await removeJoinedCopy(db, {
          downstreamProjectId,
          copyFileId,
          fileId,
          mirrorEventId,
        })
      }
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

/** AQU-2549: the live mirrored copy of an upstream file, and whether anyone
 *  has translated a line of it; null when there is no such copy. */
async function joinedCopyOf(
  db: AquillaDb,
  downstreamProjectId: string,
  copyFileId: string,
): Promise<{ id: string; translated: boolean } | null> {
  return db
    .prepare(
      `SELECT f.id,
              EXISTS (SELECT 1 FROM cells c
                       WHERE c.project_id = f.project_id AND c.file_id = f.id
                         AND c.side = 'target' AND COALESCE(c.value, '') <> '') AS translated
         FROM files f
        WHERE f.project_id = ? AND f.id = ? AND f.deleted_at IS NULL`,
    )
    .bind(downstreamProjectId, copyFileId)
    .first<{ id: string; translated: boolean }>()
}

/**
 * AQU-2549: soft-delete the mirrored copy of an upstream file that one of the
 * project's own files now follows. A copy that is not there (the usual replace,
 * made at link time) is nothing to do. A copy with translations of its own is
 * kept: the join route refuses that case, and this is the last guard against
 * deleting a team's work.
 */
async function removeJoinedCopy(
  db: AquillaDb,
  args: { downstreamProjectId: string; copyFileId: string; fileId: string; mirrorEventId: (key: string) => string },
): Promise<void> {
  const { downstreamProjectId, copyFileId, fileId, mirrorEventId } = args
  if (copyFileId === fileId) return
  const copy = await joinedCopyOf(db, downstreamProjectId, copyFileId)
  if (!copy) return
  if (copy.translated) {
    console.warn(`link adopt: copy ${copyFileId} has translations of its own; keeping it beside ${fileId}`)
    return
  }
  const now = Date.now()
  const serverSeq = await allocateSeqRange(db, downstreamProjectId, 1)
  const event: PersistedEvent<'file.delete'> = {
    id: mirrorEventId(`join-remove-copy:${copyFileId}:${fileId}`),
    schemaVersion: ADOPT_SCHEMA_VERSION,
    projectId: downstreamProjectId,
    fileId: copyFileId,
    cellId: null,
    parentId: null,
    kind: 'file.delete',
    author: ADOPT_AUTHOR,
    payload: {},
    clientTs: now,
    serverTs: now,
    serverSeq,
  }
  const stmts: AquillaStatement[] = [
    buildBulkEventInsertStmt(db, [
      {
        id: event.id,
        schemaVersion: event.schemaVersion,
        projectId: event.projectId,
        fileId: event.fileId,
        cellId: null,
        parentId: null,
        kind: event.kind,
        author: event.author,
        payloadJson: '{}',
        clientTs: now,
        serverTs: now,
        serverSeq,
      },
    ]),
  ]
  buildEventProjectionStmts(db, event, stmts)
  stmts.push(buildSettleSeqRangeStmt(db, downstreamProjectId, serverSeq))
  await db.batch(stmts)
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

  // AQU-2549: an upstream line with no counterpart here is written in by the
  // join itself, as a new line under the upstream's own cell id — the id the
  // forward fold gives any line it finds no mapping for, so a later upstream
  // edit lands on this same row. (A join made after the link has run has a
  // link position past the upstream's history, so the forward fold would never
  // bring it in; on a replace made at link time the fold's older events for the
  // row are already below its stamp.) Its anchor is the upstream's, read
  // through the pairs. A matched line that FOLLOWS such a line upstream is
  // re-anchored on it, so the new line slots in where the upstream has it
  // instead of forking the order. Every other matched line keeps the anchor it
  // has — the file's own order, which its own unmatched lines hang off.
  const localOf = new Map(match.pairs.map((pair) => [pair.upstreamCellId, pair.cellId]))
  const lines: Array<{ upstreamCellId: string; cellId: string; paired: boolean }> = [
    ...match.pairs.map((pair) => ({ upstreamCellId: pair.upstreamCellId, cellId: pair.cellId, paired: true })),
    ...upstreamLines
      .filter((line) => !localOf.has(line.cellId))
      .map((line) => ({ upstreamCellId: line.cellId, cellId: line.cellId, paired: false })),
  ]
  const now = Date.now()
  let mirrored = 0

  for (let start = 0; start < lines.length; start += ADOPT_CHUNK_LINES) {
    const chunk = lines.slice(start, start + ADOPT_CHUNK_LINES)
    const rows = await db
      .prepare(
        `SELECT cell_id, value, value_html, type, canonical_ref, anchor_cell_id,
                start_ms, end_ms, metadata, event_id, hidden_at
           FROM cells
          WHERE project_id = ? AND file_id = ? AND side = 'source'
            AND tombstoned_at IS NULL AND cell_id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .bind(upstreamProjectId, upstreamFileId, ...chunk.map((line) => line.upstreamCellId))
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
      const anchorCellId = pair.paired
        ? (anchor && !localOf.has(anchor) ? anchor : null)
        : (anchor ? localOf.get(anchor) ?? anchor : null)
      const payload: EventPayloads['source.cell.mirror'] = {
        value,
        valueHtml: row.value_html ?? undefined,
        type: row.type ?? undefined,
        canonicalRef: row.canonical_ref ?? undefined,
        anchorCellId,
        startMs: row.start_ms == null ? undefined : Number(row.start_ms),
        endMs: row.end_ms == null ? undefined : Number(row.end_ms),
        metadata: row.metadata ?? undefined,
        // A line the upstream lead parked arrives parked, as it does on any
        // first sync. A visible one says nothing, so a line this project's own
        // lead parked stays parked.
        hidden: row.hidden_at != null ? true : undefined,
        // A new line is an ordinary mirror, under the monotonic guard: a re-run
        // of this join finds it already stamped and leaves it be.
        adopt: pair.paired ? true : undefined,
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
      const eventId = mirrorEventId(
        `${pair.paired ? 'adopt' : 'adopt-new'}:${fileId}:${pair.cellId}:${row.event_id}`,
      )
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
