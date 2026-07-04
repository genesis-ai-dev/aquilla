// HTML importer/exporter pair for CAT round-trip use.
//
// Import: `extractHtmlStrings` parses the document with the platform DOMParser
// (happy-dom in tests, the real browser in prod) and emits one
// TranslatableString per text-bearing block element in document order.
//
// Export: `exportHtml` is skeleton injection — it re-parses the ORIGINAL html,
// walks it with the exact same block-selection logic (guaranteed same order),
// and replaces the Nth matched block's text with the Nth cell's translation.
import { v4 as uuid } from "uuid"
import type { CellData } from "@/hooks/useCells"
import type { CellType, TranslatableString } from "./types"

/** Block elements that carry translatable text. */
const BLOCK_TAGS = new Set([
  "title",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p",
  "li",
  "blockquote",
  "td", "th",
  "figcaption",
  "dt", "dd",
])

/** Elements whose subtrees are never translatable. */
const SKIP_TAGS = new Set(["script", "style", "noscript"])

/** Collapse whitespace runs and trim — the "visible text" normalization. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** True when `el` has a descendant (not itself) whose tag is in the block set. */
function hasBlockDescendant(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) continue
    if (BLOCK_TAGS.has(tag)) return true
    if (hasBlockDescendant(child)) return true
  }
  return false
}

/**
 * Walk the DOM once and collect matched block elements in document order.
 * A block-set element is emitted only when it contains NO block-set element
 * itself (outermost-leaf rule) — e.g. a `<li>` wrapping a `<p>` yields the
 * `<p>`, never both. Elements with no visible text are skipped, so import and
 * export index the exact same element list.
 */
function collectBlocks(el: Element, out: Element[]): void {
  const tag = el.tagName.toLowerCase()
  if (SKIP_TAGS.has(tag)) return
  if (BLOCK_TAGS.has(tag) && !hasBlockDescendant(el)) {
    if (collapseWhitespace(el.textContent ?? "")) out.push(el)
    return
  }
  for (const child of Array.from(el.children)) collectBlocks(child, out)
}

function matchedBlocks(doc: Document): Element[] {
  const out: Element[] = []
  const root = doc.documentElement
  if (root) collectBlocks(root, out)
  return out
}

function classify(tag: string): { type: CellType; context: string } {
  const heading = /^h([1-6])$/.exec(tag)
  if (heading) return { type: "heading", context: `Heading ${heading[1]}` }
  switch (tag) {
    case "title":
      return { type: "heading", context: "Title" }
    case "li":
      return { type: "list", context: "List item" }
    case "blockquote":
      return { type: "blockquote", context: "Blockquote" }
    case "td":
    case "th":
      return { type: "text", context: "Table cell" }
    case "figcaption":
      return { type: "text", context: "Figure caption" }
    case "dt":
      return { type: "text", context: "Definition term" }
    case "dd":
      return { type: "text", context: "Definition description" }
    default: // "p"
      return { type: "text", context: "Paragraph" }
  }
}

export function extractHtmlStrings(content: string): TranslatableString[] {
  const doc = new DOMParser().parseFromString(content, "text/html")
  const results: TranslatableString[] = []

  for (const [index, el] of matchedBlocks(doc).entries()) {
    const original = collapseWhitespace(el.textContent ?? "")
    const { type, context } = classify(el.tagName.toLowerCase())
    // Keep inline markup (<strong>, <a>, …) only when the element actually
    // contains child elements — plain-text blocks carry no originalHtml.
    const html = collapseWhitespace(el.innerHTML)
    results.push({
      id: uuid(),
      original,
      originalHtml: el.children.length > 0 && html !== original ? html : undefined,
      translated: "",
      context,
      group: uuid(),
      type,
      sourceLocation: { file: "html", blockPath: String(index) },
    })
  }

  return results
}

/**
 * Skeleton injection: re-parse the original HTML, walk it with the same
 * block-selection logic as `extractHtmlStrings` (same elements, same order),
 * and set the Nth matched element's text to the Nth cell's translation
 * (falling back to the cell's source text when the translation is empty).
 * Blocks beyond the cell list are left unchanged.
 *
 * KNOWN LOSS: setting `textContent` drops inline markup (<strong>, <a>, …)
 * INSIDE translated blocks — the translation is plain text, so there is no
 * mapping back onto the original inline tags. Matecat-style tag placement is
 * out of scope. The surrounding tag structure (lists, tables, headings,
 * attributes) is fully preserved.
 */
export function exportHtml(originalHtml: string, cells: CellData[]): Blob {
  const doc = new DOMParser().parseFromString(originalHtml, "text/html")
  const blocks = matchedBlocks(doc)

  for (let i = 0; i < blocks.length && i < cells.length; i++) {
    const cell = cells[i]
    blocks[i].textContent = cell.translated.trim() ? cell.translated : cell.original
  }

  const hadDoctype = originalHtml.toLowerCase().includes("<!doctype")
  const serialized = doc.documentElement?.outerHTML ?? ""
  const html = hadDoctype ? `<!DOCTYPE html>\n${serialized}` : serialized
  return new Blob([html], { type: "text/html;charset=utf-8" })
}
