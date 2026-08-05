// Bilingual TSV exporter: id⇥source⇥target, one row per cell.
// RFC-4180-compatible quoting: fields containing double-quotes, tabs,
// carriage-returns, or newlines are wrapped in double-quotes with internal
// double-quotes doubled (""). Simple fields (no special chars) are emitted
// bare so that consumers that don't handle RFC-4180 quoting still work.
// SWARM-TODO(export): lossy — inline markup (bold, italics, footnote markers)
// is stripped; only plain text values are emitted.
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"

/**
 * Quote a TSV field per RFC-4180 if it contains any character that would
 * otherwise corrupt tab-delimited parsing: double-quote, tab, CR, or LF.
 * Plain fields are returned unchanged.
 */
function tsvField(value: string): string {
  if (value.includes('"') || value.includes("\t") || value.includes("\r") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function exportTsv(cells: CellData[]): Blob {
  const header = "id\tsource\ttarget"
  const rows = cells.map((c) => {
    const id = tsvField(c.group || c.id)
    const src = tsvField(effectiveSourceText(c))
    const tgt = tsvField(c.translated)
    return `${id}\t${src}\t${tgt}`
  })
  return new Blob([[header, ...rows].join("\n")], { type: "text/tab-separated-values;charset=utf-8" })
}
