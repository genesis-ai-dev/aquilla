// Plain-text exporter: one translated segment per line.
// SWARM-TODO(export): paragraph/section structure is not preserved — only the
// translated text value of each cell is emitted; USFM markers, poetry layout,
// and other structural markup are all lost.
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { plainTextStructuredBody } from "@/lib/export/plaintext-structured"

export function exportPlainText(cells: CellData[]): Blob {
  const lines = cells
    .filter((c) => c.translated.trim() !== "")
    .map((c) => c.translated.trim())
  return new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" })
}

// Structure-preserving plain-text exporter for CAT round-trip use. The
// paragraph rules live in plaintext-structured.ts, shared with the
// sync-worker's `.txt` export route (AQU-1472) so both build the same bytes.
// exportPlainText above is untouched (C7: existing output stays byte-identical).
export function exportPlainTextStructured(cells: CellData[]): Blob {
  const body = plainTextStructuredBody(
    cells.map((c) => ({ translated: c.translated, source: effectiveSourceText(c), group: c.group })),
  )
  return new Blob([body], { type: "text/plain;charset=utf-8" })
}
