// Best-effort default reference for a new footnote, derived from whatever
// canonical-ref-shaped text the cell carries. Extracted from EditorTable
// (AQU-646) so the media-lens detail pane's footnote dialog shares it.

import type { CellData } from "@/hooks/useCells"

export function defaultFootnoteRef(cell: CellData): string {
  const candidates = [
    ...(cell.globalReferences ?? []),
    cell.group,
    cell.context,
    cell.cellLabel,
  ].filter(Boolean)

  for (const candidate of candidates) {
    const text = String(candidate).trim()
    const canonicalRef = text.match(/\b[1-3]?\s?[A-Z][A-Z0-9]{1,4}\s+\d+:\d+(?:[-–]\d+)?\b/i)
    if (canonicalRef) return canonicalRef[0].replace(/\s+/g, " ")
  }

  for (const candidate of candidates) {
    const text = String(candidate).trim()
    const verseOnlyRef = text.match(/\b\d+:\d+(?:[-–]\d+)?\b/)
    if (verseOnlyRef) return verseOnlyRef[0]
  }

  return ""
}
