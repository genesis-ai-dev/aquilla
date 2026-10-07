import { useMemo } from "react"
import { readAtVersion, type CellStore } from "./useActiveCellStore"
import type { CellData } from "./useCells"

const EMPTY: CellData[] = []

/** Character data is needed by the timeline, review/import dialogs, and
 * linked audio recording even when the timeline is hidden. Plain text editing
 * without those consumers must not materialize every cell view on each save. */
export function useCharacterSheetCells(
  store: Pick<CellStore, "getAllCellViews">,
  version: number,
  consumers: { timeline: boolean; importDialog: boolean; review: boolean; linkedAudio: boolean },
): CellData[] {
  const needed = consumers.timeline || consumers.importDialog || consumers.review || consumers.linkedAudio
  return useMemo(
    () => needed ? readAtVersion(version, () => store.getAllCellViews()) : EMPTY,
    [store, version, needed],
  )
}
