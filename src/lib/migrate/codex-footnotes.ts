// Codex keeps a footnote on its caller:
//   <sup class="footnote-marker" data-footnote="&lt;p&gt;…&lt;/p&gt;">1</sup>
// The note body is the attribute. Aquilla's tray reads a `\f … \f*` span in the
// plain value, and the editor drops every attribute except `data-usfm-footnote`.
// Leaving the `<sup>` in place makes stripHtml throw the note away and keep the
// caller digit, which is the "1" a number check then flags.
//
// This runs before stripHtml and replaces each marker with a USFM footnote, so
// the same characters land in `value` and in `valueHtml`.

import { decodeHtmlEntities } from "../html-entities"

const MARKER_CLASS = "footnote-marker"

interface ParsedTag {
  name: string
  /** Index just after the tag's closing `>`. */
  end: number
  attrs: Map<string, string>
  closing: boolean
  selfClosing: boolean
}

/**
 * Replace Codex `footnote-marker` elements with `\f + \ft … \f*`.
 * A marker whose note is empty is left untouched.
 */
export function codexFootnotesToUsfm(html: string): string {
  if (!html.includes(MARKER_CLASS)) return html
  let out = ""
  let i = 0
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4)
      const next = end === -1 ? html.length : end + 3
      out += html.slice(i, next)
      i = next
      continue
    }
    const tag = html[i] === "<" ? parseTag(html, i) : null
    if (!tag || !isCodexFootnote(tag)) {
      out += html[i]
      i += 1
      continue
    }
    const close = tag.selfClosing ? tag.end : closingTagEnd(html, tag)
    if (close === null) {
      out += html[i]
      i += 1
      continue
    }
    const note = footnoteText(tag.attrs.get("data-footnote") ?? "")
    if (!note) {
      out += html.slice(i, close)
      i = close
      continue
    }
    out += `\\f + \\ft ${note}\\f*`
    i = close
  }
  return out
}

function isCodexFootnote(tag: ParsedTag): boolean {
  if (tag.closing || !tag.attrs.has("data-footnote")) return false
  const classes = tag.attrs.get("class") ?? ""
  return classes.split(/\s+/).includes(MARKER_CLASS)
}

function footnoteText(raw: string): string {
  let text = raw
  for (let pass = 0; pass < 2; pass += 1) {
    const decoded = decodeHtmlEntities(text)
    if (decoded === text) break
    text = decoded
  }
  return stripTags(text).replace(/\uFEFF/g, "").replace(/\s+/g, " ").trim()
}

function stripTags(html: string): string {
  let out = ""
  let i = 0
  while (i < html.length) {
    const tag = html[i] === "<" ? parseTag(html, i) : null
    if (!tag) {
      out += html[i]
      i += 1
      continue
    }
    if (tag.name === "br") out += " "
    i = tag.end
  }
  return out
}

/** End index of the matching close tag, or null when the element never closes. */
function closingTagEnd(html: string, open: ParsedTag): number | null {
  let depth = 1
  let i = open.end
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt === -1) return null
    const tag = parseTag(html, lt)
    if (!tag) {
      i = lt + 1
      continue
    }
    if (tag.name === open.name && !tag.closing && !tag.selfClosing) depth += 1
    else if (tag.closing && tag.name === open.name) {
      depth -= 1
      if (depth === 0) return tag.end
    }
    i = tag.end
  }
  return null
}

function parseTag(html: string, i: number): ParsedTag | null {
  if (html[i] !== "<" || html.startsWith("<!--", i) || html.startsWith("<!", i) || html.startsWith("<?", i)) {
    return null
  }
  let j = i + 1
  let closing = false
  if (html[j] === "/") {
    closing = true
    j += 1
  }
  const nameStart = j
  while (j < html.length && /[A-Za-z0-9:-]/.test(html[j])) j += 1
  if (j === nameStart) return null
  const name = html.slice(nameStart, j).toLowerCase()
  const attrs = new Map<string, string>()
  let selfClosing = false
  while (j < html.length) {
    while (j < html.length && /\s/.test(html[j])) j += 1
    if (j >= html.length) return null
    if (html[j] === ">") {
      j += 1
      break
    }
    if (html[j] === "/" && html[j + 1] === ">") {
      selfClosing = true
      j += 2
      break
    }
    const attrStart = j
    while (j < html.length && /[^\s=/>]/.test(html[j])) j += 1
    const attr = html.slice(attrStart, j).toLowerCase()
    if (!attr) return null
    while (j < html.length && /\s/.test(html[j])) j += 1
    if (html[j] !== "=") {
      attrs.set(attr, "")
      continue
    }
    j += 1
    while (j < html.length && /\s/.test(html[j])) j += 1
    let value = ""
    if (html[j] === '"' || html[j] === "'") {
      const quote = html[j]
      j += 1
      const valueStart = j
      while (j < html.length && html[j] !== quote) j += 1
      value = html.slice(valueStart, j)
      if (html[j] === quote) j += 1
    } else {
      const valueStart = j
      while (j < html.length && !/[\s>]/.test(html[j])) j += 1
      value = html.slice(valueStart, j)
    }
    attrs.set(attr, value)
  }
  return { name, end: j, attrs, closing, selfClosing }
}
