// AQU-519 regression guard — WHY: after a successful export the dialog must
// (a) show a visible success confirmation, and (b) offer an unmistakable way
// out. Before this fix the footer only showed "Cancel"/"Export", so a user who
// had just exported couldn't tell whether anything happened or how to dismiss
// the dialog. The success state now swaps in a primary "Done" button that
// closes the dialog; a failed export must NOT show "Done".
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

function cell(id: string, translated: string): CellData {
  return {
    id,
    fileId: "f1",
    original: "source text",
    translated,
    context: "",
    group: "GEN 1:1",
  } as CellData
}

const onOpenChange = vi.fn()

const BASE_PROPS = {
  open: true,
  onOpenChange,
  cells: [cell("c1", "translated one"), cell("c2", "translated two")],
  projectId: "p1",
  projectName: "Demo project",
  activeFileId: "f1",
  activeFileName: "gen.txt",
  // No native round-trip for an unknown import type — the "Export to another
  // format" section opens by default and TSV is pre-selected.
  activeFileType: null,
  projectFiles: [{ id: "f1", name: "gen.txt", type: "txt" }],
  targetLanguage: "es",
  getToken: async () => null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
  } as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — success confirmation + Done affordance", () => {
  it("before export: footer shows Cancel + Export, no Done", () => {
    render(<ExportDialog {...BASE_PROPS} />)
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Export$/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Done$/i })).not.toBeInTheDocument()
  })

  it("after a successful export: shows a confirmation and a Done button that closes the dialog", async () => {
    render(<ExportDialog {...BASE_PROPS} />)

    // Default format for a non-USFM/non-DOCX file is TSV — a client-side exporter.
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))

    // The blob was produced and handed to the downloader.
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    // Visible success confirmation (in-dialog status region).
    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/Downloaded/i)

    // The obvious way out: a Done button appears; Cancel is gone.
    const done = await screen.findByRole("button", { name: /^Done$/i })
    expect(screen.queryByRole("button", { name: /^Cancel$/i })).not.toBeInTheDocument()

    // Clicking Done closes the dialog.
    fireEvent.click(done)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("after a failed export: shows an error, keeps Cancel, no Done button", async () => {
    // SDBH XML export with no skeleton chosen sets an error status. The footer
    // must stay in its pre-success form (Cancel + Export), never showing Done.
    render(
      <ExportDialog
        {...BASE_PROPS}
        projectFiles={[{ id: "f1", name: "SDBH.XML", type: "sdbh" }]}
      />,
    )

    fireEvent.click(screen.getByText("SDBH XML (MARBLE)"))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))

    await waitFor(() =>
      expect(screen.getByText(/Choose the original SDBH/i)).toBeInTheDocument(),
    )
    expect(mockDownload).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: /^Done$/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeInTheDocument()
  })
})
