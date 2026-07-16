// Per-cell precondition resolution against the live projection (AQU-533 §3).
//
// A changeset pins, per target cell, the exact state it was planned against:
//   - targetHeadEventId — the current target chain head (parentId for the new
//     target.cell.commit); null when no target row exists yet.
//   - sourceEventId — the current source-side cells.event_id (the AD-9 pin
//     stamped into the compiled commit's payload.sourceEventId).
// Commit re-resolves these and returns plan_stale on any drift — Aquilla never
// silently recomputes and applies something other than what was approved.
//
// This mirrors the same reads route.ts prefetches (prefetchSourceEventIds for
// the source pin; the target head is cells.event_id where side='target').

import { cellKey } from './commands'

export interface CellPrecondition {
  fileId: string
  cellId: string
  /** Current target chain head, or null if the target cell does not exist. */
  targetHeadEventId: string | null
  /** Current source-side event_id (AD-9 pin), or null if no source cell. */
  sourceEventId: string | null
}

/** Live per-cell state for a set of (fileId, cellId) pairs in one project. */
export interface CellState {
  targetHeadEventId: string | null
  sourceEventId: string | null
  sourceExists: boolean
  targetExists: boolean
}

/** Resolve current source + target head event ids for the given cells. */
export async function resolveCellStates(
  db: AquillaDb,
  projectId: string,
  cells: readonly { fileId: string; cellId: string }[],
): Promise<Map<string, CellState>> {
  const states = new Map<string, CellState>()
  if (cells.length === 0) return states

  // De-dupe the lookup set.
  const uniq = new Map<string, { fileId: string; cellId: string }>()
  for (const c of cells) uniq.set(cellKey(c.fileId, c.cellId), c)
  const list = [...uniq.values()]

  const placeholders = list.map(() => '(?, ?)').join(', ')
  const binds: unknown[] = []
  for (const c of list) binds.push(c.fileId, c.cellId)

  const { results } = await db
    .prepare(
      `SELECT file_id, cell_id, side, event_id FROM cells
       WHERE project_id = ?
         AND side IN ('source', 'target')
         AND (file_id, cell_id) IN (${placeholders})`,
    )
    .bind(projectId, ...binds)
    .all<{ file_id: string; cell_id: string; side: string; event_id: string }>()

  for (const c of list) {
    states.set(cellKey(c.fileId, c.cellId), {
      targetHeadEventId: null,
      sourceEventId: null,
      sourceExists: false,
      targetExists: false,
    })
  }
  for (const r of results) {
    const s = states.get(cellKey(r.file_id, r.cell_id))
    if (!s) continue
    if (r.side === 'target') {
      s.targetHeadEventId = r.event_id
      s.targetExists = true
    } else {
      s.sourceEventId = r.event_id
      s.sourceExists = true
    }
  }
  return states
}
