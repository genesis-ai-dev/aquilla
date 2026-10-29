// AQU-2210: which open files the Web page export is offered for. WHY these
// guards: every book of a migrated Codex project is a `"codex"` file, and the
// format was gated on `=== "usfm"`, so the teams AQU-2182 brought Codex's
// "Export as HTML" back for never saw it. A Codex book must get it, a USFM book
// must keep it, and a file that is not one Bible book must not grow it — which
// includes the `codex` files that are dubbing episodes, Pilgrim's Progress or a
// commentary: the file type cannot tell those from a book, only their lines can.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import { pickSelectOption } from "@/test-utils/select"
import { buildCellData } from "@/hooks/useCells"
import { writeExportMemory, DEFAULT_EXPORT_MEMORY } from "@/lib/export/export-dialog-memory"
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
 * A line of a migrated Codex notebook, as the sync worker serves it and
 * `buildCellData` pairs it — the shapes read off the local migrated projects.
 * The SOURCE row carries the canonical ref (if any) and the type `text` (never
 * `verse`); the TARGET row has no type and no ref, and its HTML lives in
 * `valueHtml` beside the plain `value`. A dubbing cue also carries its timing.
 */
function codexLine(
  id: string,
  ref: string | null,
  translated: string,
  timing: { startMs: number; endMs: number } | null = null,
) {
  const base = { cellId: id, anchorCellId: null, lastEditAt: 0, validated: true, wordCount: 1, metadata: null }
  const source: CellRow = {
    ...base, side: "source", value: `source ${id}`, valueHtml: `source ${id}`, type: "text",
    canonicalRef: ref, eventId: `s-${id}`, sourceEventId: null, lastEditor: "legacy-import",
    ...(timing ?? {}),
  }
  const target: CellRow = {
    ...base, side: "target", value: translated, valueHtml: `<span>${translated}</span>`, type: null,
    canonicalRef: null, eventId: `t-${id}`, sourceEventId: `s-${id}`, lastEditor: "translator",
  }
  return buildCellData(id, source, target, "f-book", "dev", 1, undefined)
}

/** A Bible book: the shape that failed. */
const BOOK_CELLS = [
  codexLine("c1", "RUT 1:1", "In the days when the judges ruled"),
  codexLine("c2", "RUT 1:2", "The name of the man was Elimelek"),
  codexLine("c3", "RUT 2:1", "Naomi had a relative"),
]

/** A Chosen episode in a dubbing project: cue refs, timed lines. */
const CHOSEN_EPISODE = [
  codexLine("e1", "TheChosen-101-en-5-2 1:cue-2642.261-2642.684", "Just...", { startMs: 2642261, endMs: 2642684 }),
  codexLine("e2", "TheChosen-101-en-5-2 1:cue-2643.100-2645.900", "Come with me.", { startMs: 2643100, endMs: 2645900 }),
]

/** Pilgrim's Progress: chapter:verse-shaped refs on a work that is not a Bible book. */
const PILGRIMS_PROGRESS = [
  codexLine("p1", "PilgrimsProgress 1:13", "He answered, because I do not know"),
  codexLine("p2", "PilgrimsProgress 10:1", "Now I saw in my dream"),
]

/** A commentary or audio notebook: no references at all. */
const UNREFERENCED = [codexLine("u1", null, "A note on the passage"), codexLine("u2", null, "Another note")]

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

/** ProjectWorkspace keeps the dialog mounted and flips `open`; the remembered
 *  format is restored on that flip, not on a fresh mount. */
function openLikeTheWorkspace(props: React.ComponentProps<typeof ExportDialog>) {
  const { rerender } = render(<ExportDialog {...props} open={false} />)
  rerender(<ExportDialog {...props} open />)
}

/** A type with a native download keeps the fold closed until it is opened. */
function openFoldIfClosed() {
  if (screen.queryByRole("radiogroup", { name: "Export format" })) return
  fireEvent.click(screen.getByText("Export to another format"))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
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

  it.each([
    ["a Chosen episode (cue refs)", "TheChosen_101_en_52", CHOSEN_EPISODE],
    ["Pilgrim's Progress (non-Bible chapter:verse refs)", "PilgrimsProgress", PILGRIMS_PROGRESS],
    ["a commentary (no refs)", "eng bbc", UNREFERENCED],
  ])("does not offer Web page for a codex file that is %s", (_label, fileName, cells) => {
    render(
      <ExportDialog
        {...BASE_PROPS}
        cells={cells}
        activeFileName={fileName}
        activeFileType="codex"
        projectFiles={[{ id: "f-book", name: fileName, type: "codex" }]}
      />,
    )
    openFoldIfClosed()
    expect(screen.getByRole("radio", { name: /^Markdown/ })).toBeInTheDocument()
    expect(webPageRadio()).toBeNull()
  })

  it("a Web page remembered from a Bible book does not stay selected on Pilgrim's Progress", async () => {
    // The fold format is remembered per project, and a migrated project can
    // hold both: Ruth exported as a page, then Pilgrim's Progress opened.
    writeExportMemory("local", "p1", { ...DEFAULT_EXPORT_MEMORY, foldFormat: "html" })
    const props = {
      ...BASE_PROPS,
      cells: PILGRIMS_PROGRESS,
      activeFileName: "PilgrimsProgress",
      activeFileType: "codex",
      projectFiles: [{ id: "f-book", name: "PilgrimsProgress", type: "codex" }],
    }
    openLikeTheWorkspace(props)
    openFoldIfClosed()
    expect(webPageRadio()).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    const [, name] = mockDownload.mock.calls[0] as [Blob, string]
    expect(name).not.toMatch(/\.html$/)
  })

  it("restores a remembered Web page on a Bible book", () => {
    writeExportMemory("local", "p1", { ...DEFAULT_EXPORT_MEMORY, foldFormat: "html" })
    openLikeTheWorkspace({ ...BASE_PROPS, activeFileType: "codex" })
    openFoldIfClosed()
    expect(webPageRadio()).toBeChecked()
  })
})
