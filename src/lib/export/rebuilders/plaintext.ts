import type { ExportCell } from "@/lib/store/file-doc"

export function rebuildPlaintext(cells: ExportCell[]): string {
  const groups: { groupId: string; cells: ExportCell[] }[] = []
  const groupIndex = new Map<string, number>()

  for (const cell of cells) {
    const idx = groupIndex.get(cell.group)
    if (idx === undefined) {
      groupIndex.set(cell.group, groups.length)
      groups.push({ groupId: cell.group, cells: [cell] })
    } else {
      groups[idx].cells.push(cell)
    }
  }

  const paragraphs: string[] = []
  for (const { cells } of groups) {
    const parts = cells.map((c) => (c.translated.trim() ? c.translated : c.original))
    paragraphs.push(parts.join(" "))
  }

  return paragraphs.join("\n\n")
}
