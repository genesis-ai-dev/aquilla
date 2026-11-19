/**
 * AQU-2539 at the dialog: after a Word export, the formatting note names only
 * the paragraphs where words lost their look, by their first words, under a
 * plain heading; formatting the export kept is not reported again.
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
  fetchRemovedCells: vi.fn(async () => []),
}))
vi.mock("@/lib/export/exporters/docx", () => ({ exportDocx: vi.fn() }))
vi.mock("@/lib/posthog", () => ({ default: { scope() { return { ...this, enabled: () => true } }, capture: vi.fn() } }))

import { useProjectCells } from "@/hooks/useProjectCells"
import { exportDocx } from "@/lib/export/exporters/docx"

const mockDocx = vi.mocked(exportDocx)

/** A Word line with formatting in its source (it has originalHtml), translated. */
const cell = (id: string, blockPath: string) => ({
  id,
  fileId: "f1",
  original: `Such is the Codex Leningradensis ${id}`,
  originalHtml: `<p>Such is the <em>Codex Leningradensis</em> ${id}</p>`,
  translated: `Tel est le codex de Leningrad ${id}`,
  context: "",
  group: `g-${id}`,
  status: "validated",
  metadata: { aquillaImport: { sourceLocator: { kind: "package-block", memberPath: "word/document.xml", blockPath } } },
}) as unknown as CellData

const BASE = {
  open: true,
  onOpenChange: vi.fn(),
  cells: [cell("a", "w:p[1]"), cell("b", "w:p[2]")],
  projectId: "p1",
  projectName: "Word looks",
  activeFileId: "f1",
  activeFileName: "notes.docx",
  activeFileType: "docx",
  projectFiles: [{ id: "f1", name: "notes.docx", type: "docx" }],
  targetLanguage: "fr",
  getToken: async () => "tok",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useProjectCells).mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
})

async function exportOnce() {
  render(<ExportDialog {...BASE} />)
  fireEvent.click(screen.getByRole("button", { name: /^Download /i }))
  await waitFor(() => expect(mockDocx).toHaveBeenCalledTimes(1))
}

describe("ExportDialog — Word paragraphs that lost a look (AQU-2539)", () => {
  it("shows no formatting note when every look was kept", async () => {
    mockDocx.mockResolvedValue({ blob: new Blob(["docx"]), warnings: [], lostLooks: [], injected: 2 } as never)
    await exportOnce()
    await screen.findByText(/2 paragraphs translated/i)
    expect(screen.queryByRole("note")).toBeNull()
  })

  it("names each paragraph that lost a look by its first words, under a plain heading", async () => {
    mockDocx.mockResolvedValue({
      blob: new Blob(["docx"]),
      warnings: [],
      lostLooks: [{ segment: "Such is the Codex Leningradensis a", words: ["Codex Leningradensis"] }],
      injected: 2,
    } as never)
    await exportOnce()
    const note = await screen.findByRole("note")
    expect(note.textContent).toContain(
      "In 1 paragraph, some words lost their bold, italic or other look because the translation changed them.",
    )
    expect(note.textContent).toContain("Such is the Codex Leningradensis a: “Codex Leningradensis”")
    expect(note.textContent).not.toMatch(/w:p\[|segments? lost inline formatting/)
  })
})
