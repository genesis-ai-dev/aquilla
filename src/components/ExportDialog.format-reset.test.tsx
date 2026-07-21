// Format-state reset — WHY: the dialog stays mounted in ProjectWorkspace
// across file switches, so its format state must follow the active file.
// A stale "usfm"/"docx" selection can otherwise drive handleExport down the
// wrong server side-car path after the user switches files.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"

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

function cell(id: string): CellData {
  return {
    id,
    fileId: "f-txt",
    original: "source text",
    translated: "target text",
    context: "",
    group: "GEN 1:1",
  } as CellData
}

const PROJECT_FILES = [
  { id: "f-usfm", name: "gen.usfm", type: "usfm" },
  { id: "f-txt", name: "notes.txt", type: "txt" },
  { id: "f-pptx", name: "slides.pptx", type: "pptx" },
]

const USFM_FILE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  cells: [cell("c1")],
  projectId: "p1",
  projectName: "Format reset",
  activeFileId: "f-usfm",
  activeFileName: "gen.usfm",
  activeFileType: "usfm",
  projectFiles: PROJECT_FILES,
  targetLanguage: "es",
  getToken: async () => null,
}

const TXT_FILE_PROPS = {
  ...USFM_FILE_PROPS,
  activeFileId: "f-txt",
  activeFileName: "notes.txt",
  activeFileType: "txt",
}

const PPTX_FILE_PROPS = {
  ...TXT_FILE_PROPS,
  activeFileId: "f-pptx",
  activeFileName: "slides.pptx",
  activeFileType: "pptx",
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — format follows the active file", () => {
  it("drops the stale USFM format when the active file switches to a non-USFM file", async () => {
    const { rerender } = render(<ExportDialog {...USFM_FILE_PROPS} />)
    // USFM file: the round-trip option is offered and preselected.
    expect(screen.getByText("USFM")).toBeInTheDocument()

    // Switch the active file while the dialog stays mounted (as in ProjectWorkspace).
    rerender(<ExportDialog {...TXT_FILE_PROPS} />)
    expect(screen.queryByText("USFM")).not.toBeInTheDocument()

    // The primary action must now be the TXT file's native export — not the
    // stale USFM server round-trip.
    fireEvent.click(screen.getByRole("button", { name: /^Download notes\.txt$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    const [, name] = mockDownload.mock.calls[0]
    expect(name).toBe("notes.txt")
  })

  it("keeps the user's format choice while the same file stays active", () => {
    const { rerender } = render(<ExportDialog {...TXT_FILE_PROPS} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Markdown"))

    // Unrelated prop churn on the same file must not clobber the choice.
    rerender(<ExportDialog {...TXT_FILE_PROPS} open={true} />)
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    return waitFor(() => {
      expect(mockDownload).toHaveBeenCalledTimes(1)
      const [, name] = mockDownload.mock.calls[0]
      expect(name).toMatch(/\.md$/)
    })
  })

  it("offers and preselects native PPTX round-trip for a PPTX file", () => {
    render(<ExportDialog {...PPTX_FILE_PROPS} />)
    expect(screen.getByRole("button", { name: /^Download slides\.pptx$/i })).toBeVisible()
    fireEvent.click(screen.getByText("Export to another format"))
    expect(screen.getByRole("radio", { name: /PowerPoint \(.pptx\)/i })).toBeChecked()
    expect(screen.queryByText("USFM")).not.toBeInTheDocument()
  })
})
