import type { ExportCell } from "@/lib/store/file-doc"

// Convert TipTap-generated HTML (a subset: <p>, <b>, <i>, <u>, <s>, <code>, <br>)
// into markdown syntax. Unknown tags drop through as their text content.
export function htmlToMarkdown(html: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, "text/html")
  // Join paragraphs with "\n" since block separation is handled at a higher level.
  const parts: string[] = []
  for (const child of Array.from(doc.body.childNodes)) {
    parts.push(nodeToMarkdown(child))
  }
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim()
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue || ""
  if (node.nodeType !== 1) return ""
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  const inner = Array.from(el.childNodes).map(nodeToMarkdown).join("")

  switch (tag) {
    case "p":
      return inner + "\n"
    case "br":
      return "\n"
    case "b":
    case "strong":
      return inner ? `**${inner}**` : ""
    case "i":
    case "em":
      return inner ? `*${inner}*` : ""
    case "s":
    case "strike":
    case "del":
      return inner ? `~~${inner}~~` : ""
    case "code":
      return inner ? `\`${inner}\`` : ""
    case "u":
      // No standard markdown underline. Preserve as HTML tag for round-trip.
      return inner ? `<u>${inner}</u>` : ""
    default:
      return inner
  }
}

function getCellText(cell: ExportCell): string {
  if (cell.translated.trim()) {
    // Prefer rich text if available — preserves bold/italic/etc. as markdown syntax
    if (cell.translatedHtml) return htmlToMarkdown(cell.translatedHtml)
    return cell.translated
  }
  return cell.original
}

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
    const text = groupCells.map(getCellText).join(" ")

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
