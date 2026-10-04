// AQU-1569: the arithmetic behind "put this file here".
//
// A file's hand-placed position is a single number in `files.meta.sortIndex`,
// written by the `file.reorder` event. This module turns a drag or a
// Move up/down into the set of numbers to write, and nothing else — no React,
// no outbox, no DOM. The sidebar and the tests both go through it, so the rule
// that decides an order is the rule the tests pin.
//
// Two shapes of write, and the difference is the whole design:
//
//   * **Steady state — every file in the group is already placed.** Moving one
//     writes ONE number: the midpoint of its new neighbours. Two leads moving
//     two different files touch two different files, so neither clobbers the
//     other, which is the reason the index is fractional rather than an
//     integer rank.
//
//   * **First placement, or a group holding a mix of placed and unplaced
//     files.** Here a single midpoint cannot express the result: an unplaced
//     file sorts after every placed one (see `sortIndexCompare`), so there is
//     no number that puts the moved file *below* one. The move stamps every
//     file in the group instead, in the order the move produces — a one-time
//     normalisation that buys exactness now and midpoints forever after.

import { usableSortIndex } from "./group-by-corpus"

/**
 * Gap between stamped indices on a full renumber. Wide enough that the
 * midpoints of midpoints stay comfortably inside a double for far longer than
 * anyone will drag a file, and a plain power of two so those midpoints are
 * exact binary fractions rather than repeating ones.
 */
export const SORT_INDEX_STEP = 1024

/** The subset of a file this module reads. */
export interface PlaceableFile {
  id: string
  sortIndex?: number
}

/** One file's new hand-placed position; `null` clears it. */
export interface SortIndexWrite {
  fileId: string
  sortIndex: number | null
}

function renumber(ordered: readonly PlaceableFile[]): SortIndexWrite[] {
  return ordered.map((file, i) => ({ fileId: file.id, sortIndex: i * SORT_INDEX_STEP }))
}

/**
 * Where the moved file lands, given the indices of the neighbours it ends up
 * between. `null` means "no number can express this" — the caller renumbers.
 */
function midpoint(prev: number | undefined, next: number | undefined): number | null {
  if (prev === undefined && next === undefined) return 0
  if (prev === undefined) return (next as number) - SORT_INDEX_STEP
  if (next === undefined) return prev + SORT_INDEX_STEP
  const candidate = (prev + next) / 2
  // Strictly between, or there is nothing to gain by writing it. Catches both
  // equal neighbours (two devices can mint the same midpoint, and the visual
  // order between them came from the tie-break, not from the numbers) and the
  // float-exhaustion end of a very long run of midpoints.
  return candidate > prev && candidate < next ? candidate : null
}

/**
 * The writes that move `fileId` to `toPosition` within its group.
 *
 * `ordered` is the group's CURRENT visual order — exactly what `groupByCorpus`
 * handed the sidebar, including the automatic name-derived order for files
 * nobody has placed yet. `toPosition` is the 0-based slot the file should
 * occupy afterwards, counted in that same list.
 *
 * Returns an empty array when the move is a no-op (unknown file, or it is
 * already in that slot), so a stray drop emits nothing.
 */
export function planFileMove(
  ordered: readonly PlaceableFile[],
  fileId: string,
  toPosition: number,
): SortIndexWrite[] {
  const from = ordered.findIndex((f) => f.id === fileId)
  if (from === -1) return []
  const to = Math.max(0, Math.min(ordered.length - 1, toPosition))
  if (to === from) return []

  const next = ordered.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)

  const allPlaced = ordered.every((f) => usableSortIndex(f.sortIndex) !== undefined)
  if (!allPlaced) return renumber(next)

  const placed = midpoint(
    to > 0 ? usableSortIndex(next[to - 1].sortIndex) : undefined,
    to < next.length - 1 ? usableSortIndex(next[to + 1].sortIndex) : undefined,
  )
  return placed === null
    ? renumber(next)
    : [{ fileId: moved.id, sortIndex: placed }]
}

/**
 * The writes that put `fileId` into a group it is not in yet, at `toPosition`.
 *
 * `ordered` is the target group's current visual order, without the incoming
 * file. `toPosition` is the 0-based slot the file should occupy afterwards,
 * and it may be `ordered.length` (after the last file). A file that is
 * already in `ordered` is handed to `planFileMove`, so a same-group drop and
 * a cross-corpus drop share one rule once the file is in the list.
 */
export function planFileInsert(
  ordered: readonly PlaceableFile[],
  fileId: string,
  toPosition: number,
): SortIndexWrite[] {
  if (ordered.some((file) => file.id === fileId)) return planFileMove(ordered, fileId, toPosition)
  const to = Math.max(0, Math.min(ordered.length, toPosition))
  const incoming: PlaceableFile = { id: fileId }
  const next = ordered.slice()
  next.splice(to, 0, incoming)

  const allPlaced = ordered.every((file) => usableSortIndex(file.sortIndex) !== undefined)
  if (!allPlaced) return renumber(next)

  const placed = midpoint(
    to > 0 ? usableSortIndex(next[to - 1].sortIndex) : undefined,
    to < next.length - 1 ? usableSortIndex(next[to + 1].sortIndex) : undefined,
  )
  return placed === null
    ? renumber(next)
    : [{ fileId, sortIndex: placed }]
}

/**
 * The writes that move `fileId` one slot up (`-1`) or down (`+1`). Returns
 * nothing at the respective end of the group, which is also what disables the
 * menu item — the two agree because they ask this same function.
 */
export function planFileNudge(
  ordered: readonly PlaceableFile[],
  fileId: string,
  direction: -1 | 1,
): SortIndexWrite[] {
  const from = ordered.findIndex((f) => f.id === fileId)
  if (from === -1) return []
  const to = from + direction
  if (to < 0 || to >= ordered.length) return []
  return planFileMove(ordered, fileId, to)
}

/**
 * The writes that put a group back on the automatic order: clear the index of
 * every file that carries one. Files with no index are left alone — there is
 * nothing to clear, and an event per untouched file would be noise in the log.
 */
export function planFileOrderReset(ordered: readonly PlaceableFile[]): SortIndexWrite[] {
  return ordered
    .filter((f) => usableSortIndex(f.sortIndex) !== undefined)
    .map((f) => ({ fileId: f.id, sortIndex: null }))
}

/** Whether a group has any hand-placed file at all — what gates "Reset order". */
export function hasPlacedFiles(ordered: readonly PlaceableFile[]): boolean {
  return ordered.some((f) => usableSortIndex(f.sortIndex) !== undefined)
}
