import { useMemo } from "react"
import type { CellData } from "./useCells"

type UnfinishedCellShape = Pick<CellData, "translated">

/**
 * AQU-738: a cell is "unfinished" only when its target text is empty or
 * whitespace. Validation state must NOT make a cell a jump target — with the
 * common 1-required-validation setting, treating unvalidated cells as
 * unfinished walked the translator line-by-line through work they'd already
 * done instead of taking them to the next untranslated line.
 */
function isUnfinished(cell: UnfinishedCellShape): boolean {
  return !cell.translated || !cell.translated.trim()
}

/**
 * Pure, testable search. Returns the next unfinished cell's index after
 * `fromIndex` (exclusive), wrapping to the start if needed. Excludes
 * `fromIndex` itself. Returns -1 if no other cell is unfinished.
 */
export function findNextUnfinishedIndex(
  cells: readonly UnfinishedCellShape[],
  fromIndex: number,
): number {
  if (cells.length === 0) return -1
  for (let offset = 1; offset <= cells.length; offset++) {
    const idx = (fromIndex + offset) % cells.length
    if (idx === fromIndex) break
    if (isUnfinished(cells[idx])) return idx
  }
  return -1
}

/**
 * Hook variant returning a callable locator that can be invoked on a button
 * click. Kept separate from the pure function so the pure path is
 * independently testable.
 */
export function useNextUnfinished(cells: readonly UnfinishedCellShape[]) {
  return useMemo(() => {
    const hasAny = cells.some((c) => isUnfinished(c))
    return {
      hasAny,
      findNext: (fromIndex: number) => findNextUnfinishedIndex(cells, fromIndex),
    }
  }, [cells])
}
