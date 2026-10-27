// AQU-2210: which open files the Web page export is offered for. WHY these
// guards: every book of a migrated Codex project is a `"codex"` file, and the
// format was gated on `=== "usfm"`, so the teams AQU-2182 brought Codex's
// "Export as HTML" back for never saw it. A Codex book must get it, a USFM book
// must keep it, and a file that is not one Scripture book must not grow it.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import { pickSelectOption } from "@/test-utils/select"
import { buildCellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/lib/export/export-service", () => ({
  downloadBlob: vi.fn(),
}))
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: vi.fn(),
}))

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"

const mockDownload = vi.mocked(downloadBlob)
const mockProjectCells = vi.mocked(useProjectCells)

/**
 * A verse of a migrated Codex book, as the sync worker serves it and
 * `buildCellData` pairs it — the shape that failed. The SOURCE row carries the
 * canonical ref and the type `text` (never `verse`); the TARGET row has no
 * type and no ref, and its HTML lives in `valueHtml` beside the plain `value`.
 */
function codexVerse(id: string, ref: string, translated: string) {
  const base = { cellId: id, anchorCellId: null, lastEditAt: 0, validated: true, wordCount: 1, metadata: null }
  const source: CellRow = {
    ...base, side: "source", value: `source ${id}`, valueHtml: `source ${id}`, type: "text",
    canonicalRef: ref, eventId: `s-${id}`, sourceEventId: null, lastEditor: "legacy-import",
  }
  const target: CellRow = {
    ...base, side: "target", value: translated, valueHtml: `<span>${translated}</span>`, type: null,
    canonicalRef: null, eventId: `t-${id}`, sourceEventId: `s-${id}`, lastEditor: "translator",
  }
  return buildCellData(id, source, target, "f-book", "dev", 1, undefined)
}

const BOOK_CELLS = [
  codexVerse("c1", "RUT 1:1", "In the days when the judges ruled"),
  codexVerse("c2", "RUT 1:2", "The name of the man was Elimelek"),
  codexVerse("c3", "RUT 2:1", "Naomi had a relative"),
]

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  cells: BOOK_CELLS,
  projectId: "p1",
  projectName: "Migrated",
  activeFileId: "f-book",
  activeFileName: "RUT",
  projectFiles: [{ id: "f-book", name: "RUT", type: "codex" }],
  targetLanguage: "es",
  getToken: async () => null,
}

const webPageRadio = () => screen.queryByRole("radio", { name: /^Web page \(\.html\)/ })

/** A type with a native download keeps the fold closed until it is opened. */
function openFoldIfClosed() {
  if (screen.queryByRole("radiogroup", { name: "Export format" })) return
  fireEvent.click(screen.getByText("Export to another format"))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — Web page export by file type (AQU-2210)", () => {
  it("offers Web page for a Codex book and exports it as a readable page", async () => {
    render(<ExportDialog {...BASE_PROPS} activeFileType="codex" />)
    openFoldIfClosed()
    const radio = webPageRadio()
    expect(radio).not.toBeNull()
    fireEvent.click(radio!)

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    const [blob, name] = mockDownload.mock.calls[0] as [Blob, string]
    expect(name).toBe("RUT.html")
    const page = await blob.text()
    expect(page).toMatch(/^<!doctype html>/i)
    expect(page).toContain(`<h1 class="book-title">Ruth</h1>`)
    expect(page).toContain(`<nav class="chapter-index"`)
    // One heading per chapter, and both chapters' verses on the page.
    expect(page).toContain(`<h2 class="chapter-title">Ruth 1</h2>`)
    expect(page).toContain(`<h2 class="chapter-title">Ruth 2</h2>`)
    // Each verse with its number, though a Codex verse is typed `text`.
    expect(page).toContain(`<sup class="verse-number">1</sup> In the days when the judges ruled`)
    expect(page).toContain(`<sup class="verse-number">1</sup> Naomi had a relative`)
  })

  it("exports only the chosen chapter of a Codex book", async () => {
    render(<ExportDialog {...BASE_PROPS} activeFileType="codex" />)
    openFoldIfClosed()
    fireEvent.click(webPageRadio()!)
    const trigger = await pickSelectOption(/filter export by chapter/i, /^RUT 2$/)
    await waitFor(() => expect(trigger.textContent).toContain("RUT 2"))

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    const [blob, name] = mockDownload.mock.calls[0] as [Blob, string]
    expect(name).toBe("RUT_RUT-2.html")
    const page = await blob.text()
    expect(page).toContain("Naomi had a relative")
    expect(page).not.toContain("In the days when the judges ruled")
    expect(page).not.toContain(`<h2 class="chapter-title">Ruth 1</h2>`)
  })

  it("still offers Web page for a USFM book", () => {
    render(
      <ExportDialog
        {...BASE_PROPS}
        activeFileName="rut.usfm"
        activeFileType="usfm"
        projectFiles={[{ id: "f-book", name: "rut.usfm", type: "usfm" }]}
      />,
    )
    openFoldIfClosed()
    expect(webPageRadio()).not.toBeNull()
  })

  it.each([
    ["docx", "notes.docx"],
    ["srt", "episode.srt"],
    ["txt", "notes.txt"],
    ["source", "untyped"],
  ])("does not offer Web page for a %s file", (type, fileName) => {
    render(
      <ExportDialog
        {...BASE_PROPS}
        activeFileName={fileName}
        activeFileType={type}
        projectFiles={[{ id: "f-book", name: fileName, type }]}
      />,
    )
    openFoldIfClosed()
    // The fold is open: the other formats are there, Web page is not.
    expect(screen.getByRole("radio", { name: /^Markdown/ })).toBeInTheDocument()
    expect(webPageRadio()).toBeNull()
  })
})
