import type { CheckingRow } from "./api"

/** One passage in reading order, with its position in the flat passage list. */
export interface CheckingSegment { row: CheckingRow; index: number }
export interface CheckingBlock { kind: "heading" | "paragraph"; segments: CheckingSegment[] }
export interface CheckingSection { fileId: string; fileName: string; blocks: CheckingBlock[] }

/** Lays the shared passages out as a document. Paragraphs break only where the
 * file itself marks one (`paragraphStart`) and headings stand alone; a file
 * with no structure reads as one continuous paragraph. */
export function checkingDocument(rows: CheckingRow[]): CheckingSection[] {
  const sections: CheckingSection[] = []
  rows.forEach((row, index) => {
    let section = sections.at(-1)
    if (section?.fileId !== row.fileId) {
      section = { fileId: row.fileId, fileName: row.fileName, blocks: [] }
      sections.push(section)
    }
    const segment = { row, index }
    const last = section.blocks.at(-1)
    if (row.type === "heading") section.blocks.push({ kind: "heading", segments: [segment] })
    else if (last?.kind === "paragraph" && !row.paragraphStart) last.segments.push(segment)
    else section.blocks.push({ kind: "paragraph", segments: [segment] })
  })
  return sections
}

/** The short marker shown before a passage in running text: the last part of
 * its display label ("MRK 1:2" → "1:2", "Unit 3" → "3"). */
export function segmentMarker(label: string): string {
  return label.trim().split(/\s+/).at(-1) ?? ""
}
