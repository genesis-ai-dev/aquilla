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
import { pdfOfParagraphs } from "@/lib/parsers/__fixtures__/build-pdf"
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
