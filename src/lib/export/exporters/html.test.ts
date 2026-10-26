// AQU-2182: the USFM → HTML page. What a reviewer opens from disk must show
// the book, its chapters and numbered verses, never a raw USFM marker, and
// never run anything a translation typed.
import { describe, it, expect } from "vitest"
import { buildHtmlPage, exportHtml } from "./html"
import type { CellData } from "@/hooks/useCells"

function makeCell(overrides: Partial<CellData>): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "In the beginning",
    translated: "Au commencement",
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

const NOW = new Date("2026-10-26T15:04:05Z")

const GENESIS: CellData[] = [
  makeCell({ id: "h1", group: "GEN 1", type: "heading", original: "The creation", translated: "La création" }),
  makeCell({ id: "v1", group: "GEN 1:1", original: "In the beginning", translated: "Au commencement" }),
  makeCell({ id: "v2", group: "GEN 1:2", original: "The earth was formless", translated: "La terre était informe" }),
  makeCell({ id: "v3", group: "GEN 1:3-4", original: "God said", translated: "Dieu dit" }),
  makeCell({ id: "v4", group: "GEN 2:1", original: "Thus the heavens", translated: "Ainsi les cieux" }),
]

describe("buildHtmlPage", () => {
  it("writes one self-contained page: book title, chapter index and numbered verses", () => {
    const html = buildHtmlPage(GENESIS, { fileName: "sample.usfm", now: NOW })

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
    expect(html).toContain("<title>Genesis</title>")
    expect(html).toContain('<h1 class="book-title">Genesis</h1>')
    // Inline CSS, no external stylesheet — the file opens with nothing beside it.
    expect(html).toContain("<style>")
    expect(html).not.toContain("<link")
    // Index links → same-page anchors.
    expect(html).toContain('<a href="#ch-GEN-1">1</a>')
    expect(html).toContain('<a href="#ch-GEN-2">2</a>')
    expect(html).toContain('<section class="chapter" id="ch-GEN-1">')
    expect(html).toContain('<h2 class="chapter-title">Genesis 1</h2>')
    expect(html).toContain('<h2 class="chapter-title">Genesis 2</h2>')
    // Superscript verse numbers, a bridge keeps its range.
    expect(html).toContain('<p class="verse"><sup class="verse-number">1</sup> Au commencement</p>')
    expect(html).toContain('<sup class="verse-number">3-4</sup> Dieu dit')
    expect(html).toContain('<sup class="verse-number">1</sup> Ainsi les cieux')
    // Section headings sit between the verses.
    expect(html).toContain('<h3 class="section-heading">La création</h3>')
    // Chapter 2's verse follows chapter 1's.
    expect(html.indexOf("Au commencement")).toBeLessThan(html.indexOf("Ainsi les cieux"))
  })

  it("chapters follow document order, not alphabetical", () => {
    const cells = [
      makeCell({ id: "a", group: "GEN 2:1", translated: "two" }),
      makeCell({ id: "b", group: "GEN 10:1", translated: "ten" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })
    expect(html.indexOf('href="#ch-GEN-2"')).toBeLessThan(html.indexOf('href="#ch-GEN-10"'))
  })

  it("an untranslated line falls back to its source text and is marked; an empty cell is skipped", () => {
    const cells = [
      makeCell({ id: "v1", group: "GEN 1:1", translated: "Au commencement" }),
      makeCell({ id: "v2", group: "GEN 1:2", original: "The earth was formless", translated: "" }),
      makeCell({ id: "v3", group: "GEN 1:3", original: "", translated: "   " }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain('<p class="verse"><sup class="verse-number">1</sup> Au commencement</p>')
    expect(html).toContain('<p class="verse untranslated"><sup class="verse-number">2</sup> The earth was formless</p>')
    expect(html).not.toContain('verse-number">3</sup>')
    expect(html).toContain("1 untranslated line shows the source text and is marked.")
  })

  it("never shows a raw USFM marker: notes dropped, character markers unwrapped, breaks as line breaks", () => {
    const cells = [
      makeCell({
        id: "v1",
        group: "GEN 1:3",
        translated: "Light\\f + \\fr 1:3 \\ft a note\\f* appeared",
      }),
      makeCell({
        id: "v2",
        group: "GEN 1:4",
        translated: "\\wj Follow me\\wj* said the \\nd Lord\\nd*",
      }),
      makeCell({
        id: "v3",
        group: "GEN 1:5",
        translated: "First line \\q1 second line \\q2 third~line",
      }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain("Light appeared")
    expect(html).not.toContain("a note")
    expect(html).toContain("Follow me said the Lord")
    expect(html).toContain("First line<br>\nsecond line<br>\nthird line")
    expect(html).not.toMatch(/\\(f|fr|ft|wj|nd|q1|q2)\b/)
  })

  it("escapes whatever a translation typed, so nothing runs in the page", () => {
    const cells = [
      makeCell({ id: "v1", group: "GEN 1:1", translated: '<script>alert(1)</script> <b>bold</b> & "quotes"' }),
      makeCell({ id: "h", group: "GEN 1", type: "heading", translated: "<img src=x onerror=alert(1)>" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<b>bold</b>")
    expect(html).not.toContain("<img")
  })

  it("the footer states the export date and the content mode", () => {
    const current = buildHtmlPage(GENESIS, { now: NOW })
    expect(current).toContain("Exported from Aquilla on 2026-10-26.")
    expect(current).toContain("Target translations, current text.")

    const validated = buildHtmlPage(GENESIS, { now: NOW, validatedOnly: true })
    expect(validated).toContain("Target translations, validated only")
  })

  it("carries the exported language on <html> only when it is a language tag", () => {
    expect(buildHtmlPage(GENESIS, { now: NOW, lang: "fr" })).toContain('<html lang="fr">')
    expect(buildHtmlPage(GENESIS, { now: NOW, lang: "pt-BR" })).toContain('<html lang="pt-BR">')
    expect(buildHtmlPage(GENESIS, { now: NOW, lang: "und" })).toContain("<html>\n")
    expect(buildHtmlPage(GENESIS, { now: NOW })).toContain("<html>\n")
    // A lane's language can be a display name — that is not a `lang` value.
    expect(buildHtmlPage(GENESIS, { now: NOW, lang: "Greek" })).toContain("<html>\n")
    expect(buildHtmlPage(GENESIS, { now: NOW, lang: "Burmese plus" })).toContain("<html>\n")
  })

  it("front matter stays above the index; an unreferenced line goes with the next referenced chapter", () => {
    const cells = [
      makeCell({ id: "t", group: "GEN", type: "heading", translated: "Genèse" }),
      makeCell({ id: "v1", group: "GEN 1:1", translated: "Au commencement" }),
      makeCell({ id: "mid", group: "", type: "text", translated: "Inside chapter one" }),
      makeCell({ id: "v1b", group: "GEN 1:2", translated: "La terre" }),
      // An inserted cell with no reference, sitting above 2:1 — it introduces
      // chapter 2 rather than closing chapter 1.
      makeCell({ id: "label", group: "", type: "text", translated: "Chapitre 2" }),
      makeCell({ id: "v2", group: "GEN 2:1", translated: "Ainsi les cieux" }),
      makeCell({ id: "tail", group: "", type: "paratext", translated: "A closing note" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain('<section class="front-matter">\n<h2 class="">Genèse</h2>')
    expect(html.indexOf("Genèse")).toBeLessThan(html.indexOf('class="chapter-index"'))
    const chapter1 = html.slice(html.indexOf('id="ch-GEN-1"'), html.indexOf('id="ch-GEN-2"'))
    const chapter2 = html.slice(html.indexOf('id="ch-GEN-2"'))
    expect(chapter1).toContain("Au commencement")
    expect(chapter1).toContain('<p class="text">Inside chapter one</p>')
    expect(chapter1).toContain("La terre")
    expect(chapter1).not.toContain("Chapitre 2")
    expect(chapter2.indexOf("Chapitre 2")).toBeLessThan(chapter2.indexOf("Ainsi les cieux"))
    expect(chapter2).toContain('<p class="text">A closing note</p>')
  })

  it("titles the page after the file when no cell carries a scripture reference, and skips the index", () => {
    const cells = [
      makeCell({ id: "a", group: "cue-1", type: "text", translated: "First cue" }),
      makeCell({ id: "b", group: "cue-2", type: "text", translated: "Second cue" }),
    ]
    const html = buildHtmlPage(cells, { fileName: "notes.usfm", now: NOW })

    expect(html).toContain("<title>notes</title>")
    expect(html).not.toContain("<nav")
    expect(html).toContain('<p class="text">First cue</p>')
  })
})

describe("exportHtml", () => {
  it("returns an html blob of the page", async () => {
    const blob = exportHtml(GENESIS, { now: NOW })
    expect(blob.type).toBe("text/html;charset=utf-8")
    expect(await blob.text()).toContain("<title>Genesis</title>")
  })
})
