/**
 * AQU-2551: the PDF reader.
 *
 * WHY each group matters:
 *  - A PDF saved by an ordinary producer (macOS print-to-PDF, untagged, two
 *    columns, hyphenation and ligatures) must come out as the paragraphs that
 *    were typed, in reading order. `two-column.pdf` was made for the
 *    feasibility study with its true text beside it.
 *  - A tagged PDF (what Word saves) is read by its tags: headings typed from
 *    them, list bullets and Word's heading numbers dropped as the Word import
 *    never sees them (question 55), running headers left out, footnotes put in
 *    at their mark, and blocks placed in printed order, not tag order.
 *  - An untagged PDF gets no headings at all (Sam's pick: text size gave 16
 *    false headings in one document), and its repeated headers, footers and
 *    page numbers are dropped.
 *  - The two text rules: spacing (a hyphen at a line end joins only a word the
 *    document also has unbroken) and page continuation.
 *  - Scanned, empty and locked PDFs are refused with a reason; a PDF with some
 *    scanned pages imports its text pages and names the others (question 56).
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildPdf, type PdfFixturePage } from "./__fixtures__/build-pdf"
import { splitFootnoteAware } from "./docx"
import { extractPdfImport, PdfReadError } from "./pdf"
import { pdfPagesToParagraphs } from "./pdf-blocks"

const FIXTURES = "src/lib/parsers/__fixtures__/pdf"

function fixture(name: string): ArrayBuffer {
  const b = readFileSync(`${FIXTURES}/${name}`)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

async function paragraphs(buffer: ArrayBuffer): Promise<{ text: string; type: string; context: string }[]> {
  const read = await extractPdfImport(buffer, { cellUnit: "paragraph" })
  return read.strings.map((s) => ({ text: s.original, type: s.type ?? "text", context: s.context }))
}

async function refusal(buffer: ArrayBuffer): Promise<string> {
  try {
    await extractPdfImport(buffer)
  } catch (err) {
    if (err instanceof PdfReadError) return err.code
    throw err
  }
  return "read"
}

/** The true text of two-column.pdf, one paragraph per entry. */
const TWO_COLUMN_TRUTH = [
  "Two Columns of Plain Prose",
  "This page is set in two columns so that a reader must finish the left column before it starts the right one. A reader that sorts every line by its height on the page would weave the two columns together, line by line, and the result would be nonsense.",
  "The official fish fled the office in a flurry of fluffy waffles; five fine fields of flowers flanked the final flight. Typesetters join letters such as f and i into one ligature glyph, and a careful reader must turn that glyph back into two letters.",
  "Internationalization, incomprehensibility and counterrevolutionaries are long words, set here in a narrow column with hyphenation turned on, so that some of them break across a line end with a hyphen that is not part of the word.",
  "Greek: Ἐν ἀρχῇ ἦν ὁ λόγος, καὶ ὁ λόγος ἦν πρὸς τὸν θεόν.",
  "Hebrew: בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ",
  "A paragraph that is long enough to run from the bottom of the first column into the top of the second column tests whether a reader keeps one paragraph whole when it continues in another column. It goes on for a while, with ordinary words and ordinary sentences, so that the column break falls somewhere in its middle rather than at its end. Then it carries on a little further and stops.",
  "The last paragraph is short.",
]

describe("an untagged PDF from an ordinary producer (two columns)", () => {
  it("gives the typed paragraphs in reading order: columns kept, hyphenation and ligatures undone", async () => {
    const read = await paragraphs(fixture("two-column.pdf"))
    // One page cannot show a header repeating, so its running header stays;
    // its page number is dropped. Hebrew marks on one letter may come back in
    // another order that means the same (canonically equivalent), so compare
    // normalized text.
    expect(read.map((p) => p.text.normalize("NFC"))).toEqual(["Test file, AQU-2551", ...TWO_COLUMN_TRUTH].map((t) => t.normalize("NFC")))
  })

  it("types no headings, even for the large title", async () => {
    const read = await paragraphs(fixture("two-column.pdf"))
    expect(read.every((p) => p.type === "text" && p.context === "Paragraph")).toBe(true)
  })

  it("cuts paragraphs into sentences on the Sentence setting with the Word import's splitter", async () => {
    const read = await extractPdfImport(fixture("two-column.pdf"), { cellUnit: "sentence" })
    const long = TWO_COLUMN_TRUTH[6]
    const expected = splitFootnoteAware(long, "sentence").map((s) => s.text)
    expect(expected.length).toBeGreaterThan(1)
    const start = read.strings.findIndex((s) => s.original === expected[0])
    expect(read.strings.slice(start, start + expected.length).map((s) => s.original)).toEqual(expected)
    expect(read.strings[start].paragraphStart).toBe(true)
    expect(read.strings[start + 1].paragraphStart).toBeUndefined()
    expect(new Set(read.strings.slice(start, start + expected.length).map((s) => s.group)).size).toBe(1)
  })

  it("reads a PDF with only an owner (permissions) password like any other", async () => {
    const read = await paragraphs(fixture("owner-only.pdf"))
    expect(read.map((p) => p.text.normalize("NFC"))).toEqual(["Test file, AQU-2551", ...TWO_COLUMN_TRUTH].map((t) => t.normalize("NFC")))
  })
})

/** Three pages with a running header and a page number, one body line each. */
function runningPages(bodies: string[][], size = 11): PdfFixturePage[] {
  return bodies.map((lines, i) => ({
    runs: [
      { text: "Student Notes - Draft", x: 72, y: 800, size: 9, tag: `hdr${i}`, artifact: true },
      ...lines.map((text, k) => ({ text, x: 72, y: 700 - k * 14, size, tag: `p${i}-${k}` })),
      { text: String(i + 1), x: 290, y: 40, size: 9, tag: `pg${i}`, artifact: true },
    ],
  }))
}

describe("an untagged PDF read by its layout", () => {
  it("drops headers and page numbers that repeat on three or more pages", async () => {
    const pdf = buildPdf({ pages: runningPages([["First page text."], ["Second page text."], ["Third page text."]]) })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual(["First page text.", "Second page text.", "Third page text."])
  })

  it("joins a line-end hyphen only for a word the document has unbroken", async () => {
    const pdf = buildPdf({ pages: [{ runs: [
      { text: "The columns of this book are narrow, so the col-", x: 72, y: 700 },
      { text: "umns break words, but non-", x: 72, y: 686 },
      { text: "commercial use keeps its hyphen.", x: 72, y: 672 },
    ] }] })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual([
      "The columns of this book are narrow, so the columns break words, but non-commercial use keeps its hyphen.",
    ])
  })

  it("runs a dash at a line end on without a space when it is attached to its word", async () => {
    const pdf = buildPdf({ pages: [{ runs: [
      { text: "See the notes on pages 57–", x: 72, y: 700 },
      { text: "58 for more —", x: 72, y: 686 },
      { text: "and the table.", x: 72, y: 672 },
    ] }] })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual(["See the notes on pages 57–58 for more — and the table."])
  })

  it("continues a paragraph cut mid-sentence by the page foot on the next page", async () => {
    const pdf = buildPdf({ pages: runningPages([
      ["Done.", "This paragraph runs to the full width and is cut by the"],
      ["page foot and goes on here.", "Then a new paragraph starts on a line of full width."],
      ["The end."],
    ]) })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual([
      "Done.",
      "This paragraph runs to the full width and is cut by the page foot and goes on here.",
      "Then a new paragraph starts on a line of full width.",
      "The end.",
    ])
  })

  it("never runs a larger heading line into the paragraph before it", async () => {
    const pdf = buildPdf({ pages: [
      { runs: [{ text: "Body text that stops without a full stop", x: 72, y: 700 }] },
      { runs: [{ text: "Chapter Two", x: 72, y: 740, size: 18 }, { text: "More body text.", x: 72, y: 700 }] },
    ] })
    const read = await paragraphs(pdf)
    expect(read.map((p) => p.text)).toEqual(["Body text that stops without a full stop", "Chapter Two", "More body text."])
    expect(read.every((p) => p.type === "text")).toBe(true)
  })

  it("drops a leading bullet glyph", async () => {
    const pdf = buildPdf({ pages: [{ runs: [
      { text: "• First point.", x: 72, y: 700 },
      { text: "• Second point.", x: 72, y: 686 },
    ] }] })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual(["First point.", "Second point."])
  })

  it("puts a footnote in at its raised mark", async () => {
    const pdf = buildPdf({ pages: [{ runs: [
      { text: "Body text with a note", x: 72, y: 700 },
      { text: "1", x: 190, y: 704, size: 7 },
      { text: " and more after it.", x: 195, y: 700 },
      { text: "Second body line here.", x: 72, y: 686 },
      { text: "1 The note says this.", x: 72, y: 100, size: 8 },
    ] }] })
    const text = (await paragraphs(pdf)).map((p) => p.text)
    expect(text).toEqual(["Body text with a note\\f + \\ft The note says this.\\f* and more after it. Second body line here."])
  })
})

describe("a tagged PDF read by its tags", () => {
  const tagged = () => buildPdf({
    pages: [
      { runs: [
        { text: "Running Header", x: 72, y: 800, size: 9, artifact: true },
        { text: "1.1. The Origin of Texts", x: 72, y: 740, size: 16, tag: "h" },
        { text: "A paragraph with a note", x: 72, y: 700, tag: "p1" },
        { text: "1", x: 196, y: 705, size: 7, tag: "mark" },
        { text: "that runs on.", x: 72, y: 686, tag: "p1b" },
        { text: "•", x: 72, y: 660, tag: "lbl1" },
        { text: "First item", x: 84, y: 660, tag: "li1" },
        { text: "2.", x: 72, y: 646, tag: "lbl2" },
        { text: "Second item", x: 84, y: 646, tag: "li2" },
        { text: "This paragraph is cut by the page", x: 72, y: 620, tag: "p2" },
        { text: "1 The note text.", x: 72, y: 100, size: 8, tag: "note" },
        { text: "1", x: 290, y: 40, size: 9, artifact: true },
      ] },
      { runs: [
        { text: "Running Header", x: 72, y: 800, size: 9, artifact: true },
        { text: "foot and goes on.", x: 72, y: 740, tag: "p3" },
        { text: "2 Corinthians", x: 72, y: 700, size: 14, tag: "h2" },
        { text: "2", x: 290, y: 40, size: 9, artifact: true },
      ] },
    ],
    structure: [{ role: "Document", children: [
      { role: "H2", children: [{ role: "Span", id: "h" }] },
      { role: "P", children: [
        { role: "Span", id: "p1" },
        { role: "Span", id: "mark" },
        { role: "Note", children: [{ role: "Span", id: "note" }] },
        { role: "Span", id: "p1b" },
      ] },
      { role: "L", children: [
        { role: "LI", children: [{ role: "Lbl", id: "lbl1" }, { role: "LBody", id: "li1" }] },
        { role: "LI", children: [{ role: "Lbl", id: "lbl2" }, { role: "LBody", id: "li2" }] },
      ] },
      { role: "P", id: "p2" },
      { role: "P", id: "p3" },
      { role: "H1", id: "h2" },
    ] }],
  })

  it("types headings from the tags, drops labels, artifacts and Word's heading numbers, and inlines the footnote", async () => {
    const read = await extractPdfImport(tagged(), { cellUnit: "paragraph" })
    expect(read.tagged).toBe(true)
    expect(read.strings.map((s) => [s.type, s.context, s.original])).toEqual([
      ["heading", "Heading 2", "The Origin of Texts"],
      ["text", "Paragraph", "A paragraph with a note\\f + \\ft The note text.\\f* that runs on."],
      ["text", "Paragraph", "First item"],
      ["text", "Paragraph", "Second item"],
      ["text", "Paragraph", "This paragraph is cut by the page foot and goes on."],
      // a bare number with no dot is the heading's own text
      ["heading", "Heading 1", "2 Corinthians"],
    ])
  })

  it("drops every form of Word's heading numbers", async () => {
    const headings = ["3.1 External Evidence", "2.1.1.2.Homoioteleuton", "1. Introduction", "2.1. Causes"]
    const pdf = buildPdf({
      pages: [{ runs: headings.map((text, i) => ({ text, x: 72, y: 700 - i * 30, size: 14, tag: `h${i}` })) }],
      structure: [{ role: "Document", children: headings.map((_, i) => ({ role: "H3", id: `h${i}` })) }],
    })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual(["External Evidence", "Homoioteleuton", "Introduction", "Causes"])
  })

  it("places blocks in the order they are drawn, not the order they are tagged", async () => {
    const pdf = buildPdf({
      pages: [{ runs: [
        { text: "Drawn first.", x: 72, y: 700, tag: "a" },
        { text: "Drawn second.", x: 72, y: 680, tag: "b" },
      ] }],
      structure: [{ role: "Document", children: [{ role: "P", id: "b" }, { role: "P", id: "a" }] }],
    })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual(["Drawn first.", "Drawn second."])
  })

  it("falls back to the layout when the tags reach little of the text", async () => {
    const pdf = buildPdf({
      pages: [{ runs: [
        { text: "Tagged line.", x: 72, y: 700, tag: "a" },
        { text: "An untagged paragraph that holds most of the page's text, far more than the tagged line.", x: 72, y: 600 },
      ] }],
      structure: [{ role: "Document", children: [{ role: "H1", id: "a" }] }],
    })
    const read = await extractPdfImport(pdf, { cellUnit: "paragraph" })
    expect(read.tagged).toBe(false)
    expect(read.strings.every((s) => s.type === "text")).toBe(true)
  })
})

describe("right-to-left text", () => {
  it("puts each letter's marks back after the letter pdf.js put them before", () => {
    // pdf.js gives "בְּרֵאשִׁית" with every run of marks before its letter
    const reversed = "ְּבֵראִׁשית"
    const read = pdfPagesToParagraphs([{
      n: 1, w: 595, h: 842, tree: null,
      items: [{ s: reversed, x: 100, y: 700, b: 0, w: 60, h: 11, eol: false, dir: "rtl" }],
    }], (t) => t)
    expect(read.paragraphs.map((p) => p.text)).toEqual(["בְּרֵאשִׁית"])
  })
})

describe("PDFs with no text to import (question 56)", () => {
  it("refuses a scanned PDF", async () => {
    expect(await refusal(buildPdf({ pages: [{ image: true }, { image: true }] }))).toBe("scanned")
  })

  it("refuses an empty PDF", async () => {
    expect(await refusal(fixture("blank.pdf"))).toBe("empty")
    expect(await refusal(buildPdf({ pages: [{}] }))).toBe("empty")
  })

  it("refuses a password-protected PDF", async () => {
    expect(await refusal(fixture("locked.pdf"))).toBe("password")
  })

  it("refuses a file that is not a PDF", async () => {
    expect(await refusal(new TextEncoder().encode("not a pdf at all").buffer)).toBe("unreadable")
  })

  it("imports the text pages of a partly scanned PDF and names the image-only pages", async () => {
    const pdf = buildPdf({ pages: [
      { runs: [{ text: "Page one has text.", x: 72, y: 700 }] },
      { image: true },
      { runs: [{ text: "Page three has text.", x: 72, y: 700 }] },
      { image: true },
    ] })
    const read = await extractPdfImport(pdf, { cellUnit: "paragraph" })
    expect(read.strings.map((s) => s.original)).toEqual(["Page one has text.", "Page three has text."])
    expect(read.imageOnlyPages).toEqual([2, 4])
  })
})
