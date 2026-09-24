// Turning a SELECTION into calls, using the file's drafting units (AQU-1386).
//
// `packUnitsIntoCalls` packs units. This module is the bit in between: it works
// out which units the user's selection actually covers.
//
// The trap it exists to avoid: seams are properties of the FILE, not of the
// selection. If a translator multi-selects cells 1, 2, 5 and 6, there is no
// seam between 2 and 5 — they are not adjacent — and grouping them because
// cell 2 happens to end on a comma would send unrelated text into one prompt
// and produce exactly the "I clicked one cell and three changed" surprise the
// ticket forbids. So units are derived over the corpus, and the selection is
// cut into contiguous runs WITHIN those units.

import { draftingUnitsFor, type SeamStoreCell } from "./seam-store"
import { packUnitsIntoCalls, type DraftingUnit } from "./seams"

export type GroupingCell = SeamStoreCell

/**
 * Group `selection` (document order) into calls of at most `budget` cells.
 *
 * `corpus` is the file's full ordered cell list — the thing seams are defined
 * over. A selection cell that is not in the corpus is treated as its own unit:
 * unknown adjacency is not an excuse to guess.
 *
 * Returns arrays of cell ids, in selection order, losing nothing.
 */
export function packSelectionIntoCalls(
  selection: readonly GroupingCell[],
  corpus: readonly GroupingCell[],
  budget: number,
): string[][] {
  if (selection.length === 0 || budget <= 0) return []

  const units = draftingUnitsFor(corpus)
  const position = new Map<string, { unit: number; index: number }>()
  units.forEach((unit, unitIndex) => {
    unit.ids.forEach((id, index) => position.set(id, { unit: unitIndex, index }))
  })

  // Cut the selection wherever it stops being a contiguous run inside one unit.
  const runs: { ids: string[]; seamStrength: number[] }[] = []
  let current: { ids: string[]; seamStrength: number[] } | null = null
  let previous: { unit: number; index: number } | null = null

  for (const cell of selection) {
    const here = position.get(cell.id) ?? null
    const continuesRun =
      here !== null
      && previous !== null
      && here.unit === previous.unit
      && here.index === previous.index + 1

    if (continuesRun && current) {
      // The seam we are stepping over is the one between previous.index and
      // here.index inside that unit.
      current.seamStrength.push(units[here.unit].seamStrength[previous!.index] ?? 0)
      current.ids.push(cell.id)
    } else {
      if (current) runs.push(current)
      current = { ids: [cell.id], seamStrength: [] }
    }
    previous = here
  }
  if (current) runs.push(current)

  return packUnitsIntoCalls(runs as DraftingUnit[], budget)
}

/**
 * Today's behaviour, kept callable so the flag-off path is literally the old
 * code rather than a re-derivation of it: fixed slices of `budget` cells,
 * blind to meaning.
 */
export function fixedSlices<T>(cells: readonly T[], budget: number): T[][] {
  if (budget <= 0) return []
  const out: T[][] = []
  for (let i = 0; i < cells.length; i += budget) out.push(cells.slice(i, i + budget))
  return out
}
