// AQU-2552 (review r6): B's Word export of a paragraph cut into lines, some of
// them translated, hidden or deleted. Each line is written as its translation
// or its source; a hidden or deleted line takes only its words and its own
// footnote (AQU-2552, question 62): the rest stays. Every cell here
// is made by the importer from a small made .docx, as a real import makes it,
// and every check reads the written XML (references, pictures, fields, tabs).
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"
import { hiddenRoundTripRemovals, scopeRoundTripCells } from "../validation-scope"
import { docxPartsToStrings } from "@/lib/parsers/docx"
import { assertWellFormedXml } from "@/lib/parsers/xml-lite"
import { structuralProblems } from "./__fixtures__/docx-structure-check"
import type { CellData } from "@/hooks/useCells"
import {
  complexField,
  documentXml,
  footnoteRefRun,
  footnotesXml,
  para,
  pictureRun,
  run,
} from "@/lib/parsers/__fixtures__/docx-structures"

const WORD = "word/document.xml"
const NOTES = "word/footnotes.xml"

/** Over 100 characters with it, so no two lines fit in the importer's 200 and
 *  the Sentence setting gives each sentence a line of its own. */
const PAD = " goes on for a good while longer, so that the importer has to cut this paragraph into its sentences"

async function makeDocx(body: string, notes?: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(WORD, documentXml(body))
  if (notes) zip.file(NOTES, notes)
  return zip.generateAsync({ type: "arraybuffer" })
}

/** The cells the importer makes for this body, each located as an import
 *  locates it; `translate` gives line k (from 0) of paragraph 1 its text. */
function importedCells(body: string, notes: string | undefined, translate: (k: number, original: string) => string): CellData[] {
  const strings = docxPartsToStrings({ documentXml: documentXml(body), ...(notes ? { footnotesXml: notes } : {}) })
  const seen = new Map<string, number>()
  return strings.map((s) => {
    const blockPath = s.sourceLocation!.blockPath
    const paragraph = Number(/\d+/.exec(blockPath)![0])
    const segment = (seen.get(blockPath) ?? 0) + 1
    seen.set(blockPath, segment)
    return {
      id: `c${paragraph}-${segment}`,
      fileId: "f",
      original: s.original,
      translated: paragraph === 1 ? translate(segment - 1, s.original) : "",
      context: "Paragraph",
      group: s.group,
      type: "text",
      status: "validated",
      validationStatus: "none",
      activeValidators: [],
      validationHistory: [],
      history: [],
      threads: [],
      metadata: {
        aquillaImport: {
          sourceLocator: { kind: "package-block", memberPath: WORD, blockPath, segment },
          physicalOrder: paragraph * 100 + segment,
        },
      },
    } as CellData
  })
}

interface Exported {
  xml: string
  notes: string | undefined
  result: Awaited<ReturnType<typeof exportDocx>>
}

/** Export as the dialog does: hidden lines cleared and handed over as removals,
 *  deleted ones as the server's removals. */
async function exportAsDialog(body: string, notes: string | undefined, cells: CellData[], deleted: CellData[] = []): Promise<Exported> {
  const result = await exportDocx(await makeDocx(body, notes), scopeRoundTripCells(cells, "current"), {
    removedCells: [...deleted.map((cell) => ({ metadata: cell.metadata ?? null })), ...hiddenRoundTripRemovals(cells)],
  })
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file(WORD)!.async("string")
  const outNotes = await zip.file(NOTES)?.async("string")
  expect(() => assertWellFormedXml(xml)).not.toThrow()
  expect(structuralProblems(xml, outNotes)).toEqual([])
  return { xml, notes: outNotes, result }
}

/** Paragraph 1 as a reader meets it: its text, `[n]` for footnote reference n,
 *  `[picture]` for a drawing, `{field}` for a field's code. */
function firstParagraph(xml: string): string {
  const body = xml.slice(xml.indexOf("<w:body>"))
  const p = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/.exec(body)![0]
  let out = ""
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:footnoteReference w:id="(\d+)"\/>|<w:tab\/>|<w:br\/>|<w:drawing>|<w:fldChar w:fldCharType="begin"\/>/g
  for (const m of p.matchAll(token)) {
    if (m[1] !== undefined) out += m[1]
    else if (m[2] !== undefined) out += `[${m[2]}]`
    else if (m[0] === "<w:tab/>") out += "\t"
    else if (m[0] === "<w:br/>") out += "\n"
    else if (m[0] === "<w:drawing>") out += "[picture]"
    else out += "{field}"
  }
  return out
}

/** A note's text as footnotes.xml holds it. */
function noteText(notes: string, id: number): string {
  const note = new RegExp(`<w:footnote w:id="${id}">([\\s\\S]*?)</w:footnote>`).exec(notes)![1]
  return [...note.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("").trim()
}

const S1 = `The first line${PAD}`
const S2 = `The second line${PAD}`
const S3 = `The third line${PAD}`
const T1 = "Première ligne, traduite."
const T2 = "Deuxième ligne, traduite."
const T3 = "Troisième ligne, traduite."
const NOTE = (text: string) => `\\f + \\ft ${text}\\f*`

describe("Word export — a line's footnote is that line's own (AQU-2552, review r6)", () => {
  // Line 1 holds footnote 1, line 2 footnote 2, line 3 none.
  const body = para(run(S1) + footnoteRefRun(1) + run(`. ${S2}`) + footnoteRefRun(2) + run(`. ${S3}.`)) + para(run("Next paragraph."))
  const notes = footnotesXml({ 1: "Note one.", 2: "Note two." })

  it("the importer gives each sentence its own line, each holding its own marker", () => {
    const lines = importedCells(body, notes, () => "").filter((cell) => cell.id.startsWith("c1-")).map((cell) => cell.original)
    expect(lines).toEqual([`${S1}${NOTE("Note one.")}.`, `${S2}${NOTE("Note two.")}.`, `${S3}.`])
  })

  it("a hidden line takes its footnote with it; an untranslated line keeps its own", async () => {
    const cells = importedCells(body, notes, (k) => (k === 2 ? T3 : "")).map((cell) => (cell.id === "c1-1" ? { ...cell, hidden: true } : cell))
    const out = await exportAsDialog(body, notes, cells)
    expect(firstParagraph(out.xml)).toBe(`${S2}[2]. ${T3}`)
    // Neither note's text is touched.
    expect(out.notes).toBe(notes)
  })

  it("a deleted line takes its footnote with it; a translated line's marker takes its own note", async () => {
    const all = importedCells(body, notes, (k) => [T1, `Deuxième ligne${NOTE("Note deux.")}, traduite.`, T3][k])
    const deleted = all.filter((cell) => cell.id === "c1-1")
    const out = await exportAsDialog(body, notes, all.filter((cell) => cell.id !== "c1-1"), deleted)
    expect(firstParagraph(out.xml)).toBe(`Deuxième ligne[2], traduite. ${T3}`)
    expect(noteText(out.notes!, 2)).toBe("Note deux.")
    expect(noteText(out.notes!, 1)).toBe("Note one.")
  })

  it("finds a line the importer joined from two sentences with one space where the paragraph has two", async () => {
    const a = "This second line is a sentence of a little over ninety characters, all told, and not fewer."
    const b = "Its next sentence follows two spaces after it and is about as long"
    const joined = para(run(S1) + footnoteRefRun(1) + run(`. ${a}  ${b}`) + footnoteRefRun(2) + run(`. ${S3}.`)) + para(run("Next paragraph."))
    const cells = importedCells(joined, notes, (k) => (k === 2 ? T3 : "")).map((cell) => (cell.id === "c1-1" ? { ...cell, hidden: true } : cell))
    expect(cells.filter((cell) => cell.id.startsWith("c1-")).map((cell) => cell.original)).toEqual([`${S1}${NOTE("Note one.")}.`, `${a} ${b}${NOTE("Note two.")}.`, `${S3}.`])
    const out = await exportAsDialog(joined, notes, cells)
    // Written as the paragraph has it: both spaces, its own reference.
    expect(firstParagraph(out.xml)).toBe(`${a}  ${b}[2]. ${T3}`)
    expect(out.notes).toBe(notes)
  })

  it("with nothing hidden: a translation that dropped its marker leaves its reference after it, never another line's", async () => {
    const cells = importedCells(body, notes, (k) => (k === 0 ? T1 : k === 2 ? T3 : ""))
    const out = await exportAsDialog(body, notes, cells)
    expect(firstParagraph(out.xml)).toBe(`${T1}[1] ${S2}[2]. ${T3}`)
    expect(out.notes).toBe(notes)
  })

  it("with every line translated: the second line's marker takes the second note, though the first dropped its own", async () => {
    const cells = importedCells(body, notes, (k) => [T1, `Deuxième ligne${NOTE("Note deux.")}, traduite.`, T3][k])
    const out = await exportAsDialog(body, notes, cells)
    expect(firstParagraph(out.xml)).toBe(`${T1}[1] Deuxième ligne[2], traduite. ${T3}`)
    expect(noteText(out.notes!, 1)).toBe("Note one.")
    expect(noteText(out.notes!, 2)).toBe("Note deux.")
  })
})

// AQU-2552 (question 62): this replaces review r6's "a hidden or deleted
// line's pictures, fields and tabs leave with it". AQU-2552 (review r9): a
// tab among a lost line's words is its own text, and goes with them; what
// stays sits where the line was, after the line before it.
describe("Word export — a hidden or deleted line's words, and a tab among them, go; its pictures, fields and links stay (AQU-2552, question 62)", () => {
  const next = para(run("Next paragraph."))
  const italic = "<w:rPr><w:i/></w:rPr>"
  /** Line 2 of three, with this in its middle. */
  const withInLine2 = (inner: string) => para(run(`${S1}. The second line`) + inner + run(`${PAD}. ${S3}.`)) + next
  /** Each shape, how what stays of it reads, and what of it stays, byte for byte. */
  const shapes: [string, string, string, string][] = [
    ["a picture", pictureRun, "[picture]", pictureRun],
    ["a figure-number field", run(" shows figure ") + complexField("SEQ Figure \\* ARABIC", "1") + run(" and"), "{field}", "SEQ Figure"],
    ["a tab", "<w:r><w:tab/></w:r>", "", ""],
    // An italic word is words only: they go, and nothing is said of their look.
    ["an italic word", run(" has an ") + run("italic", italic) + run(" word and"), "", ""],
    // A link its words filled stays, emptied of them.
    ["a link", `<w:hyperlink w:anchor="_Top"><w:r><w:t xml:space="preserve"> links somewhere and</w:t></w:r></w:hyperlink>`, "", `<w:hyperlink w:anchor="_Top"></w:hyperlink>`],
  ]
  const translate = (k: number) => [T1, "", T3][k]

  it.each(shapes)("a hidden line's words go and %s stays", async (_name, inner, seen, kept) => {
    const body = withInLine2(inner)
    const cells = importedCells(body, undefined, translate).map((cell) => (cell.id === "c1-2" ? { ...cell, hidden: true } : cell))
    expect(cells.filter((cell) => cell.id.startsWith("c1-"))).toHaveLength(3)
    const out = await exportAsDialog(body, undefined, cells)
    expect(firstParagraph(out.xml)).toBe(`${T1}${seen} ${T3}`)
    expect(out.xml).toContain(kept)
    expect(out.xml).not.toMatch(/The second line|links somewhere|italic|<w:tab\/>/)
    // Nothing is said about words the export left out on purpose.
    expect(out.result.lostLooks).toEqual([])
    expect(out.result.fidelity.emptiedFields).toBe(0)
    expect(out.result.fidelity.droppedLinks).toBe(0)
  })

  it.each(shapes)("a deleted line's words go and %s stays", async (_name, inner, seen, kept) => {
    const body = withInLine2(inner)
    const all = importedCells(body, undefined, translate)
    const deleted = all.filter((cell) => cell.id === "c1-2")
    const out = await exportAsDialog(body, undefined, all.filter((cell) => cell.id !== "c1-2"), deleted)
    expect(firstParagraph(out.xml)).toBe(`${T1}${seen} ${T3}`)
    expect(out.xml).toContain(kept)
    expect(out.xml).not.toMatch(/The second line|links somewhere|italic|<w:tab\/>/)
    expect(out.result.lostLooks).toEqual([])
  })

  it("never names a hidden line's words among those that lost their look, though a run holds them and the next line's", async () => {
    const body = para(run(`${S1}. ${S2.replace(/ sentences$/, "")}`) + run(" sentences. The third", italic) + run(` line${PAD}.`)) + next
    const cells = importedCells(body, undefined, translate).map((cell) => (cell.id === "c1-2" ? { ...cell, hidden: true } : cell))
    expect(cells.filter((cell) => cell.id.startsWith("c1-")).map((cell) => cell.original)).toEqual([`${S1}.`, `${S2}.`, `${S3}.`])
    const out = await exportAsDialog(body, undefined, cells)
    expect(firstParagraph(out.xml)).toBe(`${T1} ${T3}`)
    expect(out.result.lostLooks.flatMap((l) => l.words)).toEqual(["The third"])
  })

  it("keeps what a remaining line holds: its picture, its field", async () => {
    const body = para(run(`${S1}. ${S2}. The third line shows figure `) + complexField("SEQ Figure \\* ARABIC", "1") + run(` and${PAD}`) + pictureRun + run(".")) + next
    const cells = importedCells(body, undefined, () => "").map((cell) => (cell.id === "c1-2" ? { ...cell, hidden: true } : cell))
    const out = await exportAsDialog(body, undefined, cells)
    // AQU-2552 (review r7 D1): the picture stays beside its words, before the stop.
    expect(firstParagraph(out.xml)).toBe(`${S1}. The third line shows figure {field}1 and${PAD}[picture].`)
  })
})

describe("Word export — lines are joined by the gap the source had between them (AQU-2552, review r6)", () => {
  const next = para(run("Next paragraph."))
  const lines = (body: string) => importedCells(body, undefined, () => "").filter((cell) => cell.id.startsWith("c1-")).map((cell) => cell.original)

  it("no space where the importer cut at a dash with none", async () => {
    const left = "This half of the line runs on and on without a single stop or comma for longer than anyone would like it to—"
    const right = "and this half picks up straight after the dash and runs on for just as long before it comes to its end."
    const body = para(run(left + right)) + next
    expect(lines(body)).toEqual([left, right])
    const out = await exportAsDialog(body, undefined, importedCells(body, undefined, (k) => ["Cette moitié court—", "et celle-ci reprend."][k]))
    expect(firstParagraph(out.xml)).toBe("Cette moitié court—et celle-ci reprend.")
  })

  it("two spaces where the source had two", async () => {
    const body = para(run(`${S1}.  ${S2}.`)) + next
    expect(lines(body)).toEqual([`${S1}.`, `${S2}.`])
    const out = await exportAsDialog(body, undefined, importedCells(body, undefined, (k) => [T1, ""][k]))
    expect(firstParagraph(out.xml)).toBe(`${T1}  ${S2}.`)
  })
})

describe("Word export — a text box whose only paragraph loses every line (AQU-2552, review r6)", () => {
  // From Fixer 1's shared tests: it passes here and fails on the 2552 branch
  // alone, whose exporter numbers a text box's paragraphs one off from its
  // importer (the AQU-2539 bug), so it lives in this B-only file.
  const box = (inner: string) =>
    `<w:p><w:r><w:pict><v:shape><v:textbox><w:txbxContent>${inner}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`

  it("keeps an empty paragraph in the box and leaves the paragraph after the box alone", async () => {
    const body = box(para(run(`${S1}. ${S2}. ${S3}.`))) + para(run("After."))
    const cells = importedCells(body, undefined, () => "")
    const inBox = cells.filter((cell) => cell.original.startsWith("The "))
    expect(inBox).toHaveLength(3)
    const hiddenIds = new Set(inBox.map((cell) => cell.id))
    const out = await exportAsDialog(body, undefined, cells.map((cell) => (hiddenIds.has(cell.id) ? { ...cell, hidden: true } : cell)))
    expect(out.xml).toContain(box("<w:p></w:p>"))
    expect(out.xml).toContain("After.")
    expect(out.xml).not.toContain("The first line")
  })
})
