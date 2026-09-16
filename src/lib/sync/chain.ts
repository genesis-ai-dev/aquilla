// AD-2 parent-chain helpers shared by readers of a cell's event history.
//
// Extracted from `useCellEditHistory` (AQU-464) so the history drawer and the
// audio↔text drift resolver decide "which commits actually counted" the same
// way. There is exactly one right answer per cell and it should not be
// computed twice.

import type { CellHistoryEvent } from "./history-read-types"

/**
 * Build the set of event ids that are currently on the AD-2 chain — the
 * sequence reachable by walking back from the cell's chain head (current
 * `cells.event_id`) via `parentId` pointers. Any commit not in this set is
 * a stale sibling that lost its first-child-of-parent race; it stays in the
 * log so the user can find it from the history drawer, but it never
 * advanced the projection.
 *
 * If `currentEventId` is absent (no projection yet, or caller didn't pass
 * one) we treat the whole list as on-chain — falling back to the pre-AD-2
 * "everything is current" rendering, which is better than mis-flagging
 * winning commits as stale.
 */
export function computeOnChainSet(
  events: CellHistoryEvent[],
  currentEventId: string | null,
): Set<string> | null {
  if (!currentEventId) return null
  const byId = new Map<string, CellHistoryEvent>()
  for (const e of events) byId.set(e.id, e)
  // If the supplied head doesn't appear in the events we just read, the
  // caller passed a head for a different side of the cell (eg. target head
  // while we're viewing source history) or for a chain that's outside the
  // limit window. Fall back to null — flagging every commit stale would be
  // strictly worse than not flagging at all.
  if (!byId.has(currentEventId)) return null
  const onChain = new Set<string>()
  let cursor: string | null = currentEventId
  // Guard against runaway walks if the data ever cycles. A cell's chain
  // should never exceed the events we just read, so events.length is a
  // safe upper bound.
  let steps = events.length + 1
  while (cursor && steps-- > 0) {
    if (onChain.has(cursor)) break
    onChain.add(cursor)
    const node = byId.get(cursor)
    if (!node) break
    cursor = node.parentId
  }
  return onChain
}
