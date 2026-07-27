// AQU-654 regression: export is a basic, must-not-fail function and must NEVER
// be hard-blocked by HTML/validation "health" errors. The ExportDialog has no
// gate on outstanding LQA/validation infractions — the only export gate is org
// policy (`canExport`). When a file still carries flagged infractions we render
// a calm, NON-blocking advisory so users stop believing those flags prevent a
// download (the reported confusion), and the download still fires normally.
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
vi.mock("@/lib/sync/source-export", () => ({
  downloadSourceFile: vi.fn(),
  downloadProjectZip: vi.fn(),
  fetchSourceSidecar: vi.fn(),
}))

import { downloadSourceFile } from "@/lib/sync/source-export"
import { useProjectCells } from "@/hooks/useProjectCells"

const mockDownloadSource = vi.mocked(downloadSourceFile)
const mockProjectCells = vi.mocked(useProjectCells)

function cell(id: string, translated: string): CellData {
  return {
    id,
    fileId: "f1",
    original: "source",
    translated,
    context: "",
    group: `g-${id}`,
  } as CellData
}

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  cells: [cell("c1", "hola")],
  projectId: "p1",
  projectName: "Demo",
  activeFileId: "f1",
  activeFileName: "book.usfm",
  activeFileType: "usfm",
  projectFiles: [{ id: "f1", name: "book.usfm", type: "usfm" }],
  targetLanguage: "es",
  getToken: async () => "token",
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
  } as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — validation/health flags never block export (AQU-654)", () => {
  it("shows a non-blocking advisory when the file has outstanding infractions", () => {
    render(<ExportDialog {...BASE_PROPS} outstandingInfractionCount={3} />)

    const note = screen.getByTestId("export-nonblocking-health-note")
    expect(note).toHaveTextContent(/3 outstanding validation flags/i)
    expect(note).toHaveTextContent(/won't block your export/i)
  })

  it("uses the singular form for a single outstanding flag", () => {
    render(<ExportDialog {...BASE_PROPS} outstandingInfractionCount={1} />)
    expect(screen.getByTestId("export-nonblocking-health-note"))
      .toHaveTextContent(/1 outstanding validation flag\b/i)
  })

  it("renders no advisory when there are no outstanding infractions", () => {
    render(<ExportDialog {...BASE_PROPS} outstandingInfractionCount={0} />)
    expect(screen.queryByTestId("export-nonblocking-health-note")).not.toBeInTheDocument()
  })

  it("export still fires even with outstanding infractions present", async () => {
    mockDownloadSource.mockResolvedValue({ lossyVerseCount: 0 })

    render(<ExportDialog {...BASE_PROPS} outstandingInfractionCount={5} />)

    // The primary "Download <file>" action is fully enabled — the flags do not
    // disable or gate it in any way.
    const primary = screen.getByRole("button", { name: /Download book/i })
    expect(primary).toBeEnabled()
    fireEvent.click(primary)

    await waitFor(() => expect(mockDownloadSource).toHaveBeenCalledTimes(1))
    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/Exported book\.SFM/i)
  })
})
