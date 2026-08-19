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
  sourceCellReanchorEventId,
  targetCellDeleteEventId,
} from "./ids"
import type { IngestEvent } from "./types"

/** One cell as the projection currently holds it, collapsed across sides.
 *  Mirrors the `/migrate/cell-ids` response row. */
export interface ProjectionCell {
  cellId: string
  hasSource: boolean
  hasTarget: boolean
  /** The source row's current `anchor_cell_id` (null = chain head, or no
   *  source row). Optional so pre-AQU-931 fixtures/servers still typecheck;
   *  absent reads as null. */
  sourceAnchorCellId?: string | null
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

/** Safety cap on retraction-generation escalation (AQU-933). Each generation
 *  beyond 1 means a logged tombstone was undone by a pre-AQU-931 rebuild —
 *  with that arbitration rule fixed, more than a couple should never occur. */
const MAX_RETRACTION_GENERATION = 8

/**
 * The first retraction id that can still APPLY, escalating generations
 * (AQU-933). A generation already in the log did not stick — the caller only
 * reaches this for a cell the projection STILL HOLDS, so a logged tombstone
 * means a pre-AQU-931 rebuild/replay resurrected the row and the id can never
 * re-project (re-runs delta-filter it). Returns null when this pass already
 * emits the id elsewhere (the mapper's own retraction — it will land and
 * project), or when the escalation cap is exhausted.
 */
function nextRetractionId(
  idForGeneration: (generation: number) => string,
  existingEventIds: ReadonlySet<string>,
  skipEventIds: ReadonlySet<string> | undefined,
): string | null {
  for (let generation = 1; generation <= MAX_RETRACTION_GENERATION; generation++) {
    const id = idForGeneration(generation)
    if (existingEventIds.has(id)) continue // logged but undone → escalate
    if (skipEventIds?.has(id)) return null // this run already emits it
    return id
  }
  return null
}

/**
 * Retract the cells the projection still holds for `fileId` that the current
 * Codex parse no longer produces. Ids are the same deterministic ones AQU-747
 * mints, so a re-run dedupes and a project that never had the cell is
 * untouched — escalating to a fresh generation when a logged tombstone was
 * undone by a pre-AQU-931 rebuild (AQU-933).
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
      const id = nextRetractionId(
        (generation) => sourceCellDeleteEventId(projectId, fileId, cell.cellId, generation),
        existingEventIds,
        skipEventIds,
      )
      if (id) {
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
      const id = nextRetractionId(
        (generation) => targetCellDeleteEventId(projectId, fileId, cell.cellId, generation),
        existingEventIds,
        skipEventIds,
      )
      if (id) {
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
 * The live cells of a mapped event stream, keyed by file (guard 1), each with
 * the anchor today's mapping gave it (null = chain head). Every file the pass
 * produced gets an entry — including one whose every cell was deleted in
 * Codex, which is exactly the Algerian case (all headings gone) and must
 * still be reconciled. A cell is live when the pass emitted its
 * `source.cell.create`; a Codex-deleted cell only ever gets a retraction, so it
 * correctly reads as not-live.
 */
export function liveSourceAnchorsByFile(
  events: readonly IngestEvent[],
): Map<string, Map<string, string | null>> {
  const byFile = new Map<string, Map<string, string | null>>()
  for (const e of events) {
    if (typeof e.fileId !== "string") continue
    if (e.kind === "file.create") {
      if (!byFile.has(e.fileId)) byFile.set(e.fileId, new Map())
    } else if (e.kind === "source.cell.create") {
      const cellId = (e.payload.cellId as string | undefined) ?? e.cellId
      if (typeof cellId !== "string") continue
      let live = byFile.get(e.fileId)
      if (!live) {
        live = new Map()
        byFile.set(e.fileId, live)
      }
      live.set(cellId, (e.payload.anchorCellId as string | null | undefined) ?? null)
    }
  }
  return byFile
}

/** Cell-id view of `liveSourceAnchorsByFile` (the orphan pass needs only ids). */
export function liveCellIdsByFile(events: readonly IngestEvent[]): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>()
  for (const [fileId, anchors] of liveSourceAnchorsByFile(events)) {
    byFile.set(fileId, new Set(anchors.keys()))
  }
  return byFile
}

export interface AnchorRepairArgs {
  projectId: string
  /** The migrated file being reconciled — repairs never cross a file boundary. */
  fileId: string
  /** cellId → the anchor today's mapping produced (null = chain head), i.e.
   *  one file's entry of `liveSourceAnchorsByFile`. */
  intendedAnchors: ReadonlyMap<string, string | null>
  /** The projection's current cells for this file (with stored anchors). */
  projectionCells: Iterable<ProjectionCell>
  /** Event ids already in the project's log — provenance proof plus no-op
   *  suppression for repairs a prior run landed. */
  existingEventIds: ReadonlySet<string>
  fallbackAuthor: string
  fallbackTs: number
}

/**
 * Anchor repairs for an already-migrated file (AQU-931).
 *
 * A re-run inserts nothing for a cell that already has its deterministic
 * `source.cell.create` in the log — so when a retraction removes the cell its
 * stored `anchor_cell_id` pointed at (a deleted heading per AQU-747/910, a
 * milestone marker per AQU-930), the projection keeps the dangling anchor
 * forever: the read walk can't reach the cell, it and everything chained
 * behind it fall to the orphan tail, and the file scrambles.
 *
 * This diffs the projection's stored anchor against the anchor today's
 * mapping produced and emits a `source.cell.reanchor` (anchor-only,
 * non-chain-mutating — no staleness, no validation churn) wherever they
 * differ. Guards mirror the retraction pass:
 *   1. FILE SCOPE — the caller reconciles only files this pass produced.
 *   2. MIGRATION PROVENANCE — only cells the migration itself created are
 *      re-anchored; cells authored inside Aquilla keep their author's anchor.
 * A repair whose deterministic id is already in the log is skipped — so a
 * deliberate later reorder inside Aquilla is not endlessly re-fought.
 */
export function mapAnchorRepairs(args: AnchorRepairArgs): IngestEvent[] {
  const {
    projectId,
    fileId,
    intendedAnchors,
    projectionCells,
    existingEventIds,
    fallbackAuthor,
    fallbackTs,
  } = args
  const events: IngestEvent[] = []

  for (const cell of projectionCells) {
    if (!cell.hasSource) continue
    const intended = intendedAnchors.get(cell.cellId)
    // Not produced by this pass: either retraction territory (the orphan pass
    // owns it) or another importer's cell — never re-anchor it.
    if (intended === undefined) continue
    // Guard 2: only ever repair what the migration itself created.
    if (!existingEventIds.has(sourceCellCreateEventId(projectId, fileId, cell.cellId))) continue
    if ((cell.sourceAnchorCellId ?? null) === intended) continue
    const id = sourceCellReanchorEventId(projectId, fileId, cell.cellId, intended)
    if (existingEventIds.has(id)) continue
    events.push({
      id,
      kind: "source.cell.reanchor",
      fileId,
      cellId: cell.cellId,
      parentId: null,
      author: fallbackAuthor,
      clientTs: fallbackTs,
      payload: { anchorCellId: intended },
    })
  }

  return events
}
