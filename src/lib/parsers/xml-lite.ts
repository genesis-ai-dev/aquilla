// Minimal DOM-free XML element reader (AQU-1237).
//
// The OOXML parsers were written against the browser's `DOMParser`, which is a
// Window-only global — that single dependency is what kept docx/pptx/usx/xliff
// out of the Agent API's server-side import path (see
// sync-worker/src/external/import-parse.ts). This module reads the small,
// well-formed, machine-generated XML those formats ship into a plain object
// tree so ONE parser implementation can run in the browser, in the parse Web
// Worker, and inside a Cloudflare Worker.
//
// Deliberately not a general XML parser: no DTDs, no namespace resolution
// (OOXML tag names are matched verbatim, prefix included, exactly as
// `getElementsByTagName("w:p")` did), no entity definitions beyond the five
// predefined ones plus numeric character references. That is the whole of what
// Word/InDesign/Paratext emit.

export interface XmlElement {
  /** Tag name verbatim, prefix included (`w:p`, not `p`). */
  tagName: string
  attributes: Record<string, string>
  children: XmlNode[]
  /** Only with `parseXmlLite(xml, { offsets: true })`: where the element sits
   *  in the parsed string. `start` is its `<`, `openEnd` is just past its start
   *  tag, `closeStart` is its end tag's `<` (equal to `end` when self-closing),
   *  `end` is just past the element. Lets a caller splice the ORIGINAL bytes of
   *  an element instead of re-serialising it (AQU-2539, the DOCX exporter). */
  start?: number
  openEnd?: number
  closeStart?: number
  end?: number
}

export type XmlNode = XmlElement | { text: string }

export function isElement(node: XmlNode): node is XmlElement {
  return (node as XmlElement).tagName !== undefined
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
}

/** Decode the predefined XML entities plus numeric character references. */
export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match
    }
    return NAMED_ENTITIES[body] ?? match
  })
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code < 0 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

/**
 * Parse an XML document into an element tree.
 *
 * The returned element is a synthetic `#document` root holding the real root
 * element, so callers can query it exactly like a `Document`. Throws on
 * malformed markup (unclosed or mismatched tags) rather than guessing — a
 * silent partial parse is how a truncated upload turns into a partial import.
 */
export function parseXmlLite(xml: string, options?: { offsets?: boolean }): XmlElement {
  const root: XmlElement = { tagName: "#document", attributes: {}, children: [] }
  const stack: XmlElement[] = [root]
  const offsets = options?.offsets === true

  scanXmlTags(xml, {
    text(raw) {
      stack[stack.length - 1].children.push({ text: decodeXmlEntities(raw) })
    },
    cdata(literal) {
      // CDATA is literal — it must NOT go through entity decoding.
      stack[stack.length - 1].children.push({ text: literal })
    },
    open(body, start, end, selfClosing) {
      const element = readStartTag(body)
      if (offsets) {
        element.start = start
        element.openEnd = end
        if (selfClosing) {
          element.closeStart = end
          element.end = end
        }
      }
      stack[stack.length - 1].children.push(element)
      if (!selfClosing) stack.push(element)
    },
    close(name, start, end) {
      const open = stack.pop()
      if (!open || open === root || open.tagName !== name) {
        throw new Error(`Malformed XML: unexpected closing tag </${name}>`)
      }
      if (offsets) {
        open.closeStart = start
        open.end = end
      }
    },
  })

  if (stack.length !== 1) {
    throw new Error(`Malformed XML: unclosed tag <${stack[stack.length - 1].tagName}>`)
  }
  return root
}

/** What `scanXmlTags` reports, in document order. */
export interface XmlTagVisitor {
  /** Raw (still entity-encoded) character data between tags; never empty. */
  text?(raw: string): void
  /** A CDATA section's literal content; never empty. */
  cdata?(literal: string): void
  /** A start tag. `body` is the tag without `<`, `>` and a self-closing `/`;
   *  `start` is the `<`, `end` is just past the `>`. */
  open?(body: string, start: number, end: number, selfClosing: boolean): void
  /** An end tag `</name>`. `start` is the `<`, `end` is just past the `>`. */
  close?(name: string, start: number, end: number): void
}

/**
 * The ONE tokenizer behind `parseXmlLite` (AQU-2539). Exported so a caller that
 * needs only element boundaries — the DOCX exporter numbering `w:p` elements in
 * a string it splices — recognises exactly the elements the tree parser builds,
 * in the same order, without building the tree. Comments, processing
 * instructions and declarations are skipped; a `>` inside a quoted attribute
 * value does not end a tag. Throws on an unterminated tag.
 */
export function scanXmlTags(xml: string, visit: XmlTagVisitor): void {
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf("<", i)
    if (lt === -1) {
      if (visit.text) visit.text(xml.slice(i))
      break
    }
    if (lt > i && visit.text) visit.text(xml.slice(i, lt))

    // Non-element constructs carry no addressable content for these formats.
    if (xml.startsWith("<!--", lt)) {
      i = skipPast(xml, lt, "-->")
      continue
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt)
      const literal = end === -1 ? xml.slice(lt + 9) : xml.slice(lt + 9, end)
      if (literal !== "" && visit.cdata) visit.cdata(literal)
      i = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith("<?", lt)) {
      i = skipPast(xml, lt, "?>")
      continue
    }
    if (xml.startsWith("<!", lt)) {
      i = skipPast(xml, lt, ">")
      continue
    }

    const gt = findTagEnd(xml, lt)
    if (gt === -1) throw new Error("Malformed XML: unterminated tag")
    const inner = xml.slice(lt + 1, gt)

    if (inner.startsWith("/")) {
      if (visit.close) visit.close(inner.slice(1).trim(), lt, gt + 1)
    } else {
      const selfClosing = inner.endsWith("/")
      if (visit.open) visit.open(selfClosing ? inner.slice(0, -1) : inner, lt, gt + 1, selfClosing)
    }
    i = gt + 1
  }
}

/**
 * Throw unless `xml` is well-formed in the ways a spliced part can break:
 * every end tag closes the element that is open, nothing is left open, and
 * there is exactly one root element. Builds no tree, so it costs a scan, not
 * the ~19× memory of `parseXmlLite` (AQU-2539: the DOCX exporter's guard).
 */
export function assertWellFormedXml(xml: string): void {
  const stack: string[] = []
  let roots = 0
  scanXmlTags(xml, {
    text(raw) {
      if (stack.length === 0 && raw.trim() !== "") throw new Error("Malformed XML: text outside the root element")
      if (raw.includes("<")) throw new Error("Malformed XML: unescaped '<' in text")
      if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(raw)) {
        throw new Error("Malformed XML: unescaped '&' in text")
      }
    },
    open(body, start, _end, selfClosing) {
      const name = startTagName(body)
      if (stack.length === 0) roots++
      if (roots > 1) throw new Error(`Malformed XML: second root element <${name}> at ${start}`)
      if (!selfClosing) stack.push(name)
    },
    close(name, start) {
      const open = stack.pop()
      if (open !== name) {
        throw new Error(`Malformed XML: </${name}> at ${start} closes <${open ?? "nothing"}>`)
      }
    },
  })
  if (stack.length > 0) throw new Error(`Malformed XML: <${stack[stack.length - 1]}> is never closed`)
  if (roots !== 1) throw new Error("Malformed XML: no root element")
}

/** The element name at the head of a start-tag body (`w:p` for `w:p w14:paraId="…"`). */
export function startTagName(body: string): string {
  const nameMatch = /^([^\s/>]+)/.exec(body)
  if (!nameMatch) throw new Error("Malformed XML: tag with no name")
  return nameMatch[1]
}

function skipPast(xml: string, from: number, terminator: string): number {
  const end = xml.indexOf(terminator, from)
  return end === -1 ? xml.length : end + terminator.length
}

/** Index of the `>` closing a start/end tag, skipping any inside attribute quotes. */
function findTagEnd(xml: string, lt: number): number {
  let quote: string | null = null
  for (let i = lt + 1; i < xml.length; i++) {
    const ch = xml[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === ">") return i
  }
  return -1
}

const ATTRIBUTE_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g

function readStartTag(body: string): XmlElement {
  const tagName = startTagName(body)
  const attributes: Record<string, string> = {}
  ATTRIBUTE_RE.lastIndex = tagName.length
  let attr: RegExpExecArray | null
  while ((attr = ATTRIBUTE_RE.exec(body)) !== null) {
    attributes[attr[1]] = decodeXmlEntities(attr[3] ?? attr[4] ?? "")
  }
  return { tagName, attributes, children: [] }
}

/**
 * All descendant elements with this tag name, in document order — the same
 * contract as `Element.getElementsByTagName` (self excluded, deep, live-order).
 */
export function elementsByTagName(root: XmlElement, tagName: string): XmlElement[] {
  const out: XmlElement[] = []
  const walk = (node: XmlElement) => {
    for (const child of node.children) {
      if (!isElement(child)) continue
      if (child.tagName === tagName) out.push(child)
      walk(child)
    }
  }
  walk(root)
  return out
}

/** First descendant with this tag name, or undefined. */
export function firstElementByTagName(root: XmlElement, tagName: string): XmlElement | undefined {
  const walk = (node: XmlElement): XmlElement | undefined => {
    for (const child of node.children) {
      if (!isElement(child)) continue
      if (child.tagName === tagName) return child
      const found = walk(child)
      if (found) return found
    }
    return undefined
  }
  return walk(root)
}

/** Concatenated text of every descendant text node — `Node.textContent`. */
export function textContent(node: XmlNode): string {
  if (!isElement(node)) return node.text
  let out = ""
  for (const child of node.children) out += textContent(child)
  return out
}

export function getAttribute(element: XmlElement, name: string): string | null {
  return Object.prototype.hasOwnProperty.call(element.attributes, name) ? element.attributes[name] : null
}
