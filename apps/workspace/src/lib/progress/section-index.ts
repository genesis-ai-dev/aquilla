import type { CellData } from "@/hooks/useCells"

export interface SectionInfo {
  label: string
  cellIds: string[]
}

/** Extract the "BOOK CH" prefix from a verse ref like "LUK 1:1" or a range like "LUK 1:1-2". */
function sectionLabelFromRef(ref: string): string {
  const colonIdx = ref.indexOf(":")
  return (colonIdx >= 0 ? ref.slice(0, colonIdx) : ref).trim()
}

type IndexableCell = Pick<CellData, "id" | "group" | "section" | "globalReferences">

/**
 * Group cells into sidebar sections. Label derivation, in order:
 *   1. `globalReferences[0]` → "BOOK CH" prefix (scripture cells)
 *   2. `section` if non-empty (legacy docs written before globalReferences existed)
 *   3. "Ungrouped" (untagged cells)
 *
 * `group` is intentionally NOT used as a fallback: for text-split content it holds an opaque
 * UUID tying split segments to their source chunk, not a user-facing label.
 *
 * Files with zero sectionable cells return an empty array so the sidebar skips the sub-list
 * entirely (no "Loading…" flash, no UUID leakage).
 */
export function buildSectionIndex(cells: IndexableCell[]): SectionInfo[] {
  const byLabel = new Map<string, SectionInfo>()
  let hasAnyTaggedCell = false

  for (const cell of cells) {
    const firstRef = cell.globalReferences?.find((r) => r && r.trim().length > 0)
    let label: string
    if (firstRef) {
      label = sectionLabelFromRef(firstRef)
      hasAnyTaggedCell = true
    } else if (cell.section && cell.section.trim()) {
      label = cell.section.trim()
      hasAnyTaggedCell = true
    } else {
      label = "Ungrouped"
    }

    let section = byLabel.get(label)
    if (!section) {
      section = { label, cellIds: [] }
      byLabel.set(label, section)
    }
    section.cellIds.push(cell.id)
  }

  // No cell has a real section/ref tag → this file has no meaningful sub-structure.
  if (!hasAnyTaggedCell) return []

  return Array.from(byLabel.values())
}
