// AQU-2559: the Web page reads the layout a translator adds in the Bible
// document. That layout is stored as a USFM lead on the verse it precedes
// (docs/decisions/0010-usfm-target-layout.md). The page is also the document's
// reading preview, so a raw `\s1` or `\p` reaching it would show the
// translator markers instead of the heading or break they just made — and the
// exported page would disagree with the exported USFM file.
import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { buildHtmlPage, isBibleBookFile } from "./html"

function cell(overrides: Partial<CellData>): CellData {
  return {
    id: overrides.group ?? "c",
    fileId: "file-1",
    original: "",
    translated: "",
    context: "",
    group: "GEN 1:1",
    type: "verse",
    status: "validated",
    validationStatus: "full",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

/** Three verses of one source paragraph, so a break can only come from a lead. */
function book(v2: string, v3 = "Trois"): CellData[] {
  return [
    cell({ group: "GEN 1:1", original: "One", translated: "Un", paragraphStart: true, paragraphMarker: "p" }),
    cell({ group: "GEN 1:2", original: "Two", translated: v2 }),
    cell({ group: "GEN 1:3", original: "Three", translated: v3 }),
  ]
}

const page = (cells: CellData[], verseAnchors = false) => buildHtmlPage(cells, { now: new Date("2026-11-21T00:00:00Z"), verseAnchors })

describe("buildHtmlPage reads a translation's layout lead", () => {
  it("draws an added section heading as a heading, never as a raw marker", () => {
    const html = page(book("\\s1 La lumière\nDeux"))
    expect(html).toContain('<h3 class="section-heading">La lumière</h3>')
    expect(html).not.toContain("\\s1")
    // The heading sits between verse 1 and verse 2, so verse 2 starts afresh.
    expect(html.indexOf("Un")).toBeLessThan(html.indexOf("La lumière"))
    expect(html.indexOf("La lumière")).toBeLessThan(html.indexOf("Deux"))
  })

  it("opens a new paragraph where the translator broke one", () => {
    const joined = page(book("Deux"))
    expect(joined).toContain('<sup class="verse-number">1</sup> Un <sup class="verse-number">2</sup> Deux')

    const broken = page(book("\\p\nDeux"))
    expect(broken).not.toContain('Un <sup class="verse-number">2</sup>')
    expect(broken).toMatch(/<p class="[^"]*">\s*<sup class="verse-number">2<\/sup> Deux/)
    expect(broken).not.toContain("\\p")
  })

  it("styles a verse as poetry when the lead says so", () => {
    const html = page(book("\\q1\nDeux"))
    expect(html).toMatch(/<p class="[^"]*poetry[^"]*"><sup class="verse-number">2<\/sup> Deux/)
  })

  it("joins a verse to the paragraph above when the lead is \\nb, whatever the source says", () => {
    const cells = book("\\nb\nDeux")
    cells[1] = { ...cells[1], paragraphStart: true, paragraphMarker: "p" }
    expect(page(cells)).toContain('Un <sup class="verse-number">2</sup> Deux')
  })

  it("keeps the source's words, marked, under a value that is only a lead", () => {
    // Decision 0010: a break added before an untranslated verse stores only
    // the lead; the export keeps the source there, and so does the page.
    const html = page(book("\\s1 Titre"))
    expect(html).toContain('<h3 class="section-heading">Titre</h3>')
    expect(html).toMatch(/class="[^"]*untranslated[^"]*"><sup class="verse-number">2<\/sup> Two/)
    expect(html).toContain("1 untranslated line shows the source text")
  })
})

describe("verse anchors", () => {
  it("tags verse numbers with their reference only for the live preview", () => {
    expect(page(book("Deux"), true)).toContain('<sup class="verse-number" data-ref="GEN 1:2">2</sup>')
    // The downloaded page is unchanged.
    expect(page(book("Deux"))).not.toContain("data-ref")
  })
})

describe("isBibleBookFile", () => {
  const verses = [{ group: "RUT 1:1" }]
  const episode = [{ group: "TheChosen-101-en-5-2 1:cue-2642.261-2642.684" }]

  it("counts USFM and eBible files as books before any line has loaded", () => {
    expect(isBibleBookFile("usfm", [])).toBe(true)
    expect(isBibleBookFile("ebible", [])).toBe(true)
  })

  it("counts a file of any other format as a book when its lines carry verse references", () => {
    // The point of AQU-2559's widening: a Bible imported from Word or InDesign
    // gets the document layout and the reading preview too.
    expect(isBibleBookFile("docx", verses)).toBe(true)
    expect(isBibleBookFile("idml", verses)).toBe(true)
    expect(isBibleBookFile("codex", verses)).toBe(true)
  })

  it("does not count a file whose lines are not verses", () => {
    expect(isBibleBookFile("codex", episode)).toBe(false)
    expect(isBibleBookFile("docx", [{ group: "" }])).toBe(false)
    expect(isBibleBookFile(null, [])).toBe(false)
  })
})
