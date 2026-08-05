// Generic bilingual XLIFF 1.2 exporter.
// SWARM-TODO(export): lossy — inline formatting (bold, italics, footnotes) is
// not expressed as XLIFF <g>/<x> elements; plain-text values only. A proper
// round-trip would require inline-element extraction from the source markup.
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

export function exportXliff(cells: CellData[], sourceLanguage = "und", targetLanguage = "und"): Blob {
  const transUnits = cells.map((c) => {
    const id = xmlEscape(c.group || c.id)
    const src = xmlEscape(effectiveSourceText(c))
    const tgt = xmlEscape(c.translated)
    const state = c.status === "validated" ? "final" : c.translated.trim() ? "translated" : "new"
    return [
      `    <trans-unit id="${id}">`,
      `      <source>${src}</source>`,
      `      <target state="${state}">${tgt}</target>`,
      `      <note>${id}</note>`,
      `    </trans-unit>`,
    ].join("\n")
  })

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">`,
    `  <file source-language="${xmlEscape(sourceLanguage)}" target-language="${xmlEscape(targetLanguage)}" datatype="plaintext" original="export">`,
    `    <body>`,
    ...transUnits,
    `    </body>`,
    `  </file>`,
    `</xliff>`,
  ].join("\n")

  return new Blob([xml], { type: "application/xliff+xml;charset=utf-8" })
}
