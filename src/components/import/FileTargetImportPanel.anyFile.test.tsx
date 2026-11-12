/**
 * FileTargetImportPanel — a translation in any file the source import reads
 * (AQU-2544).
 *
 * WHY: Sam, Nov 12: "txt is not supported as import into target. That needs
 * fixing. We should be able to support almost anything." A file the panel has
 * no reader of its own for is read by the source import's own parsers
 * (readTranslationFile, run for real here) with the project's own cell unit,
 * and its lines fill the open file's paragraph by paragraph, through the same
 * review every other import uses: each incoming line beside the line it
 * fills, the count-mismatch notice, and the tick needed to replace a
 * translation. A paragraph that cut differently is shared out, flagged and
 * ticked; a row that is only its line's source text starts unticked. The
 * file's content picks its reader. The outbox and the proposal staging are
 * the only things mocked.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, within } from "@testing-library/react"
import JSZip from "jszip"

vi.mock("@/lib/import", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import")>()),
  applyEBibleTargetImport: vi.fn(),
}))
vi.mock("@/lib/import-file-target-proposals", () => ({
  stageTargetImportAsProposals: vi.fn(),
}))

import { FileTargetImportPanel } from "./FileTargetImportPanel"
import { applyEBibleTargetImport, prepareImportFile } from "@/lib/import"
import { stageTargetImportAsProposals } from "@/lib/import-file-target-proposals"
import type { FileTargetCellRef } from "@/lib/import-file-target"
import { expectClickNote } from "@/test-utils/tooltip"

function lines(...originals: string[]): FileTargetCellRef[] {
  return originals.map((original, i) => ({
    cellId: `line-${i + 1}`,
    fileId: "file-1",
    sourceEventId: `se-${i + 1}`,
    targetEventId: undefined,
    translated: "",
    original,
  }))
}

const THREE_LINES = lines("In the beginning", "And the earth was formless", "And God said")

function renderPanel(overrides: Partial<React.ComponentProps<typeof FileTargetImportPanel>> = {}) {
  const onImported = vi.fn()
  const onProposalsStaged = vi.fn()
  render(
    <FileTargetImportPanel
      projectId="proj-2544"
      username="tester"
      fileName="Genesis"
      cells={THREE_LINES}
      getToken={vi.fn(async () => "tok")}
      onImported={onImported}
      onCancel={vi.fn()}
      onProposalsStaged={onProposalsStaged}
      applyOptimisticTargetEdits={vi.fn()}
      {...overrides}
    />,
  )
  return { onImported, onProposalsStaged }
}

async function selectFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    fireEvent.change(input)
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** The review row a text sits in, by the line (cell) it fills. */
const rowOf = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-review-cell]")!
const checkboxIn = (row: HTMLElement) => row.querySelector("input[type=checkbox]") as HTMLInputElement

async function importNow(name: RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }))
    await new Promise((r) => setTimeout(r, 0))
  })
}

function docx(paragraphs: string[]): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
    paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")
  }</w:body></w:document>`)
  return zip.generateAsync({ type: "arraybuffer" })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(applyEBibleTargetImport).mockResolvedValue({ committedCount: 3, skippedCount: 0 })
})

/** Lines as a Paragraph-setting import makes them: each its own paragraph. */
const paragraphLines = (...originals: string[]) => lines(...originals).map((line) => ({ ...line, paragraphStart: true }))

/** The open file's lines as the REAL source import makes them from `source`. */
async function importedLines(source: File, cellUnit?: "sentence" | "paragraph"): Promise<FileTargetCellRef[]> {
  const prepared = await prepareImportFile(source, { projectId: "proj-2544", cellUnit })
  return prepared.results.flatMap((r) => r.strings).map((s, i) => ({
    ...lines(s.original)[0],
    cellId: `line-${i + 1}`,
    canonicalRef: s.group,
    ...(s.paragraphStart ? { paragraphStart: true } : {}),
  }))
}

const EN_LONG = "At the river they found the ferryman asleep in his boat. " +
  "Anna woke him gently and asked the price of the crossing. " +
  "He named a sum far larger than they carried, then looked at their faces and named a smaller one. " +
  "They crossed in silence while the current pulled at the hull."

describe("a .txt translation", () => {
  it("fills line 1, 2, 3 from a file of three lines on the Paragraph setting, and imports them", async () => {
    const { onImported } = renderPanel({ cells: paragraphLines("In the beginning", "And the earth was formless", "And God said"), cellUnit: "paragraph" })
    await selectFile(new File(["Au commencement\r\nEt la terre était informe\r\nEt Dieu dit\r\n"], "genese.txt"))

    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText("3 matched")).toBeInTheDocument()
    expect(rowOf("Au commencement")).toHaveAttribute("data-review-cell", "line-1")
    expect(within(rowOf("Au commencement")).getByText("In the beginning")).toBeInTheDocument()
    expect(rowOf("Et la terre était informe")).toHaveAttribute("data-review-cell", "line-2")
    expect(rowOf("Et Dieu dit")).toHaveAttribute("data-review-cell", "line-3")
    expect(screen.queryByText(/in this file:/)).not.toBeInTheDocument()

    await importNow(/import 3/i)
    const [result, selected, ctx] = vi.mocked(applyEBibleTargetImport).mock.calls[0]
    expect(result.matched.map((m) => [m.cellId, m.incomingText])).toEqual([
      ["line-1", "Au commencement"],
      ["line-2", "Et la terre était informe"],
      ["line-3", "Et Dieu dit"],
    ])
    expect([...selected]).toEqual(["line-1", "line-2", "line-3"])
    // The copy kept beside the translation is tagged as the text it is.
    expect((ctx as { sourceArtifact: { format: string; name: string } }).sourceArtifact).toMatchObject({
      format: "txt", name: "genese.txt",
    })
    expect(onImported).toHaveBeenCalledWith(3)
  })

  it("reads the file the way the source was read: on Sentence, three short lines are one line", async () => {
    const cells = await importedLines(new File(["In the beginning\nAnd the earth\nAnd God said\n"], "a.txt"))
    expect(cells).toHaveLength(1)
    renderPanel({ cells })
    await selectFile(new File(["Au commencement\nEt la terre\nEt Dieu dit\n"], "a-fr.txt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText("1 matched")).toBeInTheDocument()
    expect(screen.queryByText(/didn't find a line/)).not.toBeInTheDocument()
  })

  it("says how many paragraphs each side has when one is missing", async () => {
    renderPanel({ cells: paragraphLines("One", "Two", "Three"), cellUnit: "paragraph" })
    await selectFile(new File(["Un\n\nDeux\n"], "short.txt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(rowOf("Un")).toHaveAttribute("data-review-cell", "line-1")
    expect(screen.getByText(
      "Paragraphs in this file: 2. Paragraphs in the open file: 3. If a paragraph was added or left out, every paragraph after it is on the wrong lines.",
    )).toHaveClass("text-amber-600")
  })

  it("counts rows against lines imported before paragraphs were stored", async () => {
    renderPanel({ cellUnit: "paragraph" })
    await selectFile(new File(["Un\n\nDeux\n"], "short.txt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(
      "Rows in this file: 2. Lines in the open file: 3. If a row was added or left out, every row after it is on the wrong line.",
    )).toHaveClass("text-amber-600")
    expect(screen.getByText("Matched in order, not by reference or timing. Check each row's source text.")).toBeInTheDocument()
  })

  it("needs a tick to replace a translation a line already has", async () => {
    renderPanel({ cells: [{ ...THREE_LINES[0], translated: "Au début" }, ...THREE_LINES.slice(1)], cellUnit: "paragraph" })
    await selectFile(new File(["Au commencement\nEt la terre\nEt Dieu dit\n"], "genese.txt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    const replacing = rowOf("Au commencement")
    expect(within(replacing).getByText("Replaces: Au début")).toBeInTheDocument()
    expect(checkboxIn(replacing).checked).toBe(false)
    expect(checkboxIn(rowOf("Et la terre")).checked).toBe(true)
    expect(screen.getByRole("button", { name: "Import 2 cells" })).toBeInTheDocument()
    fireEvent.click(checkboxIn(replacing))
    expect(screen.getByRole("button", { name: "Import 3 cells" })).toBeInTheDocument()
  })

  it("leaves a row that is only its line's source text unticked, and says so", async () => {
    renderPanel({ cells: lines("Bonjour", "Merci"), cellUnit: "paragraph" })
    await selectFile(new File(["Bonjour\nThank you\n"], "en.txt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    const same = screen.getByText("Same as the source").closest<HTMLElement>("[data-review-cell]")!
    expect(same).toHaveAttribute("data-review-cell", "line-1")
    expect(checkboxIn(same).checked).toBe(false)
    expect(checkboxIn(rowOf("Thank you")).checked).toBe(true)
  })

  it("is read from a file the host chose, without the panel's own drop step", async () => {
    renderPanel({ initialFile: new File(["Un\nDeux\nTrois\n"], "fr.txt"), cellUnit: "paragraph" })
    expect(screen.queryByText(/drop a file here/i)).not.toBeInTheDocument()
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText("3 matched")).toBeInTheDocument()
  })

  it("stages the same rows as proposals in proposal mode", async () => {
    vi.mocked(stageTargetImportAsProposals).mockResolvedValue({ stagedCount: 3, skippedUnchangedCount: 0 } as never)
    const { onProposalsStaged } = renderPanel({ mode: "proposal", jwt: "jwt-1", cellUnit: "paragraph" })
    await selectFile(new File(["Un\nDeux\nTrois\n"], "fr.txt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    await importNow(/propose 3 cells/i)
    expect(applyEBibleTargetImport).not.toHaveBeenCalled()
    const [matched, , opts] = vi.mocked(stageTargetImportAsProposals).mock.calls[0]
    expect(matched.map((m) => m.incomingText)).toEqual(["Un", "Deux", "Trois"])
    expect(opts).toMatchObject({ sourceFileName: "fr.txt", projectId: "proj-2544" })
    expect(onProposalsStaged).toHaveBeenCalled()
  })
})

describe("the file's content picks its reader", () => {
  const VERSES = lines("In the beginning", "And the earth was formless").map((line, i) => ({ ...line, canonicalRef: `GEN 1:${i + 1}` }))

  it("reads a .txt holding USFM with the USFM reader, by verse", async () => {
    renderPanel({ cells: VERSES })
    await selectFile(new File(["\\id GEN\n\\c 1\n\\v 2 Et la terre\n\\v 1 Au commencement\n"], "gen.txt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(rowOf("Au commencement")).toHaveAttribute("data-review-cell", "line-1")
    expect(rowOf("Et la terre")).toHaveAttribute("data-review-cell", "line-2")
    await importNow(/import 2/i)
    const ctx = vi.mocked(applyEBibleTargetImport).mock.calls[0][2] as { sourceArtifact: { format: string } }
    expect(ctx.sourceArtifact.format).toBe("usfm")
  })

  it("sends a .txt of tab-separated records to the column mapping", async () => {
    renderPanel()
    await selectFile(new File(["ref\ttext\nGEN 1:1\tAu commencement\nGEN 1:2\tEt la terre\n"], "gen.txt"))
    expect(await screen.findByRole("button", { name: "Map columns" })).toBeInTheDocument()
  })

  it("refuses a .txt holding JSON as it refuses a .json", async () => {
    renderPanel()
    await selectFile(new File(['{"greeting": "Bonjour"}'], "fr.txt"))
    expect(await screen.findByText(/^Unsupported file type\./)).toBeInTheDocument()
    expect(screen.queryByText(/review matches/i)).not.toBeInTheDocument()
  })

  it("won't pair a document by position with lines that are verses, and says what will", async () => {
    renderPanel({ cells: VERSES })
    await selectFile(new File([await docx(["Au commencement", "Et la terre"])], "genese.docx"))
    expect(await screen.findByText(
      "This file's lines are verses, which a translation fills by reference. Import it as USFM, or as a spreadsheet with a reference column.",
    )).toBeInTheDocument()
    expect(screen.queryByText(/review matches/i)).not.toBeInTheDocument()
  })
})

describe("a Word translation", () => {
  it("fills paragraph for paragraph and keeps the file as Word", async () => {
    renderPanel({ cells: paragraphLines("In the beginning", "And the earth was formless", "And God said") })
    await selectFile(new File([await docx(["Au commencement", "Et la terre était informe", "Et Dieu dit"])], "genese.docx"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText("3 matched")).toBeInTheDocument()
    expect(rowOf("Et Dieu dit")).toHaveAttribute("data-review-cell", "line-3")
    await importNow(/import 3/i)
    const ctx = vi.mocked(applyEBibleTargetImport).mock.calls[0][2] as { sourceArtifact: { format: string } }
    expect(ctx.sourceArtifact.format).toBe("docx")
  })

  it("shares a paragraph out over its lines on the Sentence setting, flagged and ticked", async () => {
    const cells = await importedLines(new File([await docx(["Morning came early.", EN_LONG, "The end."])], "road.docx"))
    expect(cells).toHaveLength(4)
    renderPanel({ cells })
    const t2 = "En el río, el barquero dormía. Ana lo despertó. Pidió mucho, luego menos. Cruzaron."
    await selectFile(new File([await docx(["La mañana llegó temprano.", t2, "Fin."])], "camino.docx"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    const first = rowOf("En el río, el barquero dormía.")
    const second = rowOf("Ana lo despertó. Pidió mucho, luego menos. Cruzaron.")
    expect(first).toHaveAttribute("data-review-cell", "line-2")
    expect(second).toHaveAttribute("data-review-cell", "line-3")
    for (const row of [first, second]) {
      expect(within(row).getByText("Shared out")).toBeInTheDocument()
      expect(checkboxIn(row).checked).toBe(true)
    }
    // The pill's note opens on a click, as a bridge's does (AQU-2508).
    await expectClickNote(within(first).getByText("Shared out"), "Shared out over this paragraph's lines")
    expect(screen.getByRole("button", { name: "Import 4 cells" })).toBeInTheDocument()
    expect(screen.queryByText(/in this file:/)).not.toBeInTheDocument()
  })
})

describe("a file it can't read", () => {
  it("says so and names what it can read", async () => {
    renderPanel()
    await selectFile(new File(['{"greeting": "Bonjour"}'], "fr.json"))
    expect(await screen.findByText(
      "Unsupported file type. Use a text or Word file, USFM, a spreadsheet, subtitles, or another type listed above.",
    )).toBeInTheDocument()
    expect(screen.getByText(
      "TXT, DOCX, MD, HTML, PPTX, IDML, USFM, USX, PO, XLIFF, TMX, Java properties, CSV, TSV, XLSX, VTT, SRT, or SBV",
    )).toBeInTheDocument()
    expect(screen.queryByText(/review matches/i)).not.toBeInTheDocument()
  })
})
