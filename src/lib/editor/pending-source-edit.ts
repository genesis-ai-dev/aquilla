/**
 * AQU-888 — "the row I just made should be ready to type in".
 *
 * A row inserted from the source-cell "+" has to open with its SOURCE editor
 * already focused, but the row doesn't exist yet when the click happens: the
 * create goes through the outbox, and its `EditorRow` only mounts once the
 * projection round-trips. So the workspace leaves a one-shot claim here and the
 * new row picks it up in its `useState` initializer as it mounts.
 *
 * A module-level claim rather than a prop or a context field on purpose: both
 * of those re-render every row in the table to tell exactly one row something,
 * and the row that needs telling is the one row that is mounting anyway.
 *
 * The claim expires on its own, because a create can fail server-side and a
 * claim nobody collects must not sit here waiting to ambush an unrelated row
 * that happens to reuse the id. Collecting it does NOT delete it outright: it
 * shortens the claim to a brief settle window instead.
 *
 * THE SETTLE WINDOW IS THE WHOLE REASON THIS IS NOT A ONE-SHOT FLAG. Under
 * StrictMode React invokes a `useState` initializer twice per mount and keeps
 * one of the two results; a claim consumed by the first invocation leaves the
 * surviving state `false`, so the row opens closed in development and open in
 * production — the worst possible split. Re-answering the SAME cell for a
 * moment makes both invocations agree, while a re-mount seconds later (a lane
 * switch, a recycled row) still finds the claim gone and doesn't pop the editor
 * open a second time.
 */

/** How long an uncollected claim stays live. Matches the workspace's own
 *  `pendingNewCell` give-up window, so the two can't disagree about when a
 *  create is considered lost. */
const CLAIM_TTL_MS = 8000

/** How long a collected claim keeps answering its own cell — long enough to
 *  span one mount's render passes, far short of a later re-mount. */
const SETTLE_MS = 250

let pending: { cellId: string; expiresAt: number } | null = null

/** Ask that `cellId` open its source editor the moment its row mounts. */
export function requestSourceEdit(cellId: string, now = Date.now()): void {
  pending = { cellId, expiresAt: now + CLAIM_TTL_MS }
}

/**
 * Take the claim for `cellId`, if it is the one outstanding and still fresh.
 * Answers true for that cell again during the settle window (see above), and
 * never for any other.
 */
export function claimSourceEdit(cellId: string, now = Date.now()): boolean {
  if (!pending) return false
  if (pending.expiresAt <= now) {
    pending = null
    return false
  }
  if (pending.cellId !== cellId) return false
  pending = { cellId, expiresAt: Math.min(pending.expiresAt, now + SETTLE_MS) }
  return true
}

/** Drop any outstanding claim (unmounting the table, abandoning a create). */
export function clearSourceEditRequest(): void {
  pending = null
}
