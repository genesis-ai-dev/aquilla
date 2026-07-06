// Skeleton-aware bilingual XLIFF 1.2 exporter.
//
// Differs from the legacy exportXliff (untouched, C7) in three ways:
//   1. Inline tags: when a cell carries the importer's XliffSegmentMeta
//      (metadata.xliff), the exported <source> re-emits the original inline
//      markup (g/x/bpt/ept/ph…) verbatim instead of flattened text.
//   2. Targets: an unedited target (translated === source text, or no edit
//      since import) re-emits the imported target skeleton; an edited target
//      is emitted as its text (inline-tag placement in edited targets is a
//      documented gap — Matecat solves it with Guess Tags, out of scope here).
//   3. States: segment status maps to target/@state per Matecat's documented
//      convention — empty → "new", unvalidated → "translated",
//      validated → "final".
import type { CellData } from "@/hooks/useCells"
import { fragmentText, type XliffSegmentMeta } from "@/lib/parsers/xliff"

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")

interface MetaCell extends CellData {
  metadata?: { xliff?: XliffSegmentMeta }
}



export const statusToXliffState = (cell: Pick<CellData, "status" | "translated">): string => {
  if (cell.status === "validated") return "final"
  return cell.translated.trim() ? "translated" : "new"
}

export function exportXliff12Structured(
  cells: CellData[],
  sourceLanguage = "en",
  targetLanguage = "en",
): Blob {
  const seen = new Map<string, number>()
  const units = (cells as MetaCell[]).map((c, i) => {
    const meta = c.metadata?.xliff
    let id = meta?.unitId ?? c.group ?? c.id ?? `u${i + 1}`
    const dup = seen.get(id)
    seen.set(id, (dup ?? 0) + 1)
    if (dup) id = `${id}-${dup + 1}` // XLIFF requires unique trans-unit ids per file

    const sourceXml = meta?.sourceXml || xmlEscape(c.original)
    const translated = c.translated.trim()
    // A target whose text still matches the imported skeleton's text (or a
    // copy-source draft matching the source skeleton) re-emits that skeleton,
    // keeping inline tags; an edited target is emitted as its text. Empty
    // target stays an empty element (valid per the 1.2 schema).
    let targetXml = translated ? xmlEscape(translated) : ""
    if (meta) {
      if (meta.targetXml != null && translated === fragmentText(meta.targetXml)) {
        targetXml = meta.targetXml
      } else if (translated === fragmentText(meta.sourceXml)) {
        targetXml = meta.sourceXml
      }
    }
    const state = statusToXliffState(c)
    const note = c.context && c.context !== id ? `\n        <note>${xmlEscape(c.context)}</note>` : ""
    return [
      `      <trans-unit id="${xmlEscape(id)}">`,
      `        <source>${sourceXml}</source>`,
      `        <target state="${state}">${targetXml}</target>${note}`,
      `      </trans-unit>`,
    ].join("\n")
  })

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">`,
    `  <file source-language="${xmlEscape(sourceLanguage)}" target-language="${xmlEscape(targetLanguage)}" datatype="plaintext" original="export">`,
    `    <body>`,
    ...units,
    `    </body>`,
    `  </file>`,
    `</xliff>`,
    ``,
  ].join("\n")

  return new Blob([xml], { type: "application/xliff+xml;charset=utf-8" })
}
