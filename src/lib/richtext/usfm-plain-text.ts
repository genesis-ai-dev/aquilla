// Shared helpers for mapping between the editor's ProseMirror document and the
// plain-text USFM that everything OUTSIDE the editor (sync `value`, rule
// infractions, terminology matches, audio timings) is computed against.
//
// FRO: footnotes used to live inline in the doc as raw `\f...\f*` TEXT, hidden
// with CSS. They are now a dedicated atomic inline node (see footnote-node.ts)
// so they can be selected as a single unit like in Word. The node contributes
// ZERO text characters to ProseMirror's own text model but its `raw` attribute
// still represents N characters in the canonical plain `value`. These helpers
// bridge that gap so every offset computed against `value` keeps mapping to the
// right ProseMirror position even when the footnote is no longer plain text.

import type { Node as PMNode } from "@tiptap/pm/model"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"

/** ProseMirror node name for an inline USFM footnote marker. */
export const FOOTNOTE_NODE_NAME = "usfmFootnote"

/** The plain-text contribution of a node when serialising back to USFM. */
export function footnoteRawLeafText(node: PMNode): string {
  return node.type.name === FOOTNOTE_NODE_NAME ? ((node.attrs.raw as string) ?? "") : ""
}

export interface UsfmPlainTextMap {
  /** The full plain text of the doc, with footnote nodes expanded to their raw USFM. */
  text: string
  /** plainOffset → ProseMirror position. Footnote raw offsets collapse onto the node. */
  plainToPm: number[]
}

/**
 * Walk the doc in reading order, building both the plain text (footnote nodes
 * expanded to their raw `\f...\f*`) and an offset→position map. Footnote raw
 * characters all map onto the node's start position; the offset immediately
 * after the raw maps to the position just past the (atomic) node.
 *
 * For a footnote-free single-paragraph cell this is identical to the previous
 * text-node-only walk (`pm_pos = plain_offset + 1`).
 */
export function buildUsfmPlainTextMap(doc: PMNode): UsfmPlainTextMap {
  const plainToPm: number[] = []
  let text = ""
  let cursor = 0
  doc.descendants((node, pos) => {
    if (node.isText) {
      const value = node.text ?? ""
      for (let i = 0; i <= value.length; i++) plainToPm[cursor + i] = pos + i
      text += value
      cursor += value.length
      return true
    }
    if (node.type.name === FOOTNOTE_NODE_NAME) {
      const raw = (node.attrs.raw as string) ?? ""
      for (let i = 0; i < raw.length; i++) plainToPm[cursor + i] = pos
      cursor += raw.length
      plainToPm[cursor] = pos + node.nodeSize
      text += raw
      return false
    }
    return true
  })
  if (!(cursor in plainToPm)) plainToPm[cursor] = doc.content.size
  return { text, plainToPm }
}

/**
 * Inverse of the map for a single position: ProseMirror position → plain-text
 * offset (counting footnote raw length). Mirrors `buildUsfmPlainTextMap`.
 */
export function pmToPlainOffset(doc: PMNode, position: number): number {
  let plain = 0
  let done = false
  doc.descendants((node, pos) => {
    if (done) return false
    if (node.isText) {
      const len = node.text?.length ?? 0
      if (position <= pos) {
        done = true
        return false
      }
      if (position <= pos + len) {
        plain += position - pos
        done = true
        return false
      }
      plain += len
      return true
    }
    if (node.type.name === FOOTNOTE_NODE_NAME) {
      if (position <= pos) {
        done = true
        return false
      }
      plain += ((node.attrs.raw as string) ?? "").length
      return false
    }
    return true
  })
  return plain
}

/**
 * Convert any HTML/plain string that may contain raw `\f...\f*` TEXT into HTML
 * where each footnote becomes `<span data-usfm-footnote="...">`, so TipTap's
 * parser builds proper footnote nodes on load. Existing footnote spans (from a
 * previous editor serialisation) are left untouched — they carry their raw in
 * the attribute and have no text content to re-match.
 */
export function injectFootnoteSpans(html: string): string {
  if (typeof document === "undefined") return html
  if (!html.includes("\\f")) return html
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, "text/html")
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let current: Node | null
  while ((current = walker.nextNode())) textNodes.push(current as Text)

  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? ""
    if (!value.includes("\\f")) continue
    const footnotes = extractUsfmFootnotes(value)
    if (footnotes.length === 0) continue

    const fragment = doc.createDocumentFragment()
    let cursor = 0
    for (const footnote of footnotes) {
      if (footnote.index > cursor) {
        fragment.appendChild(doc.createTextNode(value.slice(cursor, footnote.index)))
      }
      const span = doc.createElement("span")
      span.setAttribute("data-usfm-footnote", footnote.raw)
      fragment.appendChild(span)
      cursor = footnote.index + footnote.raw.length
    }
    if (cursor < value.length) {
      fragment.appendChild(doc.createTextNode(value.slice(cursor)))
    }
    textNode.parentNode?.replaceChild(fragment, textNode)
  }

  return doc.body.innerHTML
}
