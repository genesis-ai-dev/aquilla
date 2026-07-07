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

// Structure-preserving plain-text exporter for CAT round-trip use. Cells that
// share a `group` are sub-segments of one source paragraph (see
// splitIntoSegments in the plaintext importer) and are rejoined with a space;
// paragraphs are separated by a blank line, matching the importer's
// blank-line paragraph split so import→export→import is stable. Untranslated
// cells fall back to source (Matecat-style draft export).
// exportPlainText above is untouched (C7: existing output stays byte-identical).
export function exportPlainTextStructured(cells: CellData[]): Blob {
  const paragraphs: string[] = []
  let currentGroup: string | null = null
  for (const c of cells) {
    const text = (c.translated || c.original || "").trim()
    if (!text) continue
    if (c.group && c.group === currentGroup && paragraphs.length > 0) {
      paragraphs[paragraphs.length - 1] += ` ${text}`
    } else {
      paragraphs.push(text)
      currentGroup = c.group || null
    }
  }
  const body = paragraphs.length ? `${paragraphs.join("\n\n")}\n` : ""
  return new Blob([body], { type: "text/plain;charset=utf-8" })
}
