/**
 * Offset-preserving XML scanner.
 *
 * Adapters must patch native files surgically: replace the bytes of a text
 * node and leave every other byte alone. A conventional DOM round-trip would
 * re-serialize attributes, whitespace and entities and so "change" members we
 * never meant to touch. This scanner returns a tree whose nodes carry their
 * exact source offsets, and nothing is ever re-serialized.
 *
 * Scope: well-formed XML without DTDs (DOCTYPE is rejected — IDML never needs
 * one, and refusing it removes the entity-expansion attack surface).
 */

export class XmlError extends Error {
  constructor(
    readonly code: "MALFORMED_XML" | "UNSAFE_XML_DECLARATION",
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`)
  }
}

export interface XmlElement {
  readonly type: "element"
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  /** Offset of '<' of the start tag. */
  readonly start: number
  /** Offset just after the start tag's '>'. */
  readonly openEnd: number
  /** Offset of '<' of the end tag (== openEnd for self-closing). */
  readonly closeStart: number
  /** Offset just after the element. */
  readonly end: number
  readonly selfClosing: boolean
  readonly children: XmlNode[]
}

export interface XmlText {
  readonly type: "text"
  readonly start: number
  readonly end: number
  /** Decoded text. */
  readonly text: string
}

export interface XmlPI {
  readonly type: "pi"
  readonly start: number
  readonly end: number
  readonly target: string
  readonly data: string
}

export interface XmlOther {
  readonly type: "comment" | "cdata"
  readonly start: number
  readonly end: number
  readonly text: string
}

export type XmlNode = XmlElement | XmlText | XmlPI | XmlOther

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y
const ATTR = /\s+([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/y

export const decodeEntities = (s: string, offset = 0): string =>
  s.indexOf("&") < 0
    ? s
    : s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (m, body: string, at: number) => {
        if (!m.endsWith(";")) throw new XmlError("MALFORMED_XML", `unterminated entity ${m}`, offset + at)
        if (body[0] === "#") {
          const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
          return String.fromCodePoint(code)
        }
        switch (body) {
          case "amp":
            return "&"
          case "lt":
            return "<"
          case "gt":
            return ">"
          case "quot":
            return '"'
          case "apos":
            return "'"
          default:
            throw new XmlError("MALFORMED_XML", `unknown entity &${body};`, offset + at)
        }
      })

/** Escape text for an XML text node. `\r` and other C0 controls become numeric references so they survive parsers' newline normalisation. */
export const encodeText = (s: string): string =>
  s.replace(/[&<>\r\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : `&#${c.charCodeAt(0)};`,
  )

export const encodeAttr = (s: string): string => encodeText(s).replace(/"/g, "&quot;")

export interface XmlDocument {
  readonly source: string
  readonly root: XmlElement
}

export const parseXml = (source: string): XmlDocument => {
  let i = 0
  const n = source.length
  const stack: { el: Omit<XmlElement, "closeStart" | "end"> & { children: XmlNode[] } }[] = []
  let root: XmlElement | undefined
  const top = (): XmlNode[] | undefined => stack.at(-1)?.el.children

  if (source.charCodeAt(0) === 0xfeff) i = 1
  while (i < n) {
    const lt = source.indexOf("<", i)
    if (lt < 0 || lt > i) {
      const end = lt < 0 ? n : lt
      const raw = source.slice(i, end)
      const parent = top()
      if (parent) parent.push({ type: "text", start: i, end, text: decodeEntities(raw, i) })
      else if (raw.trim() !== "") throw new XmlError("MALFORMED_XML", "text outside the root element", i)
      i = end
      continue
    }
    if (source.startsWith("<?", lt)) {
      const close = source.indexOf("?>", lt + 2)
      if (close < 0) throw new XmlError("MALFORMED_XML", "unterminated processing instruction", lt)
      const body = source.slice(lt + 2, close)
      const sp = body.search(/\s/)
      const target = sp < 0 ? body : body.slice(0, sp)
      const parent = top()
      if (parent) parent.push({ type: "pi", start: lt, end: close + 2, target, data: sp < 0 ? "" : body.slice(sp + 1) })
      i = close + 2
      continue
    }
    if (source.startsWith("<!--", lt)) {
      const close = source.indexOf("-->", lt + 4)
      if (close < 0) throw new XmlError("MALFORMED_XML", "unterminated comment", lt)
      top()?.push({ type: "comment", start: lt, end: close + 3, text: source.slice(lt + 4, close) })
      i = close + 3
      continue
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const close = source.indexOf("]]>", lt + 9)
      if (close < 0) throw new XmlError("MALFORMED_XML", "unterminated CDATA section", lt)
      const parent = top()
      if (!parent) throw new XmlError("MALFORMED_XML", "CDATA outside the root element", lt)
      parent.push({ type: "cdata", start: lt, end: close + 3, text: source.slice(lt + 9, close) })
      i = close + 3
      continue
    }
    if (source.startsWith("<!", lt)) throw new XmlError("UNSAFE_XML_DECLARATION", "DOCTYPE and markup declarations are not allowed", lt)
    if (source[lt + 1] === "/") {
      NAME.lastIndex = lt + 2
      const m = NAME.exec(source)
      if (!m) throw new XmlError("MALFORMED_XML", "bad end tag", lt)
      const gt = source.indexOf(">", NAME.lastIndex)
      if (gt < 0 || source.slice(NAME.lastIndex, gt).trim() !== "") throw new XmlError("MALFORMED_XML", "bad end tag", lt)
      const open = stack.pop()
      if (!open || open.el.name !== m[0]) throw new XmlError("MALFORMED_XML", `unexpected </${m[0]}>`, lt)
      const el: XmlElement = { ...open.el, closeStart: lt, end: gt + 1 }
      const parent = top()
      if (parent) parent.push(el)
      else {
        if (root) throw new XmlError("MALFORMED_XML", "multiple root elements", lt)
        root = el
      }
      i = gt + 1
      continue
    }
    NAME.lastIndex = lt + 1
    const m = NAME.exec(source)
    if (!m) throw new XmlError("MALFORMED_XML", "bad start tag", lt)
    const attrs: Record<string, string> = {}
    let p = NAME.lastIndex
    for (;;) {
      ATTR.lastIndex = p
      const a = ATTR.exec(source)
      if (!a) break
      if (a[1]! in attrs) throw new XmlError("MALFORMED_XML", `duplicate attribute ${a[1]}`, p)
      attrs[a[1]!] = decodeEntities(a[3] ?? a[4] ?? "", p)
      p = ATTR.lastIndex
    }
    while (p < n && /\s/.test(source[p]!)) p++
    const selfClosing = source.startsWith("/>", p)
    if (!selfClosing && source[p] !== ">") throw new XmlError("MALFORMED_XML", `malformed start tag <${m[0]}>`, lt)
    const openEnd = p + (selfClosing ? 2 : 1)
    const base = { type: "element" as const, name: m[0], attrs, start: lt, openEnd, selfClosing, children: [] as XmlNode[] }
    if (selfClosing) {
      const el: XmlElement = { ...base, closeStart: openEnd, end: openEnd }
      const parent = top()
      if (parent) parent.push(el)
      else {
        if (root) throw new XmlError("MALFORMED_XML", "multiple root elements", lt)
        root = el
      }
    } else stack.push({ el: base })
    i = openEnd
  }
  if (stack.length > 0) throw new XmlError("MALFORMED_XML", `unclosed <${stack.at(-1)!.el.name}>`, n)
  if (!root) throw new XmlError("MALFORMED_XML", "no root element", 0)
  return { source, root }
}

export const childElements = (el: XmlElement, name?: string): XmlElement[] =>
  el.children.filter((c): c is XmlElement => c.type === "element" && (name === undefined || c.name === name))

export function* walk(el: XmlElement): Generator<XmlElement> {
  yield el
  for (const c of el.children) if (c.type === "element") yield* walk(c)
}

export const findFirst = (el: XmlElement, name: string): XmlElement | undefined => {
  for (const e of walk(el)) if (e.name === name) return e
  return undefined
}

/** Splice replacements into a source string. Ranges must not overlap. */
export const splice = (source: string, edits: ReadonlyArray<{ start: number; end: number; text: string }>): string => {
  const sorted = [...edits].sort((a, b) => a.start - b.start)
  let out = ""
  let at = 0
  for (const e of sorted) {
    if (e.start < at) throw new Error(`overlapping edits at ${e.start}`)
    out += source.slice(at, e.start) + e.text
    at = e.end
  }
  return out + source.slice(at)
}
