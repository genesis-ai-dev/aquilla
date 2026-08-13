// AQU-646 stage 3: the arithmetic behind dragging a track's name up or down the
// timeline gutter. Pure and DOM-free on purpose — the pointer layer in
// TimelineEditor is the part that cannot be unit-tested cheaply, so everything
// that can be wrong by one row lives here instead.
//
// TRACK `order` IS A SORT KEY, NOT AN INDEX, and this module never forgets it.
// A drop computes ONE new number for ONE track — the midpoint of its new
// neighbours — so a drag emits exactly one `file.track.set` event and renumbers
// nothing else. That matters beyond tidiness: every extra track named in a
// reorder is another row a concurrent collaborator's rename could be racing.
//
// It imports `compareTracksBySeat` from tracks.ts, which imports nothing, so
// there is no cycle to close. That import is deliberate rather than convenient:
// the optimistic overlay must sort by the SAME total order the merge does or
// tied rows swap places at the instant the user releases the drag.

import { compareTracksBySeat, type TimelineTrack } from "./tracks"

/**
 * One gutter row's vertical extent in the gutter's CONTENT coordinates — i.e.
 * already past the scroll offset, not viewport coordinates.
 *
 * The distinction is the whole reason this is a named type. Bounds are
 * snapshotted from the live DOM once at pointerdown, but the gutter sits inside
 * a scroller that can move under the drag; storing viewport coordinates would
 * make every row's hit-test wrong by exactly `scrollTop` the moment it did.
 */
export interface RowBound {
  top: number
  bottom: number
}

/**
 * Where the dragged row would land if the pointer were released at
 * `pointerContentY`.
 *
 * Rows are hit-tested by MIDPOINT rather than by dividing the pointer offset by
 * a row height: rows are not uniform (a compact band beside a full-height one)
 * and the height can change mid-session via the vertical zoom, so the only
 * honest source is the measured bounds.
 *
 * The two-step is where reorder off-by-ones live, so it is spelled out. First
 * comes the INSERTION BOUNDARY, in `0..n` — how many rows the pointer has
 * passed the middle of, i.e. which gap it is hovering. Then that becomes a
 * destination INDEX, in `0..n-1`: the dragged row is still occupying a slot in
 * the list, so any boundary below it is one slot too low once the row is lifted
 * out. Dropping onto your own boundary either side is a no-op, which falls out
 * of the same adjustment.
 */
export function proposeDropIndex(
  fromIndex: number,
  pointerContentY: number,
  bounds: readonly RowBound[],
): number {
  const last = bounds.length - 1
  if (last < 0) return fromIndex
  // A non-finite pointer (an unmeasurable rect, a detached node) compares false
  // against every midpoint, which would silently read as "drop at the very
  // top". Staying put is the only answer that cannot lose the user's row.
  if (!Number.isFinite(pointerContentY)) return Math.max(0, Math.min(fromIndex, last))

  let insertAt = 0
  for (const bound of bounds) {
    if ((bound.top + bound.bottom) / 2 < pointerContentY) insertAt += 1
  }

  const toIndex = insertAt > fromIndex ? insertAt - 1 : insertAt
  return Math.max(0, Math.min(toIndex, last))
}

/**
 * The single `order` to persist for a drop, or null when there is nothing to
 * do.
 *
 * Neighbours are read from the list WITHOUT the dragged row, because that is
 * what the list looks like at the moment the row is inserted; reading them from
 * the full list would pick up the row's own old position as one of its new
 * bounds and halve the gap for no reason.
 *
 * `needsRenormalise` says the caller must fall back to `renormaliseOrders`,
 * and it is decided by EXACT arithmetic rather than an epsilon — an epsilon
 * would be a guess at how much float headroom is "enough", and the two real
 * triggers do not need guessing:
 *   - the result is non-finite (a stored order of ±Infinity, or f64 exhausted
 *     after ~52 successive midpoints in the same gap — not reachable by hand);
 *   - the result EQUALS one of its neighbours, which happens the moment those
 *     neighbours legitimately share an `order`. That is not hypothetical: the
 *     merge's total order exists precisely because ties are a real state, and
 *     tracks.test.ts pins it.
 */
export function orderForDrop(
  tracks: readonly TimelineTrack[],
  fromIndex: number,
  toIndex: number,
): { trackId: string; order: number; needsRenormalise: boolean } | null {
  if (fromIndex === toIndex) return null
  if (fromIndex < 0 || fromIndex >= tracks.length) return null
  if (toIndex < 0 || toIndex >= tracks.length) return null

  const moved = tracks[fromIndex]
  const rest = tracks.filter((_, index) => index !== fromIndex)
  if (rest.length === 0) return null

  const before = toIndex > 0 ? rest[toIndex - 1] : undefined
  const after = toIndex < rest.length ? rest[toIndex] : undefined

  let order: number
  if (!before && after) order = after.order - 1
  else if (before && !after) order = before.order + 1
  else if (before && after) order = (before.order + after.order) / 2
  else return null

  const needsRenormalise =
    !Number.isFinite(order) || order === before?.order || order === after?.order
  return { trackId: moved.id, order, needsRenormalise }
}

/**
 * Integer orders from 0 for a list ALREADY in the sequence the user wants, as
 * the deltas that get it there — only the tracks whose number actually changes,
 * so the ordinary case emits nothing at all.
 *
 * WHY THIS DOES NOT BREAK THE FORWARD-COMPATIBILITY INVARIANT in tracks.ts
 * (a future reader will and should flag it): that rule forbids writing back a
 * LIST derived from a merge, because the merge drops kinds this build has never
 * heard of and writing the survivors back as a list would delete the rest. What
 * comes out of here is N independent single-track deltas, each naming one id
 * this build itself derived. A newer client's unknown track is never named, so
 * it is never touched — it simply keeps the order it had, which is the same
 * outcome as if this build had never run.
 */
export function renormaliseOrders(
  tracks: readonly TimelineTrack[],
): Array<{ trackId: string; order: number }> {
  const changes: Array<{ trackId: string; order: number }> = []
  tracks.forEach((track, index) => {
    if (track.order !== index) changes.push({ trackId: track.id, order: index })
  })
  return changes
}

/**
 * The list to DRAW while a reorder is in flight: the server's tracks with the
 * pending orders laid over them.
 *
 * Display-only, and the copies are why. Every row comes back fresh, so nothing
 * a caller holds can carry an optimistic order back into `trackOverrides`, into
 * IDB or into an emitted patch — the overlay exists so the row does not snap
 * back while a full project refresh lands, and it must not become a source of
 * truth for anything.
 *
 * Ids in `pending` that the server has no row for are ignored rather than
 * appended: a pending order is a patch to something the user can see, and a
 * track that has since been removed (or that this build cannot draw) must not
 * be conjured into the gutter by one.
 */
export function applyPendingOrders(
  tracks: readonly TimelineTrack[],
  pending: ReadonlyMap<string, number>,
): TimelineTrack[] {
  const seats = new Map<string, number>()
  tracks.forEach((track, index) => seats.set(track.id, index))
  const patched = tracks.map((track) => {
    const order = pending.get(track.id)
    return order === undefined ? { ...track } : { ...track, order }
  })
  return patched.sort(compareTracksBySeat(seats, tracks.length))
}

/**
 * Which pending ids the server has now caught up with, so the caller can drop
 * them from the overlay.
 *
 * Exact `===` and not a tolerance: the number the server echoes back is the
 * number this client sent, byte for byte through JSON. Anything else means some
 * OTHER writer won — a collaborator dragging the same row — and in that case
 * the overlay is stale and holding it would fight the winner.
 */
export function settledPendingOrders(
  pending: ReadonlyMap<string, number>,
  serverTracks: readonly TimelineTrack[],
): string[] {
  const settled: string[] = []
  for (const track of serverTracks) {
    const wanted = pending.get(track.id)
    if (wanted !== undefined && track.order === wanted) settled.push(track.id)
  }
  return settled
}
