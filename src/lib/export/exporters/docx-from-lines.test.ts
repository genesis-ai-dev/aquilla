/**
 * AQU-2551 (question 54): a Word document written from a file's lines, for a
 * file with no uploaded .docx (a PDF source, and any other).
 *
 * WHY each group matters:
 *  - Headings stay headings, a paragraph's lines are one paragraph (joined as
 *    the text and Markdown exports join them), and footnotes are real Word
 *    footnotes. The proof is the app's own Word import reading the document
 *    back: same paragraphs, same headings, same footnotes.
 *  - A PDF imported and exported this way comes back as a Word document of
 *    its paragraphs, which is what Sam asked for.
 *  - The parts are built to the ECMA-376 schema; the schema run itself is a
 *    scratch check (xmllint against the r4 schemas), the shape is pinned here.
 */

import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import { prepareImportFile } from "@/lib/import"
import { extractDocxStrings } from "@/lib/parsers/docx"
import { buildPdf, pdfOfParagraphs } from "@/lib/parsers/__fixtures__/build-pdf"
import { docxFromLinesFiles, exportDocxFromLines, linesToParagraphs } from "./docx-from-lines"
import { scopeCellsForExport } from "../validation-scope"

function cell(overrides: Partial<CellData>): CellData {
  return {
    id: "c",
    fileId: "f",
    original: "",
    translated: "",
    context: "Paragraph",
    group: "",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  } as CellData
}

async function reimport(blob: Blob): Promise<{ type: string; context: string; text: string }[]> {
  const strings = await extractDocxStrings(await blob.arrayBuffer(), { cellUnit: "paragraph" })
  return strings.map((s) => ({ type: s.type ?? "text", context: s.context, text: s.original }))
}

const STORY: CellData[] = [
  cell({ id: "1", type: "heading", context: "Title", original: "The Road", translated: "El camino", paragraphStart: true }),
  cell({ id: "2", type: "heading", context: "Heading 2", original: "Morning", translated: "La mañana", paragraphStart: true }),
  cell({ id: "3", original: "The rain had stopped.", translated: "La lluvia había cesado.", paragraphStart: true }),
  cell({ id: "4", original: "Anna packed the bread.", translated: "Ana guardó el pan.\\f + \\ft Pan de centeno.\\f*" }),
  cell({ id: "5", original: "They walked on.", translated: "", paragraphStart: true }),
]

describe("a Word document from the lines", () => {
  it("keeps headings, joins a paragraph's lines, makes footnotes real, and falls back to the source", async () => {
    const back = await reimport(await exportDocxFromLines(STORY))
    expect(back).toEqual([
      { type: "heading", context: "Title", text: "El camino" },
      { type: "heading", context: "Heading 2", text: "La mañana" },
      { type: "text", context: "Paragraph", text: "La lluvia había cesado. Ana guardó el pan.\\f + \\ft Pan de centeno.\\f*" },
      { type: "text", context: "Paragraph", text: "They walked on." },
    ])
  })

  it("writes the note as a Word footnote, referenced from its place in the text", () => {
    const files = docxFromLinesFiles(STORY)
    expect(files["word/footnotes.xml"]).toContain('<w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/>')
    expect(files["word/footnotes.xml"]).toContain("Pan de centeno.")
    expect(files["word/document.xml"]).toContain('Ana guardó el pan.</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>')
    expect(files["word/settings.xml"]).toContain('<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>')
    expect(files["[Content_Types].xml"]).toContain('PartName="/word/footnotes.xml"')
    expect(files["word/_rels/document.xml.rels"]).toContain('Target="footnotes.xml"')
  })

  it("has no footnotes part when there are no notes", () => {
    const files = docxFromLinesFiles([cell({ original: "Plain.", paragraphStart: true })])
    expect(files["word/footnotes.xml"]).toBeUndefined()
    expect(files["[Content_Types].xml"]).not.toContain("footnotes")
    expect(files["word/settings.xml"]).not.toContain("footnotePr")
  })

  it("joins only lines that share a group when the file carries no paragraph starts", async () => {
    const back = await reimport(await exportDocxFromLines([
      cell({ original: "One.", group: "g1" }),
      cell({ original: "Two.", group: "g1" }),
      cell({ original: "Three." }),
      cell({ original: "Four." }),
    ]))
    expect(back.map((p) => p.text)).toEqual(["One. Two.", "Three.", "Four."])
  })

  it("sets a right-to-left paragraph right-to-left, and escapes what XML cannot hold", () => {
    const files = docxFromLinesFiles([
      cell({ original: "שלום עולם", paragraphStart: true }),
      cell({ original: "Fish & <chips>\u0001 \"quoted\"", paragraphStart: true }),
    ])
    expect(files["word/document.xml"]).toContain("<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr>")
    expect(files["word/document.xml"]).toContain("Fish &amp; &lt;chips&gt; &quot;quoted&quot;")
  })

  // AQU-2680: bold and italic the translator marked come across as Word's own.
  it("writes bold and italic marks as bold and italic runs", () => {
    const doc = docxFromLinesFiles([cell({ original: "A \\bd strong\\bd* and \\it slanted\\it* word.", paragraphStart: true })])["word/document.xml"]
    expect(doc).toContain('<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">strong</w:t></w:r>')
    expect(doc).toContain('<w:r><w:rPr><w:i/><w:iCs/></w:rPr><w:t xml:space="preserve">slanted</w:t></w:r>')
    expect(doc).toContain('<w:r><w:t xml:space="preserve">A </w:t></w:r>')
  })

  it("puts bold before right-to-left in a run's properties, as the schema orders them", () => {
    const doc = docxFromLinesFiles([cell({ original: "שלום \\bd עולם\\bd*", paragraphStart: true })])["word/document.xml"]
    expect(doc).toContain('<w:rPr><w:b/><w:bCs/><w:rtl/></w:rPr><w:t xml:space="preserve">עולם</w:t>')
  })

  // AQU-2680: a whole bold or italic paragraph of the source (a PDF's
  // subtitle, a quotation) is bold or italic in the translation.
  it("sets a whole paragraph bold or italic when its import says so", () => {
    const doc = docxFromLinesFiles([
      cell({ id: "1", original: "Subtitle", translated: "Subtítulo", paragraphStart: true, metadata: { paragraphBold: true } }),
      cell({ id: "2", original: "A quote.", translated: "Una cita.", paragraphStart: true, metadata: { paragraphItalic: true } }),
      cell({ id: "3", original: "Plain.", paragraphStart: true }),
    ])["word/document.xml"]
    expect(doc).toContain('<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">Subtítulo</w:t></w:r>')
    expect(doc).toContain('<w:r><w:rPr><w:i/><w:iCs/></w:rPr><w:t xml:space="preserve">Una cita.</w:t></w:r>')
    expect(doc).toContain('<w:r><w:t xml:space="preserve">Plain.</w:t></w:r>')
  })

  // AQU-2680: a PDF's page size; A4 when the import recorded none.
  it("takes the page size the import recorded, else A4", () => {
    const letter = docxFromLinesFiles([cell({ original: "Hi.", paragraphStart: true, metadata: { pageSize: { width: 612, height: 792 } } })])["word/document.xml"]
    expect(letter).toContain('<w:pgSz w:w="12240" w:h="15840"/>')
    const landscape = docxFromLinesFiles([cell({ original: "Hi.", metadata: { pageSize: { width: 842, height: 595 } } })])["word/document.xml"]
    expect(landscape).toContain('<w:pgSz w:w="16840" w:h="11900" w:orient="landscape"/>')
    expect(docxFromLinesFiles([cell({ original: "Hi." })])["word/document.xml"]).toContain('<w:pgSz w:w="11906" w:h="16838"/>')
    expect(docxFromLinesFiles([cell({ original: "Hi.", metadata: { pageSize: { width: "x", height: 5 } } })])["word/document.xml"]).toContain('<w:pgSz w:w="11906" w:h="16838"/>')
  })

  // AQU-2680 review finding 8: a page under about 2.5 inches left no room
  // inside fixed 1-inch margins.
  it("keeps 1-inch margins, and narrows them on a page too small for them", () => {
    const doc = (pageSize?: { width: number; height: number }) => docxFromLinesFiles([cell({ original: "Hi.", ...(pageSize ? { metadata: { pageSize } } : {}) })])["word/document.xml"]
    expect(doc()).toContain('<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>')
    expect(doc({ width: 612, height: 792 })).toContain('<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708"')
    expect(doc({ width: 144, height: 216 })).toContain('<w:pgMar w:top="360" w:right="360" w:bottom="360" w:left="360" w:header="180" w:footer="180" w:gutter="0"/>')
  })

  it("names the document's language when the export has one", () => {
    expect(docxFromLinesFiles([cell({ original: "Hola." })], { lang: "es-419" })["word/styles.xml"]).toContain('<w:lang w:val="es-419"/>')
    expect(docxFromLinesFiles([cell({ original: "Hola." })], { lang: "und" })["word/styles.xml"]).not.toContain("w:lang")
  })

  it("is a Word package: content types first, every part present", async () => {
    const zip = await JSZip.loadAsync(await (await exportDocxFromLines(STORY)).arrayBuffer())
    expect(Object.keys(zip.files).filter((n) => !n.endsWith("/"))).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/settings.xml",
      "word/footnotes.xml",
    ])
  })
})

// AQU-2680: a tagged PDF's list items are Word list items, numbered by Word.
describe("lists", () => {
  const LIST: CellData[] = [
    cell({ id: "1", original: "Before.", paragraphStart: true }),
    cell({ id: "2", original: "Bread", context: "List Paragraph", paragraphStart: true, metadata: { list: "bullet", listLevel: 0 } }),
    cell({ id: "3", original: "Rye", context: "List Paragraph", paragraphStart: true, metadata: { list: "bullet", listLevel: 1 } }),
    cell({ id: "4", original: "Wash", context: "List Paragraph", paragraphStart: true, metadata: { list: "number", listLevel: 0 } }),
    cell({ id: "5", original: "Rinse", context: "List Paragraph", paragraphStart: true, metadata: { list: "number", listLevel: 0 } }),
    cell({ id: "6", original: "Between.", paragraphStart: true }),
    cell({ id: "7", original: "Dry", context: "List Paragraph", paragraphStart: true, metadata: { list: "number", listLevel: 0 } }),
  ]

  it("writes list items as Word list paragraphs, at their level", () => {
    const doc = docxFromLinesFiles(LIST)["word/document.xml"]
    expect(doc).toContain('<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Bread</w:t>')
    expect(doc).toContain('<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Rye</w:t>')
    expect(doc).toContain('<w:p><w:r><w:t xml:space="preserve">Before.</w:t>')
  })

  it("numbers each numbered list from 1, and continues the numbers within one list", () => {
    const files = docxFromLinesFiles(LIST)
    const numIds = [...files["word/document.xml"].matchAll(/<w:numId w:val="(\d+)"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">(\w+)/g)].map((m) => [m[2], m[1]])
    expect(numIds).toEqual([["Bread", "1"], ["Rye", "1"], ["Wash", "2"], ["Rinse", "2"], ["Dry", "3"]])
    expect(files["word/numbering.xml"]).toContain('<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>')
    expect(files["word/numbering.xml"]).toContain('<w:numFmt w:val="bullet"/>')
    expect(files["word/numbering.xml"]).toContain('<w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>')
    expect(files["word/styles.xml"]).toContain('w:styleId="ListParagraph"')
    expect(files["[Content_Types].xml"]).toContain('PartName="/word/numbering.xml"')
    expect(files["word/_rels/document.xml.rels"]).toContain('Target="numbering.xml"')
  })

  // AQU-2680 review finding 2: a numbered list started again at 1 after any
  // paragraph between its items, and a numbered list under bullets carried on
  // under the next bullet. The printed label says where a list starts again.
  it("carries a numbered list on across paragraphs between its items, and starts again where the label says 1", () => {
    const item = (id: string, label: string | null, level: number, kind = "number") =>
      cell({ id, original: id, context: "List Paragraph", paragraphStart: true, metadata: { list: kind, listLevel: level, ...(label ? { listLabel: label } : {}) } })
    const files = docxFromLinesFiles([
      item("Wash", "1.", 0), cell({ id: "x", original: "A note between.", paragraphStart: true }), item("Rinse", "2.", 0),
      item("Bul", "\u2022", 0, "bullet"), item("SubOne", "1.", 1), item("SubTwo", "2.", 1),
      item("Bultwo", "\u2022", 0, "bullet"), item("SubAgain", "1.", 1),
      item("Dry", "3.", 0), cell({ id: "y", original: "Another list.", paragraphStart: true }), item("New", "1.", 0),
      cell({ id: "z", original: "Part way.", paragraphStart: true }), item("Five", "5.", 0),
    ])
    const numIds = Object.fromEntries([...files["word/document.xml"].matchAll(/<w:numId w:val="(\d+)"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">(\w+)/g)].map((m) => [m[2], m[1]]))
    expect(numIds).toEqual({ Wash: "2", Rinse: "2", Bul: "1", SubOne: "3", SubTwo: "3", Bultwo: "1", SubAgain: "4", Dry: "2", New: "5", Five: "6" })
    expect(files["word/numbering.xml"]).toContain('<w:num w:numId="4"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="1"><w:startOverride w:val="1"/>')
    expect(files["word/numbering.xml"]).toContain('<w:num w:numId="6"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/>')
  })

  it("starts a list at its label's number", () => {
    const files = docxFromLinesFiles([cell({ original: "Later", context: "List Paragraph", paragraphStart: true, metadata: { list: "number", listLevel: 0, listLabel: "4." } })])
    expect(files["word/numbering.xml"]).toContain('<w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/>')
  })

  // AQU-2680 review finding 7: "a)" and "1.1.1." came out as Word's own "1.".
  it("numbers each list in its label's form: letters, roman numerals, brackets, a section number", () => {
    const item = (id: string, label: string, level = 0) =>
      cell({ id, original: id, context: "List Paragraph", paragraphStart: true, metadata: { list: "number", listLevel: level, listLabel: label } })
    const between = (id: string) => cell({ id, original: `Text ${id}.`, paragraphStart: true })
    const files = docxFromLinesFiles([
      item("Ha", "h)"), item("Ia", "i)"), between("1"), item("Roman", "iv."), between("2"), item("Brackets", "(1)"),
      between("3"), item("Section", "1.1.3."), between("4"), item("Upper", "B."), between("5"), item("UpperRoman", "II.", 1),
    ])
    const numbering = files["word/numbering.xml"]
    const lvlOf = (numId: number) => new RegExp(`<w:num w:numId="${numId}">.*?</w:num>`).exec(numbering)?.[0]
    expect(lvlOf(2)).toContain('<w:startOverride w:val="8"/><w:lvl w:ilvl="0"><w:start w:val="8"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1)"/>')
    expect(files["word/document.xml"]).toContain('<w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Ia</w:t>')
    expect(lvlOf(3)).toContain('<w:start w:val="4"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%1."/>')
    expect(lvlOf(4)).toContain('<w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="(%1)"/>')
    expect(lvlOf(5)).toContain('<w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="1.1.%1."/>')
    expect(lvlOf(6)).toContain('<w:start w:val="2"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="%1."/>')
    expect(lvlOf(7)).toContain('<w:lvlOverride w:ilvl="1"><w:startOverride w:val="2"/><w:lvl w:ilvl="1"><w:start w:val="2"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%2."/>')
  })

  it("adds no bullet or number to an item that had no label", () => {
    const doc = docxFromLinesFiles([cell({ original: "1) Its own number.", context: "List Paragraph", paragraphStart: true, metadata: { list: "none", listLevel: 1 } })])["word/document.xml"]
    expect(doc).toContain('<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="1440"/></w:pPr><w:r><w:t xml:space="preserve">1) Its own number.</w:t>')
  })

  it("adds no numbering part or list style to a document without lists", () => {
    const files = docxFromLinesFiles(STORY)
    expect(files["word/numbering.xml"]).toBeUndefined()
    expect(files["word/styles.xml"]).not.toContain("ListParagraph")
    expect(files["[Content_Types].xml"]).not.toContain("numbering")
  })

  it("reads back in the app's Word import with every item kept", async () => {
    const back = await reimport(await exportDocxFromLines(LIST))
    expect(back.map((p) => p.text)).toEqual(["Before.", "Bread", "Rye", "Wash", "Rinse", "Between.", "Dry"])
  })
})

describe("a PDF source comes back as Word", () => {
  it("imports a tagged PDF and exports its lines as the same headings and paragraphs", async () => {
    const pdf = pdfOfParagraphs(["# Chapter One", "A first paragraph that is long enough to wrap onto a second line of the page, so the reader joins it.", "A second paragraph."], { tagged: true })
    const prepared = await prepareImportFile(new File([pdf], "notes.pdf"), { projectId: "p", cellUnit: "sentence" })
    // as the app stores them: no group, the paragraph start kept
    const cells = prepared.results[0].strings.map((s, i) => cell({
      id: String(i), original: s.original, type: s.type, context: s.context, paragraphStart: s.paragraphStart,
    }))
    const back = await reimport(await exportDocxFromLines(cells))
    expect(back).toEqual([
      { type: "heading", context: "Heading 1", text: "Chapter One" },
      { type: "text", context: "Paragraph", text: "A first paragraph that is long enough to wrap onto a second line of the page, so the reader joins it." },
      { type: "text", context: "Paragraph", text: "A second paragraph." },
    ])
  })
})

// AQU-2680: a tagged PDF's list and its bold subtitle reach the Word file.
describe("a PDF's lists and whole-paragraph bold come back as Word", () => {
  it("numbers the list and sets the subtitle bold", async () => {
    const pdf = buildPdf({
      pages: [{ runs: [
        { text: "A Bold Subtitle", x: 72, y: 770, font: "bold", tag: "s" },
        { text: "1.", x: 72, y: 730, tag: "l1" }, { text: "Wash", x: 84, y: 730, tag: "b1" },
        { text: "2.", x: 72, y: 716, tag: "l2" }, { text: "Rinse", x: 84, y: 716, tag: "b2" },
      ] }],
      structure: [{ role: "Document", children: [
        { role: "P", id: "s" },
        { role: "L", children: [
          { role: "LI", children: [{ role: "Lbl", id: "l1" }, { role: "LBody", id: "b1" }] },
          { role: "LI", children: [{ role: "Lbl", id: "l2" }, { role: "LBody", id: "b2" }] },
        ] },
      ] }],
    })
    const prepared = await prepareImportFile(new File([pdf], "notes.pdf"), { projectId: "p", cellUnit: "sentence" })
    const cells = prepared.results[0].strings.map((s, i) => cell({
      id: String(i), original: s.original, type: s.type, context: s.context, paragraphStart: s.paragraphStart, metadata: s.metadata,
    }))
    const doc = docxFromLinesFiles(cells)["word/document.xml"]
    expect(doc).toContain('<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">A Bold Subtitle</w:t></w:r>')
    expect(doc).toContain('<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Wash</w:t>')
    expect(doc).toContain('<w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Rinse</w:t>')
  })
})

// Review finding 9 (Nov 14): hiding a paragraph's first line, or exporting
// "validated only" with that line unvalidated, ran the rest of the paragraph
// into the one before it.
describe("a paragraph whose first line is left out", () => {
  const text = (cells: CellData[]) => linesToParagraphs(cells).map((p) => p.lines.flat().map((r) => r.text).join(""))
  const lines = (second: Partial<CellData>) => [
    cell({ id: "1", original: "P1 s1.", translated: "T1 s1.", paragraphStart: true, status: "validated" }),
    cell({ id: "2", original: "P2 s1.", translated: "T2 s1.", paragraphStart: true, ...second }),
    cell({ id: "3", original: "P2 s2.", translated: "T2 s2.", status: "validated" }),
  ]

  it("stays its own paragraph when that line is hidden", () => {
    expect(text(scopeCellsForExport(lines({ status: "validated", hidden: true }), "current"))).toEqual(["T1 s1.", "T2 s2."])
  })

  it("stays its own paragraph on validated only", () => {
    expect(text(scopeCellsForExport(lines({ status: "unvalidated" }), "validated-only"))).toEqual(["T1 s1.", "T2 s2."])
  })
})
