import type { CellData } from "@/hooks/useCells"

export interface SectionInfo {
  label: string
  cellIds: string[]
}

export function buildSectionIndex(cells: Pick<CellData, "id" | "group">[]): SectionInfo[] {
  const byLabel = new Map<string, SectionInfo>()
  for (const cell of cells) {
    const label = cell.group && cell.group.trim() ? cell.group : "Ungrouped"
    let section = byLabel.get(label)
    if (!section) {
      section = { label, cellIds: [] }
      byLabel.set(label, section)
    }
    section.cellIds.push(cell.id)
  }
  return Array.from(byLabel.values())
}
