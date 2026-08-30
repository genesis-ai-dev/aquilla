// AQU-1068: the export formats that round-trip through the user's ORIGINAL
// file cannot carry a cell that was added inside the app — USFM substitutes by
// canonical ref, docx/pptx/IDML by position in the original package, and a cell
// born here has neither. That is inherent, not a bug.
//
// Sam settled the trade on 2026-08-30: keep the inserts available everywhere
// (blocking them would gut scripture and document editing, and leave incoherent
// seams — an eBible import would keep the buttons while a USFM one lost them),
// and make the omission LOUD instead. This is what stops it being the exact
// silent drop the round ruled out everywhere else.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import { userLineOrigin } from "@/lib/timeline/user-lines"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))
vi.mock("@/lib/sync/source-export", () => ({
  downloadSourceFile: vi.fn(),
  downloadProjectZip: vi.fn(),
  fetchSourceSidecar: vi.fn(),
}))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

import { useProjectCells } from "@/hooks/useProjectCells"
const mockProjectCells = vi.mocked(useProjectCells)

const imported = (id: string): CellData =>
  ({ id, fileId: "f1", original: "source", translated: "hola", context: "", group: `g-${id}` }) as CellData

const addedHere = (id: string): CellData =>
  ({
    id, fileId: "f1", original: "", translated: "a missing verse", context: "", group: "",
    metadata: { aquillaOrigin: userLineOrigin() },
  }) as unknown as CellData

const BASE = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "p1",
  projectName: "Demo",
  activeFileId: "f1",
  activeFileName: "01-GEN.usfm",
  activeFileType: "usfm",
  projectFiles: [{ id: "f1", name: "01-GEN.usfm", type: "usfm" }],
  targetLanguage: "es",
  getToken: async () => "token",
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
  } as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — added lines and the round-trip formats", () => {
  it("warns that added cells will not be in a USFM export", () => {
    render(<ExportDialog {...BASE} cells={[imported("c1"), addedHere("new1"), addedHere("new2")]} />)
    expect(screen.getByText(/2 cells added here aren.t part of the original file/i)).toBeTruthy()
  })

  it("says it in the singular for one", () => {
    render(<ExportDialog {...BASE} cells={[imported("c1"), addedHere("new1")]} />)
    expect(screen.getByText(/1 cell added here isn.t part of the original file/i)).toBeTruthy()
  })

  it("says nothing when the file has no added cells — no noise on the common case", () => {
    render(<ExportDialog {...BASE} cells={[imported("c1"), imported("c2")]} />)
    expect(screen.queryByText(/added here/i)).toBeNull()
  })

  it("warns on a document round-trip too, not just scripture", () => {
    // docx/pptx patch the original package by position; same limitation.
    render(
      <ExportDialog
        {...BASE}
        activeFileName="deck.pptx" activeFileType="pptx"
        projectFiles={[{ id: "f1", name: "deck.pptx", type: "pptx" }]}
        cells={[imported("c1"), addedHere("new1")]}
      />,
    )
    expect(screen.getByText(/added here isn.t part of the original file/i)).toBeTruthy()
  })

  it("stays silent for a file type with no native round-trip", () => {
    // An eBible import has no original file to patch — it exports through the
    // generic formats, which carry added lines perfectly well.
    render(
      <ExportDialog
        {...BASE}
        activeFileName="bible.ebible" activeFileType="ebible"
        projectFiles={[{ id: "f1", name: "bible.ebible", type: "ebible" }]}
        cells={[imported("c1"), addedHere("new1")]}
      />,
    )
    expect(screen.queryByText(/added here/i)).toBeNull()
  })
})
