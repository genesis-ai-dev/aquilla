import type { ExportCell } from "@/lib/store/file-doc"

function cueText(cell: ExportCell): string {
  return cell.translated.trim() ? cell.translated : cell.original
}

export function rebuildVtt(cells: ExportCell[]): string {
  if (cells.length === 0) return "WEBVTT"
  const blocks: string[] = ["WEBVTT"]
  for (const cell of cells) {
    blocks.push(`${cell.context}\n${cueText(cell)}`)
  }
  return blocks.join("\n\n")
}

export function rebuildSrt(cells: ExportCell[]): string {
  if (cells.length === 0) return ""
  const blocks: string[] = []
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    blocks.push(`${i + 1}\n${cell.context}\n${cueText(cell)}`)
  }
  return blocks.join("\n\n")
}
