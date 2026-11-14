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
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" mc:Ignorable="wps"'

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
async function wordOut(bytes: ArrayBuffer, cells: CellData[], deleted: CellData[] = [], emptiedOnPurpose: readonly string[] = []): Promise<Out> {
  const result = await exportDocx(bytes, scopeRoundTripCells(cells, "current"), {
    removedCells: [...deleted.map((c) => ({ cellId: c.id, canonicalRef: c.group || null, metadata: c.metadata ?? null })), ...hiddenRoundTripRemovals(cells)],
  })
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const body = await zip.file("word/document.xml")!.async("string")
  expect(() => assertWellFormedXml(body)).not.toThrow()
  expect(structuralProblems(body, undefined, { emptiedOnPurpose })).toEqual([])
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

/** AQU-2552 (review r9): the link a kind's lost line empties on purpose, by its start tag. */
const emptiedBy = (kind: Kind) => [kind.kept?.match(/^(<w:hyperlink\b[^>]*>)<\/w:hyperlink>$/)?.[1]].filter((tag): tag is string => tag !== undefined)

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
    const out = await wordOut(bytes, [typed(a, "Un."), hide(typed(b, "Deux.")), typed(c, "Trois."), ...rest], [], emptiedBy(kind))
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
    const out = await wordOut(bytes, [typed(a, "Un."), typed(c, "Trois."), ...rest], [b], emptiedBy(kind))
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
  async function eachLoss(line2: string, check: (out: Out, translated: boolean) => void, emptied: readonly string[] = []) {
    const { bytes, a, b, c, rest } = await threeLines(line2)
    check(await wordOut(bytes, [typed(a, "Un."), hide(typed(b, "Deux.")), typed(c, "Trois."), ...rest], [], emptied), true)
    check(await wordOut(bytes, [typed(a, "Un."), typed(c, "Trois."), ...rest], [b], emptied), true)
    check(await wordOut(bytes, [a, hide(b), c, ...rest], [], emptied), false)
    check(await wordOut(bytes, [a, c, ...rest], [b], emptied), false)
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

  // A wrapper the lost line emptied has nothing left in it to place it by:
  // it sits where it began.
  it.each(KINDS.filter((kind) => kind.name === "a link" || kind.name === "a content control"))("$name a lost line emptied sits after the remaining line before it", async (kind) => {
    await eachLoss(kind.line2, (out, translated) => {
      const first = firstPara(out.body)
      expect(first.indexOf(kind.kept!)).toBeGreaterThan(first.indexOf(translated ? "Un." : "First line"))
      expect(first.indexOf(kind.kept!)).toBeLessThan(first.indexOf(translated ? "Trois." : "Third line"))
    }, emptiedBy(kind))
  })

  it("a picture right at the cut between a remaining line and the lost line after it stays at that cut", async () => {
    const bytes = await docxBytes(para(run(L1) + IMG + run(" Second line here" + PAD + " ") + run(L3)) + NEXT)
    const [a, b, c, ...rest] = await importCells(bytes, false)
    expect(b.original.replaceAll(PAD.trim(), "…")).toBe("Second line here …")
    expect(paras((await wordOut(bytes, [typed(a, "Un."), hide(b), typed(c, "Trois."), ...rest])).body)[0]).toBe("Un.[IMG] Trois.")
    expect(paras((await wordOut(bytes, [typed(a, "Un."), typed(c, "Trois."), ...rest], [b])).body)[0]).toBe("Un.[IMG] Trois.")
    expect(paras((await wordOut(bytes, [a, hide(b), c, ...rest])).body)[0]).toBe("First line here …[IMG] Third line here …")
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
      // AQU-2552 (review r11): a bookmark is not one of these: it keeps its
      // paragraph (see below).
      para(`<w:pPr><w:pStyle w:val="Body"/></w:pPr><w:proofErr w:type="spellStart"/>` + run("Only a line") + `<w:proofErr w:type="spellEnd"/>` + run(" of words here.")),
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

  // R6: a field or wrapper any of whose characters is a lost line's is never
  // looked for by its whole result. Here line 1 ends with the very words the
  // result holds of line 2 ("here …"), so a whole-result search finds them
  // there, and the copy covers line 1's words with line 2's run.
  const FIELD_OF = (inner: string) =>
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "http://x.example/" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${inner}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
  const oneRun = run("here" + PAD + " Third")
  /** Three lines, `wrapped` holding the end of line 2 and "Third", line 3's first word. */
  async function intoLine3(wrapped: string) {
    const bytes = await docxBytes(para(run(L1 + " ") + run("Second line ") + wrapped + run(" line here" + PAD)) + NEXT)
    const cells = await importCells(bytes, false)
    const at = (text: string) => cells.find((c) => c.original.startsWith(text))!
    const [a, b, c] = [at("First line"), at("Second"), at("Third line")]
    return { bytes, a, b, c, rest: cells.filter((cell) => cell !== a && cell !== b && cell !== c) }
  }
  it.each([
    ["a field", FIELD_OF(oneRun), /fldCharType="separate"\/><\/w:r>([\s\S]*?)<w:r><w:fldChar w:fldCharType="end"/],
    ["a link", `<w:hyperlink w:anchor="x">${oneRun}</w:hyperlink>`, /<w:hyperlink w:anchor="x">([\s\S]*?)<\/w:hyperlink>/],
  ])("%s running from a lost line into the next, in one run, never covers another line's words", async (_, wrapped, inside) => {
    const { bytes, a, b, c, rest } = await intoLine3(wrapped)
    expect(b.original.replaceAll(PAD.trim(), "…")).toBe("Second line here …")
    expect(c.original.replaceAll(PAD.trim(), "…")).toBe("Third line here …")
    for (const out of [await wordOut(bytes, [a, hide(b), c, ...rest]), await wordOut(bytes, [a, c, ...rest], [b])]) {
      expect(paras(out.body)[0].replace("{field}", "")).toBe("First line here … Third line here …")
      expect(firstPara(out.body)).not.toContain(oneRun)
      expect(inside.exec(firstPara(out.body))?.[1] ?? "").not.toMatch(/here and it goes/)
    }
  })

  // R5: a link (or other wrapper) running from a lost line into a remaining
  // one keeps covering the remaining words. When that line is untranslated,
  // they keep their look and the link is not reported as changed.
  const bold = "<w:b/>"
  const LINK = `<w:hyperlink w:anchor="x">`
  it.each([
    ["a link", `${LINK}${run("here" + PAD + " ")}${run("Third", bold)}</w:hyperlink>`, `${LINK}${run("Third", bold)}</w:hyperlink>`],
    ["a content control", `${SDT}${run("here" + PAD + " ")}${run("Third", bold)}</w:sdtContent></w:sdt>`, `${SDT}${run("Third", bold)}</w:sdtContent></w:sdt>`],
    ["a field", FIELD_OF(run("here" + PAD + " ") + run("Third", bold)), FIELD_OF(run("Third", bold))],
    ["a link whose one run holds both lines' words", `${LINK}${oneRun}</w:hyperlink>`, `${LINK}<w:r><w:t xml:space="preserve"> Third</w:t></w:r></w:hyperlink>`],
  ])("%s running from a lost line into an untranslated one keeps covering its remaining words", async (_, wrapped, kept) => {
    const { bytes, a, b, c, rest } = await intoLine3(wrapped)
    for (const out of [await wordOut(bytes, [a, hide(b), c, ...rest]), await wordOut(bytes, [a, c, ...rest], [b])]) {
      expect(paras(out.body)[0].replace("{field}", "")).toBe("First line here … Third line here …")
      expect(firstPara(out.body)).toContain(kept)
      expect(out.body).not.toMatch(/Second/)
      expect(out.result.fidelity.droppedLinks).toBe(0)
      expect(out.result.fidelity.emptiedFields).toBe(0)
      expect(out.result.lostLooks).toEqual([])
    }
  })

  it("a link running from a lost line into a translated one is dropped, its words changed, as any such link", async () => {
    const { bytes, a, b, c, rest } = await intoLine3(`${LINK}${run("here" + PAD + " ")}${run("Third")}</w:hyperlink>`)
    const out = await wordOut(bytes, [typed(a, "Un."), hide(b), typed(c, "Trois."), ...rest])
    expect(paras(out.body)[0]).toBe("Un. Trois.")
    expect(out.body).not.toContain("w:hyperlink")
    expect(out.result.fidelity.droppedLinks).toBe(1)
  })

  // From the independent review of these fixes.
  /** The same file with a footnotes part holding `notes` (ids 1, 2…). */
  async function withNotes(body: string, notes: string[]): Promise<ArrayBuffer> {
    const zip = await JSZip.loadAsync(await docxBytes(body))
    zip.file("word/footnotes.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W_NS}>` +
      notes.map((text, k) => `<w:footnote w:id="${k + 1}"><w:p><w:r><w:footnoteRef/></w:r>${text ? run(" " + text) : ""}</w:p></w:footnote>`).join("") + `</w:footnotes>`)
    return zip.generateAsync({ type: "arraybuffer" })
  }
  const noteRef = `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>`

  it("a footnote reference with no note text, in the part of a cut link that remains, is kept", async () => {
    const bytes = await withNotes(para(run(L1 + " ") + run("Second line ") + `${LINK}${run("here" + PAD + " ")}${run("Third line")}${noteRef}${run(" here")}</w:hyperlink>` + run(PAD)) + NEXT, [""])
    const [a, b, c, ...rest] = await importCells(bytes, false)
    for (const out of [await wordOut(bytes, [typed(a, "Un."), hide(b), c, ...rest]), await wordOut(bytes, [typed(a, "Un."), c, ...rest], [b])]) {
      expect(out.body.match(/<w:footnoteReference w:id="1"\/>/g)).toHaveLength(1)
      expect(firstPara(out.body)).toContain(`${run("Third line")}${noteRef}${run(" here")}</w:hyperlink>`)
    }
  })

  it("a footnote reference with no note text inside a lost line, or right after its last word, leaves with it", async () => {
    for (const line2 of [run("Second line") + noteRef + run(" here" + PAD), run("Second line here" + PAD) + noteRef]) {
      const bytes = await withNotes(para(run(L1 + " ") + line2 + run(" " + L3)) + NEXT, [""])
      const [a, b, c, ...rest] = await importCells(bytes, false)
      const out = await wordOut(bytes, [typed(a, "Un."), hide(b), typed(c, "Trois."), ...rest])
      expect(paras(out.body)[0]).toBe("Un. Trois.")
      expect(out.body).not.toContain("w:footnoteReference")
    }
  })

  it("a link over the end of line 1, all of a lost line 2 and the start of line 3, in one run, keeps the words left with one space", async () => {
    const tail = "with many more words, long enough that the importer cuts the paragraph after this sentence ends."
    const bytes = await docxBytes(para(run("First line here and it goes on ") + `${LINK}${run(`${tail} Second line here${PAD} Third line`)}</w:hyperlink>` + run(" here" + PAD)) + NEXT)
    const [a, b, c, ...rest] = await importCells(bytes, false)
    expect(b.original.replaceAll(PAD.trim(), "…")).toBe("Second line here …")
    for (const out of [await wordOut(bytes, [a, hide(b), c, ...rest]), await wordOut(bytes, [a, c, ...rest], [b])]) {
      expect(paras(out.body)[0]).toBe("First line here … Third line here …")
      expect(firstPara(out.body)).toContain(`${LINK}<w:r><w:t xml:space="preserve">${tail} Third line</w:t></w:r></w:hyperlink>`)
      expect(out.result.fidelity.droppedLinks).toBe(0)
    }
  })

  it("a paragraph whose lines are all lost leaves when what remains is nothing a reader sees: hidden text, a tracked deletion", async () => {
    for (const body of [
      para(run("Only line here.") + run(" secret", "<w:vanish/>")),
      para(run("Only line here.") + `<w:del w:id="9" w:author="a" w:date="2020-01-01T00:00:00Z"><w:r><w:delText>old</w:delText></w:r></w:del>`),
    ]) {
      for (const out of await allLost(body)) {
        expect(paras(out.body)).toEqual(["Next paragraph."])
        expect(out.result.removed).toBe(1)
      }
    }
  })

  it("a paragraph whose lines are all lost keeps its section break", async () => {
    for (const out of await allLost(`<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr>${run("Only line here.")}</w:p>`)) {
      expect(out.body).toContain(`<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr></w:p>`)
      expect(out.body).not.toContain("Only line")
    }
  })

  // Review r10 (N1): one answer for "nothing remains". A paragraph whose lines
  // are all lost leaves exactly when, without them, it holds nothing a reader
  // sees, whatever wrapper or field held the words.
  const ONLY = "Only line here."
  const TARGET = para(`<w:bookmarkStart w:id="1" w:name="_Ref1"/>${run("Target words.")}<w:bookmarkEnd w:id="1"/>`)
  const target = (cells: CellData[]) => cells.filter((c) => c.original === "Target words.")
  const moved = (tag: string, inner: string) => `<${tag} w:id="40" w:author="A" w:date="2020-01-01T00:00:00Z">${inner}</${tag}>`
  it.each([
    ["a link", para(`<w:hyperlink w:anchor="_Top">${run(ONLY)}</w:hyperlink>`)],
    ["a complex field", para(FIELD_OF(run(ONLY)))],
    ["a simple field", TARGET + para(`<w:fldSimple w:instr=" REF _Ref1 \\h ">${run(ONLY)}</w:fldSimple>`)],
    ["a content control", para(`${SDT}${run(ONLY)}</w:sdtContent></w:sdt>`)],
    ["a smart tag", para(`<w:smartTag w:uri="urn:x" w:element="e"><w:smartTagPr><w:attr w:name="a" w:val="b"/></w:smartTagPr>${run(ONLY)}</w:smartTag>`)],
    ["a custom XML element", para(`<w:customXml w:uri="urn:x" w:element="e"><w:customXmlPr><w:attr w:name="a" w:val="b"/></w:customXmlPr>${run(ONLY)}</w:customXml>`)],
    ["a tracked insertion", para(moved("w:ins", run(ONLY)))],
    ["a tracked move here", para(moved("w:moveTo", run(ONLY)))],
    ["words beside a tracked move away", para(run(ONLY) + moved("w:moveFrom", `<w:r><w:delText>moved</w:delText></w:r>`))],
    ["words beside a deleted picture", para(run(ONLY) + moved("w:del", IMG))],
    ["words beside a picture hidden in Word", para(run(ONLY) + IMG.replace("<w:r>", "<w:r><w:rPr><w:vanish/></w:rPr>"))],
  ])("a paragraph whose lines are all lost leaves when it holds nothing a reader sees: %s emptied of them", async (_, body) => {
    for (const out of await allLost(body, target)) {
      expect(paras(out.body)).toEqual([...(body.startsWith(TARGET) ? ["Target words."] : []), "Next paragraph."])
      expect(out.result.removed).toBe(1)
      expect(out.result.injected).toBe(0)
    }
  })

  it.each([
    ["a column break", `<w:r><w:br w:type="column"/></w:r>`],
    ["a symbol", `<w:r><w:sym w:font="Wingdings" w:char="F0E0"/></w:r>`],
    ["an equation", `<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>`],
  ])("a paragraph whose lines are all lost stays when it holds something a reader sees: %s", async (_, thing) => {
    for (const out of await allLost(para(run("Only line") + thing + run(" here.")))) {
      expect(firstPara(out.body)).toContain(thing)
      expect(out.body).not.toContain("Only line")
      expect(out.result.removed).toBe(0)
    }
  })

  // Review r11 (finding 1): a paragraph whose lines are all lost, and which
  // carries a bookmark, a comment's marks or a field running on beyond it,
  // stays, emptied of its words, with those marks in it, whatever follows it.
  // Nothing moves to another paragraph, so nothing pointing at them, or
  // pairing with them, is left without them or ends before it starts.
  const nextOf = (xml: string) => xml.match(/<w:body>[\s\S]*?(<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*Next paragraph\.[\s\S]*?<\/w:p>)/)![1]
  it("a heading whose lines are all lost stays, emptied, with its bookmark, so the contents' page number still finds it", async () => {
    const pageRef = para(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("3")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`)
    const heading = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="5" w:name="_Toc1"/>${run("Chapter one heading.")}<w:bookmarkEnd w:id="5"/></w:p>`
    for (const out of await allLost(pageRef + heading, (cells) => cells.filter((c) => c.original === "3"))) {
      expect(paras(out.body)).toEqual(["{field}3", "", "Next paragraph."])
      expect(out.body).toContain(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="5" w:name="_Toc1"/><w:bookmarkEnd w:id="5"/></w:p>${NEXT}`)
      expect(out.result.removed).toBe(1)
    }
  })

  it("a paragraph whose lines are all lost stays, emptied, with the start of a bookmark or comment that ends in the next paragraph, which is left as it was", async () => {
    for (const [mark, end] of [
      [`<w:bookmarkStart w:id="6" w:name="b6"/>`, `<w:bookmarkEnd w:id="6"/>`],
      [`<w:commentRangeStart w:id="3"/>`, `<w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r>`],
    ]) {
      const bytes = await docxBytes(para(mark + run(ONLY)) + para(run("Next paragraph.") + end))
      const [line, next] = await importCells(bytes, false)
      for (const out of [await wordOut(bytes, [hide(typed(line, "Caché.")), next]), await wordOut(bytes, [next], [line])]) {
        expect(paras(out.body)).toEqual(["", "Next paragraph."])
        expect(out.body).toContain(para(mark) + para(run("Next paragraph.") + end))
      }
    }
  })

  it("a paragraph whose lines are all lost keeps a comment's range and reference, in order, in itself", async () => {
    const comment = `<w:commentRangeStart w:id="3"/>${run(ONLY)}<w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r>`
    for (const out of await allLost(para(comment))) {
      expect(out.body).toContain(para(`<w:commentRangeStart w:id="3"/><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r>`) + NEXT)
      expect(out.result.removed).toBe(1)
    }
  })

  // Review r11 (finding 4): a mark inside text Word does not show (deleted, or
  // moved away) is the paragraph's all the same: it keeps the paragraph, and
  // stays in it, out of the deletion, so its pair still has both ends.
  it.each([
    ["w:del", `<w:bookmarkStart w:id="6" w:name="b6"/>`, `<w:bookmarkEnd w:id="6"/>`],
    ["w:moveFrom", `<w:bookmarkStart w:id="6" w:name="b6"/>`, `<w:bookmarkEnd w:id="6"/>`],
    ["w:del", `<w:commentRangeStart w:id="3"/>`, `<w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r>`],
  ])("a paragraph whose lines are all lost keeps a mark it holds inside %s, out of it", async (tag, start, end) => {
    const gone = moved(tag, `${end}<w:r><w:delText>old</w:delText></w:r>`)
    const bytes = await docxBytes(para(start + run("Before words.")) + para(run(ONLY) + gone) + NEXT)
    const [before, line, next] = await importCells(bytes, false)
    for (const out of [await wordOut(bytes, [before, hide(typed(line, "Caché.")), next]), await wordOut(bytes, [before, next], [line])]) {
      expect(out.body).toContain(para(start + run("Before words.")) + para(end) + NEXT)
      expect(out.result.removed).toBe(1)
    }
  })

  it("a paragraph whose lines are all lost keeps a contents field's start running on into the next paragraph; a field all its own goes", async () => {
    const begin = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`
    const end = `<w:r><w:fldChar w:fldCharType="end"/></w:r>`
    const bytes = await docxBytes(para(begin + run("Chapter one.") + FIELD_OF(run(" More."))) + para(run("Next paragraph.") + end))
    const [line, next] = await importCells(bytes, false)
    for (const out of [await wordOut(bytes, [hide(typed(line, "Caché.")), next]), await wordOut(bytes, [next], [line])]) {
      expect(paras(out.body)).toEqual(["{field}", "Next paragraph."])
      expect(out.body).toContain(para(begin) + para(run("Next paragraph.") + end))
    }
  })

  // The checker's cases (r11, s12): a table, a block content control, or
  // nothing at all after it. Marks moved past these ended before they began.
  const TABLE = (inner: string) => `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr/>${inner}</w:tc></w:tr></w:tbl>`
  const BLOCK_SDT = (inner: string) => `<w:sdt><w:sdtPr><w:id w:val="1"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`
  const FIELD_BEGIN = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`
  const FIELD_END = `<w:r><w:fldChar w:fldCharType="end"/></w:r>`
  it.each([
    ["a table holding a bookmark's end", `<w:bookmarkStart w:id="6" w:name="b6"/>`, (rest: string) => TABLE(para(rest + `<w:bookmarkEnd w:id="6"/>`)) + NEXT],
    ["a table holding a comment's end", `<w:commentRangeStart w:id="3"/>`, (rest: string) => TABLE(para(rest + `<w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r>`)) + NEXT],
    ["a table holding a field's end", FIELD_BEGIN, (rest: string) => TABLE(para(rest + FIELD_END)) + NEXT],
    ["a content control holding a bookmark's end", `<w:bookmarkStart w:id="6" w:name="b6"/>`, (rest: string) => BLOCK_SDT(para(rest + `<w:bookmarkEnd w:id="6"/>`)) + NEXT],
    ["a table and nothing after it", `<w:bookmarkStart w:id="6" w:name="b6"/>`, (rest: string) => TABLE(para(rest + `<w:bookmarkEnd w:id="6"/>`))],
  ])("a paragraph whose lines are all lost, followed by %s, stays emptied with its mark, before what follows", async (_, mark, after) => {
    const body = para(run("Before words.")) + para(mark + run(ONLY)) + after(run("Gamma words."))
    const bytes = await docxBytes(body)
    const cells = await importCells(bytes, false)
    const line = cells.find((c) => c.original === ONLY)!
    const others = cells.filter((c) => c !== line)
    for (const out of [await wordOut(bytes, [...others, hide(typed(line, "Caché."))]), await wordOut(bytes, others, [line])]) {
      expect(out.body).toContain(`<w:body>${para(run("Before words.")) + para(mark) + after(run("Gamma words."))}<w:sectPr/>`)
      expect(out.result.removed).toBe(1)
    }
  })

  it("the last paragraph of the body, its lines all lost, stays emptied with the end of a bookmark begun before it", async () => {
    const bytes = await docxBytes(para(`<w:bookmarkStart w:id="6" w:name="b6"/>` + run("Before words.")) + para(run(ONLY) + `<w:bookmarkEnd w:id="6"/>`))
    const [before, line] = await importCells(bytes, false)
    for (const out of [await wordOut(bytes, [before, hide(typed(line, "Caché."))]), await wordOut(bytes, [before], [line])]) {
      expect(out.body).toContain(`${para(`<w:bookmarkStart w:id="6" w:name="b6"/>` + run("Before words."))}${para(`<w:bookmarkEnd w:id="6"/>`)}<w:sectPr/>`)
    }
  })

  it("the last paragraph of a table cell, emptied, keeps its marks", async () => {
    const cell = (inner: string) => `<w:tbl><w:tr><w:tc>${inner}</w:tc></w:tr></w:tbl>`
    const bytes = await docxBytes(cell(para(`<w:bookmarkStart w:id="6" w:name="b6"/>` + run(ONLY) + `<w:bookmarkEnd w:id="6"/>`)) + NEXT)
    const [line, next] = await importCells(bytes, false)
    for (const out of [await wordOut(bytes, [hide(typed(line, "Caché.")), next]), await wordOut(bytes, [next], [line])]) {
      expect(out.body).toContain(`<w:tc><w:p><w:bookmarkStart w:id="6" w:name="b6"/><w:bookmarkEnd w:id="6"/></w:p></w:tc>`)
    }
  })

  // Review r10 (N5): a paragraph whose lines are all lost but which stays
  // (it keeps a picture) is neither translated nor removed.
  it("a paragraph whose lines are all lost but which keeps a picture is counted neither translated nor removed", async () => {
    const bytes = await docxBytes(para(run("Only line") + IMG + run(" here.")) + para(run("Other words here.")) + NEXT)
    const [line, other, next] = await importCells(bytes, false)
    for (const out of [
      await wordOut(bytes, [hide(typed(line, "Caché.")), typed(other, "Autres mots."), next]),
      await wordOut(bytes, [typed(other, "Autres mots."), next], [line]),
    ]) {
      expect(paras(out.body)).toEqual(["[IMG]", "Autres mots.", "Next paragraph."])
      expect(out.result.injected).toBe(1)
      expect(out.result.removed).toBe(0)
      expect(out.result.untouched).toBe(1)
    }
  })

  // Review r10 (N3): a link's, field's or content control's words are looked
  // for only inside the written range of the line they belong to, so a
  // translated line before it holding the same word more often than its
  // source does never takes them.
  const wordsOf = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("")
  it.each([
    ["a link", `${LINK}${run("here" + PAD + " ")}${run("Third")}</w:hyperlink>`, LINK, "</w:hyperlink>"],
    ["a content control", `${SDT}${run("here" + PAD + " ")}${run("Third")}</w:sdtContent></w:sdt>`, SDT, "</w:sdtContent>"],
    ["a field", FIELD_OF(run("here" + PAD + " ") + run("Third")), `w:fldCharType="separate"/></w:r>`, `<w:r><w:fldChar w:fldCharType="end"/>`],
  ])("%s left holding a word of the next line stays on that line's word, whatever a line before it holds", async (_, wrapped, open, close) => {
    const { bytes, a, b, c, rest } = await intoLine3(wrapped)
    for (const line1 of ["Third un.", "Un Third. Third."]) {
      for (const out of [await wordOut(bytes, [typed(a, line1), hide(b), c, ...rest]), await wordOut(bytes, [typed(a, line1), c, ...rest], [b])]) {
        const p = firstPara(out.body)
        expect(wordsOf(p).replaceAll(PAD.trim(), "…")).toBe(`${line1} Third line here …`)
        expect(wordsOf(p.slice(0, p.indexOf(open)))).toBe(`${line1} `)
        expect(wordsOf(p.slice(p.indexOf(open), p.indexOf(close)))).toBe("Third")
      }
    }
  })

  it("a link on a word of an untranslated line stays on that line's word when a translated line before it holds the word too", async () => {
    const bytes = await docxBytes(para(run(L1 + " ") + run("Second line here" + PAD + " ") + `${LINK}${run("Third")}</w:hyperlink>` + run(" line here" + PAD)) + NEXT)
    const [a, b, c, ...rest] = await importCells(bytes, false)
    const out = await wordOut(bytes, [typed(a, "Third un."), typed(b, "Deux."), c, ...rest])
    const p = firstPara(out.body)
    expect(wordsOf(p.slice(0, p.indexOf(LINK)))).toBe("Third un. Deux. ")
    expect(out.result.fidelity.droppedLinks).toBe(0)
  })

  // Review r10 (N4): each remaining line is found after the one before it,
  // and never inside a deleted line's stretch. Here line 2's words are also
  // the end of line 1's first sentence, before line 1's tab: found there,
  // line 1's tab and its last words would sit between lines 2 and 3.
  it("a remaining line whose words a deleted line also holds is found in its own place, so the deleted line's tab goes with it", async () => {
    const bytes = await docxBytes(para(run("First line here" + PAD) + `<w:r><w:tab/></w:r>` + run("Second line here" + PAD + " ") + run(L3)) + NEXT)
    const [a, b, c, next] = await importCells(bytes, false)
    expect(a.original).toMatch(/\tSecond line here and it goes on with many more words,$/)
    expect(b.original).toBe(PAD.trim().replace(/^and it goes on with many more words, /, ""))
    expect(paras((await wordOut(bytes, [typed(b, "Deux."), typed(c, "Trois."), next], [a])).body)[0]).toBe("Deux. Trois.")
    expect(paras((await wordOut(bytes, [b, c, next], [a])).body)[0]).toBe(`${b.original} Third line here …`)
  })

  // R7: the structure check flags a link with no run again; only a link this
  // export emptied on purpose (its words were all a lost line's) is exempt,
  // named by its start tag.
  it("the structure check flags an empty link, unless it is one the export emptied on purpose", () => {
    const doc = (inner: string) => `<w:document ${W_NS}><w:body>${para(inner)}</w:body></w:document>`
    const empty = `<w:hyperlink w:anchor="_Top" w:history="1"></w:hyperlink>`
    expect(structuralProblems(doc(empty))).toEqual(["w:hyperlink with no run"])
    expect(structuralProblems(doc(empty), undefined, { emptiedOnPurpose: [`<w:hyperlink w:anchor="_Top" w:history="1">`] })).toEqual([])
    expect(structuralProblems(doc(empty + empty), undefined, { emptiedOnPurpose: [`<w:hyperlink w:anchor="_Top" w:history="1">`] })).toEqual(["w:hyperlink with no run"])
    expect(structuralProblems(doc(empty), undefined, { emptiedOnPurpose: [`<w:hyperlink w:anchor="other">`] })).toEqual(["w:hyperlink with no run"])
    expect(structuralProblems(doc(`<w:hyperlink w:anchor="_Top">${run("words")}</w:hyperlink>`))).toEqual([])
  })
})
