// Plain-text exporter: one translated segment per line.
// SWARM-TODO(export): paragraph/section structure is not preserved — only the
// translated text value of each cell is emitted; USFM markers, poetry layout,
// and other structural markup are all lost.
import type { CellData } from "@/hooks/useCells"

export function exportPlainText(cells: CellData[]): Blob {
  const lines = cells
    .filter((c) => c.translated.trim() !== "")
    .map((c) => c.translated.trim())
  return new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" })
}
