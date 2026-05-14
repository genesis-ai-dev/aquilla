import { useMemo } from "react"
import type { CellData } from "./useCells"

function isUnfinished(
  cell: Pick<CellData, "translated" | "activeValidators">,
  validationCount: number,
): boolean {
  if (!cell.translated || !cell.translated.trim()) return true
  return (cell.activeValidators?.length ?? 0) < validationCount
}

/**
 * Pure, testable search. Returns the next unfinished cell's index after
 * `fromIndex` (exclusive), wrapping to the start if needed. Excludes
 * `fromIndex` itself. Returns -1 if no other cell is unfinished.
 */
export function findNextUnfinishedIndex(
  cells: Array<Pick<CellData, "translated" | "activeValidators">>,
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
export function useNextUnfinished(cells: CellData[], validationCount: number) {
  return useMemo(() => {
    const hasAny = cells.some((c) => isUnfinished(c, validationCount))
    return {
      hasAny,
      findNext: (fromIndex: number) => findNextUnfinishedIndex(cells, fromIndex, validationCount),
    }
  }, [cells, validationCount])
}
