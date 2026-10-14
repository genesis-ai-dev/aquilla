// Bible data, the file's cells as verses (AQU-1687; shared since AQU-1689).
//
// Voices and Who's Who both need each cell's canonical ref and type, in file
// order, and must not rebuild anything on a keystroke. A keystroke bumps the
// cell store's version without changing any ref, so the refs are read into
// one string first, and everything downstream depends on that string.

import { useMemo } from "react"
import { readAtVersion, type CellStore } from "@/hooks/useActiveCellStore"
import type { VoiceCellInput } from "@/lib/bible-data/voice-index"

const NO_CELLS: readonly VoiceCellInput[] = []

/** One input per cell id, by position; empty while `enabled` is false. */
export function useVerseCells(
  cellStore: CellStore,
  cellIds: readonly string[],
  version: number,
  enabled: boolean,
): readonly VoiceCellInput[] {
  // One "type<TAB>ref" line per cell.
  const cellsKey = useMemo(
    () =>
      enabled
        ? readAtVersion(version, () =>
            cellIds
              .map((id) => {
                const view = cellStore.getCellView(id)
                return view ? `${view.type}\t${view.group}` : "\t"
              })
              .join("\n"),
          )
        : "",
    [enabled, version, cellIds, cellStore],
  )
  return useMemo<readonly VoiceCellInput[]>(
    () =>
      cellsKey === ""
        ? NO_CELLS
        : cellsKey.split("\n").map((line) => {
            const tab = line.indexOf("\t")
            return { type: line.slice(0, tab), ref: line.slice(tab + 1) }
          }),
    [cellsKey],
  )
}
