// Bible Swap is a Biblica export option, offered only for the two editions
// whose verse text is swapped in from a separate Bible file.
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
  fetchSourceSidecar: vi.fn(async () => new ArrayBuffer(8)),
  fetchRemovedCells: vi.fn(async () => []),
}))
vi.mock("@/lib/export/exporters/idml", () => ({
  exportIdml: vi.fn(async () => ({
    blob: new Blob(["idml"]),
    report: { translated: 1, missing: 0, rejected: 0 },
    diagnostics: [],
  })),
}))
vi.mock("@/lib/posthog", () => ({
  default: { capture: vi.fn() },
}))

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"
import { exportIdml } from "@/lib/export/exporters/idml"

const mockDownload = vi.mocked(downloadBlob)
const mockProjectCells = vi.mocked(useProjectCells)
const mockExportIdml = vi.mocked(exportIdml)

function cell(profileId?: string): CellData {
  return {
    id: "c1",
    fileId: "f1",
    original: "source",
    translated: "cible",
    context: "",
    group: "g1",
    ...(profileId
      ? { metadata: { aquillaImport: { profileId } } }
      : {}),
  } as CellData
}

function props(profileId?: string, fileName = "JOS-EST.idml") {
  return {
    open: true,
    onOpenChange: vi.fn(),
    cells: [cell(profileId)],
    projectId: "p1",
    projectName: "Demo",
    activeFileId: "f1",
    activeFileName: fileName,
    activeFileType: "idml",
    projectFiles: [{ id: "f1", name: fileName, type: "idml" }],
    targetLanguage: "fr",
    getToken: async () => "token",
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
    revalidate: vi.fn(),
    applyOptimisticTargetEdit: vi.fn(),
  } as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — Bible Swap", () => {
  it("offers Bible Swap for a Study Bible file and still shows the other export formats", async () => {
    render(<ExportDialog {...props("builtin:biblica-study-notes")} />)

    expect(await screen.findByText("Bible Swap (optional)")).toBeInTheDocument()
    expect(screen.getByTestId("export-fold")).toBeInTheDocument()
  })

  it("offers Bible Swap for a Treasure Hunt file", async () => {
    render(<ExportDialog {...props("builtin:biblica-treasure-hunt", "Treasure.idml")} />)

    expect(await screen.findByText("Bible Swap (optional)")).toBeInTheDocument()
  })

  it("does not offer Bible Swap for other Biblica editions or a generic IDML file", async () => {
    const { rerender } = render(<ExportDialog {...props("builtin:biblica-reach4life")} />)
    expect(screen.queryByText("Bible Swap (optional)")).not.toBeInTheDocument()

    rerender(<ExportDialog {...props("builtin:biblica-ebl")} />)
    expect(screen.queryByText("Bible Swap (optional)")).not.toBeInTheDocument()

    rerender(<ExportDialog {...props()} />)
    expect(screen.queryByText("Bible Swap (optional)")).not.toBeInTheDocument()

    // The option is lazy. Give a study-bible render a tick so a late appearance
    // on the earlier files would have been caught above, then confirm the
    // study-bible file is the one that does show it.
    rerender(<ExportDialog {...props("builtin:biblica-study-notes")} />)
    expect(await screen.findByText("Bible Swap (optional)")).toBeInTheDocument()
  })

  it("downloads the notes-only IDML when swap is left off", async () => {
    render(<ExportDialog {...props("builtin:biblica-study-notes")} />)
    await screen.findByText("Bible Swap (optional)")

    fireEvent.click(screen.getByRole("button", { name: /Download JOS-EST\.idml/i }))

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    expect(mockExportIdml).toHaveBeenCalledTimes(1)
    expect(mockDownload.mock.calls[0][1]).toBe("JOS-EST.idml")
  })
})
