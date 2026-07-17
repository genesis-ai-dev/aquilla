// Source-side chain-head bookkeeping for the inline "Edit source text"
// affordance (source.cell.commit). Mirrors the target-side reconciliation in
// ProjectWorkspace (pendingTargetCommitHeadsRef) but scoped to a single cell
// row, so the editor never forks two source commits onto the same parent.
//
// AQU-603: a `source.cell.commit` is dropped by the server's AD-2 first-child
// guard ("server accepted but did not apply — stale siblings") when a second
// commit chains onto a parent that already has a winning child. That happened
// when a lane switch triggered a mid-flight cells revalidate: the row's pending
// source head was clobbered back to the (still-lagging) projection head, so the
// next edit re-used the old parent and forked. These helpers encode the rule
// that a locally-pending head is never regressed while the projection lags at
// its parent.

export interface PendingSourceCommit {
  /** The event id of the just-enqueued source.cell.commit (the new head). */
  eventId: string
  /** The parent this commit chained onto (the head at emit time). */
  parentId: string | null
}

/**
 * Parent for the NEXT source.cell.commit on a cell: chain onto the
 * locally-pending head if one is still in flight, otherwise the projection's
 * current source head. Returns null only when neither is known (genesis).
 */
export function resolveSourceCommitParent(
  pending: PendingSourceCommit | null,
  projectedSourceEventId: string | null,
): string | null {
  return pending?.eventId ?? projectedSourceEventId ?? null
}

/**
 * Reconcile a pending source head against the latest projection head. Returns
 * the pending commit to KEEP, or null to clear it:
 *
 *  - Projection caught up to our pending head  → clear (it landed).
 *  - A DIFFERENT head landed that isn't the parent we chained from (a
 *    remote/peer source commit or mirror-sync) → clear, so the next edit
 *    chains onto that newer projection head.
 *  - Projection still lags at our commit's parent → KEEP, so the next edit
 *    chains onto our pending head instead of forking a stale sibling.
 */
export function reconcilePendingSourceCommit(
  pending: PendingSourceCommit | null,
  projectedSourceEventId: string | null,
): PendingSourceCommit | null {
  if (!pending) return null
  if (projectedSourceEventId === pending.eventId) return null
  if (projectedSourceEventId && projectedSourceEventId !== pending.parentId) return null
  return pending
}
