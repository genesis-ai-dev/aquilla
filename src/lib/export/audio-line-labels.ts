// AQU-2073: what the Export dialog calls a line when it lists the lines that
// would ship an unvalidated recording.
//
// A line with a human reference ("JHN 6:5", a script's "B4") is called by it —
// the name the editor's gutter and the selection bar already use. Any other
// line is "L" and its place in the file, counted the way the by-line export
// numbers its files (time order, every line counted, 1-based), so the pill "L3"
// and the file "…_L0003_…" in the zip are the same line.

import { namedCellRef } from "@/lib/cell-named-ref"

interface LabelledLine {
  id: string
  startTime?: number | null
  context?: string | null
  globalReferences?: readonly string[] | null
}

/** Every line's label, by id. */
export function audioLineLabels(cells: readonly LabelledLine[]): Map<string, string> {
  // Stable sort: lines with no time keep their file order after the timed ones,
  // as `collectPerLineClips` orders them.
  const ordered = [...cells].sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity))
  const labels = new Map<string, string>()
  ordered.forEach((cell, i) => {
    labels.set(cell.id, namedCellRef(cell) ?? `L${i + 1}`)
  })
  return labels
}
