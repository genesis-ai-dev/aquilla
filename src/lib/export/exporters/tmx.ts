// TMX 1.4b exporter — Translation Memory eXchange format.
// SWARM-TODO(export): lossy — inline formatting (bold, italics, footnotes) is
// not expressed as TMX <ph>/<bpt>/<ept> elements; plain-text values only. A
// proper round-trip would require inline-element extraction from source markup.
import type { CellData } from "@/hooks/useCells"

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function exportTmx(cells: CellData[], sourceLanguage = "und", targetLanguage = "und"): Blob {
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")
  const tus = cells
    .filter((c) => c.original.trim() && c.translated.trim())
    .map((c) => {
      const tuid = xmlEscape(c.group || c.id)
      const src = xmlEscape(c.original)
      const tgt = xmlEscape(c.translated)
      return [
        `    <tu tuid="${tuid}">`,
        `      <tuv xml:lang="${xmlEscape(sourceLanguage)}"><seg>${src}</seg></tuv>`,
        `      <tuv xml:lang="${xmlEscape(targetLanguage)}"><seg>${tgt}</seg></tuv>`,
        `    </tu>`,
      ].join("\n")
    })

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE tmx SYSTEM "tmx14.dtd">`,
    `<tmx version="1.4">`,
    `  <header creationtool="Aquilla" creationtoolversion="1.0" datatype="PlainText"`,
    `          segtype="sentence" adminlang="en-US" srclang="${xmlEscape(sourceLanguage)}"`,
    `          o-tmf="export" creationdate="${now}"/>`,
    `  <body>`,
    ...tus,
    `  </body>`,
    `</tmx>`,
  ].join("\n")

  return new Blob([xml], { type: "application/x-tmx+xml;charset=utf-8" })
}
