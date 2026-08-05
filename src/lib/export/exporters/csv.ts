// Bilingual CSV exporter: RFC 4180-compliant. Fields are quoted only when they
// contain a comma, double-quote, or newline.
// SWARM-TODO(export): lossy — inline markup (bold, italics, footnote markers)
// is stripped; only plain text values are emitted.
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"

function csvField(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function exportCsv(cells: CellData[]): Blob {
  const header = "id,source,target"
  const rows = cells.map((c) => {
    const id = csvField(c.group || c.id)
    const src = csvField(effectiveSourceText(c))
    const tgt = csvField(c.translated)
    return `${id},${src},${tgt}`
  })
  return new Blob([[header, ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" })
}
