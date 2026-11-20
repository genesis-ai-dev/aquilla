/** Row a checkbox drag is on.
 *
 * The list only mounts a window of rows. The drag follows the row under the
 * pointer and the scroll that brings the next row under it. It does not jump
 * to the first or last cell when the pointer crosses the edge of the window. */
export function dragSelectionIndex(input: {
  rowIndex: number
  count: number
}): number {
  if (input.count <= 0) return -1
  if (!Number.isInteger(input.rowIndex) || input.rowIndex < 0 || input.rowIndex >= input.count) return -1
  return input.rowIndex
}

/** Ids this drag writes into the stored selection.
 *
 * A plain drag replaces the selection with the range. Command-drag passes the
 * ids already stored in `keep` and adds the range, so rows the list is not
 * drawing stay selected. */
export function idsForDrag(input: {
  listIds: readonly string[]
  anchorIndex: number
  focusIndex: number
  keep: ReadonlySet<string> | null
}): string[] {
  const count = input.listIds.length
  if (count === 0) return []
  const anchor = Math.max(0, Math.min(count - 1, input.anchorIndex))
  const focus = Math.max(0, Math.min(count - 1, input.focusIndex))
  const start = Math.min(anchor, focus)
  const end = Math.max(anchor, focus)
  const range = input.listIds.slice(start, end + 1)
  if (!input.keep) return range
  const next = new Set(input.keep)
  for (const id of range) next.add(id)
  return [...next]
}
