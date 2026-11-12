// AQU-2184: the typeset half of the HTML export. What matters here is that
// the book's structure survives — a line's poetry level, a note's text and
// origin reference, the styling a character marker carried — and that nothing
// reaches the page unescaped.
import { describe, it, expect } from "vitest"
import { blockClass, cellLines, createNoteCollector, escapeHtml, lineInlineHtml } from "./html-blocks"

describe("cellLines", () => {
  it("text with no marker at all is one prose line, verbatim", () => {
    const { lines, trailingBlank } = cellLines("Au commencement")
    expect(lines).toEqual([{ indent: 0, blankBefore: false, runs: [{ kind: "text", text: "Au commencement", marks: [], roles: [] }] }])
    expect(trailingBlank).toBe(false)
  })

  it("splits at break markers and keeps each line's indent level", () => {
    const { lines } = cellLines("Blessed is the man\n\\q2 nor stands in the way\n\\q1 but his delight")
    expect(lines.map((l) => [l.indent, l.runs.map((r) => (r.kind === "text" ? r.text : "")).join("")])).toEqual([
      [0, "Blessed is the man"],
      [2, "nor stands in the way"],
      [1, "but his delight"],
    ])
  })

  it("drops a trailing break that carries no words — the marker governs the NEXT cell", () => {
    // `parseUsfmLossless` ends a verse span at the next \\v, so the bare \\q1
    // meant for the following verse lands at the end of this one's text.
    const { lines } = cellLines("nor sit in the seat;\n\\q1")
    expect(lines).toHaveLength(1)
  })

  it("reports a \\b with nothing after it as a trailing blank, not a line", () => {
    const { lines, trailingBlank } = cellLines("of Yahweh.\n\\b\n\\p")
    expect(lines).toHaveLength(1)
    expect(trailingBlank).toBe(true)
  })

  it("marks the line a \\b stands above", () => {
    const { lines } = cellLines("first\n\\b\n\\q1 second")
    expect(lines.map((l) => l.blankBefore)).toEqual([false, true])
  })

  it("parses notes into runs, with their origin reference and body", () => {
    const { lines } = cellLines("the law\\f + \\fr 1:2 \\ft a note\\f* of Yahweh\\x + \\xo 1:2 \\xt Jer 17:8\\x*")
    expect(lines[0].runs).toEqual([
      { kind: "text", text: "the law", marks: [], roles: [] },
      { kind: "note", noteKind: "footnote", ref: "1:2", text: "a note" },
      { kind: "text", text: " of Yahweh", marks: [], roles: [] },
      { kind: "note", noteKind: "xref", ref: "1:2", text: "Jer 17:8" },
    ])
  })

  it("reports the marks and roles a character marker carried", () => {
    const { lines } = cellLines("the \\nd Lord\\nd* said \\wj follow me\\wj* and \\bdit go\\bdit*")
    const styled = lines[0].runs.flatMap((r) => (r.kind === "text" && (r.marks.length > 0 || r.roles.length > 0) ? [[r.text, r.marks, r.roles]] : []))
    expect(styled).toEqual([
      ["Lord", ["small-caps"], ["divine-name"]],
      ["follow me", [], ["words-of-jesus"]],
      ["go", ["bold", "italic"], ["bold-italic"]],
    ])
  })

  it("collapses USFM's own line wrapping, and keeps `~` a no-break space", () => {
    const { lines } = cellLines("\\nd Lord\\nd* of\n hosts~indeed")
    expect(lines).toHaveLength(1)
    expect(lineInlineHtml(lines[0])).toBe('<span class="small-caps">Lord</span> of hosts\u00a0indeed')
  })

  it("empty text yields no lines", () => {
    expect(cellLines("").lines).toEqual([])
    expect(cellLines("\\p").lines).toEqual([])
  })
})

describe("lineInlineHtml", () => {
  it("escapes every run, so nothing a translation typed can run", () => {
    const { lines } = cellLines('<script>alert(1)</script> & "quotes"')
    expect(lineInlineHtml(lines[0])).toBe("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;")
  })

  it("renders each mark as its element, and words of Jesus as their own style", () => {
    const { lines } = cellLines("\\bd bold\\bd* \\it italic\\it* \\sc caps\\sc* \\add supplied\\add* \\wj mine\\wj*")
    expect(lineInlineHtml(lines[0])).toBe(
      '<strong>bold</strong> <em>italic</em> <span class="small-caps">caps</span> <em>supplied</em> <span class="wj">mine</span>',
    )
  })

  it("nests a run's marks in a stable order", () => {
    const { lines } = cellLines("\\bdit both\\bdit*")
    expect(lineInlineHtml(lines[0])).toBe("<strong><em>both</em></strong>")
  })

  it("drops a note when no collector is numbering notes (the front matter)", () => {
    const { lines } = cellLines("text\\f + \\fr 1:1 \\ft a note\\f* more")
    expect(lineInlineHtml(lines[0])).toBe("text more")
  })
})

describe("blockClass", () => {
  it("a break marker's own level always wins over the paragraph's", () => {
    expect(blockClass("p", 2)).toBe("poetry poetry-2")
    expect(blockClass(undefined, 3)).toBe("poetry poetry-3")
  })

  it("maps the paragraph markers to their styles", () => {
    const cases: [string | undefined, string][] = [
      [undefined, "para"],
      ["p", "para"],
      ["q", "poetry poetry-1"],
      ["q1", "poetry poetry-1"],
      ["q2", "poetry poetry-2"],
      ["qm2", "poetry poetry-2"],
      ["qc", "poetry poetry-centered"],
      ["qr", "poetry poetry-right"],
      ["m", "para para-flush"],
      ["mi", "para para-flush"],
      ["nb", "para para-flush"],
      ["pi", "para para-indent-1"],
      ["pi2", "para para-indent-2"],
      ["li3", "para list list-3"],
      ["pc", "para para-centered"],
      ["pr", "para para-right"],
      ["zsomething", "para"],
    ]
    for (const [marker, expected] of cases) expect(blockClass(marker, 0)).toBe(expected)
  })

  it("clamps a level USFM does not define, so no class is invented", () => {
    expect(blockClass("q9", 0)).toBe("poetry poetry-4")
    expect(blockClass(undefined, 11)).toBe("poetry poetry-4")
  })
})

describe("createNoteCollector", () => {
  it("numbers footnotes, letters cross-references, and links each marker to its note and back", () => {
    const notes = createNoteCollector("ch-PSA-1")
    const first = notes.marker({ kind: "note", noteKind: "footnote", ref: "1:2", text: "a note" })
    const xref = notes.marker({ kind: "note", noteKind: "xref", ref: "1:3", text: "Jer 17:8" })
    const second = notes.marker({ kind: "note", noteKind: "endnote", ref: "", text: "an endnote" })

    expect(first).toContain('href="#ch-PSA-1-n1"')
    expect(first).toContain('id="ch-PSA-1-n1-ref"')
    expect(first).toContain(">1</a>")
    expect(xref).toContain('class="note-marker xref"')
    expect(xref).toContain(">a</a>")
    expect(second).toContain(">2</a>")

    const list = notes.listHtml()
    expect(list).toContain('<li class="note footnote" id="ch-PSA-1-n1">')
    expect(list).toContain('<a class="note-back" href="#ch-PSA-1-n1-ref"')
    expect(list).toContain('<span class="note-ref">1:2</span>')
    expect(list).toContain('<span class="note-text">a note</span>')
    expect(list).toContain('<li class="note xref" id="ch-PSA-1-x1">')
    // A note with no \\fr origin reference shows only its text.
    expect(list).toContain('<li class="note footnote" id="ch-PSA-1-n2"><a class="note-back" href="#ch-PSA-1-n2-ref" aria-label="Back to text">2</a> <span class="note-text">an endnote</span></li>')
  })

  it("escapes a note's text and its reference", () => {
    const notes = createNoteCollector("ch-GEN-1")
    notes.marker({ kind: "note", noteKind: "footnote", ref: "<b>1:1</b>", text: "<script>alert(1)</script>" })
    const list = notes.listHtml()
    expect(list).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(list).not.toContain("<script>")
    expect(list).not.toContain("<b>1:1</b>")
  })

  it("letters past z keep going", () => {
    const notes = createNoteCollector("s")
    let last = ""
    for (let i = 0; i < 27; i++) last = notes.marker({ kind: "note", noteKind: "xref", ref: "", text: "x" })
    expect(last).toContain(">aa</a>")
  })

  it("a section with no notes renders no list", () => {
    expect(createNoteCollector("s").listHtml()).toBe("")
  })
})

describe("escapeHtml", () => {
  it("escapes the five characters that could break out of the page", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;")
  })
})
