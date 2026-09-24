// AQU-1391 — wiring layer between the pure repetition engine
// (`autopropagation.ts`) and the event log.
//
// `propagateTranslation` answers "which cells should receive this text". It
// knows nothing about AD-2 chains, so on its own it cannot be handed to
// `emitTargetCellCommits`: every receiving cell needs its OWN chain head and
// its OWN AD-9 source pin. Reusing the confirmed cell's parent would make each
// propagated commit claim a head it does not hold, and the server's
// compare-and-swap would reject all but one of them (AQU-1154).
//
// This module does that per-cell resolution, and returns the pre-propagation
// value alongside so the toast's Undo can commit it back.

import {
  propagateTranslation,
  normalizeRepetitionSource,
  type PropagationSegment,
} from "./autopropagation"

/**
 * The slice of a cell view this planner reads. Structurally satisfied by
 * `CellData` (`src/hooks/useCells.ts`) — deliberately restated so the planner
 * stays a pure unit with no React/store dependency.
 */
export interface RepetitionCell {
  id: string
  fileId: string
  original: string
  translated: string
  translatedHtml?: string
  status: "empty" | "unvalidated" | "validated"
  /** AD-2 chain head for this cell's target row. */
  targetEventId?: string
  /** AD-9 staleness pin for this cell's source row. */
  sourceEventId?: string
}

/** One `target.cell.commit` to emit, already pinned to its own cell's chain. */
export interface RepetitionCommit {
  cellId: string
  fileId: string
  /** Text copied from the validated cell. */
  value: string
  valueHtml?: string
  /** This cell's own chain head — never the confirmed cell's. */
  parentId: string | null
  /** This cell's own source pin — never the confirmed cell's. */
  sourceEventId: string | null
  /** Value before propagation, so Undo can commit it back verbatim. */
  previousValue: string
  previousValueHtml?: string
}

export interface PlanRepetitionPropagationInput {
  /** The cell the user just validated. */
  confirmedCellId: string
  /** Cells of the ACTIVE FILE (v1 scope — see AQU-1391; project-wide needs a
   *  sync-worker query by normalized source and must not load files client-side). */
  cells: RepetitionCell[]
  /**
   * The workspace's own chain-head resolver (`resolveTargetCommitParentId`),
   * which knows about commits still sitting in the outbox — those are the real
   * head, and the projected value lags behind them. Passed in rather than
   * re-derived so a propagated commit chains exactly like a typed one; without
   * it the fallback below uses the projection alone.
   */
  resolveParentId?: (cell: RepetitionCell) => string | null | undefined
}

/**
 * Resolve the chain head for one receiving cell: the caller's resolver when it
 * has an answer, then the projected target head, then the source event (a
 * genesis target write), then null.
 */
function parentIdFor(
  cell: RepetitionCell,
  resolve?: PlanRepetitionPropagationInput["resolveParentId"],
): string | null {
  return resolve?.(cell) ?? cell.targetEventId ?? cell.sourceEventId ?? null
}

/**
 * Plan the commits that carry a newly validated cell's translation to every
 * repeated source segment in the same file.
 *
 * Returns `[]` when nothing should move — unknown cell, empty source, empty
 * translation, or no eligible repetitions. Callers emit nothing and show no
 * toast in that case.
 */
export function planRepetitionPropagation({
  confirmedCellId,
  cells,
  resolveParentId,
}: PlanRepetitionPropagationInput): RepetitionCommit[] {
  const confirmed = cells.find((c) => c.id === confirmedCellId)
  if (!confirmed) return []

  // Same file only. The store holds the active file, but a caller that hands
  // us a wider set must not silently write across files in v1.
  const sameFile = cells.filter((c) => c.fileId === confirmed.fileId)
  const byId = new Map(sameFile.map((c) => [c.id, c]))

  const segments: PropagationSegment[] = sameFile.map((c) => ({
    id: c.id,
    source: c.original,
    translated: c.translated,
    status: c.status,
  }))

  const updates = propagateTranslation(
    { id: confirmed.id, source: confirmed.original, translated: confirmed.translated },
    segments,
  )

  const commits: RepetitionCommit[] = []
  for (const update of updates) {
    const cell = byId.get(update.id)
    if (!cell) continue
    commits.push({
      cellId: cell.id,
      fileId: cell.fileId,
      value: update.translated,
      // The confirmed cell's rich text travels with its plain text: the
      // receiving cells are, by definition, the same string.
      valueHtml: confirmed.translatedHtml,
      parentId: parentIdFor(cell, resolveParentId),
      sourceEventId: cell.sourceEventId ?? null,
      previousValue: cell.translated,
      previousValueHtml: cell.translatedHtml,
    })
  }
  return commits
}

/**
 * How many cells in the file share each cell's normalized source, counting the
 * cell itself. Only cells that actually repeat (count ≥ 2) get an entry, so a
 * caller can render the "Repetition ×N" badge straight off a `has`/`get`.
 *
 * Counts every cell with that source, INCLUDING validated ones: the badge
 * answers "how often does this text occur", which is true regardless of who
 * may still receive a propagation.
 */
export function buildRepetitionCounts(cells: RepetitionCell[]): Map<string, number> {
  const byKey = new Map<string, string[]>()
  for (const cell of cells) {
    const key = normalizeRepetitionSource(cell.original)
    if (!key) continue
    const bucket = byKey.get(key)
    if (bucket) bucket.push(cell.id)
    else byKey.set(key, [cell.id])
  }
  const counts = new Map<string, number>()
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue
    for (const id of ids) counts.set(id, ids.length)
  }
  return counts
}
