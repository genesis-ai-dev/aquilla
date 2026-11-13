// AQU-2552 (review r6): B's Word export of a paragraph cut into lines, some of
// them translated, hidden or deleted. Each line is written as its translation
// or its source; a hidden or deleted line contributes nothing. Every cell here
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
