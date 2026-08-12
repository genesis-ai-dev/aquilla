import { useMemo } from "react"
import type { CellData } from "./useCells"

type UnfinishedCellShape = Pick<CellData, "translated" | "activeValidators"> &
  Partial<Pick<CellData, "hasOwnTake">>

function isUnfinished(
  cell: UnfinishedCellShape,
  validationCount: number,
): boolean {
  // AQU-646: a line whose deliverable is a recording is not unfinished for
  // want of text — "next unfinished" must not park the user on a dub that is
  // already done. It can still be unfinished for want of VALIDATION, which is
  // the same bar every other line is held to.
  const hasContent = Boolean(cell.translated?.trim()) || Boolean(cell.hasOwnTake)
  if (!hasContent) return true
  return (cell.activeValidators?.length ?? 0) < validationCount
}

/**
 * Pure, testable search. Returns the next unfinished cell's index after
 * `fromIndex` (exclusive), wrapping to the start if needed. Excludes
 * `fromIndex` itself. Returns -1 if no other cell is unfinished.
 */
export function findNextUnfinishedIndex(
  cells: readonly UnfinishedCellShape[],
  fromIndex: number,
  validationCount: number,
): number {
  if (cells.length === 0) return -1
  for (let offset = 1; offset <= cells.length; offset++) {
    const idx = (fromIndex + offset) % cells.length
    if (idx === fromIndex) break
    if (isUnfinished(cells[idx], validationCount)) return idx
  }
  return -1
}

/**
 * Hook variant returning a callable locator that can be invoked on a button
 * click. Kept separate from the pure function so the pure path is
 * independently testable.
 */
export function useNextUnfinished(cells: readonly UnfinishedCellShape[], validationCount: number) {
  return useMemo(() => {
    const hasAny = cells.some((c) => isUnfinished(c, validationCount))
    return {
      hasAny,
      findNext: (fromIndex: number) => findNextUnfinishedIndex(cells, fromIndex, validationCount),
    }
  }, [cells, validationCount])
}
