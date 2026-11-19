/**
 * AQU-2551: a PDF goes through the one source path.
 *
 * WHY each group matters:
 *  - A .pdf is its own file type, read by the PDF reader beside Word,
 *    PowerPoint, InDesign and EPUB, and its original is kept as a
 *    preserved-only source artifact (a PDF cannot be rebuilt from lines).
 *  - A PDF the reader refuses is never handed to the AI sandbox, even when
 *    the person is signed in: the sandbox cannot read a scan or open a locked
 *    file, and its guess differs on every run.
 *  - Because the translation import reads any file the source import reads
 *    (AQU-2544), a translated PDF fills a source's lines paragraph by
 *    paragraph with no PDF-specific code there.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import JSZip from "jszip"
import { buildBulkCellsWithSpeakers, prepareImportFile } from "@/lib/import"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { matchTargetRowsByOrder, type FileTargetCellRef, type FileTargetMatchResult } from "@/lib/import-file-target"
import { buildPdf, pdfOfParagraphs } from "@/lib/parsers/__fixtures__/build-pdf"
import { detectFileType } from "@/lib/parsers/types"
import { SOURCE_ARTIFACT_FORMATS } from "../../../shared/import-contract"
import { fileTargetCellRef } from "./cell-refs"
import { FILE_TARGET_EXTENSIONS } from "./translation-destination"
import { readTranslationFile, translationFileType } from "./translation-file"

const PROJECT = { projectId: "proj-2551" }

const pdfFile = (bytes: ArrayBuffer, name = "book.pdf") => new File([bytes], name, { type: "application/pdf" })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("a PDF on the source path", () => {
  it("is its own file type, and the translation import accepts it", () => {
    expect(detectFileType("Notes.PDF")).toBe("pdf")
    expect(FILE_TARGET_EXTENSIONS).toContain("pdf")
  })

  it("imports its paragraphs and keeps the original as a preserved-only artifact", async () => {
    const bytes = pdfOfParagraphs(["# Chapter One", "The first paragraph.", "The second paragraph."], { tagged: true })
    const prepared = await prepareImportFile(pdfFile(bytes), { ...PROJECT, cellUnit: "paragraph" })
    expect(prepared.fileType).toBe("pdf")
    expect(prepared.results).toHaveLength(1)
    const [result] = prepared.results
    expect(result.strings.map((s) => [s.type, s.original])).toEqual([
      ["heading", "Chapter One"],
      ["text", "The first paragraph."],
      ["text", "The second paragraph."],
    ])
    expect(result.rawSourceFormat).toBe("pdf")
    expect(result.roundTripFidelity).toBe("preserved-only")
    expect(new Uint8Array(result.rawBytes!)).toEqual(new Uint8Array(bytes))
    expect(SOURCE_ARTIFACT_FORMATS.pdf).toEqual({ extension: "pdf", contentType: "application/pdf", defaultFidelity: "preserved-only" })
  })

  it("carries the image-only-pages notice into the preview", async () => {
    const bytes = buildPdf({ pages: [{ runs: [{ text: "Some text.", x: 72, y: 700 }] }, { image: true }] })
    const prepared = await prepareImportFile(pdfFile(bytes), PROJECT)
    expect(prepared.results[0].importNotices?.map((n) => n.code)).toEqual(["pdf-image-only-pages"])
  })

  it("never sends a PDF it refuses to the AI sandbox, even signed in", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }))
    vi.stubGlobal("fetch", fetchSpy)
    const signedIn = { ...PROJECT, identityToken: "token-2551" }
    await expect(prepareImportFile(pdfFile(buildPdf({ pages: [{ image: true }] })), signedIn))
      .rejects.toThrow("This PDF is a scanned image. It has no text to import.")
    await expect(prepareImportFile(pdfFile(new TextEncoder().encode("%PDF-1.7 broken").buffer), signedIn))
      .rejects.toThrow("This file could not be read as a PDF.")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // Review finding: a PDF saved without its extension ("report", or a
  // browser's "x.pdf.download") took the unknown-file path, and signed in it
  // went to the AI sandbox. Its bytes say what it is.
  it("reads a PDF by its bytes when its name has no .pdf, and never sends it to the sandbox", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }))
    vi.stubGlobal("fetch", fetchSpy)
    const bytes = pdfOfParagraphs(["A paragraph from a file with no extension."])
    const prepared = await prepareImportFile(new File([bytes], "report"), { ...PROJECT, identityToken: "token-2551", cellUnit: "paragraph" })
    expect(prepared.fileType).toBe("pdf")
    expect(prepared.results[0].strings.map((s) => s.original)).toEqual(["A paragraph from a file with no extension."])
    await expect(prepareImportFile(new File([buildPdf({ pages: [{ image: true }] })], "scan.pdf.download"), { ...PROJECT, identityToken: "token-2551" }))
      .rejects.toThrow("This PDF is a scanned image. It has no text to import.")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // Review finding 13 (Nov 14): the header was looked for anywhere in the
  // first kilobyte, so a text file that mentions "%PDF-" was refused as "not
  // a PDF". PDF readers take it only at the very start, after at most a
  // byte-order mark or whitespace.
  it("takes the PDF header only at the start of a file, after at most a BOM or whitespace", async () => {
    const notes = new File(["Notes on the export.\nEvery PDF starts with %PDF-1.7 in its first line.\n"], "notes.log")
    await expect(prepareImportFile(notes, { ...PROJECT, cellUnit: "paragraph" })).rejects.toThrow(/^Unsupported file type: notes\.log\./)
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x0a, 0x20, ...new Uint8Array(pdfOfParagraphs(["After a byte-order mark."]))])
    const prepared = await prepareImportFile(new File([bom], "report"), { ...PROJECT, cellUnit: "paragraph" })
    expect(prepared.fileType).toBe("pdf")
  })

  // Re-review finding 9 (Nov 14): pdf.js reads a PDF whose header follows a
  // line break later in the first kilobyte, so the app takes it there too.
  it("takes the PDF header after a line break in the first kilobyte", async () => {
    const junk = new Uint8Array([...new TextEncoder().encode("X-Gateway: scanned\r\n"), ...new Uint8Array(pdfOfParagraphs(["After a junk line."]))])
    const prepared = await prepareImportFile(new File([junk], "report"), { ...PROJECT, cellUnit: "paragraph" })
    expect(prepared.fileType).toBe("pdf")
  })
})

// ─── a translated PDF ───────────────────────────────────────────────────────

/** The open file's lines as the app has them after importing `source`, read
 *  back through the real cell store (as in translation-file.test.ts). */
async function sourceLines(source: File, cellUnit?: "sentence" | "paragraph"): Promise<FileTargetCellRef[]> {
  const prepared = await prepareImportFile(source, { ...PROJECT, cellUnit })
  const { cells } = buildBulkCellsWithSpeakers(prepared.results.flatMap((result) => result.strings), {
    fileName: source.name,
    fileType: prepared.fileType,
  })
  const store = new CellStore()
  store.setRuntime({ projectId: PROJECT.projectId, fileId: "open-file", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(cells.map((cell, i): CellRow => ({
    cellId: `line-${i + 1}`, side: "source", value: cell.value, valueHtml: cell.valueHtml ?? null, type: cell.type ?? "text",
    canonicalRef: cell.canonicalRef ?? null, anchorCellId: i === 0 ? null : `line-${i}`, eventId: `se-${i + 1}`,
    sourceEventId: null, lastEditor: "tester", lastEditAt: 1, validated: false, wordCount: 1, metadata: cell.metadata ?? null,
  })))
  return store.getAllSummaries().map(fileTargetCellRef)
}

async function translate(translation: File, lines: FileTargetCellRef[], cellUnit?: "sentence" | "paragraph"): Promise<FileTargetMatchResult> {
  return matchTargetRowsByOrder((await readTranslationFile(translation, { ...PROJECT, cellUnit })).rows, lines)
}

const filled = (result: FileTargetMatchResult) => Object.fromEntries(result.matched.map((m) => [m.cellId, m.incomingText]))

function docx(paragraphs: string[]): Promise<ArrayBuffer> {
  const body = paragraphs
    .map((p) => p.startsWith("# ")
      ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${p.slice(2)}</w:t></w:r></w:p>`
      : `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("")
  const zip = new JSZip()
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)
  return zip.generateAsync({ type: "arraybuffer" })
}

// Two paragraphs long enough for the Sentence setting to cut them (the AQU-2544
// review's story), and the Spanish translation, set as PDFs.
const EN_LONG1 = "The rain had stopped before dawn, and the road was still dark with water. " +
  "Anna packed the last of the bread into her bag and tied it shut. " +
  "Her brother waited by the gate, stamping his feet against the cold. " +
  "Neither of them spoke about the letter that had come the night before. " +
  "They both knew what it meant, and they both knew there was no going back. " +
  "When the sun finally rose over the hills, they were already two miles from home."
const ES_LONG1 = "La lluvia había cesado antes del amanecer, y el camino seguía oscuro por el agua. " +
  "Ana guardó el último trozo de pan en su bolsa y la ató con fuerza. " +
  "Su hermano esperaba junto a la puerta, golpeando el suelo con los pies para combatir el frío. " +
  "Ninguno de los dos habló de la carta que había llegado la noche anterior. " +
  "Ambos sabían lo que significaba, y ambos sabían que no había vuelta atrás. " +
  "Cuando por fin salió el sol sobre las colinas, ya estaban a tres kilómetros de casa."
const EN_LONG2 = "At the river they found the ferryman asleep in his boat. " +
  "Anna woke him gently and asked the price of the crossing. " +
  "He named a sum far larger than they carried, then looked at their faces and named a smaller one. " +
  "They crossed in silence while the current pulled at the hull."
const ES_LONG2 = "En el río encontraron al barquero dormido en su bote. " +
  "Ana lo despertó con suavidad y le preguntó cuánto costaba cruzar. " +
  "Él pidió una suma mucho mayor de la que llevaban, luego miró sus rostros y pidió una menor. " +
  "Cruzaron en silencio mientras la corriente tiraba del casco."
const EN_DOC = ["# The Road North", "Morning came early.", EN_LONG1, "They walked on.", EN_LONG2, "The end."]
const ES_DOC = ["# El camino al norte", "La mañana llegó temprano.", ES_LONG1, "Siguieron caminando.", ES_LONG2, "Fin."]

describe("a translated PDF fills a source's lines paragraph by paragraph", () => {
  it("reads as a PDF when chosen as a translation", async () => {
    expect((await translationFileType(pdfFile(pdfOfParagraphs(ES_DOC), "camino.pdf"))).type).toBe("pdf")
  })

  it("an untagged PDF translation of a Word source, on the Sentence setting", async () => {
    const lines = await sourceLines(new File([await docx(EN_DOC)], "road.docx"))
    expect(lines).toHaveLength(9)
    const result = await translate(pdfFile(pdfOfParagraphs(ES_DOC), "camino.pdf"), lines)
    expect(result.countMismatch).toBeUndefined()
    const byLine = filled(result)
    expect(byLine["line-1"]).toBe("El camino al norte")
    expect(byLine["line-2"]).toBe("La mañana llegó temprano.")
    expect(["line-3", "line-4", "line-5"].map((id) => byLine[id]).join(" ")).toBe(ES_LONG1)
    expect(byLine["line-6"]).toBe("Siguieron caminando.")
    expect(["line-7", "line-8"].map((id) => byLine[id]).join(" ")).toBe(ES_LONG2)
    expect(byLine["line-9"]).toBe("Fin.")
  })

  it("a tagged PDF translation of a tagged PDF source, on both settings", async () => {
    for (const cellUnit of ["sentence", "paragraph"] as const) {
      const lines = await sourceLines(pdfFile(pdfOfParagraphs(EN_DOC, { tagged: true }), "road.pdf"), cellUnit)
      expect(lines).toHaveLength(cellUnit === "sentence" ? 9 : 6)
      const result = await translate(pdfFile(pdfOfParagraphs(ES_DOC, { tagged: true }), "camino.pdf"), lines, cellUnit)
      expect(result.countMismatch).toBeUndefined()
      expect(result.uncovered).toEqual([])
      expect(Object.values(filled(result)).join(" ")).toBe(ES_DOC.map((p) => p.replace(/^# /, "")).join(" "))
    }
  })
})

// Review finding 8 (Nov 14): a table in an untagged translation PDF came in as
// one paragraph, so every later line filled too early.
describe("a table in an untagged translation PDF", () => {
  const P = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
  const TC = (t: string) => `<w:tc>${P(t)}</w:tc>`
  async function docxBody(body: string): Promise<ArrayBuffer> {
    const zip = new JSZip()
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)
    return zip.generateAsync({ type: "arraybuffer" })
  }

  it("fills a Word table's cells one by one, row by row, on both settings", async () => {
    const source = new File([await docxBody(
      P("Before the table.") + `<w:tbl><w:tr>${TC("Name")}${TC("Age")}${TC("Town")}</w:tr><w:tr>${TC("Anna")}${TC("12")}${TC("Haifa")}</w:tr></w:tbl>` + P("After the table."),
    )], "s.docx")
    const pdf = buildPdf({ pages: [{ runs: [
      { text: "Antes de la tabla.", x: 72, y: 760 },
      { text: "Nombre", x: 72, y: 730 }, { text: "Edad", x: 250, y: 730 }, { text: "Pueblo", x: 430, y: 730 },
      { text: "Ana", x: 72, y: 712 }, { text: "12", x: 250, y: 712 }, { text: "Haifa", x: 430, y: 712 },
      { text: "Despues de la tabla.", x: 72, y: 680 },
    ] }] })
    for (const cellUnit of ["paragraph", "sentence"] as const) {
      const lines = await sourceLines(source, cellUnit)
      expect(lines).toHaveLength(8)
      const result = await translate(pdfFile(pdf, "t.pdf"), lines, cellUnit)
      expect(result.countMismatch).toBeUndefined()
      expect(lines.map((l) => filled(result)[l.cellId])).toEqual([
        "Antes de la tabla.", "Nombre", "Edad", "Pueblo", "Ana", "12", "Haifa", "Despues de la tabla.",
      ])
    }
  })
})
