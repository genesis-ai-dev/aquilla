// AQU-668: repairing the per-cell pending target-commit pin after the server
// drops a commit as a "stale sibling" (a competing event already won the AD-2
// chain slot on that cell).
//
// ProjectWorkspace pins the just-enqueued commit as the cell's pending head so
// the NEXT edit chains onto it instead of forking a second sibling off the same
// parent. That pin is normally cleared by the projection-reconcile effect once
// the projected head catches up to (or moves past) the pin. A stale-sibling
// DROP satisfies neither clear condition — the projected head stays equal to
// the pin's parent — so the pin keeps pointing at a dead event id. Every later
// commit on that cell then chains off the dead branch and is itself dropped as
// stale, until a reload clears the in-memory pin: the cell becomes a black hole
// for edits while appearing to accept them.
//
// This helper answers "which pinned cells had their pinned head dropped?" so
// the caller can clear those pins (and their optimistic shadows) at the moment
// of the flush, not on the next reload.

export interface PendingCommitHead {
  /** Event id of the enqueued commit pinned as this cell's head. */
  eventId: string
  /** The parent it chained onto (the head at emit time). */
  parentId: string | null
}

/**
 * Return the cell ids whose pinned pending head is among `droppedEventIds`.
 *
 * Matches by the DROPPED event id — not the cell id — so a pin that was already
 * re-established for a NEWER commit (a fresh edit landed after the dropped one)
 * is left intact: only a pin still pointing at the dead event is cleared.
 */
export function droppedPinnedCells(
  pins: ReadonlyMap<string, PendingCommitHead>,
  droppedEventIds: Iterable<string>,
): string[] {
  const dropped = new Set(droppedEventIds)
  if (dropped.size === 0) return []
  const out: string[] = []
  for (const [cellId, pin] of pins) {
    if (dropped.has(pin.eventId)) out.push(cellId)
  }
  return out
}
