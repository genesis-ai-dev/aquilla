// AQU-2552 (review r8): B's Word export of a paragraph cut into lines, some
// of them translated, hidden, deleted or split: what review r8 found. Every
// cell is made by the importer from a small made .docx, located and
// normalized as a real import makes it; typed lines carry `translatedHtml` as
// the editor saves it. Every check reads the written XML.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"
import { hiddenRoundTripRemovals, scopeRoundTripCells } from "../validation-scope"
import { extractDocxStrings } from "@/lib/parsers/docx"
import { normalizeTranslatableStrings, aquillaImportMetadata } from "@/lib/import/normalized-manifest"
import { splitLineOrigin } from "@/lib/timeline/user-line-origin"
import { assertWellFormedXml, isElement, parseXmlLite, type XmlElement } from "@/lib/parsers/xml-lite"
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
 *  removals, `deleted` as the server's removed records (with their cellId). */
async function wordOut(bytes: ArrayBuffer, cells: CellData[], deleted: CellData[] = []): Promise<Out> {
  const result = await exportDocx(bytes, scopeRoundTripCells(cells, "current"), {
    removedCells: [...deleted.map((c) => ({ cellId: c.id, canonicalRef: c.group || null, metadata: c.metadata ?? null })), ...hiddenRoundTripRemovals(cells)],
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

/** Each wrapper's own properties, and the parent each is written under. The
 *  schema allows them only as the first child of their own wrapper. */
const PROPERTY_OF: Record<string, string> = {
  "w:sdtPr": "w:sdt", "w:sdtEndPr": "w:sdt", "w:smartTagPr": "w:smartTag", "w:customXmlPr": "w:customXml",
}
function looseProperties(xml: string): string[] {
  const out: string[] = []
  const walk = (el: XmlElement, parent: XmlElement | null) => {
    const owner = PROPERTY_OF[el.tagName]
    if (owner && parent?.tagName !== owner) out.push(`${el.tagName} under ${parent?.tagName ?? "nothing"}`)
    for (const child of el.children) if (isElement(child)) walk(child, el)
  }
  walk(parseXmlLite(xml), null)
  return out
}

const SDT = (inner: string, pr = `<w:id w:val="9"/>`) => `<w:sdt><w:sdtPr>${pr}</w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`
const SMART_TAG = (inner: string) => `<w:smartTag w:uri="urn:x" w:element="e"><w:smartTagPr><w:attr w:name="a" w:val="b"/></w:smartTagPr>${inner}</w:smartTag>`
const CUSTOM_XML = (inner: string) => `<w:customXml w:uri="urn:x" w:element="e"><w:customXmlPr><w:attr w:name="a" w:val="b"/></w:customXmlPr>${inner}</w:customXml>`
const L1 = "First line here" + PAD
const L2 = "Second line here" + PAD
const L3 = "Third line here" + PAD

describe("Word export — a wrapper that only a lost line fills goes whole (AQU-2552, review r8 F0)", () => {
  const shapes: [string, string][] = [
    ["a content control around line 2", run(L1 + " ") + SDT(run(L2)) + run(" " + L3)],
    ["a smart tag around line 2", run(L1 + " ") + SMART_TAG(run(L2)) + run(" " + L3)],
    ["a custom XML element around line 2", run(L1 + " ") + CUSTOM_XML(run(L2)) + run(" " + L3)],
    ["a picture content control inside line 2", run(L1 + " ") + run("Second line") + SDT(IMG, `<w:id w:val="5"/><w:picture/>`) + run(" here" + PAD + " ") + run(L3)],
  ]

  it.each(shapes)("%s: hidden or deleted, none of its tags or properties is left loose", async (_name, inner) => {
    const bytes = await docxBytes(para(inner) + NEXT)
    const [a, b, c, n] = await importCells(bytes)
    expect(b.original.replaceAll(PAD.trim(), "…")).toBe("Second line here …")
    for (const out of [
      await wordOut(bytes, [typed(a, "Un."), hide(typed(b, "Deux.")), typed(c, "Trois."), n]),
      await wordOut(bytes, [typed(a, "Un."), typed(c, "Trois."), n], [b]),
      await wordOut(bytes, [a, hide(b), c, n]),
    ]) {
      expect(looseProperties(out.body)).toEqual([])
      const first = out.body.match(/<w:body>(<w:p\b[\s\S]*?<\/w:p>)/)![1]
      expect(first).not.toMatch(/<w:(sdt|smartTag|customXml)\b|w:drawing/)
      expect(paras(out.body)[1]).toBe("Next paragraph.")
    }
    const hidden = await wordOut(bytes, [typed(a, "Un."), hide(typed(b, "Deux.")), typed(c, "Trois."), n])
    expect(paras(hidden.body)[0]).toBe("Un. Trois.")
    const untranslated = await wordOut(bytes, [a, hide(b), c, n])
    expect(paras(untranslated.body)[0]).toBe("First line here … Third line here …")
  })

  it("a content control around the first line, hidden or with both first lines deleted", async () => {
    const bytes = await docxBytes(para(SDT(run(L1)) + run(" " + L2 + " ") + run(L3)) + NEXT)
    const [a, b, c, n] = await importCells(bytes)
    const hidden = await wordOut(bytes, [hide(typed(a, "Un.")), typed(b, "Deux."), typed(c, "Trois."), n])
    expect(looseProperties(hidden.body)).toEqual([])
    expect(paras(hidden.body)[0]).toBe("Deux. Trois.")
    const deleted = await wordOut(bytes, [typed(c, "Trois."), n], [a, b])
    expect(looseProperties(deleted.body)).toEqual([])
    expect(paras(deleted.body)[0]).toBe("Trois.")
  })

  it("a bookmark inside the lost wrapper stays, outside the wrapper", async () => {
    const bytes = await docxBytes(para(run(L1 + " ") + SDT(`<w:bookmarkStart w:id="7" w:name="here"/>` + run(L2) + `<w:bookmarkEnd w:id="7"/>`) + run(" " + L3)) + NEXT)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [typed(a, "Un."), hide(typed(b, "Deux.")), typed(c, "Trois."), n])
    expect(looseProperties(out.body)).toEqual([])
    expect(out.body).toContain(`<w:bookmarkStart w:id="7" w:name="here"/>`)
    expect(out.body).not.toContain("<w:sdt>")
  })
})

describe("Word export — a deleted split piece keeps its place after the row it was cut from (AQU-2552, review r8 F1)", () => {
  // Line 2 holds a picture and note 1 in its middle; the editor cuts it in
  // three: P "Second line here and it goes on", Q1 "with many more words,
  // long enough that[^1]" (the picture and note 1), Q2 "the importer cuts…".
  // Line 3 holds a picture and note 2.
  const L2a = "Second line here and it goes on"
  const L2b = `with many more words, long enough that${"\\f + \\ft Note one.\\f*"}`
  const L2c = "the importer cuts the paragraph after this sentence ends."
  const body = para(run(L1 + " ") + run(L2a + " with many more words,") + IMG + run(" long enough that") + ref(1) + run(" " + L2c + " ") + run("Third line") + IMG + run(" here") + ref(2) + run(PAD)) + NEXT
  const cut = async () => {
    const bytes = await docxBytes(body, ["Note one.", "Note two."])
    const [a, b, c, n] = await importCells(bytes)
    const P = { ...typed(b, "Deuxième ligne"), original: L2a } as CellData
    const Q1 = piece(b, "q1", L2b)
    return { bytes, a, P, Q1, c, n }
  }
  const view = (out: Out) => [paras(out.body)[0], noteText(out.notes, 1), noteText(out.notes, 2)]

  it("the middle piece deleted reads exactly as the middle piece hidden: its picture and note go, line 3 keeps its own", async () => {
    const { bytes, a, P, Q1, c, n } = await cut()
    const Q2 = piece(Q1, "q2", L2c)
    const hidden = await wordOut(bytes, [typed(a, "Un."), P, hide(Q1), Q2, c, n])
    expect(view(hidden)).toEqual([`Un. Deuxième ligne ${L2c} Third line[IMG] here[^2] …`, "Note one.", "Note two."])
    const deleted = await wordOut(bytes, [typed(a, "Un."), P, Q2, c, n], [Q1])
    expect(view(deleted)).toEqual(view(hidden))
  })

  it("so with the last piece and line 3 translated", async () => {
    const { bytes, a, P, Q1, c, n } = await cut()
    const Q2 = piece(Q1, "q2", L2c)
    const hidden = await wordOut(bytes, [typed(a, "Un."), P, hide(Q1), typed(Q2, "la fin."), typed(c, "Trois."), n])
    const deleted = await wordOut(bytes, [typed(a, "Un."), P, typed(Q2, "la fin."), typed(c, "Trois."), n], [Q1])
    expect(view(deleted)).toEqual(view(hidden))
    expect(paras(deleted.body)[0]).toBe("Un. Deuxième ligne la fin. Trois.[^2][IMG]")
  })

  it("so with line 1 hidden too", async () => {
    const { bytes, a, P, Q1, c, n } = await cut()
    const Q2 = piece(Q1, "q2", L2c)
    const hidden = await wordOut(bytes, [hide(typed(a, "Un.")), P, hide(Q1), Q2, c, n])
    const deleted = await wordOut(bytes, [hide(typed(a, "Un.")), P, Q2, c, n], [Q1])
    expect(view(deleted)).toEqual(view(hidden))
  })

  it("both pieces cut from P: the deleted one sits right after P", async () => {
    const { bytes, a, P, Q1, c, n } = await cut()
    const Q2 = piece(P, "q2", L2c)
    const hidden = await wordOut(bytes, [typed(a, "Un."), P, hide(Q1), Q2, c, n])
    const deleted = await wordOut(bytes, [typed(a, "Un."), P, Q2, c, n], [Q1])
    expect(view(deleted)).toEqual(view(hidden))
    expect(paras(deleted.body)[0]).toBe(`Un. Deuxième ligne ${L2c} Third line[IMG] here[^2] …`)
  })
})

/** Every bookmark and comment range in the part starts before it ends (and a
 *  comment's reference follows its range). */
function rangesInOrder(xml: string): string[] {
  const out: string[] = []
  const first = (re: RegExp) => { const m = re.exec(xml); return m ? m.index : -1 }
  for (const m of xml.matchAll(/<w:bookmarkStart\b[^>]*w:id="([^"]+)"/g)) {
    const end = first(new RegExp(`<w:bookmarkEnd\\b[^>]*w:id="${m[1]}"`))
    if (end !== -1 && end < m.index!) out.push(`bookmark ${m[1]} ends before it starts`)
  }
  for (const m of xml.matchAll(/<w:commentRangeStart\b[^>]*w:id="([^"]+)"/g)) {
    const end = first(new RegExp(`<w:commentRangeEnd\\b[^>]*w:id="${m[1]}"`))
    const reference = first(new RegExp(`<w:commentReference\\b[^>]*w:id="${m[1]}"`))
    if (end !== -1 && end < m.index!) out.push(`comment ${m[1]} ends before it starts`)
    if (reference !== -1 && reference < Math.max(end, m.index!)) out.push(`comment ${m[1]} referenced before its range`)
  }
  return out
}

describe("Word export — a bookmark or comment is placed among the words only with its partner (AQU-2552, review r8 F4)", () => {
  const START = `<w:bookmarkStart w:id="3" w:name="_Ref1"/><w:commentRangeStart w:id="4"/>`
  const END = `<w:bookmarkEnd w:id="3"/><w:commentRangeEnd w:id="4"/><w:r><w:commentReference w:id="4"/></w:r>`
  const firstPara = (xml: string) => xml.match(/<w:body>(<w:p\b[\s\S]*?<\/w:p>)/)![1]
  // From line 1 ("First line|here") into line 2 ("Second line|here").
  const across = para(run("First line") + START + run(" here" + PAD + " ") + run("Second line") + END + run(" here" + PAD + " ") + run(L3)) + NEXT

  it("from a translated line into an untranslated one: both ends go to the paragraph's end, in order", async () => {
    const bytes = await docxBytes(across)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [typed(a, "Un."), b, typed(c, "Trois."), n])
    expect(rangesInOrder(out.body)).toEqual([])
    expect(paras(out.body)[0]).toBe("Un. Second line here … Trois.")
    expect(firstPara(out.body)).toMatch(new RegExp(`Trois\\.</w:t></w:r>${(START + END).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</w:p>$`))
  })

  it("from an untranslated line into a translated one: so too", async () => {
    const bytes = await docxBytes(across)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [a, typed(b, "Deux."), typed(c, "Trois."), n])
    expect(rangesInOrder(out.body)).toEqual([])
    expect(firstPara(out.body)).toMatch(new RegExp(`Trois\\.</w:t></w:r>${(START + END).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</w:p>$`))
  })

  it("ending inside a link of an untranslated line, copied in place: its start goes in front, never after its end", async () => {
    const src = run("First line") + `<w:bookmarkStart w:id="3" w:name="_Ref1"/>` + run(" here" + PAD + " ") + `<w:hyperlink w:anchor="x">${run("Second line")}<w:bookmarkEnd w:id="3"/></w:hyperlink>` + run(" here" + PAD + " ") + run(L3)
    const bytes = await docxBytes(para(src) + NEXT)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [typed(a, "Un."), b, typed(c, "Trois."), n])
    expect(rangesInOrder(out.body)).toEqual([])
    expect(firstPara(out.body)).toMatch(/^<w:p><w:bookmarkStart w:id="3" w:name="_Ref1"\/><w:r>/)
    expect(firstPara(out.body)).toContain(`<w:hyperlink w:anchor="x"><w:r><w:t xml:space="preserve">Second line</w:t></w:r><w:bookmarkEnd w:id="3"/></w:hyperlink>`)
  })

  it("both ends inside one untranslated line stay among its words", async () => {
    const within = para(run(L1 + " ") + run("Second") + START + run(" line") + END + run(" here" + PAD + " ") + run(L3)) + NEXT
    const bytes = await docxBytes(within)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [typed(a, "Un."), b, typed(c, "Trois."), n])
    expect(rangesInOrder(out.body)).toEqual([])
    expect(firstPara(out.body)).toContain(`Second</w:t></w:r>${START}<w:r><w:t xml:space="preserve"> line</w:t></w:r>${END}`)
  })
})

describe("Word export — a picture in a wrapper stays beside an untranslated line's words (AQU-2552, review r8 F3)", () => {
  const PICTURE_SDT = SDT(IMG, `<w:id w:val="5"/><w:picture/>`)
  const INSERTED = `<w:ins w:id="8" w:author="A" w:date="2026-01-01T00:00:00Z">${IMG}</w:ins>`
  it.each([["a picture content control", PICTURE_SDT], ["a tracked insertion of a picture", INSERTED]])("%s in the middle of an untranslated line", async (_name, wrapped) => {
    const bytes = await docxBytes(para(run(L1 + " ") + run("Second line") + wrapped + run(" here" + PAD + " ") + run(L3)) + NEXT)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [typed(a, "Un."), b, typed(c, "Trois."), n])
    expect(paras(out.body)[0]).toBe("Un. Second line[IMG] here … Trois.")
    expect(out.body).toContain(`Second line</w:t></w:r>${wrapped}<w:r>`)
  })

  it("in a translated line it still follows the paragraph's words", async () => {
    const bytes = await docxBytes(para(run(L1 + " ") + run("Second line") + PICTURE_SDT + run(" here" + PAD + " ") + run(L3)) + NEXT)
    const [a, b, c, n] = await importCells(bytes)
    const out = await wordOut(bytes, [a, typed(b, "Deux."), typed(c, "Trois."), n])
    expect(paras(out.body)[0]).toBe("First line here … Deux. Trois.[IMG]")
  })
})
