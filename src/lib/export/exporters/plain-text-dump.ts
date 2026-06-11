// Plain-text dump exporter: all translated segments, one per line, preceded by
// an optional title. Intended as a quick "I just need the content out" tool.
//
// What this preserves:
//   - The translated text of each segment (trimmed)
//   - Canonical refs (e.g. "GEN 1:1") as inline labels when includeRefs=true
//
// What this LOSES (FRO-276 honesty bar):
//   - All USFM / DOCX markers: footnotes (\f), cross-references (\x), poetry
//     layout (\q, \qr), character markup (\nd, \add, \wj, etc.)
//   - Paragraph structure and headings (\\s, \\p, \\ms)
//   - Back-translations and comments
//   - Validation state (who validated what)
//   - Empty/untranslated segments (skipped entirely)
//   - Any format-specific metadata (e.g. VTT timecodes, XLIFF states)
//
// This is NOT suitable as input to round-trip re-import. Use the USFM or DOCX
// round-trip export for that.

import type { CellData } from "@/hooks/useCells"

export interface PlainTextDumpOptions {
  /** Prepend a title line (e.g. project + file name). Leave empty to omit. */
  title?: string
  /** Whether to prefix each line with the canonical ref, e.g. "GEN 1:1  text". */
  includeRefs?: boolean
}

export function exportPlainTextDump(cells: CellData[], opts: PlainTextDumpOptions = {}): Blob {
  const { title, includeRefs = false } = opts
  const parts: string[] = []

  if (title?.trim()) {
    parts.push(title.trim())
    parts.push("") // blank separator
  }

  const translated = cells.filter((c) => c.translated.trim() !== "")
  for (const cell of translated) {
    if (includeRefs && cell.group) {
      parts.push(`${cell.group}\t${cell.translated.trim()}`)
    } else {
      parts.push(cell.translated.trim())
    }
  }

  return new Blob([parts.join("\n")], { type: "text/plain;charset=utf-8" })
}
