import { scanXmlTags, startTagName } from "@/lib/parsers/xml-lite"

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
export type Mark = "b" | "i" | "u" | "s" | "sup" | "sub" | "code"
export interface Span { text: string; marks: Set<Mark> }

const TAG_TO_MARK: Record<string, Mark> = {
  b: "b", strong: "b", i: "i", em: "i", u: "u",
  s: "s", strike: "s", del: "s", sup: "sup", sub: "sub", code: "code",
}

export function htmlToSpans(html: string): Span[] {
  if (!html || !html.trim()) return []
  const doc = new DOMParser().parseFromString(html, "text/html")
  const root = doc.body
  const spans: Span[] = []
  const push = (text: string, marks: Set<Mark>) => {
    if (text) spans.push({ text, marks: new Set(marks) })
  }
  let blocks = 0
  const walk = (node: Node, marks: Set<Mark>) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        push(child.textContent ?? "", marks)
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element
        const tag = el.tagName.toLowerCase()
        // AQU-2539: what the translation editor writes. A hard break is a line
        // break; a footnote is an atom whose USFM text lives in an attribute;
        // a second paragraph starts on a new line.
        if (tag === "br") {
          push("\n", marks)
          continue
        }
        if (el.hasAttribute("data-usfm-footnote")) {
          push(el.getAttribute("data-usfm-footnote") ?? "", new Set())
          continue
        }
        if (tag === "p" || tag === "div") {
          if (blocks > 0) push("\n", new Set())
          blocks++
        }
        const mark = TAG_TO_MARK[tag]
        const next = mark ? new Set(marks).add(mark) : marks
        walk(child, next)
      }
    }
  }
  walk(root, new Set())
  // Drop spans that are empty after the walk; keep whitespace-bearing spans.
  return spans.filter(s => s.text.length > 0)
}

// Characters XML 1.0 cannot hold at all; one in a w:t makes the part unreadable.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const XML_INVALID_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g

export function escapeXml(s: string): string {
  return s
    .replace(XML_INVALID_RE, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const MARK_TO_TAG: Partial<Record<Mark, string>> = {
  b: "<w:b/>", i: "<w:i/>", u: '<w:u w:val="single"/>', s: "<w:strike/>",
  sup: '<w:vertAlign w:val="superscript"/>', sub: '<w:vertAlign w:val="subscript"/>', // code → none
}

/** OOXML element name behind each inline mark (`code` has no run property). */
const MARK_TO_ELEMENT: Partial<Record<Mark, string>> = {
  b: "b", i: "i", u: "u", s: "strike", sup: "vertAlign", sub: "vertAlign",
}

/** The marks a run can carry, in the order their toggles are written. */
const RUN_MARKS: Mark[] = ["b", "i", "u", "s", "sup", "sub"]

/**
 * Remove a toggle element from a verbatim `<w:rPr>` string (AQU-1719).
 *
 * A base rPr often already declares the toggle we are about to splice in — a
 * Google Docs export writes an explicit `<w:b w:val="0"/>` on every run — and
 * two contradictory flags for one property is not valid OOXML. Drop the stale
 * one so the toggle we emit is the only one. Toggles the translator did not
 * set are left alone, so the source run's own formatting still carries over.
 */
export function stripToggleElement(rPrXml: string, name: string): string {
  const re = new RegExp(`<w:${name}(?:\\s[^>]*)?/>|<w:${name}(?:\\s[^>]*)?>[\\s\\S]*?</w:${name}>`, "g")
  return rPrXml.replace(re, "")
}

/**
 * String-based run builder: returns clean OOXML run markup with NO xmlns pollution.
 *
 * We build strings rather than DOM nodes precisely to avoid XMLSerializer emitting
 * `xmlns:w="…"` on spliced fragments (which causes blank rendering in Apple Pages).
 *
 * @param spans - from htmlToSpans(); translator's inline formatting wins.
 * @param baseRprXml - verbatim `<w:rPr>…</w:rPr>` of the paragraph's first text run,
 *   or null. Translator toggles are spliced in before `</w:rPr>`.
 */
export function spansToRunXml(spans: Span[], baseRprXml: string | null): string {
  return spans.map((span) => textRunXml(span.text, rPrWithMarks(baseRprXml, span.marks))).join("")
}

/**
 * The `<w:rPr>` for a stretch of translation: the base run look with the
 * stretch's marks switched on. Returns "" when there is nothing to write.
 */
export function rPrWithMarks(baseRprXml: string | null, marks: ReadonlySet<Mark>): string {
  const applied = RUN_MARKS.filter((m) => marks.has(m))
  if (!baseRprXml) {
    return applied.length > 0 ? `<w:rPr>${applied.map((m) => MARK_TO_TAG[m]).join("")}</w:rPr>` : ""
  }
  // Replace any same-property flag the base already carries (AQU-1719); a
  // self-closed base (<w:rPr/>) is expanded.
  let rPr = baseRprXml
  for (const m of applied) rPr = setRprChild(rPr, MARK_TO_ELEMENT[m] as string, MARK_TO_TAG[m] as string)
  return /<w:rPr\b[^>]*\/>$/.test(rPr.trim()) ? "<w:rPr></w:rPr>" : rPr
}

/**
 * ECMA-376 order of `w:rPr` children (CT_RPr). Word reads children out of
 * order in practice, but a property is written where the schema puts it.
 */
const RPR_ORDER = [
  "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike",
  "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden",
  "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect",
  "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
  "specVanish", "oMath", "rPrChange",
]

/**
 * Set (or with `elementXml === null`, remove) one direct child of a verbatim
 * `<w:rPr>` string, written at its schema position; every other byte of the
 * rPr is kept. `name` is the local name (`b`, `lang`, `vertAlign`).
 */
export function setRprChild(rPrXml: string, name: string, elementXml: string | null): string {
  let rPr = rPrXml.trim()
  const selfClosed = /^<w:rPr\b[^>]*\/>$/.exec(rPr)
  if (selfClosed) rPr = `${rPr.slice(0, -2)}></w:rPr>`
  const openEnd = rPr.indexOf(">") + 1
  const closeStart = rPr.lastIndexOf("</w:rPr>")
  if (openEnd <= 0 || closeStart < openEnd) return rPrXml
  const inner = rPr.slice(openEnd, closeStart)
  // Direct children only: `w:rPrChange` holds a whole older rPr inside it.
  const children: { name: string; start: number; end: number }[] = []
  let depth = 0
  let current: { name: string; start: number } | null = null
  scanXmlTags(inner, {
    open(body, start, end, selfClosing) {
      if (depth === 0) {
        const local = startTagName(body).replace(/^w:/, "")
        if (selfClosing) children.push({ name: local, start, end })
        else current = { name: local, start }
      }
      if (!selfClosing) depth++
    },
    close(_name, _start, end) {
      depth--
      if (depth === 0 && current) {
        children.push({ ...current, end })
        current = null
      }
    },
  })
  const rank = (local: string) => {
    const i = RPR_ORDER.indexOf(local)
    return i === -1 ? RPR_ORDER.length : i
  }
  let out = ""
  let cursor = 0
  let placed = elementXml === null
  for (const child of children) {
    if (!placed && rank(child.name) > rank(name)) {
      out += inner.slice(cursor, child.start) + elementXml
      cursor = child.start
      placed = true
    }
    if (child.name === name) {
      out += inner.slice(cursor, child.start)
      cursor = child.end
    }
  }
  out += inner.slice(cursor)
  if (!placed) out += elementXml
  return rPr.slice(0, openEnd) + out + "</w:rPr>"
}

/**
 * The run look with its proofing language set to `lang` (AQU-2539), so Word
 * spell-checks a translation in the language it is written in. Only `w:val`
 * changes; an existing `w:eastAsia` or `w:bidi` is kept.
 */
export function rPrWithLanguage(rPrXml: string, lang: string): string {
  const code = lang.replace(/_/g, "-").replace(/[^A-Za-z0-9-]/g, "")
  if (!code) return rPrXml
  // The run's OWN w:lang (an older one inside w:rPrChange is history).
  const existing = rPrXml ? directRprChild(rPrXml, "lang") : null
  const el = existing && /^<w:lang\b[^>]*\/>$/.test(existing) ? existing : null
  const next = el
    ? /\sw:val="[^"]*"/.test(el)
      ? el.replace(/\sw:val="[^"]*"/, ` w:val="${code}"`)
      : el.replace(/^<w:lang\b/, `<w:lang w:val="${code}"`)
    : `<w:lang w:val="${code}"/>`
  return setRprChild(rPrXml || "<w:rPr></w:rPr>", "lang", next)
}

/** The verbatim XML of one direct child of a `<w:rPr>` string, or null. */
export function directRprChild(rPrXml: string, name: string): string | null {
  const rPr = rPrXml.trim()
  const openEnd = rPr.indexOf(">") + 1
  const closeStart = rPr.lastIndexOf("</w:rPr>")
  if (openEnd <= 0 || closeStart < openEnd) return null
  const inner = rPr.slice(openEnd, closeStart)
  let depth = 0
  let found: string | null = null
  let start = -1
  scanXmlTags(inner, {
    open(body, at, end, selfClosing) {
      if (depth === 0 && found === null && startTagName(body) === `w:${name}`) {
        if (selfClosing) found = inner.slice(at, end)
        else start = at
      }
      if (!selfClosing) depth++
    },
    close(_tag, _at, end) {
      depth--
      if (depth === 0 && start !== -1 && found === null) {
        found = inner.slice(start, end)
        start = -1
      }
    },
  })
  return found
}

/**
 * One run of translated text (AQU-2539). A tab becomes `<w:tab/>`, a line
 * break `<w:br/>`, a non-breaking hyphen `<w:noBreakHyphen/>` and a soft hyphen
 * `<w:softHyphen/>` — the elements Word reads them from — so they come back as
 * they went in. Returns "" for empty text.
 */
export function textRunXml(text: string, rPrXml: string): string {
  let inner = ""
  for (const part of text.split(/(\t|\r\n|\n|\r|\u2011|\u00AD)/)) {
    if (part === "") continue
    if (part === "\t") inner += "<w:tab/>"
    else if (part === "\n" || part === "\r" || part === "\r\n") inner += "<w:br/>"
    else if (part === "\u2011") inner += "<w:noBreakHyphen/>"
    else if (part === "\u00AD") inner += "<w:softHyphen/>"
    else {
      const escaped = escapeXml(part)
      if (escaped) inner += `<w:t xml:space="preserve">${escaped}</w:t>`
    }
  }
  return inner ? `<w:r>${rPrXml}${inner}</w:r>` : ""
}

export function spansToRuns(doc: Document, spans: Span[], baseRpr: Element | null): Element[] {
  return spans.map(span => {
    const run = doc.createElementNS(W_NS, "w:r")
    const rPr = baseRpr
      ? (baseRpr.cloneNode(true) as Element)
      : doc.createElementNS(W_NS, "w:rPr")
    const addToggle = (name: string, attrs?: Record<string, string>) => {
      // AQU-1719: the cloned base rPr may already declare this property (often
      // as an explicit off flag) — replace it rather than contradict it.
      for (const child of Array.from(rPr.children)) {
        if (child.localName === name) rPr.removeChild(child)
      }
      const el = doc.createElementNS(W_NS, `w:${name}`)
      if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      rPr.appendChild(el)
    }
    if (span.marks.has("b")) addToggle("b")
    if (span.marks.has("i")) addToggle("i")
    if (span.marks.has("u")) addToggle("u", { "w:val": "single" })
    if (span.marks.has("s")) addToggle("strike")
    if (baseRpr !== null || rPr.childNodes.length > 0) run.appendChild(rPr)
    const t = doc.createElementNS(W_NS, "w:t")
    t.setAttribute("xml:space", "preserve")
    t.textContent = span.text
    run.appendChild(t)
    return run
  })
}
