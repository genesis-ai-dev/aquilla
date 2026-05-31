// Markdown exporter: translated cells with `group` as heading anchors.
// SWARM-TODO(export): only flat segment-per-paragraph output; USFM heading
// levels, poetry (\q), tables, and footnotes are not preserved.
import type { CellData } from "@/hooks/useCells"

export function exportMarkdown(cells: CellData[]): Blob {
  const parts: string[] = []
  for (const c of cells) {
    if (!c.translated.trim()) continue
    // Use canonical ref (group) as an anchor comment if present
    if (c.group) {
      parts.push(`<!-- ${c.group} -->`)
    }
    parts.push(c.translated.trim())
    parts.push("")
  }
  return new Blob([parts.join("\n")], { type: "text/markdown;charset=utf-8" })
}
