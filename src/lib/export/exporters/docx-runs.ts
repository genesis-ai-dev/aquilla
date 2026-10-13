const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
export type Mark = "b" | "i" | "u" | "s" | "code"
export interface Span { text: string; marks: Set<Mark> }

const TAG_TO_MARK: Record<string, Mark> = {
  b: "b", strong: "b", i: "i", em: "i", u: "u",
  s: "s", strike: "s", del: "s", code: "code",
}

export function htmlToSpans(html: string): Span[] {
  if (!html || !html.trim()) return []
  const doc = new DOMParser().parseFromString(html, "text/html")
  const root = doc.body
  const spans: Span[] = []
  const walk = (node: Node, marks: Set<Mark>) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? ""
        if (text) spans.push({ text, marks: new Set(marks) })
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = (child as Element).tagName.toLowerCase()
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

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const MARK_TO_TAG: Partial<Record<Mark, string>> = {
  b: "<w:b/>", i: "<w:i/>", u: '<w:u w:val="single"/>', s: "<w:strike/>", // code → none
}

/** OOXML element name behind each inline mark (`code` has no run property). */
const MARK_TO_ELEMENT: Partial<Record<Mark, string>> = { b: "b", i: "i", u: "u", s: "strike" }

/**
 * Remove a toggle element from a verbatim `<w:rPr>` string (AQU-1719).
 *
 * A base rPr often already declares the toggle we are about to splice in — a
 * Google Docs export writes an explicit `<w:b w:val="0"/>` on every run — and
 * two contradictory flags for one property is not valid OOXML. Drop the stale
 * one so the toggle we emit is the only one. Toggles the translator did not
 * set are left alone, so the source run's own formatting still carries over.
 */
function stripToggleElement(rPrXml: string, name: string): string {
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
  return spans.map((span) => {
    const applied = (["b", "i", "u", "s"] as Mark[]).filter((m) => span.marks.has(m))
    const toggles = applied.map((m) => MARK_TO_TAG[m]).join("")
    let rPr = ""
    if (baseRprXml) {
      // splice toggles in just before the closing </w:rPr> (or expand a self-closed base),
      // after dropping any same-property flag the base already carries (AQU-1719)
      const base = applied.reduce(
        (xml, m) => stripToggleElement(xml, MARK_TO_ELEMENT[m] as string), baseRprXml)
      rPr = base.includes("</w:rPr>")
        ? base.replace("</w:rPr>", `${toggles}</w:rPr>`)
        : `<w:rPr>${toggles}</w:rPr>` // base was <w:rPr/> or empty
    } else if (toggles) {
      rPr = `<w:rPr>${toggles}</w:rPr>`
    }
    return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(span.text)}</w:t></w:r>`
  }).join("")
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
