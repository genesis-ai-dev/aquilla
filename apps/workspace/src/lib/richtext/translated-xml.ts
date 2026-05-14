import * as Y from "yjs"

// Extract plain text from a Y.XmlFragment.
// Paragraphs are joined with '\n'. Hard breaks become '\n'.
// All inline marks are stripped.
export function getPlainText(frag: Y.XmlFragment): string {
  const paragraphs: string[] = []
  for (let i = 0; i < frag.length; i++) {
    const node = frag.get(i)
    if (node instanceof Y.XmlElement) {
      paragraphs.push(extractElementText(node))
    } else if (node instanceof Y.XmlText) {
      paragraphs.push(extractXmlTextPlain(node))
    }
  }
  return paragraphs.join("\n")
}

function extractElementText(element: Y.XmlElement): string {
  const parts: string[] = []
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i)
    if (child instanceof Y.XmlElement) {
      if (child.nodeName === "br" || child.nodeName === "hardBreak") {
        parts.push("\n")
      } else {
        parts.push(extractElementText(child))
      }
    } else if (child instanceof Y.XmlText) {
      parts.push(extractXmlTextPlain(child))
    }
  }
  return parts.join("")
}

function extractXmlTextPlain(node: Y.XmlText): string {
  // Use toDelta to get raw text without attribute markup
  const delta = node.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>
  return delta.map((op) => (typeof op.insert === "string" ? op.insert : "")).join("")
}

// Overwrite the fragment with a single paragraph containing the given text.
// Newlines in the text become hard breaks within that paragraph.
export function setPlainText(frag: Y.XmlFragment, text: string): void {
  const doc = frag.doc
  const doIt = () => {
    // Clear existing children
    while (frag.length > 0) frag.delete(0, 1)
    pushParagraphFromText(frag, text)
  }
  if (!doc) {
    doIt()
    return
  }
  doc.transact(doIt)
}

/**
 * Build paragraph elements and push them directly into an attached fragment.
 * Writing to Y types that are already in a doc avoids Yjs "Invalid access"
 * warnings. The fragment MUST be attached before calling this.
 */
function pushParagraphFromText(frag: Y.XmlFragment, text: string): void {
  const para = new Y.XmlElement("paragraph")
  frag.push([para])
  if (text === "") return
  const lines = text.split("\n")
  lines.forEach((line, i) => {
    if (i > 0) {
      para.push([new Y.XmlElement("hardBreak")])
    }
    if (line.length > 0) {
      const textNode = new Y.XmlText()
      para.push([textNode])
      textNode.insert(0, line)
    }
  })
}

// Serialize the fragment to HTML using ProseMirror's schema mapping.
// Uses a minimal recursive walker since we control the schema.
export function getFragmentHtml(frag: Y.XmlFragment): string {
  const parts: string[] = []
  for (let i = 0; i < frag.length; i++) {
    const node = frag.get(i)
    if (node instanceof Y.XmlElement) {
      parts.push(serializeElement(node))
    } else if (node instanceof Y.XmlText) {
      parts.push(serializeText(node))
    }
  }
  return parts.join("")
}

function serializeElement(element: Y.XmlElement): string {
  const name = element.nodeName
  if (name === "br" || name === "hardBreak") {
    return "<br/>"
  }
  const tagName = nodeNameToHtmlTag(name)
  const inner: string[] = []
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i)
    if (child instanceof Y.XmlElement) {
      inner.push(serializeElement(child))
    } else if (child instanceof Y.XmlText) {
      inner.push(serializeText(child))
    }
  }
  if (tagName === null) {
    return inner.join("")
  }
  return `<${tagName}>${inner.join("")}</${tagName}>`
}

function nodeNameToHtmlTag(name: string): string | null {
  if (name === "paragraph") return "p"
  return null
}

function serializeText(node: Y.XmlText): string {
  // Y.XmlText stores text with attributes representing ProseMirror marks.
  // toDelta returns [{ insert: string, attributes?: { bold?: true, italic?: true, ... } }]
  const delta = node.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>
  const parts: string[] = []
  for (const op of delta) {
    if (typeof op.insert !== "string") continue
    let html = escapeHtml(op.insert)
    const attrs = op.attributes || {}
    if (attrs.code) html = `<code>${html}</code>`
    if (attrs.strike) html = `<s>${html}</s>`
    if (attrs.underline) html = `<u>${html}</u>`
    if (attrs.italic) html = `<i>${html}</i>`
    if (attrs.bold) html = `<b>${html}</b>`
    parts.push(html)
  }
  return parts.join("")
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

// Populate the fragment from HTML. Supports a small subset of tags.
// Only paragraphs and inline marks (b/strong, i/em, u, s/strike, code) and <br>.
export function setFragmentFromHtml(frag: Y.XmlFragment, html: string): void {
  const doc = frag.doc
  const doIt = () => {
    // Clear existing children
    while (frag.length > 0) frag.delete(0, 1)
    pushHtmlParagraphs(frag, html)
  }
  if (!doc) {
    doIt()
    return
  }
  doc.transact(doIt)
}

/**
 * Parse HTML and push paragraph elements directly into an attached fragment.
 * All Y types are attached before being written to, avoiding Yjs warnings.
 */
function pushHtmlParagraphs(frag: Y.XmlFragment, html: string): void {
  const parser = new DOMParser()
  const domDoc = parser.parseFromString(`<body>${html}</body>`, "text/html")
  const body = domDoc.body
  let pushed = false

  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType === 1) {
      const el = child as Element
      const tag = el.tagName.toLowerCase()
      const para = new Y.XmlElement("paragraph")
      frag.push([para])
      pushed = true
      if (tag === "p") {
        appendDomContent(el, para, {})
      } else {
        appendDomContent(el, para, {})
      }
    } else if (child.nodeType === 3) {
      const text = child.nodeValue || ""
      if (text.trim()) {
        const para = new Y.XmlElement("paragraph")
        frag.push([para])
        pushed = true
        const t = new Y.XmlText()
        para.push([t])
        t.insert(0, text)
      }
    }
  }

  if (!pushed) {
    frag.push([new Y.XmlElement("paragraph")])
  }
}

function appendDomContent(el: Element, target: Y.XmlElement, marks: Record<string, boolean>): void {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      const text = child.nodeValue || ""
      if (text.length > 0) {
        const tn = new Y.XmlText()
        target.push([tn])
        tn.insert(0, text, { ...marks })
      }
    } else if (child.nodeType === 1) {
      const childEl = child as Element
      const tag = childEl.tagName.toLowerCase()
      if (tag === "br") {
        target.push([new Y.XmlElement("hardBreak")])
      } else if (tag === "b" || tag === "strong") {
        appendDomContent(childEl, target, { ...marks, bold: true })
      } else if (tag === "i" || tag === "em") {
        appendDomContent(childEl, target, { ...marks, italic: true })
      } else if (tag === "u") {
        appendDomContent(childEl, target, { ...marks, underline: true })
      } else if (tag === "s" || tag === "strike" || tag === "del") {
        appendDomContent(childEl, target, { ...marks, strike: true })
      } else if (tag === "code") {
        appendDomContent(childEl, target, { ...marks, code: true })
      } else {
        // Unknown inline tag — drop wrapper, keep content
        appendDomContent(childEl, target, marks)
      }
    }
  }
}
