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

export function spansToRuns(doc: Document, spans: Span[], baseRpr: Element | null): Element[] {
  return spans.map(span => {
    const run = doc.createElementNS(W_NS, "w:r")
    const rPr = baseRpr
      ? (baseRpr.cloneNode(true) as Element)
      : doc.createElementNS(W_NS, "w:rPr")
    const addToggle = (name: string, attrs?: Record<string, string>) => {
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
