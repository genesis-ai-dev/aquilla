// AQU-2552 (review r7): B's Word export of a paragraph cut into lines, some
// of them translated, hidden, deleted or split. Every cell is made by the
// importer from a small made .docx, located and normalized as a real import
// makes it; typed lines carry `translatedHtml` as the editor saves it. Every
// check reads the written XML.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"
import { hiddenRoundTripRemovals, scopeRoundTripCells } from "../validation-scope"
import { extractDocxStrings } from "@/lib/parsers/docx"
import { normalizeTranslatableStrings, aquillaImportMetadata } from "@/lib/import/normalized-manifest"
import { splitLineOrigin } from "@/lib/timeline/user-line-origin"
import { assertWellFormedXml } from "@/lib/parsers/xml-lite"
import { structuralProblems } from "./__fixtures__/docx-structure-check"
import type { CellData } from "@/hooks/useCells"

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" mc:Ignorable="wps"'

/** Long enough that the importer cuts the paragraph after each sentence. */
const PAD = " and it goes on with many more words, long enough that the importer cuts the paragraph after this sentence ends."

const run = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`
const ref = (id: number) => `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`
const para = (inner: string) => `<w:p>${inner}</w:p>`
const NEXT = para(run("Next paragraph."))
const PAGE_BREAK = `<w:r><w:br w:type="page"/></w:r>`
const IMG = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="i.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
const FIELD = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
const BOX = (inner: string) =>
  `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="100" cy="100"/><wp:wrapNone/><wp:docPr id="2" name="Text Box 2"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr/><wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>${inner}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`

function footnotesXml(notes: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W_NS}>` +
    `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>` +
    notes.map((text, k) => `<w:footnote w:id="${k + 1}"><w:p><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${text}</w:t></w:r></w:p></w:footnote>`).join("") +
    `</w:footnotes>`
}

async function docxBytes(body: string, notes?: string[]): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`)
  if (notes) zip.file("word/footnotes.xml", footnotesXml(notes))
  return zip.generateAsync({ type: "arraybuffer" })
}

/** The cells a real import makes of this file. */
async function importCells(bytes: ArrayBuffer): Promise<CellData[]> {
  const strings = await extractDocxStrings(bytes)
  const file = normalizeTranslatableStrings(strings, { fileName: "t.docx", fileType: "docx" })
  return strings.map((s, i) => ({
    id: `c${i}`,
    fileId: "f",
    original: file.units[i].sourceText,
    originalHtml: file.units[i].sourceHtml,
    translated: "",
    translatedHtml: undefined,
    context: s.context ?? "",
    group: "",
    type: s.type ?? "text",
    status: "empty",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    metadata: { aquillaImport: aquillaImportMetadata(file, file.units[i]), ...(s.paragraphStart ? { paragraphStart: true } : {}) },
  }) as unknown as CellData)
}

/** A translation typed the way the editor saves it (plain and HTML). */
const typed = (cell: CellData, text: string): CellData =>
  ({ ...cell, translated: text, translatedHtml: `<p>${text}</p>`, status: "validated" }) as CellData
const hide = (cell: CellData): CellData => ({ ...cell, hidden: true }) as CellData
/** A piece split off `of` in the editor, holding `original`. */
const piece = (of: CellData, id: string, original: string): CellData =>
  ({ ...of, id, original, originalHtml: undefined, translated: "", translatedHtml: undefined, status: "empty", metadata: { aquillaOrigin: splitLineOrigin(of.id) } }) as CellData

interface Out {
  body: string
  notes: string
  result: Awaited<ReturnType<typeof exportDocx>>
}

/** Export as the dialog does: hidden lines cleared and handed over as
 *  removals, `deleted` as the server's removed records. */
async function wordOut(bytes: ArrayBuffer, cells: CellData[], deleted: CellData[] = []): Promise<Out> {
  const result = await exportDocx(bytes, scopeRoundTripCells(cells, "current"), {
    removedCells: [...deleted.map((c) => ({ metadata: c.metadata ?? null })), ...hiddenRoundTripRemovals(cells)],
  })
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const body = await zip.file("word/document.xml")!.async("string")
  const notes = (await zip.file("word/footnotes.xml")?.async("string")) ?? ""
  expect(() => assertWellFormedXml(body)).not.toThrow()
  expect(structuralProblems(body, notes || undefined)).toEqual([])
  return { body, notes, result }
}

/** Top-level paragraphs as a reader meets them: text, `[^n]` for footnote
 *  reference n, `[TAB]`, `[IMG]` for a picture, `[BOX]` for a text box,
 *  `[PAGE]` for a page break, `{field}` for a field's code. PAD reads "…". */
function paras(xml: string): string[] {
  let body = xml.replace(/^[\s\S]*?<w:body>/, "").replace(/<w:sectPr[\s\S]*$/, "")
  body = body.replace(/<mc:AlternateContent>[\s\S]*?<\/mc:AlternateContent>/g, "<BOX/>")
  return (body.match(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []).map((p) =>
    [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:footnoteReference\b[^>]*w:id="([^"]+)"[^>]*\/>|<w:tab\/>|<w:drawing>|<BOX\/>|<w:br w:type="page"\/>|<w:fldChar w:fldCharType="begin"\/>/g)]
      .map((m) => (m[1] !== undefined ? m[1]
        : m[2] !== undefined ? `[^${m[2]}]`
        : m[0] === "<w:tab/>" ? "[TAB]"
        : m[0] === "<w:drawing>" ? "[IMG]"
        : m[0] === "<BOX/>" ? "[BOX]"
        : m[0].includes("page") ? "[PAGE]"
        : "{field}"))
      .join("").replaceAll(PAD.trim(), "…"))
}

/** A note's text as footnotes.xml holds it. */
function noteText(notes: string, id: number): string {
  const note = new RegExp(`<w:footnote\\b[^>]*w:id="${id}"[^>]*>([\\s\\S]*?)</w:footnote>`).exec(notes)?.[1] ?? ""
  return [...note.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("").trim()
}

const M = (text: string) => `\\f + \\ft ${text}\\f*`
const byStart = (cells: CellData[], text: string) => cells.find((c) => c.original.startsWith(text))!

describe("Word export — a text box in a hidden or deleted line stays (AQU-2552, review r7 N4)", () => {
  const body = para(run("Holder first") + BOX(para(run("Box text here."))) + run(" line" + PAD + " ") + run("Holder second line" + PAD)) + para(run("After."))

  it("the importer gives the holder two lines and the box one of its own", async () => {
    const cells = await importCells(await docxBytes(body))
    expect(cells.map((c) => c.original.replaceAll(PAD.trim(), "…"))).toEqual(["Holder first line …", "Holder second line …", "Box text here.", "After."])
  })

  // The box sat before the remaining line's words, so it stays before them.
  it("a hidden holder line leaves its text box and the box's translated line in place", async () => {
    const bytes = await docxBytes(body)
    const cells = await importCells(bytes)
    const [h1, h2, bx, af] = [byStart(cells, "Holder first"), byStart(cells, "Holder second"), byStart(cells, "Box text"), byStart(cells, "After")]
    const out = await wordOut(bytes, [hide(typed(h1, "Un.")), typed(h2, "Deux."), typed(bx, "Texte de la boîte."), af])
    expect(paras(out.body)).toEqual(["[BOX]Deux.", "After."])
    // Both copies of the box (the modern one and the old readers' one).
    expect(out.body.split("Texte de la boîte.").length - 1).toBe(2)
    expect(out.body).not.toContain("Holder first")
  })

  it("a deleted holder line leaves its text box in place", async () => {
    const bytes = await docxBytes(body)
    const cells = await importCells(bytes)
    const [h1, h2, bx, af] = [byStart(cells, "Holder first"), byStart(cells, "Holder second"), byStart(cells, "Box text"), byStart(cells, "After")]
    const out = await wordOut(bytes, [typed(h2, "Deux."), typed(bx, "Texte de la boîte."), af], [h1])
    expect(paras(out.body)).toEqual(["[BOX]Deux.", "After."])
    expect(out.body).toContain("Texte de la boîte.")
  })

  it("with nothing translated, a hidden holder line leaves the box's own words", async () => {
    const bytes = await docxBytes(body)
    const cells = await importCells(bytes)
    const [h1, h2, bx, af] = [byStart(cells, "Holder first"), byStart(cells, "Holder second"), byStart(cells, "Box text"), byStart(cells, "After")]
    const out = await wordOut(bytes, [hide(h1), h2, bx, af])
    expect(paras(out.body)).toEqual(["[BOX]Holder second line …", "After."])
    expect(out.body).toContain("Box text here.")
  })
})

describe("Word export — a footnote the translator moved into a neighbouring line keeps its note (AQU-2552, review r7 N5)", () => {
  const L = ["First line here" + PAD, "Second line here" + PAD, "Third line here" + PAD]
  // Lines 1 and 2 each hold their note after "line"; line 3 none.
  const noted = para(L.map((l, k) => k < 2
    ? run(`${k > 0 ? " " : ""}${l.slice(0, l.indexOf(" here"))}`) + ref(k + 1) + run(l.slice(l.indexOf(" here")))
    : run(` ${l}`)).join("")) + NEXT
  const notes = ["Note one.", "Note two."]

  it("line 1's translation carries both notes, line 2's none: both notes are translated, each where its marker is", async () => {
    const bytes = await docxBytes(noted, notes)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [typed(a, `Un${M("Note un.")} et deux${M("Note deux.")}.`), typed(b, "Suite."), typed(c, "Trois."), n])
    expect(paras(out.body)).toEqual(["Un[^1] et deux[^2]. Suite. Trois.", "Next paragraph."])
    expect([noteText(out.notes, 1), noteText(out.notes, 2)]).toEqual(["Note un.", "Note deux."])
    expect(out.result.fidelity.unplacedFootnoteMarkers).toBe(0)
  })

  it("line 2's translation carries both notes, line 1's none: line 1's note goes to the marker that moved", async () => {
    const bytes = await docxBytes(noted, notes)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [typed(a, "Un."), typed(b, `Deux${M("Note un.")} et suite${M("Note deux.")}.`), typed(c, "Trois."), n])
    // Line 2's own reference takes its first marker, line 1's the second: each
    // place shows the note its marker carries.
    expect(paras(out.body)).toEqual(["Un. Deux[^2] et suite[^1]. Trois.", "Next paragraph."])
    expect([noteText(out.notes, 2), noteText(out.notes, 1)]).toEqual(["Note un.", "Note deux."])
    expect(out.result.fidelity.unplacedFootnoteMarkers).toBe(0)
  })

  it("an untranslated line keeps its own note, so a translation with one marker too many leaves it alone", async () => {
    const bytes = await docxBytes(noted, notes)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [typed(a, `Un${M("Note un.")} et deux${M("Note deux.")}.`), b, typed(c, "Trois."), n])
    expect(paras(out.body)).toEqual(["Un[^1] et deux. Second line[^2] here … Trois.", "Next paragraph."])
    expect([noteText(out.notes, 1), noteText(out.notes, 2)]).toEqual(["Note un.", "Note two."])
    expect(out.result.fidelity.unplacedFootnoteMarkers).toBe(1)
  })

  it("a translated line that places its own note lends it to no other line", async () => {
    const bytes = await docxBytes(noted, notes)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [typed(a, `Un${M("Note un.")} et plus${M("Note ajoutée.")}.`), typed(b, `Deux${M("Note deux.")}.`), typed(c, "Trois."), n])
    expect(paras(out.body)).toEqual(["Un[^1] et plus. Deux[^2]. Trois.", "Next paragraph."])
    expect([noteText(out.notes, 1), noteText(out.notes, 2)]).toEqual(["Note un.", "Note deux."])
    expect(out.result.fidelity.unplacedFootnoteMarkers).toBe(1)
  })
})

describe("Word export — a line is found in its paragraph in segment order (AQU-2552, review r7 N3)", () => {
  const S = "Refrain line" + PAD

  it("a hidden first copy with an italic word: the remaining copy is written plain", async () => {
    const bytes = await docxBytes(para(run("Refrain ") + run("line", "<w:i/>") + run(PAD + " ") + run(S + " ") + run("Third line" + PAD)) + NEXT)
    const [a, b, c, n] = await importCells(bytes)
    expect([a, b].map((x) => x.original)).toEqual([S, S])
    const out = await wordOut(bytes, [hide(typed(a, "Refrain.")), b, typed(c, "Trois."), n])
    expect(paras(out.body)).toEqual(["Refrain line … Trois.", "Next paragraph."])
    expect(out.body).not.toContain("<w:i/>")
    expect(out.result.lostLooks).toEqual([])
  })

  it("a hidden first copy: the remaining copy keeps its own picture", async () => {
    const bytes = await docxBytes(para(run(S + " ") + run("Refrain line") + IMG + run(PAD + " ") + run("Third line" + PAD)) + NEXT)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [hide(typed(a, "Refrain.")), b, typed(c, "Trois."), n])
    expect(paras(out.body)[0]).toContain("[IMG]")
  })

  it("a hidden second copy takes its picture with it", async () => {
    const bytes = await docxBytes(para(run(S + " ") + run("Refrain line") + IMG + run(PAD + " ") + run("Third line" + PAD)) + NEXT)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [a, hide(typed(b, "Refrain.")), typed(c, "Trois."), n])
    expect(paras(out.body)).toEqual(["Refrain line … Trois.", "Next paragraph."])
  })

  it("a hidden or deleted first copy takes its picture with it, though the remaining copy has the same words", async () => {
    const bytes = await docxBytes(para(run("Refrain line") + IMG + run(PAD + " ") + run(S + " ") + run("Third line" + PAD)) + NEXT)
    const [a, b, c, n] = await importCells(bytes)
    const hidden = await wordOut(bytes, [hide(typed(a, "Refrain.")), b, typed(c, "Trois."), n])
    expect(paras(hidden.body)).toEqual(["Refrain line … Trois.", "Next paragraph."])
    const deleted = await wordOut(bytes, [b, typed(c, "Trois."), n], [a])
    expect(paras(deleted.body)).toEqual(["Refrain line … Trois.", "Next paragraph."])
  })
})
