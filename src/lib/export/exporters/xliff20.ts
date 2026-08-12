// Bilingual XLIFF 2.0 exporter (OASIS xliff_core_2.0.xsd-valid).
//
// Cells imported from an XLIFF 2.0 file carry XliffSegmentMeta and are
// re-grouped into their original <unit>/<segment> structure with inline tags
// (pc/ph…) re-emitted verbatim in <source>. Cells from any other origin get
// one <unit> per cell. Segment states use only the spec enum
// (initial | translated | reviewed | final) — Matecat documents that custom
// state values are ignored, so none are emitted.
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { fragmentText, type XliffSegmentMeta } from "@/lib/parsers/xliff"

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

/** XLIFF 2.0 ids are NMTOKENs: no whitespace. Sanitize + dedupe. */
const nmtoken = (raw: string, fallback: string): string => {
  const cleaned = raw.replace(/[^\w.:-]+/g, "_")
  return cleaned.length > 0 ? cleaned : fallback
}

export const statusToXliff20State = (cell: Pick<CellData, "status" | "translated">): string => {
  if (cell.status === "validated") return "final"
  return cell.translated.trim() ? "translated" : "initial"
}

interface MetaCell extends CellData {
  metadata?: { xliff?: XliffSegmentMeta }
}

export function exportXliff20(cells: CellData[], sourceLanguage = "en", targetLanguage = "fr"): Blob {
  // Group cells by originating unit (metadata) or one unit per cell.
  interface Seg {
    segId: string
    sourceXml: string
    targetXml: string
    state: string
  }
  const unitOrder: string[] = []
  const unitSegs = new Map<string, Seg[]>()
  const unitIds = new Map<string, string>() // raw key → sanitized unique id
  const usedIds = new Set<string>()

  const metaCells = cells as MetaCell[]
  metaCells.forEach((c, i) => {
    const meta = c.metadata?.xliff
    const rawUnit = meta?.version === "2.0" ? meta.unitId : `u-${c.group || c.id || i + 1}`
    if (!unitSegs.has(rawUnit)) {
      unitSegs.set(rawUnit, [])
      unitOrder.push(rawUnit)
      let sid = nmtoken(rawUnit, `u${i + 1}`)
      let n = 2
      while (usedIds.has(sid)) sid = `${nmtoken(rawUnit, `u${i + 1}`)}-${n++}`
      usedIds.add(sid)
      unitIds.set(rawUnit, sid)
    }
    const segs = unitSegs.get(rawUnit) as Seg[]
    const translated = c.translated.trim()
    const sourceXml = meta?.version === "2.0" && meta.sourceXml ? meta.sourceXml : xmlEscape(effectiveSourceText(c))
    let targetXml = translated ? xmlEscape(translated) : ""
    if (meta?.version === "2.0") {
      if (meta.targetXml != null && translated === fragmentText(meta.targetXml)) {
        targetXml = meta.targetXml
      } else if (translated === fragmentText(meta.sourceXml)) {
        targetXml = meta.sourceXml
      }
    }
    segs.push({
      segId: nmtoken(meta?.segId ?? `s${segs.length + 1}`, `s${segs.length + 1}`),
      sourceXml,
      targetXml,
      state: statusToXliff20State(c),
    })
  })

  const unitsXml = unitOrder.map((rawUnit) => {
    const segs = unitSegs.get(rawUnit) as Seg[]
    const segUsed = new Set<string>()
    const segsXml = segs
      .map((s) => {
        let sid = s.segId
        let n = 2
        while (segUsed.has(sid)) sid = `${s.segId}-${n++}`
        segUsed.add(sid)
        const target = s.targetXml ? `\n        <target>${s.targetXml}</target>` : ""
        return `      <segment id="${sid}" state="${s.state}">\n        <source>${s.sourceXml}</source>${target}\n      </segment>`
      })
      .join("\n")
    return `    <unit id="${unitIds.get(rawUnit)}">\n${segsXml}\n    </unit>`
  })

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="${xmlEscape(sourceLanguage)}" trgLang="${xmlEscape(targetLanguage)}">`,
    `  <file id="f1">`,
    ...unitsXml,
    `  </file>`,
    `</xliff>`,
    ``,
  ].join("\n")

  return new Blob([xml], { type: "application/xliff+xml;charset=utf-8" })
}
