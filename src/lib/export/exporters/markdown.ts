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

// Structure-preserving markdown exporter for CAT round-trip use. Reconstructs
// the block markup the importer parsed away: heading level from the cell's
// "Heading N" context, "- " for list items, "> " for blockquotes. Cells that
// share a `group` are sub-segments of one block and are rejoined with a
// space. Known, accepted loss: ordered lists re-emit as unordered ("- ") —
// the importer does not record list numbering. No anchor comments are emitted
// (they would parse back as paragraph text on re-import).
// exportMarkdown above is untouched (C7: existing output stays byte-identical).
export function exportMarkdownStructured(cells: CellData[]): Blob {
  interface Block {
    prefix: string
    texts: string[]
  }
  const blocks: Block[] = []
  let currentGroup: string | null = null
  for (const c of cells) {
    const text = (c.translated || c.original || "").trim()
    if (!text) continue
    if (c.group && c.group === currentGroup && blocks.length > 0) {
      blocks[blocks.length - 1].texts.push(text)
      continue
    }
    currentGroup = c.group || null
    let prefix = ""
    if (c.type === "heading") {
      const level = Number(/^Heading (\d)$/.exec(c.context ?? "")?.[1] ?? 1)
      prefix = `${"#".repeat(Math.min(6, Math.max(1, level)))} `
    } else if (c.type === "list") {
      prefix = "- "
    } else if (c.type === "blockquote") {
      prefix = "> "
    }
    blocks.push({ prefix, texts: [text] })
  }
  const body = blocks.map((b) => `${b.prefix}${b.texts.join(" ")}`).join("\n\n")
  return new Blob([body ? `${body}\n` : ""], { type: "text/markdown;charset=utf-8" })
}
