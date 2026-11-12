import { useMemo } from "react"
import type { CellData } from "./useCells"

type UnfinishedCellShape = Pick<CellData, "translated" | "activeValidators"> &
  Partial<Pick<CellData, "hasOwnTake" | "id" | "laneStatus">>

/**
 * Media redesign slice 2: a language that counts its recordings decides what
 * is unfinished by what it delivers (`isUnfinishedLine`); absent, the text
 * rule below stands, exactly as before.
 */
export type UnfinishedRule<C extends UnfinishedCellShape = UnfinishedCellShape> = (cell: C) => boolean

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
export function findNextUnfinishedIndex<C extends UnfinishedCellShape>(
  cells: readonly C[],
  fromIndex: number,
  validationCount: number,
  rule?: UnfinishedRule<C>,
): number {
  if (cells.length === 0) return -1
  for (let offset = 1; offset <= cells.length; offset++) {
    const idx = (fromIndex + offset) % cells.length
    if (idx === fromIndex) break
    if (rule ? rule(cells[idx]) : isUnfinished(cells[idx], validationCount)) return idx
  }
  return -1
}

/**
 * Hook variant returning a callable locator that can be invoked on a button
 * click. Kept separate from the pure function so the pure path is
 * independently testable.
 */
export function useNextUnfinished<C extends UnfinishedCellShape>(
  cells: readonly C[],
  validationCount: number,
  rule?: UnfinishedRule<C>,
) {
  return useMemo(() => {
    const hasAny = cells.some((c) => (rule ? rule(c) : isUnfinished(c, validationCount)))
    return {
      hasAny,
      findNext: (fromIndex: number) => findNextUnfinishedIndex(cells, fromIndex, validationCount, rule),
    }
  }, [cells, validationCount, rule])
}
