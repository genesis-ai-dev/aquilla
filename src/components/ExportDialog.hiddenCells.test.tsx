/**
 * AQU-1423 at the dialog: what the ROUND-TRIP formats do with a parked cell, and
 * what the dialog tells the person before they hand the file to anyone.
 *
 * The round-trip exporters are the dangerous half of this issue. They inject
 * translations into the client's OWN uploaded package and leave a paragraph
 * alone when it carries no translation — so clearing a hidden cell's text is not
 * enough on its own: the parked paragraph would ship, in the source language,
 * looking exactly like a paragraph nobody has got to yet. docx and pptx can drop
 * it, through the `removedCells` mechanism AQU-1068 built. IDML cannot, by
 * design — so it keeps the original text and the dialog has to SAY so, because
 * the difference only becomes visible to the typesetter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))
vi.mock("@/lib/sync/source-export", () => ({
  downloadSourceFile: vi.fn(async () => ({ lossyVerseCount: null })),
  downloadProjectZip: vi.fn(),
  fetchSourceSidecar: vi.fn(async () => new Uint8Array([1, 2, 3])),
  // AQU-1068's server list. Non-empty in one test below, because hidden cells
  // must be ADDED to it rather than replace it — a file can have both.
  fetchRemovedCells: vi.fn(async () => []),
}))
vi.mock("@/lib/export/exporters/docx", () => ({
  exportDocx: vi.fn(async () => ({ blob: new Blob(["docx"]), warnings: [], injected: 1 })),
}))
vi.mock("@/lib/export/exporters/pptx", () => ({
  exportPptx: vi.fn(async () => ({ blob: new Blob(["pptx"]), warnings: [], injected: 1 })),
}))
vi.mock("@/lib/export/exporters/idml", () => ({
  exportIdml: vi.fn(async () => ({
    blob: new Blob(["idml"]),
    report: { translated: 1 },
    diagnostics: {},
  })),
}))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

import { useProjectCells } from "@/hooks/useProjectCells"
import { fetchRemovedCells } from "@/lib/sync/source-export"
import { exportDocx } from "@/lib/export/exporters/docx"
import { exportPptx } from "@/lib/export/exporters/pptx"
import { exportIdml } from "@/lib/export/exporters/idml"

const mockRemoved = vi.mocked(fetchRemovedCells)
const mockDocx = vi.mocked(exportDocx)
const mockPptx = vi.mocked(exportPptx)
const mockIdml = vi.mocked(exportIdml)
const mockProjectCells = vi.mocked(useProjectCells)

type ExportCell = CellData & { hidden?: boolean }

/** A paragraph the importer placed, so it has a package locator to drop by. */
function located(id: string, blockPath: string, over: Partial<ExportCell> = {}): ExportCell {
  return {
    id,
    fileId: "f1",
    original: `SOURCE ${id}`,
    translated: `TARGET ${id}`,
    context: "",
    group: `g-${id}`,
    status: "validated",
    metadata: {
      aquillaImport: {
        sourceLocator: { kind: "package-block", memberPath: "word/document.xml", blockPath },
      },
    },
    ...over,
  } as ExportCell
}

const PARKED_LOCATOR = {
  aquillaImport: {
    sourceLocator: { kind: "package-block", memberPath: "word/document.xml", blockPath: "2" },
  },
}

/** Three located paragraphs, the middle one parked. */
const CELLS: ExportCell[] = [
  located("c1", "1"),
  located("c2", "2", { hidden: true }),
  located("c3", "3"),
]

/** A file imported before locators were recorded — nothing can be placed OR
 *  dropped in it, which changes the answer the dialog must give. */
const LEGACY_CELLS: ExportCell[] = [
  { id: "c1", fileId: "f1", original: "s", translated: "t", context: "", group: "g" } as ExportCell,
  { id: "c2", fileId: "f1", original: "s", translated: "t", context: "", group: "g", hidden: true } as ExportCell,
]

const BASE = {
  open: true,
  onOpenChange: vi.fn(),
  cells: CELLS,
  projectId: "p1",
  projectName: "Hidden export",
  activeFileId: "f1",
  activeFileName: "report.docx",
  activeFileType: "docx",
  projectFiles: [{ id: "f1", name: "report.docx", type: "docx" }],
  targetLanguage: "es",
  getToken: async () => "tok",
}

const asIdml = { activeFileName: "layout.idml", activeFileType: "idml" }
const asPptx = { activeFileName: "deck.pptx", activeFileType: "pptx" }
const asUsfm = { activeFileName: "gen.usfm", activeFileType: "usfm" }

function clickPrimaryDownload() {
  fireEvent.click(screen.getByRole("button", { name: /^Download /i }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRemoved.mockResolvedValue([])
  mockDocx.mockResolvedValue({ blob: new Blob(["docx"]), warnings: [], injected: 1 } as never)
  mockPptx.mockResolvedValue({ blob: new Blob(["pptx"]), warnings: [], injected: 1 } as never)
  mockIdml.mockResolvedValue({
    blob: new Blob(["idml"]), report: { translated: 1 }, diagnostics: {},
  } as never)
  mockProjectCells.mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — hidden cells in round-trip exports (AQU-1423)", () => {
  it("tells Word to DROP the parked paragraph, not just leave it untranslated", async () => {
    render(<ExportDialog {...BASE} />)
    clickPrimaryDownload()
    await waitFor(() => expect(mockDocx).toHaveBeenCalledTimes(1))

    const [, cells, options] = mockDocx.mock.calls[0] as [unknown, ExportCell[], { removedCells: { metadata: unknown }[] }]
    // The drop list — without this the paragraph keeps the client's own words.
    expect(options.removedCells).toEqual([{ metadata: PARKED_LOCATOR }])
    // And no translation to inject, so nothing can write over it either way.
    expect(cells.find((c) => c.id === "c2")!.translated).toBe("")
    // Its neighbours are untouched.
    expect(cells.find((c) => c.id === "c1")!.translated).toBe("TARGET c1")
    expect(cells.find((c) => c.id === "c3")!.translated).toBe("TARGET c3")
  })

  it("ADDS hidden cells to the server's removals rather than replacing them", async () => {
    // A file can have both, and the two lists are independent. Replacing would
    // silently undo every deletion the moment anyone hides anything.
    const serverRemoval = { cellId: "gone", canonicalRef: null, metadata: { other: true } }
    mockRemoved.mockResolvedValue([serverRemoval] as never)
    render(<ExportDialog {...BASE} />)
    clickPrimaryDownload()
    await waitFor(() => expect(mockDocx).toHaveBeenCalledTimes(1))

    const options = (mockDocx.mock.calls[0] as [unknown, unknown, { removedCells: unknown[] }])[2]
    expect(options.removedCells).toEqual([serverRemoval, { metadata: PARKED_LOCATOR }])
  })

  it("tells PowerPoint to drop it too", async () => {
    render(<ExportDialog {...BASE} {...asPptx} />)
    clickPrimaryDownload()
    await waitFor(() => expect(mockPptx).toHaveBeenCalledTimes(1))
    const options = (mockPptx.mock.calls[0] as [unknown, unknown, { removedCells: unknown[] }])[2]
    expect(options.removedCells).toEqual([{ metadata: PARKED_LOCATOR }])
  })

  it("leaves IDML's original text in place, with no translation over it", async () => {
    // IDML's engine refuses structural change by design, so the paragraph stays.
    // What must NOT happen is the translation going in anyway — that would ship
    // a parked line as finished work.
    render(<ExportDialog {...BASE} {...asIdml} />)
    clickPrimaryDownload()
    await waitFor(() => expect(mockIdml).toHaveBeenCalledTimes(1))
    const cells = (mockIdml.mock.calls[0] as [unknown, ExportCell[]])[1]
    expect(cells.map((c) => c.id)).toEqual(["c1", "c2", "c3"])
    expect(cells.find((c) => c.id === "c2")!.translated).toBe("")
    expect(cells.find((c) => c.id === "c1")!.translated).toBe("TARGET c1")
  })
})

describe("ExportDialog — the hidden-cell note (AQU-1423)", () => {
  it("says the parked cells are left out of Word, PowerPoint and USFM", () => {
    for (const as of [{}, asPptx, asUsfm]) {
      const { unmount } = render(<ExportDialog {...BASE} {...as} />)
      expect(screen.getByText(/Cells hidden here are left out/i)).toBeTruthy()
      unmount()
    }
  })

  it("warns that InDesign keeps their original text", () => {
    render(<ExportDialog {...BASE} {...asIdml} />)
    // The one case where hiding does NOT remove the text from the delivered
    // file. Saying nothing here is how a parked paragraph reaches a typesetter
    // with no one aware of it.
    expect(screen.getByText(/keep their original text/i)).toBeTruthy()
  })

  it("gives the same warning for a Word file with no paragraph locators", () => {
    render(<ExportDialog {...BASE} cells={LEGACY_CELLS} />)
    expect(screen.getByText(/keep their original text/i)).toBeTruthy()
  })

  it("says NOTHING about hiding on a file with nothing parked", () => {
    // The note is about this file's current state, not a standing caveat — a
    // permanent line about hidden cells would train people to ignore it.
    render(<ExportDialog {...BASE} cells={[located("c1", "1"), located("c3", "3")]} />)
    expect(screen.queryByText(/Cells hidden here/i)).toBeNull()
    expect(screen.queryByText(/keep their original text/i)).toBeNull()
  })
})
