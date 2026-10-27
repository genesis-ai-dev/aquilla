// AQU-2182: the USFM → HTML page. What a reviewer opens from disk must show
// the book, its chapters and numbered verses, never a raw USFM marker, and
// never run anything a translation typed.
import { describe, it, expect } from "vitest"
import { buildHtmlPage, exportHtml, hasBibleVerses } from "./html"
import type { CellData } from "@/hooks/useCells"
import { buildBulkCellsWithSpeakers } from "@/lib/import"
import { usfmSectionToStrings } from "@/lib/parsers/parse-text-formats"

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

  it("never shows a raw USFM marker: notes become markers, character markers styling, breaks poetry lines", () => {
    // AQU-2182 dropped note bodies and flattened every break to a <br>;
    // AQU-2184 keeps the note and the poetry level. Either way, no marker
    // token reaches the page.
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

    expect(html).toContain('Light<sup class="note-marker footnote">')
    expect(html).toContain('<span class="note-text">a note</span>')
    expect(html).toContain('<span class="wj">Follow me</span> said the <span class="small-caps">Lord</span>')
    expect(html).toContain('<p class="verse"><sup class="verse-number">5</sup> First line</p>')
    expect(html).toContain('<p class="poetry poetry-1">second line</p>')
    expect(html).toContain('<p class="poetry poetry-2">third line</p>')
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

  // AQU-2210: a migrated Codex book types every verse `text` (target rows carry
  // no type at all), so its verses are recognisable only by their reference.
  it("numbers a Codex book's verses, which are typed text and known only by their ref", () => {
    const cells = [
      makeCell({ id: "a", group: "RUT 1:1", type: "text", translated: "In the days" }),
      makeCell({ id: "b", group: "RUT 1:2", type: "text", translated: "The man's name" }),
      makeCell({ id: "c", group: "RUT 2:1", type: "text", translated: "Naomi had a relative" }),
    ]
    const html = buildHtmlPage(cells, { fileName: "RUT", now: NOW })

    expect(html).toContain('<h1 class="book-title">Ruth</h1>')
    expect(html).toContain('<p class="verse"><sup class="verse-number">1</sup> In the days</p>')
    expect(html).toContain('<sup class="verse-number">2</sup> The man')
    expect(html).toContain('<sup class="verse-number">1</sup> Naomi had a relative')
    expect(html).not.toContain('<p class="text">')
  })

  it("a cue ref, a non-Bible work, a bare chapter ref or a structural cell is never numbered as a verse", () => {
    const cells = [
      makeCell({ id: "cue", group: "TheChosen-106 1:cue-834.376-835.294", type: "text", translated: "A cue" }),
      makeCell({ id: "pp", group: "PilgrimsProgress 1:13", type: "text", translated: "He answered" }),
      makeCell({ id: "chap", group: "GEN 5", type: "text", translated: "Before the first verse" }),
      makeCell({ id: "para", group: "GEN 5:1", type: "paratext", translated: "An intro line" }),
      makeCell({ id: "v", group: "GEN 5:1", type: "verse", translated: "This is the book" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain('<p class="text">A cue</p>')
    expect(html).toContain('<p class="text">He answered</p>')
    expect(html).toContain('<p class="text">Before the first verse</p>')
    expect(html).toContain('<p class="text">An intro line</p>')
    expect(html.match(/class="verse-number"/g)).toHaveLength(1)
  })
})

// AQU-2210: what decides whether a `codex` file is offered the page at all.
describe("hasBibleVerses", () => {
  it("is true for a file whose lines carry a Bible verse reference", () => {
    expect(hasBibleVerses([{ group: "" }, { group: "RUT 1:1" }])).toBe(true)
  })

  it("is false for cue refs, a non-Bible work's chapter:verse refs, bare chapters and no refs", () => {
    expect(hasBibleVerses([{ group: "TheChosen-101-en-5-2 1:cue-2642.261-2642.684" }])).toBe(false)
    expect(hasBibleVerses([{ group: "PilgrimsProgress 1:13" }, { group: "PilgrimsProgress 10:1" }])).toBe(false)
    expect(hasBibleVerses([{ group: "GEN 5" }, { group: "GEN intro" }])).toBe(false)
    expect(hasBibleVerses([{ group: "" }])).toBe(false)
    expect(hasBibleVerses([])).toBe(false)
  })
})

describe("exportHtml", () => {
  it("returns an html blob of the page", async () => {
    const blob = exportHtml(GENESIS, { now: NOW })
    expect(blob.type).toBe("text/html;charset=utf-8")
    expect(await blob.text()).toContain("<title>Genesis</title>")
  })
})

// ── AQU-2184: the book's layout ──────────────────────────────────────────────
//
// AQU-2182's page printed one plain block per verse. These lock the structure
// the reviewer actually reads: paragraphs that verses flow inside, poetry
// indented by level, the team's footnotes reachable and attributable, and
// character styles and heading kinds that still say what they said in the
// USFM. The paragraph structure is the SOURCE's, so it also has to hold on a
// Target page whose translations carry no markers at all.

describe("buildHtmlPage — layout (AQU-2184)", () => {
  it("verses flow together inside their paragraph, and a paragraph marker starts a new one", () => {
    const cells = [
      makeCell({ id: "v1", group: "GEN 1:1", paragraphStart: true, paragraphMarker: "p", translated: "In the beginning" }),
      makeCell({ id: "v2", group: "GEN 1:2", translated: "The earth was formless" }),
      makeCell({ id: "v3", group: "GEN 1:3", paragraphStart: true, paragraphMarker: "p", translated: "God said" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain(
      '<p class="para"><sup class="verse-number">1</sup> In the beginning <sup class="verse-number">2</sup> The earth was formless</p>',
    )
    expect(html).toContain('<p class="para"><sup class="verse-number">3</sup> God said</p>')
  })

  it("\\nb continues the paragraph above it rather than opening one", () => {
    // In USFM \\nb is "no break": the importer records no paragraph start for
    // the verse after it, so the verse simply continues.
    const cells = [
      makeCell({ id: "v1", group: "GEN 1:1", paragraphStart: true, paragraphMarker: "p", translated: "first" }),
      makeCell({ id: "v2", group: "GEN 1:2", translated: "second" }),
    ]
    expect(buildHtmlPage(cells, { now: NOW })).toContain(
      '<p class="para"><sup class="verse-number">1</sup> first <sup class="verse-number">2</sup> second</p>',
    )
  })

  it("poetry lines each stand on their own, indented by level, with \\b a blank line", () => {
    const cells = [
      makeCell({
        id: "v1",
        group: "PSA 1:1",
        paragraphStart: true,
        paragraphMarker: "q1",
        translated: "Blessed is the man,\n\\q2 nor stand on the path,\n\\q2 nor sit in the seat;\n\\q1",
      }),
      makeCell({ id: "v2", group: "PSA 1:2", paragraphStart: true, paragraphMarker: "q1", translated: "but his delight,\n\\b\n\\p" }),
      makeCell({ id: "v3", group: "PSA 1:3", paragraphStart: true, paragraphMarker: "p", translated: "He is like a tree" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain('<p class="poetry poetry-1"><sup class="verse-number">1</sup> Blessed is the man,</p>')
    expect(html).toContain('<p class="poetry poetry-2">nor stand on the path,</p>')
    expect(html).toContain('<p class="poetry poetry-2">nor sit in the seat;</p>')
    // The bare \\q1 that ends verse 1 governs verse 2 — it leaves no empty line.
    expect(html).not.toContain('<p class="poetry poetry-1"></p>')
    // \\q2 is indented further than \\q1 on the page, not merely labelled so.
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"))
    expect(css).toContain(".poetry-1{padding-left:1.25rem}")
    expect(css).toContain(".poetry-2{padding-left:2.5rem}")
    // The \\b at the end of verse 2 is the blank line above verse 3.
    expect(html).toContain('<div class="blank-line"></div>\n<p class="para"><sup class="verse-number">3</sup> He is like a tree</p>')
  })

  it("a footnote is a marker linked to its chapter's notes list, and back; markers restart per chapter", () => {
    const cells = [
      makeCell({
        id: "v1",
        group: "PSA 1:2",
        paragraphStart: true,
        paragraphMarker: "p",
        translated: "the law\\f + \\fr 1:2 \\ft of Yahweh\\f* is his delight\\f + \\fr 1:2 \\ft a second note\\f*",
      }),
      makeCell({ id: "v2", group: "PSA 2:1", paragraphStart: true, paragraphMarker: "p", translated: "Why\\f + \\fr 2:1 \\ft chapter two's first\\f* do the nations rage" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })
    const chapter1 = html.slice(html.indexOf('id="ch-PSA-1"'), html.indexOf('id="ch-PSA-2"'))
    const chapter2 = html.slice(html.indexOf('id="ch-PSA-2"'))

    expect(chapter1).toContain('the law<sup class="note-marker footnote"><a id="ch-PSA-1-n1-ref" href="#ch-PSA-1-n1">1</a></sup>')
    expect(chapter1).toContain('<a id="ch-PSA-1-n2-ref" href="#ch-PSA-1-n2">2</a>')
    expect(chapter1).toContain('<li class="note footnote" id="ch-PSA-1-n1">')
    expect(chapter1).toContain('<a class="note-back" href="#ch-PSA-1-n1-ref" aria-label="Back to text">1</a>')
    expect(chapter1).toContain('<span class="note-ref">1:2</span> <span class="note-text">of Yahweh</span>')
    // The notes list closes the chapter it belongs to — it is inside that section.
    expect(chapter1.indexOf("is his delight")).toBeLessThan(chapter1.indexOf('<aside class="notes"'))
    // Chapter two numbers from 1 again, and holds only its own note.
    expect(chapter2).toContain('<a id="ch-PSA-2-n1-ref" href="#ch-PSA-2-n1">1</a>')
    expect(chapter2).toContain("chapter two&#39;s first")
    expect(chapter2).not.toContain("of Yahweh")
  })

  it("cross-references are listed too, and are distinguishable from footnotes", () => {
    const cells = [
      makeCell({
        id: "v1",
        group: "PSA 1:3",
        paragraphStart: true,
        paragraphMarker: "p",
        translated: "a tree\\x + \\xo 1:3 \\xt Jer 17:8\\x* by water\\f + \\fr 1:3 \\ft a footnote\\f*",
      }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain('<sup class="note-marker xref"><a id="ch-PSA-1-x1-ref" href="#ch-PSA-1-x1">a</a></sup>')
    expect(html).toContain('<li class="note xref" id="ch-PSA-1-x1">')
    expect(html).toContain('<span class="note-text">Jer 17:8</span>')
    // Same list, different label series and class: a reader can tell them apart.
    expect(html).toContain('<li class="note footnote" id="ch-PSA-1-n1">')
  })

  it("character styles survive as styling, and no marker token is visible", () => {
    const cells = [
      makeCell({
        id: "v1",
        group: "MAT 5:1",
        paragraphStart: true,
        paragraphMarker: "p",
        translated: "\\bd Bold\\bd* \\it italic\\it* \\add supplied\\add* \\bdit both\\bdit* \\sc caps\\sc* \\nd Lord\\nd* \\wj mine\\wj* \\zzz unknown\\zzz*",
      }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain(
      '<strong>Bold</strong> <em>italic</em> <em>supplied</em> <strong><em>both</em></strong> ' +
        '<span class="small-caps">caps</span> <span class="small-caps">Lord</span> <span class="wj">mine</span> unknown',
    )
    expect(html).not.toMatch(/\\(bd|it|add|bdit|sc|nd|wj|zzz)\b/)
  })

  it("section headings, parallel-passage references and psalm titles each get their own style", () => {
    const cells = [
      makeCell({ id: "ms", group: "PSA 1:ms:1", type: "heading", translated: "Book One" }),
      makeCell({ id: "d", group: "PSA 1:d:1", type: "heading", translated: "A Psalm of David." }),
      makeCell({ id: "s", group: "PSA 1:s1:1", type: "heading", translated: "The two ways" }),
      makeCell({ id: "r", group: "PSA 1:r:1", type: "heading", translated: "(Matthew 7:13)" }),
      makeCell({ id: "v1", group: "PSA 1:1", paragraphStart: true, paragraphMarker: "q1", translated: "Blessed is the man" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain('<h2 class="major-heading">Book One</h2>')
    expect(html).toContain('<p class="psalm-title">A Psalm of David.</p>')
    expect(html).toContain('<h3 class="section-heading">The two ways</h3>')
    expect(html).toContain('<p class="parallel-ref">(Matthew 7:13)</p>')
    // A verse reference is not a heading marker, whatever its shape.
    expect(html).toContain('<p class="poetry poetry-1"><sup class="verse-number">1</sup> Blessed is the man</p>')
  })

  it("a Target page whose translations carry no markers keeps the source's layout", () => {
    // paragraphStart / paragraphMarker ride the SOURCE row, so the structure
    // is the book's even when the translator typed plain prose.
    const cells = [
      makeCell({ id: "v1", group: "PSA 1:1", paragraphStart: true, paragraphMarker: "q1", original: "\\q1 source", translated: "Heureux l'homme" }),
      makeCell({ id: "v2", group: "PSA 1:2", paragraphStart: true, paragraphMarker: "q2", original: "source", translated: "mais il se plaît" }),
      makeCell({ id: "v3", group: "PSA 1:3", paragraphStart: true, paragraphMarker: "p", original: "source", translated: "Il est comme un arbre" }),
      makeCell({ id: "v4", group: "PSA 1:4", original: "source", translated: "planté près de l'eau" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain('<p class="poetry poetry-1"><sup class="verse-number">1</sup> Heureux l&#39;homme</p>')
    expect(html).toContain('<p class="poetry poetry-2"><sup class="verse-number">2</sup> mais il se plaît</p>')
    expect(html).toContain(
      '<p class="para"><sup class="verse-number">3</sup> Il est comme un arbre <sup class="verse-number">4</sup> planté près de l&#39;eau</p>',
    )
  })

  it("an untranslated verse inside a translated paragraph is still marked", () => {
    const cells = [
      makeCell({ id: "v1", group: "GEN 1:1", paragraphStart: true, paragraphMarker: "p", translated: "Au commencement" }),
      makeCell({ id: "v2", group: "GEN 1:2", original: "The earth was formless", translated: "" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain(
      '<p class="para"><sup class="verse-number">1</sup> Au commencement ' +
        '<span class="untranslated"><sup class="verse-number">2</sup> The earth was formless</span></p>',
    )
    expect(html).toContain("1 untranslated line shows the source text and is marked.")
  })

  it("a scope that drops cells leaves no orphan notes, and renumbers what is left", () => {
    // Validated-only, a chapter range and hidden cells are all applied before
    // the exporter sees the array, so a dropped verse's note simply is not
    // there and the ones that remain number from 1.
    const all = [
      makeCell({ id: "v1", group: "GEN 1:1", paragraphStart: true, paragraphMarker: "p", translated: "first\\f + \\fr 1:1 \\ft dropped note\\f*" }),
      makeCell({ id: "v2", group: "GEN 1:2", paragraphStart: true, paragraphMarker: "p", translated: "second\\f + \\fr 1:2 \\ft kept note\\f*" }),
    ]
    const html = buildHtmlPage(all.slice(1), { now: NOW, validatedOnly: true })

    expect(html).not.toContain("dropped note")
    expect(html).toContain('<span class="note-text">kept note</span>')
    expect(html).toContain('<a id="ch-GEN-1-n1-ref" href="#ch-GEN-1-n1">1</a>')
    expect(html).not.toContain("n2")
  })

  it("a footnote whose text is markup shows those characters and runs nothing", () => {
    const cells = [
      makeCell({
        id: "v1",
        group: "GEN 1:1",
        paragraphStart: true,
        paragraphMarker: "p",
        translated: "text\\f + \\fr 1:1 \\ft <script>alert(1)</script>\\f*",
      }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>alert(1)")
  })

  it("print keeps the poetry indents and the chapter's notes on the page", () => {
    const print = buildHtmlPage(GENESIS, { now: NOW })
    const media = print.slice(print.indexOf("@media print"))
    expect(media).toContain(".chapter-index,.metadata{display:none}")
    expect(media).not.toContain(".notes{display:none}")
    expect(media).toContain(".notes{break-inside:avoid")
    expect(media).toContain(".poetry{break-inside:avoid}")
  })

  it("a file that imported no paragraph structure keeps AQU-2182's block per cell", () => {
    // Every non-scripture import carries no paragraph flags at all. Inventing
    // breaks it never imported would be a guess, so the page stays as it was —
    // while inline markers are still typeset.
    const cells = [
      makeCell({ id: "v1", group: "GEN 1:1", translated: "In the beginning" }),
      makeCell({ id: "v2", group: "GEN 1:2", translated: "The earth was \\bd formless\\bd*" }),
      makeCell({ id: "t", group: "", type: "text", translated: "A line\nand another" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain('<p class="verse"><sup class="verse-number">1</sup> In the beginning</p>')
    expect(html).toContain('<p class="verse"><sup class="verse-number">2</sup> The earth was <strong>formless</strong></p>')
    // A translation typed across two lines still reads as two lines.
    expect(html).toContain('<p class="text">A line<br>\nand another</p>')
    expect(html).not.toContain('class="para"')
  })

  it("scripture imported before the marker was captured still flows in its paragraphs", () => {
    // `paragraphStart` predates AQU-2184, so an older USFM import lays out as
    // prose paragraphs; only the poetry level of a paragraph's FIRST line is
    // missing. A continuation line carries its own marker in the cell text and
    // indents either way.
    const cells = [
      makeCell({ id: "v1", group: "PSA 1:1", paragraphStart: true, translated: "Blessed is the man,\n\\q2 nor stand on the path," }),
      makeCell({ id: "v2", group: "PSA 1:2", translated: "but his delight" }),
    ]
    const html = buildHtmlPage(cells, { now: NOW })

    expect(html).toContain('<p class="para"><sup class="verse-number">1</sup> Blessed is the man,</p>')
    // Verse 2 opened no paragraph, so it continues the line that was open —
    // the `\q2` one — which is what the USFM says, with or without the marker
    // for the paragraph's first line.
    expect(html).toContain('<p class="poetry poetry-2">nor stand on the path, <sup class="verse-number">2</sup> but his delight</p>')
  })
})

// ── The imported book, end to end ────────────────────────────────────────────
//
// The page's structure is only as good as what import actually stored, and the
// paragraph markers are gone from the cell text by then — they sit BETWEEN
// verse spans in the raw USFM. So this walks the real producer (the USFM
// parser + the import mapping) into the real consumer (the page), rather than
// hand-building cells that assume the field is there.

describe("buildHtmlPage — a USFM book through the real import path", () => {
  const PSALM = `\\id PSA
\\h Psalms
\\c 1
\\d A Psalm of David.
\\q1
\\v 1 Blessed is the man who doesn't walk in the counsel of the wicked,
\\q2 nor stand on the path of sinners,
\\q1
\\v 2 but his delight is in the law\\f + \\fr 1:2 \\ft Hebrew: torah\\f* of Yahweh.
\\b
\\p
\\v 3 He will be like a tree\\x + \\xo 1:3 \\xt Jer 17:8\\x* planted by the water,
\\v 4 that produces its fruit in its season.
\\s1 The way of the wicked
\\p
\\v 5 The wicked are like the \\nd chaff\\nd* which the wind drives away.`

  /** The cells the import path would have created for this book. */
  function importedCells(): CellData[] {
    const { strings } = usfmSectionToStrings(PSALM)
    const { cells } = buildBulkCellsWithSpeakers(strings, { fileName: "psa.usfm", fileType: "usfm" })
    return cells.map((cell, i) =>
      makeCell({
        id: cell.cellId,
        group: strings[i].group,
        type: strings[i].type,
        original: cell.value,
        // The Source side of the page: the translation is the imported text.
        translated: cell.value,
        ...(cell.metadata?.paragraphStart === true ? { paragraphStart: true } : {}),
        ...(typeof cell.metadata?.paragraphMarker === "string" ? { paragraphMarker: cell.metadata.paragraphMarker } : {}),
      }),
    )
  }

  it("lays the book out from what import stored: poetry, paragraphs, notes and styles", () => {
    const html = buildHtmlPage(importedCells(), { fileName: "psa.usfm", now: NOW })

    expect(html).toContain('<p class="psalm-title">A Psalm of David.</p>')
    expect(html).toContain("<sup class=\"verse-number\">1</sup> Blessed is the man who doesn&#39;t walk in the counsel of the wicked,")
    expect(html).toContain('<p class="poetry poetry-2">nor stand on the path of sinners,</p>')
    expect(html).toContain('<p class="poetry poetry-1"><sup class="verse-number">2</sup> but his delight is in the law')
    // Verses 3 and 4 share the \\p paragraph; verse 5 opens a new one.
    expect(html).toContain(
      '<sup class="verse-number">3</sup> He will be like a tree<sup class="note-marker xref">' +
        '<a id="ch-PSA-1-x1-ref" href="#ch-PSA-1-x1">a</a></sup> planted by the water, ' +
        '<sup class="verse-number">4</sup> that produces its fruit in its season.',
    )
    expect(html).toContain('<h3 class="section-heading">The way of the wicked</h3>')
    expect(html).toContain('<p class="para"><sup class="verse-number">5</sup> The wicked are like the <span class="small-caps">chaff</span> which the wind drives away.</p>')
    expect(html).toContain('<span class="note-ref">1:2</span> <span class="note-text">Hebrew: torah</span>')
    expect(html).toContain('<li class="note xref" id="ch-PSA-1-x1">')
    // The \\b between verses 2 and 3 is a blank line, not a lost marker.
    expect(html).toContain('<div class="blank-line"></div>')
    // Nothing raw survives anywhere on the page.
    expect(html).not.toMatch(/\\[a-z]+\d*\*?/)
  })
})
