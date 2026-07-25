// Export ergonomics — WHY: the headline export action must be "download your
// file back in its own format". (a) A file imported as .pptx gets a primary
// "Download <name>.pptx" button that round-trips through the server side-car
// and the PPTX injector (AQU-152a wiring — previously dead code); (b) files
// without a native format get no primary button and the format list opens
// instead; (c) when org policy forbids export, the dialog shows an explicit
// permission gate with a help link rather than hiding (AQU-253 revised).
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
vi.mock("@/lib/export/exporters/pptx", () => ({
  exportPptx: vi.fn(),
}))
vi.mock("@/lib/export/exporters/idml", () => ({
  exportIdml: vi.fn(),
}))

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"
import { fetchSourceSidecar } from "@/lib/sync/source-export"
import { exportPptx } from "@/lib/export/exporters/pptx"
import { exportIdml } from "@/lib/export/exporters/idml"

const mockDownload = vi.mocked(downloadBlob)
const mockProjectCells = vi.mocked(useProjectCells)
const mockSidecar = vi.mocked(fetchSourceSidecar)
const mockExportPptx = vi.mocked(exportPptx)
const mockExportIdml = vi.mocked(exportIdml)

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
  activeFileName: "deck.pptx",
  activeFileType: "pptx",
  projectFiles: [{ id: "f1", name: "deck.pptx", type: "pptx" }],
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

describe("ExportDialog — native download is the primary action", () => {
  it("pptx file: primary button downloads the original deck with translations injected", async () => {
    mockSidecar.mockResolvedValue(new ArrayBuffer(8))
    mockExportPptx.mockResolvedValue({
      blob: new Blob(["pptx"]),
      injected: 1,
      untouched: 0,
      warnings: [],
    })

    render(<ExportDialog {...BASE_PROPS} />)

    const primary = screen.getByRole("button", { name: /Download deck\.pptx/i })
    fireEvent.click(primary)

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    // Round-trip contract: side-car fetched, injector run, .pptx handed out.
    expect(mockSidecar).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", fileId: "f1" }),
    )
    expect(mockExportPptx).toHaveBeenCalledTimes(1)
    expect(mockDownload.mock.calls[0][1]).toBe("deck.pptx")

    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/Downloaded deck\.pptx/i)
  })

  it("file type without a native round-trip: no primary download; format list is open", () => {
    render(
      <ExportDialog
        {...BASE_PROPS}
        activeFileName="audio.mp3"
        activeFileType="audio"
        projectFiles={[{ id: "f1", name: "audio.mp3", type: "audio" }]}
      />,
    )
    expect(screen.queryByRole("button", { name: /^Download /i })).not.toBeInTheDocument()
    // The conversion section is expanded so the user still has options.
    // (Exact name — "Advanced export formats" is a separate radiogroup.)
    expect(screen.getByRole("radiogroup", { name: "Export format" })).toBeVisible()
  })

  it("idml mapping failure: blocks translated download and offers the exact original plus re-import", async () => {
    const original = new Uint8Array([80, 75, 3, 4, 73, 68, 77, 76]).buffer
    const onReimport = vi.fn()
    mockSidecar.mockResolvedValue(original)
    mockExportIdml.mockRejectedValue(new Error("Protected IDML anchor 2 was reordered."))

    render(
      <ExportDialog
        {...BASE_PROPS}
        activeFileName="layout.idml"
        activeFileType="idml"
        projectFiles={[{ id: "f1", name: "layout.idml", type: "idml" }]}
        onReimport={onReimport}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /Download layout\.idml/i }))

    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/Protected IDML anchor 2 was reordered/i)
    expect(mockDownload).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /Download original unchanged/i }))
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(mockDownload.mock.calls[0]?.[1]).toBe("layout-original.idml")
    expect(await mockDownload.mock.calls[0]?.[0].arrayBuffer()).toEqual(original)

    fireEvent.click(screen.getByRole("button", { name: /Repair by re-importing/i }))
    expect(onReimport).toHaveBeenCalledTimes(1)
  })

  it("canExport=false: shows the permission gate with a help link instead of export controls", () => {
    render(<ExportDialog {...BASE_PROPS} canExport={false} />)

    const gate = screen.getByRole("note", { name: /Export permission required/i })
    expect(gate).toHaveTextContent(/don't have export permission/i)
    const link = screen.getByRole("link", { name: /Roles & permissions/i })
    expect(link).toHaveAttribute("href", "https://help.aquilla.app/permissions")
    // No way to trigger an export from the gated dialog.
    expect(screen.queryByRole("button", { name: /^Export$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Download /i })).not.toBeInTheDocument()
    // Footer "Close" plus the dialog chrome's own X (also named Close).
    expect(screen.getAllByRole("button", { name: /^Close$/i }).length).toBeGreaterThan(0)
  })
})
