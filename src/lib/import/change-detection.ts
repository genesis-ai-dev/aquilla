// Generic change detection for re-importing a file whose cells have STABLE ids
// (lifted out of the Door43 delta, src/lib/dcs/delta.ts, so any importer can
// use it — the DCS adapter and Smart Extensions' files.upsert both do).
//
// Given what the importer parsed now and what the project currently holds,
// classify every cell:
//   - id not held                         → create
//   - held, content hash differs          → commit (chained on the held head)
//   - held in a re-parsed file, gone now  → delete (tombstone)
//   - held, hash equal                    → nothing
// Deletes are scoped to the files this parse produced, so a file the importer
// did not touch keeps every cell.

/** A parsed cell: a stable id and the hash of what it should hold. */
export interface DetectCell {
  cellId: string
  contentHash: string
}

/** The project's current view of one cell (from the projection). */
export interface HeldCellState {
  /** Current chain-head event id — the parent for a commit or delete. */
  eventId: string
  contentHash: string
  /** Which file holds it — scopes deletes to re-parsed files. */
  fileId: string
}

export interface DetectedChanges<C extends DetectCell> {
  creates: Array<{ cell: C; fileId: string }>
  commits: Array<{ cell: C; parentEventId: string }>
  deletes: string[]
  unchanged: number
}

export function detectChanges<C extends DetectCell>(
  files: ReadonlyArray<{ fileId: string; cells: readonly C[] }>,
  held: ReadonlyMap<string, HeldCellState>,
): DetectedChanges<C> {
  const parsedFileIds = new Set(files.map((f) => f.fileId))
  const parsedCellIds = new Set<string>()
  const creates: DetectedChanges<C>["creates"] = []
  const commits: DetectedChanges<C>["commits"] = []
  let unchanged = 0

  for (const file of files) {
    for (const cell of file.cells) {
      parsedCellIds.add(cell.cellId)
      const current = held.get(cell.cellId)
      if (!current) creates.push({ cell, fileId: file.fileId })
      else if (current.contentHash !== cell.contentHash) commits.push({ cell, parentEventId: current.eventId })
      else unchanged++
    }
  }

  const deletes: string[] = []
  for (const [cellId, current] of held) {
    if (parsedFileIds.has(current.fileId) && !parsedCellIds.has(cellId)) deletes.push(cellId)
  }
  return { creates, commits, deletes, unchanged }
}
