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
import { describe, expect, it, vi } from "vitest"
import { buildPdf, type PdfFixturePage } from "./__fixtures__/build-pdf"
import { splitFootnoteAware } from "./docx"
import { extractPdfImport, PdfReadError } from "./pdf"
import { pdfPagesToParagraphs } from "./pdf-blocks"
import { readPdfImport } from "@/lib/import/pdf-import"

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

// Re-review finding 3 (Nov 14): any two lines on one baseline counted as a
// table row, so a numbered list whose number sits in its own margin column,
// and a glossary (term, then definition), came in split in three. Lines are
// cells only when two or more rows in a row share their column starts.
describe("re-review finding 3: a label beside its text is not a table", () => {
  const L = (y: number, text: string, x = 120) => ({ text, x, y })
  const texts = async (runs: { text: string; x: number; y: number }[]) => (await paragraphs(buildPdf({ pages: [{ runs }] }))).map((p) => p.text)

  it("keeps a numbered list's number with its text", async () => {
    const read = await texts([
      L(700, "1.", 72), L(700, "The first point is long enough that it runs on"), L(686, "to a second line in the same paragraph."),
      L(660, "2.", 72), L(660, "The second point is also long enough to run on"), L(646, "to a second line of its own."),
    ])
    expect(read).toEqual([
      "1. The first point is long enough that it runs on to a second line in the same paragraph.",
      "2. The second point is also long enough to run on to a second line of its own.",
    ])
  })

  it("keeps a glossary's term with its definition", async () => {
    expect(await texts([
      L(700, "Covenant", 72), L(700, "A binding agreement between two parties, made with", 160), L(686, "promises on each side.", 160),
      L(660, "Grace", 72), L(660, "Favour that is given freely and not earned by the", 160), L(646, "one who receives it.", 160),
    ])).toEqual([
      "Covenant A binding agreement between two parties, made with promises on each side.",
      "Grace Favour that is given freely and not earned by the one who receives it.",
    ])
  })

  // AQU-2551 check of fix 2: with one line an item, two items' rows share
  // their column starts, and the list was read as a table.
  it("keeps a one-line list item's number, and a one-line glossary term, with its text", async () => {
    expect(await texts([
      L(700, "1.", 72), L(700, "Pray daily."), L(686, "2.", 72), L(686, "Give thanks."),
    ])).toEqual(["1. Pray daily.", "2. Give thanks."])
    expect(await texts([
      L(700, "Grace:", 72), L(700, "Favour freely given.", 160), L(686, "Hope:", 72), L(686, "Trust in what is to come.", 160),
    ])).toEqual(["Grace: Favour freely given.", "Hope: Trust in what is to come."])
    expect(await texts([
      L(700, "Faith –", 72), L(700, "Trust in God.", 160), L(686, "Love –", 72), L(686, "Care for others.", 160),
    ])).toEqual(["Faith – Trust in God.", "Love – Care for others."])
  })

  it("still reads a table with a numbered first column as a table", async () => {
    expect(await texts([
      L(730, "1.", 72), L(730, "Anna", 250), L(730, "Haifa", 430),
      L(712, "2.", 72), L(712, "Ben", 250), L(712, "Jaffa", 430),
    ])).toEqual(["1.", "Anna", "Haifa", "2.", "Ben", "Jaffa"])
  })

  it("still reads two rows that share their column starts as a table, a cell a paragraph", async () => {
    expect(await texts([
      L(760, "Before the table.", 72),
      L(730, "Name", 72), L(730, "Age", 250), L(730, "Town", 430),
      L(712, "Anna", 72), L(712, "12", 250), L(712, "Haifa", 430),
      L(680, "After the table.", 72),
    ])).toEqual(["Before the table.", "Name", "Age", "Town", "Anna", "12", "Haifa", "After the table."])
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
      ["text", "List Paragraph", "First item"],
      ["text", "List Paragraph", "Second item"],
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

/** AQU-2680: a cell's metadata without the page size and the list label
 *  (each pinned on its own below). */
function meta(s: { metadata?: Record<string, unknown> }): Record<string, unknown> | null {
  const { pageSize: _pageSize, listLabel: _listLabel, ...rest } = s.metadata ?? {}
  return Object.keys(rest).length ? rest : null
}

// AQU-2680: the Word file takes the PDF's page size.
describe("the page size", () => {
  it("is kept on each page's first line, in points", async () => {
    const read = await extractPdfImport(buildPdf({ mediaBox: [0, 0, 612, 792], pages: [
      { runs: [{ text: "First page one.", x: 72, y: 700 }, { text: "First page two, far below.", x: 72, y: 600 }] },
      { runs: [{ text: "Second page.", x: 72, y: 700 }] },
    ] }), { cellUnit: "paragraph" })
    expect(read.strings.map((s) => s.metadata?.pageSize ?? null)).toEqual([{ width: 612, height: 792 }, null, { width: 612, height: 792 }])
  })
})

// AQU-2680: a tagged PDF's lists are lists, so the Word file can number them.
// The label is still dropped from the text (question 55); it says only
// whether the list is bulleted or numbered.
describe("lists in a tagged PDF", () => {
  const item = (lbl: string, body: string) => ({ role: "LI", children: [{ role: "Lbl", id: lbl }, { role: "LBody", id: body }] })
  const listed = () => buildPdf({
    pages: [{ runs: [
      { text: "Before the list.", x: 72, y: 760, tag: "p0" },
      { text: "•", x: 72, y: 740, tag: "l1" }, { text: "Bread for the whole week, bought from the baker on the corner of our street.", x: 84, y: 740, tag: "b1" },
      { text: "It is bought fresh each morning, before the shop gets busy with people.", x: 84, y: 740 - 14, tag: "b1b" },
      { text: "Then it is carried home in a cloth bag and kept in the cool box.", x: 84, y: 740 - 28, tag: "b1c" },
      { text: "o", x: 90, y: 698, tag: "l2" }, { text: "Rye", x: 102, y: 698, tag: "b2" },
      { text: "•", x: 72, y: 684, tag: "l3" }, { text: "Milk", x: 84, y: 684, tag: "b3" },
      { text: "1.", x: 72, y: 662, tag: "n1" }, { text: "Wash", x: 84, y: 662, tag: "c1" },
      { text: "b)", x: 90, y: 648, tag: "n2" }, { text: "Rinse", x: 102, y: 648, tag: "c2" },
      { text: "After the list.", x: 72, y: 622, tag: "p1" },
    ] }],
    structure: [{ role: "Document", children: [
      { role: "P", id: "p0" },
      { role: "L", children: [
        { role: "LI", children: [{ role: "Lbl", id: "l1" }, { role: "LBody", children: [{ role: "Span", id: "b1" }, { role: "Span", id: "b1b" }, { role: "Span", id: "b1c" }, { role: "L", children: [item("l2", "b2")] }] }] },
        item("l3", "b3"),
      ] },
      { role: "L", children: [
        { role: "LI", children: [{ role: "Lbl", id: "n1" }, { role: "LBody", children: [{ role: "Span", id: "c1" }, { role: "L", children: [item("n2", "c2")] }] }] },
      ] },
      { role: "P", id: "p1" },
    ] }],
  })

  it("marks each item a list paragraph, bulleted or numbered, at its depth", async () => {
    const read = await extractPdfImport(listed(), { cellUnit: "paragraph" })
    expect(read.strings.map((s) => [s.context, s.original, meta(s)])).toEqual([
      ["Paragraph", "Before the list.", null],
      ["List Paragraph", "Bread for the whole week, bought from the baker on the corner of our street. It is bought fresh each morning, before the shop gets busy with people. Then it is carried home in a cloth bag and kept in the cool box.", { list: "bullet", listLevel: 0 }],
      ["List Paragraph", "Rye", { list: "bullet", listLevel: 1 }],
      ["List Paragraph", "Milk", { list: "bullet", listLevel: 0 }],
      ["List Paragraph", "Wash", { list: "number", listLevel: 0 }],
      ["List Paragraph", "Rinse", { list: "number", listLevel: 1 }],
      ["Paragraph", "After the list.", null],
    ])
  })

  // AQU-2680 review finding 2: the label as printed goes to the Word export,
  // which restarts a numbered list only where the label says 1, a or i.
  it("keeps each item's label as printed", async () => {
    const read = await extractPdfImport(listed(), { cellUnit: "paragraph" })
    expect(read.strings.map((s) => s.metadata?.listLabel ?? null)).toEqual([null, "\u2022", "o", "\u2022", "1.", "b)", null])
  })

  it("marks every sentence of an item on the Sentence setting", async () => {
    const read = await extractPdfImport(listed(), { cellUnit: "sentence" })
    const bread = read.strings.filter((s) => s.metadata?.listLevel === 0 && s.metadata?.list === "bullet").slice(0, 2)
    expect(bread.map((s) => [s.context, meta(s), s.paragraphStart ?? false])).toEqual([
      ["List Paragraph", { list: "bullet", listLevel: 0 }, true],
      ["List Paragraph", { list: "bullet", listLevel: 0 }, false],
    ])
  })

  it("leaves an untagged PDF's list as plain paragraphs", async () => {
    const read = await extractPdfImport(buildPdf({ pages: [{ runs: [
      { text: "1.", x: 72, y: 700 }, { text: "Pray daily.", x: 120, y: 700 },
      { text: "2.", x: 72, y: 686 }, { text: "Give thanks.", x: 120, y: 686 },
    ] }] }), { cellUnit: "paragraph" })
    expect(read.strings.map((s) => [s.context, s.original, meta(s)])).toEqual([
      ["Paragraph", "1. Pray daily.", null],
      ["Paragraph", "2. Give thanks.", null],
    ])
  })

  // AQU-2680 review finding 1: Word nests each later list in the last item of
  // the list before, so the tags' depth crept (the partner's 1.1.1–1.1.4 came
  // in at depths 0, 1, 2, 2). The label's place on the page says the depth.
  it("takes an item's depth from where its label sits, not from how its tags nest", async () => {
    const read = await extractPdfImport(buildPdf({
      pages: [{ runs: [
        { text: "1.1.1.", x: 74, y: 760, tag: "a" }, { text: "Alexandrian", x: 110, y: 760, tag: "ab" },
        { text: "1.1.2.", x: 74, y: 746, tag: "b" }, { text: "Caesarean", x: 110, y: 746, tag: "bb" },
        { text: "o", x: 128, y: 732, tag: "c" }, { text: "A point under it", x: 140, y: 732, tag: "cb" },
        { text: "1.1.3.", x: 74.5, y: 718, tag: "d" }, { text: "Western", x: 110, y: 718, tag: "db" },
        { text: "Between the lists.", x: 72, y: 700, tag: "p" },
        { text: "\u2022", x: 108, y: 686, tag: "e" }, { text: "Further in, and a list of its own", x: 120, y: 686, tag: "eb" },
      ] }],
      structure: [{ role: "Document", children: [
        { role: "L", children: [{ role: "LI", children: [{ role: "Lbl", id: "a" }, { role: "LBody", children: [{ role: "Span", id: "ab" },
          { role: "L", children: [{ role: "LI", children: [{ role: "Lbl", id: "b" }, { role: "LBody", children: [{ role: "Span", id: "bb" },
            { role: "L", children: [item("c", "cb"), item("d", "db")] }] }] }] }] }] }] },
        { role: "P", id: "p" },
        { role: "L", children: [item("e", "eb")] },
      ] }],
    }), { cellUnit: "paragraph" })
    expect(read.strings.map((s) => [s.original, s.metadata?.listLevel ?? null])).toEqual([
      ["Alexandrian", 0], ["Caesarean", 0], ["A point under it", 1], ["Western", 0],
      ["Between the lists.", null], ["Further in, and a list of its own", 0],
    ])
  })

  // AQU-2680 review finding 4: an item whose text sits in a paragraph of its
  // own (LI > Lbl + LBody > P) lost its list.
  it("keeps an item a list item when its text sits in a paragraph inside it", async () => {
    const read = await extractPdfImport(buildPdf({
      pages: [{ runs: [
        { text: "\u2022", x: 72, y: 760, tag: "l1" }, { text: "Wash the cups first.", x: 84, y: 760, tag: "b1" },
        { text: "\u2022", x: 72, y: 746, tag: "l2" }, { text: "Dry them after.", x: 84, y: 746, tag: "b2" },
        { text: "A second paragraph of the same item.", x: 84, y: 732, tag: "b3" },
      ] }],
      structure: [{ role: "Document", children: [
        { role: "L", children: [
          { role: "LI", children: [{ role: "Lbl", id: "l1" }, { role: "LBody", children: [{ role: "P", id: "b1" }] }] },
          { role: "LI", children: [{ role: "Lbl", id: "l2" }, { role: "LBody", children: [{ role: "P", id: "b2" }, { role: "P", id: "b3" }] }] },
        ] },
      ] }],
    }), { cellUnit: "paragraph" })
    expect(read.strings.map((s) => [s.context, s.original, meta(s)])).toEqual([
      ["List Paragraph", "Wash the cups first.", { list: "bullet", listLevel: 0 }],
      ["List Paragraph", "Dry them after.", { list: "bullet", listLevel: 0 }],
      ["Paragraph", "A second paragraph of the same item.", null],
    ])
  })

  // AQU-2680 review finding 3: an item that runs onto the next page came in
  // as two items, the second half a bullet (three in the partner's PDF).
  it("keeps an item that runs onto the next page as one item", async () => {
    const read = await extractPdfImport(buildPdf({
      pages: [
        { runs: [{ text: "1.", x: 72, y: 100, tag: "n1" }, { text: "The first step goes on and", x: 84, y: 100, tag: "b1" }] },
        { runs: [
          { text: "ends on the next page.", x: 84, y: 760, tag: "b1b" },
          { text: "2.", x: 72, y: 746, tag: "n2" }, { text: "Second step.", x: 84, y: 746, tag: "b2" },
        ] },
      ],
      structure: [{ role: "Document", children: [
        { role: "L", children: [
          { role: "LI", children: [{ role: "Lbl", id: "n1" }, { role: "LBody", id: "b1" }] },
          { role: "LI", children: [{ role: "LBody", id: "b1b" }] },
          { role: "LI", children: [{ role: "Lbl", id: "n2" }, { role: "LBody", id: "b2" }] },
        ] },
      ] }],
    }), { cellUnit: "paragraph" })
    expect(read.strings.map((s) => [s.original, s.metadata?.list, s.metadata?.listLevel])).toEqual([
      ["The first step goes on and ends on the next page.", "number", 0],
      ["Second step.", "number", 0],
    ])
  })
})

// AQU-2680: bold and italic follow a translation only when a whole paragraph
// is bold or italic (a subtitle, a quotation): a bold word inside a sentence
// has no place in the translated sentence (Sam's pick, question 2).
describe("whole-paragraph bold and italic", () => {
  const styled = (structure?: boolean) => buildPdf({
    pages: [{ runs: [
      { text: "A Bold Subtitle", x: 72, y: 770, font: "bold", tag: "a" },
      { text: "An italic quotation that runs", x: 72, y: 730, font: "italic", tag: "b" },
      { text: "onto a second line.", x: 72, y: 716, font: "italic", tag: "b2" },
      { text: "Both at once.", x: 72, y: 690, font: "bold-italic", tag: "c" },
      { text: "Plain text with one", x: 72, y: 660, tag: "d" },
      { text: "bold", x: 170, y: 660, font: "bold", tag: "d2" },
      { text: "word in it.", x: 196, y: 660, tag: "d3" },
    ] }],
    ...(structure ? { structure: [{ role: "Document", children: [
      { role: "P", id: "a" },
      { role: "P", children: [{ role: "Span", id: "b" }, { role: "Span", id: "b2" }] },
      { role: "P", id: "c" },
      { role: "P", children: [{ role: "Span", id: "d" }, { role: "Span", id: "d2" }, { role: "Span", id: "d3" }] },
    ] }] } : {}),
  })
  const EXPECTED = [
    ["A Bold Subtitle", { paragraphBold: true }],
    ["An italic quotation that runs onto a second line.", { paragraphItalic: true }],
    ["Both at once.", { paragraphBold: true, paragraphItalic: true }],
    ["Plain text with one bold word in it.", null],
  ]

  it("marks a paragraph that is all bold or all italic, in an untagged PDF", async () => {
    const read = await extractPdfImport(styled(false), { cellUnit: "paragraph" })
    expect(read.strings.map((s) => [s.original, meta(s)])).toEqual(EXPECTED)
  })

  it("marks a paragraph that is all bold or all italic, in a tagged PDF", async () => {
    const read = await extractPdfImport(styled(true), { cellUnit: "paragraph" })
    expect(read.tagged).toBe(true)
    expect(read.strings.map((s) => [s.original, meta(s)])).toEqual(EXPECTED)
  })

  it("imports without bold and italic when reading the fonts runs past the time limit", async () => {
    // The fonts are read in a second pass over each page's drawing. A page
    // whose drawing never finishes stands in for a slow or low-memory device.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const task = pdfjs.getDocument({ data: new Uint8Array(styled(false)) })
    const proto = Object.getPrototypeOf(await (await task.promise).getPage(1)) as { getOperatorList: () => Promise<unknown> }
    await task.destroy()
    const spy = vi.spyOn(proto, "getOperatorList").mockImplementation(() => new Promise(() => {}))
    try {
      const read = await extractPdfImport(styled(false), { cellUnit: "paragraph", budgetMs: 300 })
      expect(spy).toHaveBeenCalled()
      expect(read.strings.map((s) => [s.original, meta(s)])).toEqual(EXPECTED.map(([t]) => [t, null]))
    } finally {
      spy.mockRestore()
    }
  })
})

describe("review findings (Nov 14)", () => {
  it("keeps the text of an untagged page in a tagged PDF", async () => {
    // the tags reach nine tenths of the text, so the PDF is read by its tags
    const long = (n: number) => `Tagged page ${n} holds a full paragraph of ordinary text, long enough to outweigh the last page.`
    const pdf = buildPdf({
      pages: [
        ...[1, 2, 3].map((n) => ({ runs: [{ text: long(n), x: 72, y: 700, tag: `t${n}` }] })),
        { runs: [{ text: "An untagged page appended later.", x: 72, y: 700 }] },
      ],
      structure: [{ role: "Document", children: [1, 2, 3].map((n) => ({ role: "P", id: `t${n}` })) }],
      untaggedPages: [3],
    })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual([long(1), long(2), long(3), "An untagged page appended later."])
  })

  it("does not run a paragraph that ends in a footnote into the next page", async () => {
    const pdf = buildPdf({
      pages: [
        { runs: [
          { text: "He went home.", x: 72, y: 700, tag: "a" },
          { text: "1", x: 150, y: 704, size: 7, tag: "mark" },
          { text: "1 See Mark 3", x: 72, y: 100, size: 8, tag: "note" },
        ] },
        { runs: [{ text: "A new paragraph begins.", x: 72, y: 700, tag: "b" }] },
      ],
      structure: [{ role: "Document", children: [
        { role: "P", children: [{ role: "Span", id: "a" }, { role: "Span", id: "mark" }, { role: "Note", children: [{ role: "Span", id: "note" }] }] },
        { role: "P", id: "b" },
      ] }],
    })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual(["He went home.\\f + \\ft See Mark 3\\f*", "A new paragraph begins."])
  })

  it("keeps a paragraph that runs over three pages whole, and joins a word hyphenated across a page", async () => {
    const pdf = buildPdf({ pages: runningPages([
      ["Done.", "This long paragraph starts on the first page and its words are con-"],
      ["tinued on the second page, where it fills every line of the page and"],
      ["ends on the third page, as continued text does."],
    ]) })
    // "continued" also appears unbroken, so the hyphen at the page break goes
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual([
      "Done.",
      "This long paragraph starts on the first page and its words are continued on the second page, where it fills every line of the page and ends on the third page, as continued text does.",
    ])
  })

  it("finds running headers on a page whose MediaBox does not start at zero", async () => {
    const shifted = runningPages([["First page text."], ["Second page text."], ["Third page text."]])
      .map((p) => ({ runs: p.runs!.map((r) => ({ ...r, y: r.y + 200 })) }))
    const pdf = buildPdf({ pages: shifted, mediaBox: [0, 200, 595, 1042] })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual(["First page text.", "Second page text.", "Third page text."])
  })

  it("keeps a word at a page foot that only looks like a Roman numeral", async () => {
    const pdf = buildPdf({ pages: [{ runs: [{ text: "Body text.", x: 72, y: 700 }, { text: "civil", x: 72, y: 50 }, { text: "xiv", x: 290, y: 30 }] }] })
    const text = (await paragraphs(pdf)).map((p) => p.text).join(" ")
    expect(text).toContain("civil")
    expect(text).not.toContain("xiv")
  })

  it("keeps a heading that starts with a number written with a thousands point", async () => {
    const pdf = buildPdf({
      pages: [{ runs: [{ text: "10.000 Jahre", x: 72, y: 700, size: 14, tag: "h" }] }],
      structure: [{ role: "Document", children: [{ role: "H1", id: "h" }] }],
    })
    expect((await paragraphs(pdf)).map((p) => p.text)).toEqual(["10.000 Jahre"])
  })
})

describe("right-to-left text", () => {
  it("puts each letter's marks back after the letter pdf.js put them before", () => {
    // pdf.js gives "בְּרֵאשִׁית" with every run of marks before its letter
    const reversed = "ְּבֵראִׁשית"
    const read = pdfPagesToParagraphs([{
      n: 1, box: { x0: 0, y0: 0, x1: 595, y1: 842 }, tree: null,
      items: [{ s: reversed, x: 100, y: 700, b: 0, w: 60, h: 11, eol: false, dir: "rtl" }],
    }], (t) => t)
    expect(read.paragraphs.map((p) => p.text)).toEqual(["בְּרֵאשִׁית"])
  })
})

// Review findings 5, 6 and 10 (Nov 14): an untagged right-to-left PDF read
// as if its lines started at the left edge, a Hebrew phrase in an English
// line split the line, and some vowel marks stayed before their letters.
describe("review findings: right-to-left text (Nov 14)", () => {
  type Piece = { s: string; x: number; y: number; w: number; h?: number; dir?: string; eol?: boolean }
  const page = (pieces: Piece[]) => [{
    n: 1, box: { x0: 0, y0: 0, x1: 595, y1: 842 }, tree: null,
    items: pieces.map((p) => ({ s: p.s, x: p.x, y: p.y, b: 0, w: p.w, h: p.h ?? 12, eol: p.eol ?? false, dir: p.dir ?? "rtl" })),
  }]
  const read = (pieces: Piece[]) => pdfPagesToParagraphs(page(pieces), (t) => t).paragraphs.map((p) => p.text)
  /** One right-to-left line: its text, its right edge and width. */
  const rtlLine = (s: string, y: number, right: number, w: number): Piece => ({ s, x: right - w, y, w, eol: true })

  it("finds paragraphs in right-to-left text by the right edge and a right indent (finding 5)", () => {
    // first lines indented from the right margin (427 against 447), no space
    // between paragraphs, last lines short on the left
    expect(read([
      rtlLine("ספר בראשית נכתב לפני שנים רבות, והוא מספר על בריאת העולם", 751, 427, 260),
      rtlLine("ועל האבות הראשונים של העם.", 736.5, 447, 120),
      rtlLine("בפרק הראשון נברא האור, ובפרק השני נברא האדם הראשון בגן", 722, 427, 255),
      rtlLine("עדן.", 707.5, 447, 20),
      rtlLine("בסוף הספר יורדים בני יעקב למצרים ושם הם גרים שנים רבות עד", 693, 427, 258),
      rtlLine("שיצאו.", 678.5, 447, 25),
    ])).toEqual([
      "ספר בראשית נכתב לפני שנים רבות, והוא מספר על בריאת העולם ועל האבות הראשונים של העם.",
      "בפרק הראשון נברא האור, ובפרק השני נברא האדם הראשון בגן עדן.",
      "בסוף הספר יורדים בני יעקב למצרים ושם הם גרים שנים רבות עד שיצאו.",
    ])
  })

  it("keeps an English line whole around a Hebrew phrase, past pdf.js's zero-height space (finding 6)", () => {
    // pdf.js puts the space after a right-to-left run where the run started
    expect(read([
      { s: "Genesis opens with", x: 155, y: 712, w: 93.3, dir: "ltr" },
      { s: " ", x: 248.3, y: 712, w: 4.2, h: 0, dir: "ltr" },
      { s: "ְּבֵראִׁשית ָּבָרא", x: 251.3, y: 712, w: 53.3 },
      { s: " ", x: 257.1, y: 712, w: 4.2, h: 0, dir: "ltr" },
      { s: "and goes on in English.", x: 307.6, y: 712, w: 112.3, dir: "ltr" },
    ])).toEqual(["Genesis opens with בְּרֵאשִׁית בָּרָא and goes on in English."])
  })

  it("puts marks after their letters in every right-to-left piece, whatever it starts with (finding 10)", () => {
    expect(read([{ s: "ספר ְּבֵראִׁשית", x: 100, y: 700, w: 120 }])).toEqual(["ספר בְּרֵאשִׁית"])
    expect(read([{ s: " ְּבֵראִׁשית", x: 100, y: 700, w: 120 }])).toEqual(["בְּרֵאשִׁית"])
  })

  it("splits a right-to-left table into its cells, row by row (re-review finding 4)", () => {
    // the reviewer's Hebrew table as pdf.js gives it: a word a piece, its
    // number a left-to-right piece, cells about 100 pt apart
    expect(read([
      rtlLine("שם", 751, 445, 13.4), rtlLine("גיל", 751, 335, 12.4), rtlLine("עיר", 751, 225, 14.3),
      rtlLine("דוד", 726.5, 445, 13.4), { s: "12", x: 323, y: 726.5, w: 12, dir: "ltr", eol: true }, rtlLine("חיפה", 726.5, 225, 19.9),
      rtlLine("אחרי הטבלה.", 702, 445, 54),
    ])).toEqual(["שם", "גיל", "עיר", "דוד", "12", "חיפה", "אחרי הטבלה."])
  })

  // The 58-page Word PDF draws "לֹא" as a piece already in reading order: no
  // word in it starts with a mark, which is the sign of pdf.js's reversal.
  it("leaves a right-to-left piece alone when none of its words starts with a mark", () => {
    expect(read([{ s: "לֹא", x: 100, y: 700, w: 14 }])).toEqual(["לֹא"])
  })
})

// Review finding 7 (Nov 14): Arabic came in with altered letters. Arial and
// Times give presentation forms (U+FExx); Geeza Pro draws one glyph for
// several letters, and pdf.js reverses that glyph's text with the run. The
// pieces below are what pdf.js gives for the reviewer's made PDFs, one glyph
// (with its marks) a piece.
describe("review findings: Arabic (Nov 14)", () => {
  /** Pieces drawn one glyph at a time, right to left, as pdf.js gives them. */
  const glyphs = (texts: string[], y = 700) => {
    let x = 500
    return texts.map((s) => { x -= 6; return { s, x, y, b: 0, w: 5, h: 12, eol: false, dir: "rtl" } })
  }
  const read = (texts: string[]) => pdfPagesToParagraphs([{
    n: 1, box: { x0: 0, y0: 0, x1: 595, y1: 842 }, tree: null, items: glyphs(texts),
  }], (t) => t).paragraphs.map((p) => p.text.normalize("NFC"))
  /** Enough ordinary one-letter pieces to show the page is drawn glyph by glyph. */
  const ONE_BY_ONE = ["ذ", "ه", "ب", " ", "ا", "ل", "و", "ل", "د", " "]

  it("reads a glyph that stands for several letters in their order: المدرسة, الله, بَيْنَ", () => {
    expect(read([...ONE_BY_ONE, "ا", "مل", "د", "ر", "س", "ة"])).toEqual(["ذهب الولد المدرسة"])
    expect(read([...ONE_BY_ONE, "ا", "هلل"])).toEqual(["ذهب الولد الله"])
    expect(read([...ONE_BY_ONE, "\u064e\u0628", "\u064e\u0652\u0646\u064a"])).toEqual(["ذهب الولد \u0628\u064e\u064a\u0652\u0646\u064e"])
    // pdf.js's exact text for the glyph: kasra, shadda, fatha, then هلل
    expect(read([...ONE_BY_ONE, "ا", "\u0650\u0651\u064e\u0647\u0644\u0644"])).toEqual(["ذهب الولد ا\u0644\u0644\u064e\u0651\u0647\u0650".normalize("NFC")])
  })

  it("turns presentation forms into the letters they show", () => {
    // Arial's lam-alef ligature, and Times's positional forms of قرأ
    expect(read(["ﻻ", " ", "ﻗ", "ﺮ", "أ"])).toEqual(["لا قرأ"])
    // a shadda-with-fatha form inside a word gains no space
    expect(read(["ا", "ﻟ", "ﺰ", "ﱠ", "ﻣ", "َ", "ﺎ", "ن"]).map((t) => t.replace(/\p{Mn}/gu, ""))).toEqual(["الزمان"])
  })

  // Re-review finding 2 (question 79, built to the pick): Arial and Times map
  // the Arabic yeh and heh to the Persian yeh's and the Urdu heh's forms. A
  // document is Persian or Urdu by the letters only they use, read over the
  // whole document; otherwise those forms are the Arabic letters.
  const readDoc = (pages: string[][]) => pdfPagesToParagraphs(pages.map((texts, i) => ({
    n: i + 1, box: { x0: 0, y0: 0, x1: 595, y1: 842 }, tree: null, items: glyphs(texts),
  })), (t) => t).paragraphs.map((p) => p.text)
  // Arial's glyphs, as pdf.js gives them
  const YEH_INI = "\uFBFE", YEH_MED = "\uFBFF", HEH_INI = "\uFBAC", HEH_MED = "\uFBAD", HEH_FIN = "\uFBAB"
  const YAWM = [YEH_INI, "\uFEEE", "\uFEE1"] // يوم
  const HADHA = [HEH_INI, "\uFEAC", "\uFE8E"] // هذا
  const SHAHR = ["\uFEB7", HEH_MED, "\uFEAE"] // شهر
  const KEH = ["\u06A9", HEH_FIN] // که
  const IN = ["\u0627", YEH_INI, "\uFEE6"] // این
  const ZIBA = ["\uFEAF", YEH_INI, "\uFE92", "\uFE8E"] // زیبا
  const AST = ["\uFE8D", "\uFEB3", "\uFE96"] // است
  const PEDAR = ["\uFB58", "\uFEAA", "\uFEAD"] // پدر
  const KETAB = ["\u06A9", "\uFE98", "\uFE8E", "\u0628"] // کتاب

  it("reads Arial's yeh and heh in an Arabic document as the Arabic letters (re-review finding 2)", () => {
    expect(readDoc([[...YAWM, " ", ...HADHA, " ", ...SHAHR]])).toEqual(["يوم هذا شهر"])
  })

  it("does so for the letters themselves too: Arial gives a heh at a word's start as U+06BE", () => {
    // the reviewer's vowelled Arial PDF: "هَذَا" drawn as U+06BE + fatha
    expect(readDoc([["\u064E\u06BE", "\uFEAC", "\uFE8E", " ", "\u06CC", "\uFEEE", "\uFEE1"]]).map((t) => t.normalize("NFC")))
      .toEqual(["\u0647\u064E\u0630\u0627 \u064A\u0648\u0645"])
    expect(readDoc([[...PEDAR, " ", "\u06BE", "\uFEAC", "\uFE8E", " ", "\u06CC"]])).toEqual(["پدر هذا ی"])
  })

  it("keeps the Persian yeh in a Persian document, and gives it the Arabic heh", () => {
    expect(readDoc([[...PEDAR, " ", ...IN, " ", ...SHAHR, " ", ...KEH]])).toEqual(["پدر این شهر که"])
  })

  it("decides by the whole document: a Persian letter on page 2 keeps page 1 Persian", () => {
    expect(readDoc([[...IN, " ", ...SHAHR, "."], [...PEDAR, "."]])).toEqual(["این شهر.", "پدر."])
  })

  it("counts the keheh (ک) as a letter Arabic lacks: short Persian with it stays Persian", () => {
    expect(readDoc([[...IN, " ", ...KETAB, " ", ...KEH]])).toEqual(["این کتاب که"])
  })

  // What question 79 must say plainly: a short Persian text with none of the
  // letters Arabic lacks (no پ چ ژ گ ک) cannot be told from Arabic, so its
  // yeh comes in as the Arabic yeh. Its heh is right either way.
  it("reads short Persian with no letter Arabic lacks as Arabic: its yeh becomes the Arabic yeh", () => {
    expect(readDoc([[...IN, " ", ...SHAHR, " ", ...ZIBA, " ", ...AST]])).toEqual(["اين شهر زيبا است"])
  })

  it("leaves an Urdu document's heh and yeh as they are", () => {
    // یہ ٹھیک: heh goal, tteh, the Urdu heh, the yeh
    expect(readDoc([[YEH_INI, "\uFBA7", " ", "\uFB68", HEH_MED, YEH_MED, "\uFB8F"]])).toEqual(["یہ ٹھیک"])
  })

  // Re-review finding 5: vowelled Arabic in Arial, the reviewer's pieces as
  // pdf.js gives them ("لَا إِلَهَ إِلَّا اللَّهُ"): a lam-alef glyph carries
  // its lam's vowel, and a shadda drawn as its own zero-width piece sat
  // between two words.
  const at = (s: string, x: number, w: number, y = 751) => ({ s, x, y, b: 0, w, h: 12, eol: false, dir: "rtl" })
  const VOWELLED = [
    at("\u064E\uFEFB", 438.5, 6.5), // لَا
    at("\u0650\u0625", 432.7, 2.5), at("\u064E\uFEDF", 430.2, 2.5), at("\u064E\uFBAB", 425.7, 4.5), // إِلَهَ
    at("\u0650\u0625", 419.9, 2.5), at("\uFEFB", 413.3, 6.5), at("\uFC60", 413.1, 0, 752.9), // إِلَّا, its shadda a piece of its own
    at("\uFDF2", 400.5, 9.5), // الله
  ]
  const WORDS = ["\u0644\u064E\u0627", "\u0625\u0650\u0644\u064E\u0647\u064E", "\u0625\u0650\u0644\u064E\u0651\u0627", "\u0627\u0644\u0644\u0647"]

  it("keeps a lam-alef's vowel on the lam, and a zero-width mark piece never joins two words (re-review finding 5)", () => {
    const text = pdfPagesToParagraphs([{ n: 1, box: { x0: 0, y0: 0, x1: 595, y1: 842 }, tree: null, items: VOWELLED }], (t) => t)
      .paragraphs.map((p) => p.text.normalize("NFC"))
    expect(text).toEqual([WORDS.join(" ").normalize("NFC")])
  })

  it("does the same in a tagged PDF", () => {
    const text = pdfPagesToParagraphs([{
      n: 1, box: { x0: 0, y0: 0, x1: 595, y1: 842 },
      items: [{ mc: "begin", id: "p0", tag: "P" }, ...VOWELLED, { mc: "end" }],
      tree: { role: "Root", children: [{ role: "P", children: [{ type: "content", id: "p0" }] }] },
    }], (t) => t).paragraphs.map((p) => p.text.normalize("NFC"))
    expect(text).toEqual([WORDS.join(" ").normalize("NFC")])
  })

  // AQU-2551 check of fix 2: the partner's Hebrew (Num. 14:34, לַשָּׁנָה) draws
  // its points as a zero-width piece just before their letter, so the gap to
  // the letter after the points is no word break.
  const heb = (s: string, x: number, w: number) => ({ s, x, y: 541.3, b: 0, w, h: 11.04, eol: false, dir: "rtl" })
  const POINTED = [heb("ַל", 282.2, 5.11), heb("ָׁ ּ", 271.0, 0), heb("ש", 261.3, 7.66)]

  it("puts no space after Hebrew points drawn on their own just before their letter", () => {
    const layout = pdfPagesToParagraphs([{ n: 1, box: { x0: 0, y0: 0, x1: 595, y1: 842 }, tree: null, items: POINTED }], (t) => t)
    const tagged = pdfPagesToParagraphs([{
      n: 1, box: { x0: 0, y0: 0, x1: 595, y1: 842 },
      items: [{ mc: "begin", id: "p0", tag: "P" }, ...POINTED, { mc: "end" }],
      tree: { role: "Root", children: [{ role: "P", children: [{ type: "content", id: "p0" }] }] },
    }], (t) => t)
    for (const read of [layout, tagged]) expect(read.paragraphs.map((p) => p.text)).toEqual([expect.stringMatching(/ּש$/)])
  })

  it("does not reverse a right-to-left piece that holds a whole word", () => {
    const words = pdfPagesToParagraphs([{
      n: 1, box: { x0: 0, y0: 0, x1: 595, y1: 842 }, tree: null,
      items: [{ s: "ذهب الولد إلى المدرسة", x: 300, y: 700, b: 0, w: 120, h: 12, eol: false, dir: "rtl" }],
    }], (t) => t).paragraphs.map((p) => p.text)
    expect(words).toEqual(["ذهب الولد إلى المدرسة"])
  })
})

// Review finding 11 (Nov 14): a damaged PDF showed pdf.js's raw English
// ("Pages tree contains circular reference.") or told the person to reload
// the page. The reviewer's two files, written here.
describe("review findings: damaged PDFs (Nov 14)", () => {
  /** A one-page PDF whose page tree is `pagesDict`. */
  function damaged(pagesDict: string): ArrayBuffer {
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      pagesDict,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Length 46 >>\nstream\nBT /F1 12 Tf 72 700 Td (Hello page one.) Tj ET\nendstream",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
    ]
    let out = "%PDF-1.7\n"
    const offsets: number[] = []
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
    const xref = out.length
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return new TextEncoder().encode(out).buffer as ArrayBuffer
  }

  it("says a PDF whose page tree loops could not be read as a PDF", async () => {
    await expect(readPdfImport(damaged("<< /Type /Pages /Kids [5 0 R 2 0 R] /Count 2 >>"))).rejects.toThrow(/^This file could not be read as a PDF\.$/)
  })

  it("reads the pages a PDF has when it counts more than it has", async () => {
    const read = await readPdfImport(damaged("<< /Type /Pages /Kids [5 0 R] /Count 3 >>"))
    expect(read.strings.map((s) => s.original)).toEqual(["Hello page one."])
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
