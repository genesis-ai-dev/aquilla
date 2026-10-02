// Parent resolution for a `target.cell.commit` (AD-2 chain head).
//
// AQU-1578: an optimistic target row created for a previously EMPTY cell
// carries `eventId: ""` (useActiveCellStore.applyOptimisticTargetEdit) — a
// placeholder, not a head. Every emit site used to resolve its parent with a
// `??` chain, which keeps "" (only null/undefined fall through), so a quick
// second commit on a just-filled cell went out with `parentId: ""`. The
// server's head compare-and-swap logged it as a stale sibling: the re-edit
// vanished and the cell lost its validation. These helpers treat "" exactly
// like "unknown" and never hand it back.

type MaybeEventId = string | null | undefined

/** First candidate that is a real event id (non-empty), else null. */
export function firstEventId(...candidates: readonly MaybeEventId[]): string | null {
  for (const candidate of candidates) {
    if (candidate) return candidate
  }
  return null
}

export interface TargetCommitParentCandidates {
  /**
   * Locally-known heads that are newer than the projection, highest priority
   * first: a commit reserved/enqueued by this tab that the server has not
   * confirmed yet (pendingTargetCommitHeadsRef, the AI-completion map, the
   * row-local ref).
   */
  pending?: readonly MaybeEventId[]
  /** The projected (or optimistic) target head — `""` for a placeholder row. */
  targetEventId?: MaybeEventId
  /** The source head: the genesis parent of a cell's first target commit. */
  sourceEventId?: MaybeEventId
}

/**
 * Parent for the NEXT target.cell.commit on a cell: the newest pending head,
 * then the projected target head, then the source head. Returns null only
 * when none is known — never `""`.
 */
export function resolveTargetCommitParent({
  pending = [],
  targetEventId,
  sourceEventId,
}: TargetCommitParentCandidates): string | null {
  return firstEventId(...pending, targetEventId, sourceEventId)
}
