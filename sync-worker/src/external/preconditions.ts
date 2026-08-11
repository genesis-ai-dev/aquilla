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
// AQU-538 lanes: target rows are keyed (cell, target_lang), so preconditions
// are lane-qualified — each requested (fileId, cellId, laneId) resolves the
// head of ITS lane only ('' / absent = the default lane). The source pin is
// lane-independent (one shared source per cell), and `targetExists` reports
// whether ANY lane has a target row (existence callers like LinkMedia don't
// care which lane).
//
// This mirrors the same reads route.ts prefetches (prefetchSourceEventIds for
// the source pin; the target head is cells.event_id where side='target').

import { cellKey, laneCellKey } from './commands'

export interface CellPrecondition {
  fileId: string
  cellId: string
  /** Target-language lane this precondition pins ('' / absent = default lane). */
  laneId?: string
  /** Current target chain head IN THIS LANE, or null if no such target row. */
  targetHeadEventId: string | null
  /** Current source-side event_id (AD-9 pin), or null if no source cell. */
  sourceEventId: string | null
}

/** Live per-cell state for a set of (fileId, cellId, laneId) triples. */
export interface CellState {
  /** Target chain head in the requested lane, or null. */
  targetHeadEventId: string | null
  sourceEventId: string | null
  sourceExists: boolean
  /** True when ANY lane has a target row for this cell (lane-independent). */
  targetExists: boolean
}

/** Resolve current source + lane-qualified target head event ids for the given
 *  cells. The returned map is keyed by laneCellKey(fileId, cellId, laneId). */
export async function resolveCellStates(
  db: AquillaDb,
  projectId: string,
  cells: readonly { fileId: string; cellId: string; laneId?: string }[],
): Promise<Map<string, CellState>> {
  const states = new Map<string, CellState>()
  if (cells.length === 0) return states

  // De-dupe the lookup set: one DB row-set per (fileId, cellId), fanned out to
  // every requested lane of that cell.
  const lanesByCell = new Map<string, { fileId: string; cellId: string; lanes: Set<string> }>()
  for (const c of cells) {
    const key = cellKey(c.fileId, c.cellId)
    let entry = lanesByCell.get(key)
    if (!entry) {
      entry = { fileId: c.fileId, cellId: c.cellId, lanes: new Set() }
      lanesByCell.set(key, entry)
    }
    entry.lanes.add(c.laneId ?? '')
  }
  const list = [...lanesByCell.values()]

  const placeholders = list.map(() => '(?, ?)').join(', ')
  const binds: unknown[] = []
  for (const c of list) binds.push(c.fileId, c.cellId)

  const { results } = await db
    .prepare(
      `SELECT file_id, cell_id, side, target_lang, event_id FROM cells
       WHERE project_id = ?
         AND side IN ('source', 'target')
         AND (file_id, cell_id) IN (${placeholders})`,
    )
    .bind(projectId, ...binds)
    .all<{ file_id: string; cell_id: string; side: string; target_lang: string | null; event_id: string }>()

  for (const c of list) {
    for (const lane of c.lanes) {
      states.set(laneCellKey(c.fileId, c.cellId, lane), {
        targetHeadEventId: null,
        sourceEventId: null,
        sourceExists: false,
        targetExists: false,
      })
    }
  }
  for (const r of results) {
    const entry = lanesByCell.get(cellKey(r.file_id, r.cell_id))
    if (!entry) continue
    for (const lane of entry.lanes) {
      const s = states.get(laneCellKey(r.file_id, r.cell_id, lane))
      if (!s) continue
      if (r.side === 'target') {
        s.targetExists = true
        if ((r.target_lang ?? '') === lane) s.targetHeadEventId = r.event_id
      } else {
        s.sourceEventId = r.event_id
        s.sourceExists = true
      }
    }
  }
  return states
}
