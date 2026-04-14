import type { ExportCell } from "@/lib/store/file-doc"

export function rebuildMarkdown(cells: ExportCell[]): string {
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

  const blocks: string[] = []
  for (const { cells: groupCells } of groups) {
    const first = groupCells[0]
    const text = groupCells
      .map((c) => (c.translated.trim() ? c.translated : c.original))
      .join(" ")

    switch (first.type) {
      case "heading": {
        const match = first.context.match(/Heading\s+(\d+)/)
        const level = match ? parseInt(match[1]) : 1
        const hashes = "#".repeat(Math.max(1, Math.min(6, level)))
        blocks.push(`${hashes} ${text}`)
        break
      }
      case "list":
        blocks.push(`- ${text}`)
        break
      case "blockquote":
        blocks.push(`> ${text}`)
        break
      default:
        blocks.push(text)
    }
  }

  return blocks.join("\n\n")
}
