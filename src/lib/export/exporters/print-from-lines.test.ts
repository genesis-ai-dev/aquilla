/**
 * AQU-2680 (question 54, Sam's decision Nov 19): the PDF is the browser's own
 * "Save as PDF" of a print page laid out from the same structure as the new
 * Word document: headings, paragraphs, lists numbered alike, footnotes,
 * right-to-left text, the target language, and the imported PDF's page size
 * and margins as `@page` (A4 when none was recorded).
 */

import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { buildPdf, pdfOfParagraphs } from "@/lib/parsers/__fixtures__/build-pdf"
import { extractPdfImport } from "@/lib/parsers/pdf"
import { buildPrintPage } from "./print-from-lines"

function cell(overrides: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "Paragraph", group: "", type: "text",
    status: "unvalidated", validationStatus: "none", activeValidators: [], validationHistory: [], history: [], threads: [],
    ...overrides,
  } as CellData
}

/** A PDF read by the app's import, as its cells are stored. */
async function imported(pdf: ArrayBuffer, translate?: (original: string) => string): Promise<CellData[]> {
  const read = await extractPdfImport(pdf, { cellUnit: "paragraph" })
  return read.strings.map((s, i) => cell({
    id: String(i), original: s.original, translated: translate?.(s.original) ?? "", type: s.type, context: s.context,
    paragraphStart: s.paragraphStart, metadata: s.metadata,
  }))
}

const body = (html: string) => html.slice(html.indexOf("<body>"), html.indexOf("</body>"))

describe("the PDF's print page", () => {
  it("lays out a tagged PDF's headings, lists and bold subtitle, on its page size", async () => {
    const pdf = buildPdf({
      mediaBox: [0, 0, 612, 792],
      pages: [{ runs: [
        { text: "Chapter One", x: 72, y: 740, size: 16, tag: "h" },
        { text: "A Bold Subtitle", x: 72, y: 710, font: "bold", tag: "s" },
        { text: "a)", x: 72, y: 690, tag: "l1" }, { text: "Wash", x: 90, y: 690, tag: "b1" },
        { text: "b)", x: 72, y: 676, tag: "l2" }, { text: "Rinse", x: 90, y: 676, tag: "b2" },
        { text: "•", x: 90, y: 662, tag: "l3" }, { text: "Gently", x: 102, y: 662, tag: "b3" },
      ] }],
      structure: [{ role: "Document", children: [
        { role: "H1", id: "h" },
        { role: "P", id: "s" },
        { role: "L", children: [
          { role: "LI", children: [{ role: "Lbl", id: "l1" }, { role: "LBody", id: "b1" }] },
          { role: "LI", children: [{ role: "Lbl", id: "l2" }, { role: "LBody", children: [{ role: "Span", id: "b2" },
            { role: "L", children: [{ role: "LI", children: [{ role: "Lbl", id: "l3" }, { role: "LBody", id: "b3" }] }] }] }] },
        ] },
      ] }],
    })
    const page = buildPrintPage(await imported(pdf), { title: "notes", lang: "es" })
    expect(page).toContain("@page{size:612pt 792pt;margin:72pt}")
    expect(page).toContain('<html lang="es">')
    expect(page).toContain("<title>notes</title>")
    expect(body(page)).toBe([
      "<body>",
      "<h1>Chapter One</h1>",
      '<p class="b">A Bold Subtitle</p>',
      '<p class="li li-0"><span class="li-label" aria-hidden="true">a)</span>Wash</p>',
      '<p class="li li-0"><span class="li-label" aria-hidden="true">b)</span>Rinse</p>',
      '<p class="li li-1"><span class="li-label" aria-hidden="true">\u25e6</span>Gently</p>', // Word's bullet for the second level
      "",
      "",
    ].join("\n"))
  })

  it("lays out an untagged PDF's paragraphs on its page size", async () => {
    const pdf = pdfOfParagraphs(["A first paragraph that is long enough to wrap onto a second line of the page, so the reader joins it.", "A second paragraph."])
    const page = buildPrintPage(await imported(pdf), { title: "plain" })
    expect(page).toContain("@page{size:595pt 842pt;margin:72pt}")
    expect(page).toContain("<html>")
    expect(body(page)).toContain("<p>A first paragraph that is long enough to wrap onto a second line of the page, so the reader joins it.</p>\n<p>A second paragraph.</p>")
  })

  it("sets a right-to-left translation right to left, in its language, with its footnotes listed", async () => {
    const pdf = pdfOfParagraphs(["# Chapter One", "The rain had stopped."], { tagged: true })
    const arabic: Record<string, string> = { "Chapter One": "الفصل الأول", "The rain had stopped.": "توقف المطر.\\f + \\ft حاشية.\\f*" }
    const page = buildPrintPage(await imported(pdf, (o) => arabic[o]), { title: "notes", lang: "ar" })
    expect(page).toContain('<html lang="ar">')
    expect(body(page)).toContain('<h1 dir="rtl">الفصل الأول</h1>')
    expect(body(page)).toContain('<p dir="rtl">توقف المطر.<sup class="note-marker footnote"><a id="n-n1-ref" href="#n-n1">1</a></sup></p>')
    expect(body(page)).toMatch(/<li class="note footnote" id="n-n1">.*<span class="note-text">حاشية\.<\/span><\/li>/)
  })

  it("uses A4 when the import recorded no page size, and narrower margins on a small page", () => {
    expect(buildPrintPage([cell({ original: "Hi.", paragraphStart: true })], { title: "t" })).toContain("@page{size:A4;margin:72pt}")
    expect(buildPrintPage([cell({ original: "Hi.", paragraphStart: true, metadata: { pageSize: { width: 144, height: 216 } } })], { title: "t" }))
      .toContain("@page{size:144pt 216pt;margin:18pt}")
  })

  it("prints what a translation says, never runs it", () => {
    const page = buildPrintPage([cell({ original: "x", translated: "<script>alert(1)</script> & \\bd bold\\bd*", paragraphStart: true })], { title: "<b>" })
    expect(page).toContain("<title>&lt;b&gt;</title>")
    expect(body(page)).toContain("<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; <strong>bold</strong></p>")
  })

  it("numbers a list as the Word file does: on across a paragraph, again where the label says 1", () => {
    const item = (id: string, label: string) => cell({ id, original: id, context: "List Paragraph", paragraphStart: true, metadata: { list: "number", listLevel: 0, listLabel: label } })
    const page = buildPrintPage([
      item("Wash", "1.1.1."), cell({ original: "Between.", paragraphStart: true }), item("Rinse", "1.1.2."), item("New", "1."),
    ], { title: "t" })
    expect([...page.matchAll(/<span class="li-label" aria-hidden="true">([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(["1.1.1.", "1.1.2.", "1."])
  })
})
