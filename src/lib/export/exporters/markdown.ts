// Markdown exporter: translated cells with `group` as heading anchors.
// SWARM-TODO(export): only flat segment-per-paragraph output; USFM heading
// levels, poetry (\q), tables, and footnotes are not preserved.
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"

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
// "Heading N" context, list markers ("- ", or "N. " for ordered lists via the
// importer's metadata.md record), "> " for blockquotes. Cells that share a
// `group` are sub-segments of one block and are rejoined with a space.
// Consecutive list items of the same kind are grouped without blank lines so
// they re-import as one list. No anchor comments are emitted (they would
// parse back as paragraph text on re-import).
// exportMarkdown above is untouched (C7: existing output stays byte-identical).
interface MdMetaCell extends CellData {
  metadata?: { md?: { listKind?: "ordered" | "unordered"; index?: number } }
}

export function exportMarkdownStructured(cells: CellData[]): Blob {
  interface Block {
    prefix: string
    texts: string[]
    listKind?: "ordered" | "unordered"
  }
  const blocks: Block[] = []
  let currentGroup: string | null = null
  let orderedCounter = 0
  for (const c of cells as MdMetaCell[]) {
    const text = (c.translated || effectiveSourceText(c) || "").trim()
    if (!text) continue
    if (c.group && c.group === currentGroup && blocks.length > 0) {
      blocks[blocks.length - 1].texts.push(text)
      continue
    }
    currentGroup = c.group || null
    let prefix = ""
    let listKind: Block["listKind"]
    if (c.type === "heading") {
      const level = Number(/^Heading (\d)$/.exec(c.context ?? "")?.[1] ?? 1)
      prefix = `${"#".repeat(Math.min(6, Math.max(1, level)))} `
    } else if (c.type === "list") {
      listKind = c.metadata?.md?.listKind === "ordered" ? "ordered" : "unordered"
      if (listKind === "ordered") {
        const prev = blocks[blocks.length - 1]
        orderedCounter = prev?.listKind === "ordered" ? orderedCounter + 1 : 1
        prefix = `${orderedCounter}. `
      } else {
        prefix = "- "
      }
    } else if (c.type === "blockquote") {
      prefix = "> "
    }
    blocks.push({ prefix, texts: [text], ...(listKind ? { listKind } : {}) })
  }
  // Adjacent list items of the same kind join with single newlines (one list);
  // everything else separates with a blank line.
  let body = ""
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (i > 0) {
      const prev = blocks[i - 1]
      const sameList = b.listKind != null && prev.listKind === b.listKind
      body += sameList ? "\n" : "\n\n"
    }
    body += `${b.prefix}${b.texts.join(" ")}`
  }
  return new Blob([body ? `${body}\n` : ""], { type: "text/markdown;charset=utf-8" })
}
