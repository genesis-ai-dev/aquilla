// Deletion-by-ABSENCE reconciliation for the legacy-Codex → Aquilla migration.
//
// AQU-673 stopped the mapper RECREATING a cell soft-deleted in Codex
// (`metadata.data.deleted`); AQU-747 made it emit an explicit retraction so a
// re-migration purges a cell an earlier run had already materialized. Both only
// ever look at cells that are STILL IN the notebook's `cells` array.
//
// A cell Codex removed from that array outright — a hard delete, or a heading /
// verse consolidated away by a merge — maps to no event at all. There is nothing
// to skip and nothing to retract, so the row a previous migration created lives
// on in Aquilla forever and every subsequent (idempotent) re-run is a no-op on
// it. That is the third bounce (AQU-910): Codex looks correct, Aquilla still
// shows the pre-fix state, including headings Codex no longer has at all.
//
// The DCS delta already solves this shape (src/lib/dcs/delta.ts →
// `classifyAgainstCurrent`): diff a fresh parse against the projection's CURRENT
// cells and tombstone whatever the parse no longer produces. This module does
// the same for the Codex migration.
//
// Two guards keep it from ever eating live content:
//   1. FILE SCOPE — only files this pass actually produced (a `file.create` in
//      the mapped stream) are reconciled. A file missing from the Codex working
//      copy, or belonging to another importer, is never touched.
//   2. MIGRATION PROVENANCE — a cell is retracted only when its deterministic
//      `sourceCellCreateEventId` is already in the project's event log, i.e. the
//      migration itself created it. Cells added inside Aquilla (an import, the
//      agent, a contributor) carry no such event and are left alone.

import {
  sourceCellCreateEventId,
  sourceCellDeleteEventId,
  targetCellDeleteEventId,
} from "./ids"
import type { IngestEvent } from "./types"

/** One cell as the projection currently holds it, collapsed across sides.
 *  Mirrors the `/migrate/cell-ids` response row. */
export interface ProjectionCell {
  cellId: string
  hasSource: boolean
  hasTarget: boolean
}

export interface OrphanRetractionArgs {
  projectId: string
  /** The migrated file being reconciled — deletes never cross a file boundary. */
  fileId: string
  /** Cell ids the CURRENT Codex parse produced for this file (see
   *  `liveCellIdsByFile`). Anything else the projection holds is an orphan. */
  liveCellIds: ReadonlySet<string>
  /** The projection's current cells for this file. */
  projectionCells: Iterable<ProjectionCell>
  /** Event ids already in the project's log. Doubles as the provenance proof
   *  (guard 2) and as no-op suppression for retractions a prior run landed. */
  existingEventIds: ReadonlySet<string>
  /** Event ids this pass already emitted — a cell soft-deleted in Codex is both
   *  absent from `liveCellIds` and already retracted by the mapper, and the two
   *  retractions share a deterministic id. Skipping them keeps the batch clean. */
  skipEventIds?: ReadonlySet<string>
  fallbackAuthor: string
  fallbackTs: number
}

/**
 * Retract the cells the projection still holds for `fileId` that the current
 * Codex parse no longer produces. Ids are the same deterministic ones AQU-747
 * mints, so a re-run dedupes and a project that never had the cell is untouched.
 */
export function mapOrphanRetractions(args: OrphanRetractionArgs): IngestEvent[] {
  const {
    projectId,
    fileId,
    liveCellIds,
    projectionCells,
    existingEventIds,
    skipEventIds,
    fallbackAuthor,
    fallbackTs,
  } = args
  const events: IngestEvent[] = []

  for (const cell of projectionCells) {
    if (liveCellIds.has(cell.cellId)) continue
    // Guard 2: only ever retract what the migration itself created.
    if (!existingEventIds.has(sourceCellCreateEventId(projectId, fileId, cell.cellId))) continue

    if (cell.hasSource) {
      const id = sourceCellDeleteEventId(projectId, fileId, cell.cellId)
      if (!existingEventIds.has(id) && !skipEventIds?.has(id)) {
        events.push({
          id,
          kind: "source.cell.delete",
          fileId,
          cellId: cell.cellId,
          parentId: null,
          author: fallbackAuthor,
          clientTs: fallbackTs,
          payload: {},
        })
      }
    }
    if (cell.hasTarget) {
      const id = targetCellDeleteEventId(projectId, fileId, cell.cellId)
      if (!existingEventIds.has(id) && !skipEventIds?.has(id)) {
        events.push({
          id,
          kind: "target.cell.delete",
          fileId,
          cellId: cell.cellId,
          parentId: null,
          author: fallbackAuthor,
          clientTs: fallbackTs,
          payload: {},
        })
      }
    }
  }

  return events
}

/**
 * The live cells of a mapped event stream, keyed by file (guard 1). Every file
 * the pass produced gets an entry — including one whose every cell was deleted
 * in Codex, which is exactly the Algerian case (all headings gone) and must
 * still be reconciled. A cell is live when the pass emitted its
 * `source.cell.create`; a Codex-deleted cell only ever gets a retraction, so it
 * correctly reads as not-live.
 */
export function liveCellIdsByFile(events: readonly IngestEvent[]): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>()
  for (const e of events) {
    if (typeof e.fileId !== "string") continue
    if (e.kind === "file.create") {
      if (!byFile.has(e.fileId)) byFile.set(e.fileId, new Set())
    } else if (e.kind === "source.cell.create") {
      const cellId = (e.payload.cellId as string | undefined) ?? e.cellId
      if (typeof cellId !== "string") continue
      let live = byFile.get(e.fileId)
      if (!live) {
        live = new Set()
        byFile.set(e.fileId, live)
      }
      live.add(cellId)
    }
  }
  return byFile
}
