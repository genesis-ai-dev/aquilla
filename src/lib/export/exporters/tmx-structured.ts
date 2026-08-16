// Skeleton-aware TMX 1.4b exporter with Matecat-style "with or without tags"
// variants. Cells imported from TMX carry TmxSegmentMeta and re-emit their
// inline markup (bpt/ept/ph/it/hi) verbatim when the text is unedited;
// `keepTags: false` strips to plain text (Matecat "Export TMX … without tags").
// The legacy exportTmx stays untouched (C7).
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import type { TmxSegmentMeta } from "@/lib/parsers/tmx"
import { fragmentText } from "@/lib/parsers/xliff"

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export interface TmxExportOptions {
  /** true (default) re-emits imported inline tags; false strips to plain text. */
  keepTags?: boolean
}

interface MetaCell extends CellData {
  metadata?: { tmx?: TmxSegmentMeta }
}

export function exportTmxStructured(
  cells: CellData[],
  sourceLanguage = "en-US",
  targetLanguage = "fr-FR",
  options: TmxExportOptions = {},
): Blob {
  const keepTags = options.keepTags !== false
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")
  const tus = (cells as MetaCell[])
    // Untranscribed media cells drop out (see exportTmx's note) — a filename
    // is not a source segment.
    .filter((c) => effectiveSourceText(c).trim() && c.translated.trim())
    .map((c) => {
      const meta = c.metadata?.tmx
      const tuid = xmlEscape(meta?.tuid || c.group || c.id)
      const srcLang = xmlEscape(meta?.srcLang || sourceLanguage)
      const tgtLang = xmlEscape(meta?.tgtLang || targetLanguage)
      let src = xmlEscape(effectiveSourceText(c).trim())
      let tgt = xmlEscape(c.translated.trim())
      if (keepTags && meta) {
        if (effectiveSourceText(c).trim() === fragmentText(meta.srcSegXml)) src = meta.srcSegXml
        if (meta.tgtSegXml != null && c.translated.trim() === fragmentText(meta.tgtSegXml)) {
          tgt = meta.tgtSegXml
        }
      }
      return [
        `    <tu tuid="${tuid}">`,
        `      <tuv xml:lang="${srcLang}"><seg>${src}</seg></tuv>`,
        `      <tuv xml:lang="${tgtLang}"><seg>${tgt}</seg></tuv>`,
        `    </tu>`,
      ].join("\n")
    })

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE tmx SYSTEM "tmx14.dtd">`,
    `<tmx version="1.4">`,
    `  <header creationtool="Aquilla" creationtoolversion="1.0" datatype="PlainText"`,
    `          segtype="sentence" adminlang="en-US" srclang="${xmlEscape(sourceLanguage)}"`,
    `          o-tmf="aquilla" creationdate="${now}"/>`,
    `  <body>`,
    ...tus,
    `  </body>`,
    `</tmx>`,
    ``,
  ].join("\n")

  return new Blob([xml], { type: "application/x-tmx+xml;charset=utf-8" })
}
