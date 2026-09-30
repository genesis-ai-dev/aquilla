// AQU-1148: an export must not present unvalidated draft — or source-language
// filler standing in for an untranslated cell — as approved translation.
//
// The trust hazard these guard: a publisher, typesetter or reviewer receiving
// the file cannot tell approved translation from unreviewed draft from source
// text, and the surrounding copy told them it was all approved. So the dialog
// now (a) says what the DEFAULT export actually contains, and (b) offers a
// validated-only mode that omits everything else rather than back-filling it.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import { pickSelectOption } from "@/test-utils/select"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({
  downloadBlob: vi.fn(),
}))
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: vi.fn(),
}))
vi.mock("@/lib/sync/source-export", () => ({
  downloadSourceFile: vi.fn(async () => ({ lossyVerseCount: null })),
  downloadProjectZip: vi.fn(async () => ({ exported: 1, skipped: [] })),
  fetchSourceSidecar: vi.fn(),
  fetchRemovedCells: vi.fn(async () => []),
}))

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"
import { downloadSourceFile } from "@/lib/sync/source-export"

const mockDownload = vi.mocked(downloadBlob)
const mockProjectCells = vi.mocked(useProjectCells)
const mockDownloadSource = vi.mocked(downloadSourceFile)

function cell(
  id: string,
  translated: string,
  status: CellData["status"],
  original: string,
): CellData {
  return {
    id,
    fileId: "f-txt",
    original,
    translated,
    context: "",
    group: "",
    status,
  } as CellData
}

/** One of each: approved, unreviewed draft, and untranslated. */
const MIXED_CELLS = [
  cell("c1", "APPROVED LINE", "validated", "source one"),
  cell("c2", "UNREVIEWED DRAFT", "unvalidated", "source two"),
  cell("c3", "", "empty", "UNTRANSLATED SOURCE"),
]

const ALL_VALIDATED_CELLS = [
  cell("c1", "APPROVED LINE", "validated", "source one"),
  cell("c2", "ALSO APPROVED", "validated", "source two"),
]

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  cells: MIXED_CELLS,
  projectId: "p1",
  projectName: "Validated export",
  activeFileId: "f-txt",
  activeFileName: "notes.txt",
  activeFileType: "txt",
  projectFiles: [
    { id: "f-txt", name: "notes.txt", type: "txt" },
    { id: "f-usfm", name: "gen.usfm", type: "usfm" },
  ],
  targetLanguage: "es",
  getToken: async () => "tok",
}

async function pickContentMode(label: string) {
  const trigger = await pickSelectOption(
    /what the exported file contains/i,
    new RegExp(`^${label}$`),
  )
  await waitFor(() => expect(trigger.textContent).toContain(label))
}

/** Open the "Export to another format" fold on a cell-array format. */
function openFoldAsMarkdown() {
  fireEvent.click(screen.getByText("Export to another format"))
  fireEvent.click(screen.getByText("Markdown"))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — validated-only export (AQU-1148)", () => {
  it("tells the user the default export mixes drafts and source text", () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsMarkdown()
    // The claim this replaces was "the exported files contain the approved
    // text". The default must say what it really contains, up front.
    expect(
      screen.getByText(/validated, unvalidated draft and AI draft alike/i),
    ).toBeTruthy()
    expect(
      screen.getByText(/Untranslated cells are filled with the source text/i),
    ).toBeTruthy()
  })

  it("defaults to the current-translations mode on every open", () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsMarkdown()
    const trigger = screen.getByRole("combobox", { name: /what the exported file contains/i })
    expect(trigger.textContent).toContain("Current translations")
  })

  it("exports every cell's current text by default, source text included", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsMarkdown()

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    const text = await (mockDownload.mock.calls[0] as [Blob, string])[0].text()
    expect(text).toContain("APPROVED LINE")
    expect(text).toContain("UNREVIEWED DRAFT")
    // Today's source-text fallback, unchanged — now stated rather than silent.
    expect(text).toContain("UNTRANSLATED SOURCE")
  })

  it("omits unvalidated drafts AND source filler under validated-only", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsMarkdown()
    await pickContentMode("Validated translations only")

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    const text = await (mockDownload.mock.calls[0] as [Blob, string])[0].text()
    expect(text).toContain("APPROVED LINE")
    expect(text).not.toContain("UNREVIEWED DRAFT")
    // The regression that makes validated-only worthless: blanking rather than
    // omitting sends the cell through `translated || effectiveSourceText`, and
    // source-language text lands in an "approved only" file.
    expect(text).not.toContain("UNTRANSLATED SOURCE")
  })

  it("reports how much of the file is validated once the mode is chosen", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsMarkdown()
    await pickContentMode("Validated translations only")
    expect(screen.getByText(/1 of 3 cells in this file are validated/i)).toBeTruthy()
  })

  it("exports a fully-validated file identically in both modes", async () => {
    const { unmount } = render(<ExportDialog {...BASE_PROPS} cells={ALL_VALIDATED_CELLS} />)
    openFoldAsMarkdown()
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    const defaultText = await (mockDownload.mock.calls[0] as [Blob, string])[0].text()
    unmount()

    mockDownload.mockClear()
    render(<ExportDialog {...BASE_PROPS} cells={ALL_VALIDATED_CELLS} />)
    openFoldAsMarkdown()
    await pickContentMode("Validated translations only")
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    const validatedText = await (mockDownload.mock.calls[0] as [Blob, string])[0].text()

    expect(validatedText).toBe(defaultText)
  })

  it("asks the server for validated text only on the round-trip USFM export", async () => {
    render(
      <ExportDialog
        {...BASE_PROPS}
        activeFileId="f-usfm"
        activeFileName="gen.usfm"
        activeFileType="usfm"
      />,
    )
    fireEvent.click(screen.getByText("Export to another format"))
    expect(screen.getByRole("radio", { name: /USFM/i })).toBeChecked()
    await pickContentMode("Validated translations only")
    // USFM is injected server-side, so the mode has to cross the wire — the
    // client cannot filter what it never assembles.
    expect(
      screen.getByText(/keeps the words already in the file you uploaded/i),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownloadSource).toHaveBeenCalledTimes(1))
    expect(mockDownloadSource.mock.calls[0]![0]).toMatchObject({ validatedOnly: true })
  })

  it("leaves the server export unnarrowed in the default mode", async () => {
    render(
      <ExportDialog
        {...BASE_PROPS}
        activeFileId="f-usfm"
        activeFileName="gen.usfm"
        activeFileType="usfm"
      />,
    )
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownloadSource).toHaveBeenCalledTimes(1))
    expect(mockDownloadSource.mock.calls[0]![0]).toMatchObject({ validatedOnly: false })
  })
})
