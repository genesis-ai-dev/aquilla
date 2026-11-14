// AQU-2552 (question 62, Sam's pick): a hidden or deleted line takes only what
// the app shows as that line, its words and its own footnote. Everything else
// in the paragraph stays: pictures, fields, page breaks, text boxes, content
// controls, links and bookmarks. (AQU-2552 review r9: a tab or line break
// among its words is its text, and goes too.) A wrapper whose words were all the
// lost line's stays, emptied of them, with its own properties. Every cell is
// made by the importer from a small made .docx, as a real import makes it,
// with locators or as a file imported before locators. Every check reads the
// written XML, and every export is checked for Word's structure (each
// wrapper's properties inside their own wrapper included). The same exports
// were validated against the WordprocessingML schema with xmllint when this
// was built.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"
import { hiddenRoundTripRemovals, scopeRoundTripCells } from "../validation-scope"
import { extractDocxStrings } from "@/lib/parsers/docx"
import { normalizeTranslatableStrings, aquillaImportMetadata } from "@/lib/import/normalized-manifest"
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
const para = (inner: string) => `<w:p>${inner}</w:p>`
const NEXT = para(run("Next paragraph."))
const IMG = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="i.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
const FIELD = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
const BOX = (inner: string) =>
  `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="100" cy="100"/><wp:wrapNone/><wp:docPr id="2" name="Text Box 2"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr/><wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>${inner}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`
const SDT = `<w:sdt><w:sdtPr><w:alias w:val="Name"/><w:id w:val="9"/></w:sdtPr><w:sdtContent>`
const BOOKMARK_START = `<w:bookmarkStart w:id="7" w:name="_Ref7"/>`
const BOOKMARK_END = `<w:bookmarkEnd w:id="7"/>`

async function docxBytes(body: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`)
  return zip.generateAsync({ type: "arraybuffer" })
}

/** The cells a real import makes of this file: located, or (`legacy`) as a
 *  file imported before locators, grouped and with no import metadata. */
async function importCells(bytes: ArrayBuffer, legacy: boolean): Promise<CellData[]> {
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
    group: legacy ? (s.group ?? "") : "",
    type: s.type ?? "text",
    status: "empty",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    metadata: legacy ? null : { aquillaImport: aquillaImportMetadata(file, file.units[i]), ...(s.paragraphStart ? { paragraphStart: true } : {}) },
  }) as unknown as CellData)
}

const typed = (cell: CellData, text: string): CellData =>
  ({ ...cell, translated: text, translatedHtml: `<p>${text}</p>`, status: "validated" }) as CellData
const hide = (cell: CellData): CellData => ({ ...cell, hidden: true }) as CellData

interface Out {
  body: string
  result: Awaited<ReturnType<typeof exportDocx>>
}

/** Export as the dialog does: hidden lines cleared and handed over as
 *  removals, `deleted` as the server's removed records. */
async function wordOut(bytes: ArrayBuffer, cells: CellData[], deleted: CellData[] = []): Promise<Out> {
  const result = await exportDocx(bytes, scopeRoundTripCells(cells, "current"), {
    removedCells: [...deleted.map((c) => ({ cellId: c.id, canonicalRef: c.group || null, metadata: c.metadata ?? null })), ...hiddenRoundTripRemovals(cells)],
  })
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const body = await zip.file("word/document.xml")!.async("string")
  expect(() => assertWellFormedXml(body)).not.toThrow()
  expect(structuralProblems(body)).toEqual([])
  expect(looseProperties(body)).toEqual([])
  return { body, result }
}

/** Each wrapper's own properties may only be the first child of their own wrapper. */
function looseProperties(xml: string): string[] {
  const owner: Record<string, string> = { "w:sdtPr": "w:sdt", "w:sdtEndPr": "w:sdt", "w:smartTagPr": "w:smartTag", "w:customXmlPr": "w:customXml" }
  const out: string[] = []
  const walk = (el: XmlElement, parent: XmlElement | null) => {
    if (owner[el.tagName] && parent?.tagName !== owner[el.tagName]) out.push(`${el.tagName} under ${parent?.tagName ?? "nothing"}`)
    for (const child of el.children) if (isElement(child)) walk(child, el)
  }
  walk(parseXmlLite(xml), null)
  return out
}

/** Top-level paragraphs as a reader meets them: text, `[TAB]`, `[IMG]` for a
 *  picture, `[BOX]` for a text box, `[PAGE]` for a page break, `{field}` for a
 *  field's code. PAD reads "…". */
function paras(xml: string): string[] {
  let body = xml.replace(/^[\s\S]*?<w:body>/, "").replace(/<w:sectPr[\s\S]*$/, "")
  body = body.replace(/<mc:AlternateContent>[\s\S]*?<\/mc:AlternateContent>/g, "<BOX/>")
  return (body.match(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []).map((p) =>
    [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:drawing>|<BOX\/>|<w:br w:type="page"\/>|<w:fldChar w:fldCharType="begin"\/>/g)]
      .map((m) => (m[1] !== undefined ? m[1]
        : m[0] === "<w:tab/>" ? "[TAB]"
        : m[0] === "<w:drawing>" ? "[IMG]"
        : m[0] === "<BOX/>" ? "[BOX]"
        : m[0].includes("page") ? "[PAGE]"
        : "{field}"))
      .join("").replaceAll(PAD.trim(), "…"))
}

const firstPara = (xml: string) => xml.match(/<w:body>(<w:p\b[\s\S]*?<\/w:p>)/)![1]

const L1 = "First line here" + PAD
const L3 = "Third line here" + PAD

interface Kind {
  name: string
  /** Line 2 of three, as the source paragraph holds it. */
  line2: string
  /** Line 2's text as the importer reads it ("…" for PAD). */
  source: string
  /** How the piece reads in `paras`. */
  seen: string
  /** What of it the written paragraph holds, byte for byte, when its line is
   *  lost (a wrapper emptied of the line's words), or null when it is part of
   *  the line's own text and leaves with it (AQU-2552 review r9: a tab among
   *  its words). */
  kept: string | null
  /** Line 2 as a reader meets it when it is written as its source. */
  reads: string
  /** What of it the paragraph holds then. */
  parts: string[]
}

const KINDS: Kind[] = [
  {
    name: "a picture", line2: run("Second line") + IMG + run(" here" + PAD), source: "Second line here …",
    seen: "[IMG]", kept: IMG, reads: "Second line[IMG] here …", parts: [IMG],
  },
  {
    name: "a figure-number field", line2: run("Second line, figure ") + FIELD + run(", here" + PAD), source: "Second line, figure 1, here …",
    seen: "{field}", kept: `<w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText>`, reads: "Second line, figure {field}1, here …", parts: [FIELD],
  },
  {
    name: "a tab", line2: run("Second line") + `<w:r><w:tab/></w:r>` + run("here" + PAD), source: "Second line\there …",
    seen: "", kept: null, reads: "Second line[TAB]here …", parts: ["<w:tab/>"],
  },
  {
    name: "a page break", line2: run("Second line") + `<w:r><w:br w:type="page"/></w:r>` + run(" here" + PAD), source: "Second line here …",
    seen: "[PAGE]", kept: `<w:r><w:br w:type="page"/></w:r>`, reads: "Second line[PAGE] here …", parts: [`<w:r><w:br w:type="page"/></w:r>`],
  },
  {
    name: "a text box", line2: run("Second line") + BOX(para(run("Box text here."))) + run(" here" + PAD), source: "Second line here …",
    seen: "[BOX]", kept: "<w:txbxContent>", reads: "Second line[BOX] here …", parts: ["<w:txbxContent>"],
  },
  {
    name: "a content control", line2: `${SDT}${run("Second line here" + PAD)}</w:sdtContent></w:sdt>`, source: "Second line here …",
    seen: "", kept: `${SDT}</w:sdtContent></w:sdt>`, reads: "Second line here …", parts: [SDT, "</w:sdtContent></w:sdt>"],
  },
  {
    name: "a link", line2: run("Second line") + `<w:hyperlink w:anchor="_Top" w:history="1">${run(" links here")}</w:hyperlink>` + run(PAD), source: "Second line links here …",
    seen: "", kept: `<w:hyperlink w:anchor="_Top" w:history="1"></w:hyperlink>`, reads: "Second line links here …", parts: [`<w:hyperlink w:anchor="_Top" w:history="1">${run(" links here")}</w:hyperlink>`],
  },
  {
    name: "a bookmark", line2: run("Second") + BOOKMARK_START + run(" line") + BOOKMARK_END + run(" here" + PAD), source: "Second line here …",
    seen: "", kept: BOOKMARK_START + BOOKMARK_END, reads: "Second line here …", parts: [BOOKMARK_START, BOOKMARK_END],
  },
]

const bodyOf = (kind: Kind) => para(run(L1 + " ") + kind.line2 + run(" " + L3)) + NEXT

/** The paragraph's three lines, the text box's own line, and the next paragraph. */
async function linesOf(kind: Kind, legacy: boolean) {
  const bytes = await docxBytes(bodyOf(kind))
  const cells = await importCells(bytes, legacy)
  const at = (text: string) => cells.find((c) => c.original.startsWith(text))!
  const [a, b, c] = [at("First line"), at("Second"), at("Third line")]
  const rest = cells.filter((cell) => cell !== a && cell !== b && cell !== c)
  return { bytes, a, b, c, rest }
}

describe("Word export — a hidden or deleted line takes only its words and its own footnote (AQU-2552, question 62)", () => {
  it.each(KINDS)("the importer reads line 2 with $name as its own line", async (kind) => {
    for (const legacy of [false, true]) {
      const { b } = await linesOf(kind, legacy)
      expect(b.original.replaceAll(PAD.trim(), "…")).toBe(kind.source)
    }
  })

  it.each(KINDS)("a hidden line's words go and $name stays (file with locators)", async (kind) => {
    const { bytes, a, b, c, rest } = await linesOf(kind, false)
    const out = await wordOut(bytes, [typed(a, "Un."), hide(typed(b, "Deux.")), typed(c, "Trois."), ...rest])
    expect(paras(out.body)[0]).toBe(`Un.${kind.seen} Trois.`)
    if (kind.kept === null) expect(firstPara(out.body)).not.toContain(kind.parts[0])
    else expect(firstPara(out.body)).toContain(kind.kept)
    expect(out.body).not.toMatch(/Second|links here|Deux/)
    expect(paras(out.body).at(-1)).toBe("Next paragraph.")
    // Nothing is said about what the export left out on purpose.
    expect(out.result.lostLooks).toEqual([])
    expect(out.result.fidelity.emptiedFields).toBe(0)
    expect(out.result.fidelity.droppedLinks).toBe(0)
  })

  it.each(KINDS)("a deleted line's words go and $name stays (file with locators)", async (kind) => {
    const { bytes, a, b, c, rest } = await linesOf(kind, false)
    const out = await wordOut(bytes, [typed(a, "Un."), typed(c, "Trois."), ...rest], [b])
    expect(paras(out.body)[0]).toBe(`Un.${kind.seen} Trois.`)
    if (kind.kept === null) expect(firstPara(out.body)).not.toContain(kind.parts[0])
    else expect(firstPara(out.body)).toContain(kind.kept)
    expect(out.body).not.toMatch(/Second|links here/)
    expect(out.result.lostLooks).toEqual([])
    expect(out.result.fidelity.emptiedFields).toBe(0)
    expect(out.result.fidelity.droppedLinks).toBe(0)
  })

  it.each(KINDS)("a hidden line keeps its words and $name in place on a file imported before locators", async (kind) => {
    // Such a file can place no removal, so a hidden line keeps its original
    // text, as the export dialog's note says (AQU-2552 review r6).
    const { bytes, a, b, c, rest } = await linesOf(kind, true)
    const out = await wordOut(bytes, [typed(a, "Un."), hide(typed(b, "Deux.")), typed(c, "Trois."), ...rest])
    expect(paras(out.body)[0]).toBe(`Un. ${kind.reads} Trois.`)
    for (const part of kind.parts) expect(firstPara(out.body)).toContain(part)
    expect(out.body).not.toContain("Deux")
  })

  // On such a file the export cannot tell a deleted line's words from words
  // that changed: a tab among them goes with them, and a link they filled
  // goes as a link whose words changed does (AQU-2539). Its other pieces stay.
  const legacyKept = KINDS.filter((kind) => kind.name !== "a tab" && kind.name !== "a link")
  it.each(legacyKept)("a deleted line's words go and $name stays on a file imported before locators", async (kind) => {
    const { bytes, a, b, c, rest } = await linesOf(kind, true)
    const out = await wordOut(bytes, [typed(a, "Un."), typed(c, "Trois."), ...rest], [b])
    expect(paras(out.body)[0]).toBe(`Un. Trois.${kind.seen}`)
    if (kind.kept === null) expect(firstPara(out.body)).not.toContain(kind.parts[0])
    else expect(firstPara(out.body)).toContain(kind.kept)
    expect(out.body).not.toMatch(/Second|links here/)
  })

  it("a deleted line's tab and link go with its words on a file imported before locators, as before", async () => {
    for (const kind of KINDS.filter((k) => !legacyKept.includes(k))) {
      const { bytes, a, b, c, rest } = await linesOf(kind, true)
      const out = await wordOut(bytes, [typed(a, "Un."), typed(c, "Trois."), ...rest], [b])
      expect(paras(out.body)[0]).toBe("Un. Trois.")
      expect(out.body).not.toMatch(/Second|links here|w:hyperlink|<w:tab\/>/)
    }
  })
})

describe("Word export — a lost line's tab never turns up in another line (AQU-2552, review r9)", () => {
  // R2: the line separators an old translation lacks come back from the
  // remaining lines only. "Amen." ends line 1 and follows line 2's tab.
  it("rebuilds no tab from a hidden or deleted line's text, so none is doubled", async () => {
    const L1g = "Glory to God" + PAD + " Amen."
    const bytes = await docxBytes(para(run(L1g + " ") + run("Praise him" + PAD) + `<w:r><w:tab/></w:r>` + run("Amen. ") + run("Next line here" + PAD)) + NEXT)
    const cells = await importCells(bytes, false)
    const b = cells.find((c) => c.original.startsWith("Praise"))!
    expect(b.original.replaceAll(PAD.trim(), "…")).toBe("Praise him …\tAmen.")
    const rest = cells.filter((c) => c !== b)
    for (const out of [await wordOut(bytes, [rest[0], hide(b), ...rest.slice(1)]), await wordOut(bytes, rest, [b])]) {
      expect(paras(out.body)[0]).toBe("Glory to God … Amen. Next line here …")
    }
  })
})
// AQU-2552 (review r9): one rule. A hidden or deleted line takes its own
// text, with any tab or line break inside that text, and its own footnote;
// everything else stays exactly where it was, at the boundary after the
// remaining line before it. A paragraph leaves only when nothing in it
// remains.
describe("Word export — what a lost line owns is its own text range and its footnote (AQU-2552, review r9)", () => {
  /** A paragraph of three lines, line 2 as given, and the next paragraph. */
  async function threeLines(line2: string, legacy = false) {
    const bytes = await docxBytes(para(run(L1 + " ") + line2 + run(" " + L3)) + NEXT)
    const cells = await importCells(bytes, legacy)
    const at = (text: string) => cells.find((c) => c.original.startsWith(text))!
    const [a, b, c] = [at("First line"), at("Second"), at("Third line")]
    return { bytes, a, b, c, rest: cells.filter((cell) => cell !== a && cell !== b && cell !== c) }
  }
  /** Line 2 lost every way: hidden or deleted, its neighbours translated or not. */
  async function eachLoss(line2: string, check: (out: Out, translated: boolean) => void) {
    const { bytes, a, b, c, rest } = await threeLines(line2)
    check(await wordOut(bytes, [typed(a, "Un."), hide(typed(b, "Deux.")), typed(c, "Trois."), ...rest]), true)
    check(await wordOut(bytes, [typed(a, "Un."), typed(c, "Trois."), ...rest], [b]), true)
    check(await wordOut(bytes, [a, hide(b), c, ...rest]), false)
    check(await wordOut(bytes, [a, c, ...rest], [b]), false)
  }
  const remaining = (translated: boolean) => (translated ? "Un. Trois." : "First line here … Third line here …")

  // R4: a tab or line break inside a lost line's words is part of its text.
  it.each([
    ["a tab in a run of its own", run("Second line") + `<w:r><w:tab/></w:r>` + run("here" + PAD), "Second line\there …"],
    ["a tab sharing a run with words", `<w:r><w:t>Second</w:t><w:tab/><w:t xml:space="preserve">line here${PAD}</w:t></w:r>`, "Second\tline here …"],
    ["a line break sharing a run with words", `<w:r><w:t>Second line</w:t><w:br/><w:t xml:space="preserve">here${PAD}</w:t></w:r>`, "Second line\nhere …"],
    ["a line break in a run of its own", run("Second line") + `<w:r><w:br/></w:r>` + run("here" + PAD), "Second line\nhere …"],
  ])("%s inside a lost line's words leaves with them", async (_, line2, source) => {
    const { b } = await threeLines(line2)
    expect(b.original.replaceAll(PAD.trim(), "…")).toBe(source)
    await eachLoss(line2, (out, translated) => {
      expect(paras(out.body)[0]).toBe(remaining(translated))
      expect(firstPara(out.body)).not.toMatch(/<w:tab\/>|<w:br\/>/)
    })
  })

  // R3: what a lost line keeps sits where the line was, at the boundary
  // after the remaining line before it, its neighbours translated or not.
  const staying = KINDS.filter((kind) => kind.seen !== "")
  it.each(staying)("$name of a lost line sits after the remaining line before it", async (kind) => {
    await eachLoss(kind.line2, (out, translated) => {
      expect(paras(out.body)[0]).toBe(translated ? `Un.${kind.seen} Trois.` : `First line here …${kind.seen} Third line here …`)
    })
    // One neighbour translated, the other not.
    const { bytes, a, b, c, rest } = await threeLines(kind.line2)
    expect(paras((await wordOut(bytes, [typed(a, "Un."), hide(b), c, ...rest])).body)[0]).toBe(`Un.${kind.seen} Third line here …`)
    expect(paras((await wordOut(bytes, [a, typed(c, "Trois."), ...rest], [b])).body)[0]).toBe(`First line here …${kind.seen} Trois.`)
  })

  it.each(staying)("$name of a lost first line sits before the first remaining line", async (kind) => {
    const bytes = await docxBytes(para(kind.line2 + run(" " + L1 + " ") + run(L3)) + NEXT)
    const cells = await importCells(bytes, false)
    const at = (text: string) => cells.find((c) => c.original.startsWith(text))!
    const [b, a, c] = [at("Second"), at("First line"), at("Third line")]
    const rest = cells.filter((cell) => cell !== a && cell !== b && cell !== c)
    const out = await wordOut(bytes, [hide(b), typed(a, "Un."), typed(c, "Trois."), ...rest])
    expect(paras(out.body)[0]).toBe(`${kind.seen}Un. Trois.`)
  })

  it("a lost last line's picture follows the paragraph's words, after the remaining lines' own pieces, in source order", async () => {
    const line1 = run("First line") + IMG.replace('id="1" name="Picture 1"', 'id="3" name="Picture 3"') + run(" here" + PAD)
    const bytes = await docxBytes(para(line1 + run(" Second line here" + PAD + " ") + run("Third line") + IMG + run(" here" + PAD)) + NEXT)
    const cells = await importCells(bytes, false)
    const [a, b, c, ...rest] = cells
    const out = await wordOut(bytes, [typed(a, "Un."), typed(b, "Deux."), hide(c), ...rest])
    expect(paras(out.body)[0]).toBe("Un. Deux.[IMG][IMG]")
    expect(firstPara(out.body).indexOf("Picture 3")).toBeLessThan(firstPara(out.body).indexOf("Picture 1"))
  })

  // R1: a paragraph leaves only when nothing in it remains. One whose lines
  // are all lost keeps what is not their text, written without their words.
  /** The paragraph `body` holds, its lines all hidden, then all deleted. */
  async function allLost(body: string, also: (cells: CellData[]) => CellData[] = () => []) {
    const bytes = await docxBytes(body + NEXT)
    const cells = await importCells(bytes, false)
    const next = cells.find((c) => c.original === "Next paragraph.")!
    const extra = also(cells)
    const lines = cells.filter((c) => c !== next && !extra.some((x) => x.id === c.id))
    return [
      await wordOut(bytes, [...lines.map((c) => hide(typed(c, "Caché."))), ...extra, next]),
      await wordOut(bytes, [...extra, next], lines),
    ]
  }

  it("a paragraph whose lines are all lost keeps its picture, without their words", async () => {
    for (const body of [
      para(run("Only line") + IMG + run(" here.")),
      para(run(L1 + " ") + run("Second line") + IMG + run(" here" + PAD)),
    ]) {
      for (const out of await allLost(body)) {
        expect(paras(out.body)).toEqual(["[IMG]", "Next paragraph."])
        expect(out.body).not.toMatch(/line here|Only line|Caché/)
        expect(out.result.removed).toBe(0)
      }
    }
  })

  it("a paragraph whose lines are all lost keeps its text box, with the box's own line, translated or not", async () => {
    const holder = para(run(L1 + " ") + run("Second line") + BOX(para(run("Box words here."))) + run(" here" + PAD))
    const box = (cells: CellData[]) => cells.filter((c) => c.original === "Box words here.")
    for (const out of await allLost(holder, (cells) => box(cells).map((c) => typed(c, "Mots de la boîte.")))) {
      expect(paras(out.body)).toEqual(["[BOX]", "Next paragraph."])
      expect(out.body.match(/Mots de la boîte\./g)).toHaveLength(2) // the box and its stored copy
      expect(out.body).not.toMatch(/line here|Box words/)
    }
    for (const out of await allLost(holder, (cells) => box(cells))) {
      expect(paras(out.body)).toEqual(["[BOX]", "Next paragraph."])
      expect(out.body.match(/Box words here\./g)).toHaveLength(2)
    }
  })

  it("a paragraph whose lines are all lost keeps its field and its page break, in their places", async () => {
    const body = para(run("Figure ") + FIELD + run(" shows the map.") + `<w:r><w:br w:type="page"/></w:r>`)
    for (const out of await allLost(body)) {
      expect(paras(out.body)).toEqual(["{field}[PAGE]", "Next paragraph."])
      expect(firstPara(out.body)).toContain("SEQ Figure")
    }
  })

  it("a paragraph left with nothing is removed, as before: no words, or only marks of no width and its emptied wrappers", async () => {
    for (const body of [
      para(run("Only a line of words here.")),
      para(`<w:pPr><w:pStyle w:val="Body"/></w:pPr><w:proofErr w:type="spellStart"/>` + BOOKMARK_START + run("Only a line") + BOOKMARK_END + `<w:proofErr w:type="spellEnd"/>` + run(" of words here.")),
      para(`<w:r><w:rPr><w:b/></w:rPr><w:lastRenderedPageBreak/><w:t>Only a line</w:t></w:r>` + run(" of words here.")),
      para(`<w:hyperlink w:anchor="_Top">${run("Only a line of words here.")}</w:hyperlink>`),
      para(`${SDT}${run("Only a line of words here.")}</w:sdtContent></w:sdt>`),
    ]) {
      for (const out of await allLost(body)) {
        expect(paras(out.body)).toEqual(["Next paragraph."])
        expect(out.result.removed).toBe(1)
      }
    }
  })
})
