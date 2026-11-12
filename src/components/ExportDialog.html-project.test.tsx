// AQU-2183: "Web page" now offers whole-project scope, and that export is a
// zip of one page per USFM book plus an index — not buildProjectZip's
// one-entry-per-file shape, and not a disabled radio.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import JSZip from "jszip"
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

function cell(id: string, fileId: string, group: string, translated: string): CellData {
  return { id, fileId, original: `source ${id}`, translated, context: "", group, type: "verse" } as CellData
}

const GENESIS = [cell("g1", "f-gen", "GEN 1:1", "in the beginning")]
const MARK = [cell("k1", "f-mrk", "MRK 1:1", "the beginning of the gospel")]
/** No reference, and "handbook.docx" names no book — not a USFM book. */
const HANDBOOK = [cell("d1", "f-doc", "", "some notes")]

const PROJECT_FILES = [
  { id: "f-gen", name: "sample.usfm", type: "usfm" },
  { id: "f-mrk", name: "parity-mark.usfm", type: "usfm" },
  { id: "f-doc", name: "handbook.docx", type: "docx" },
]

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  cells: GENESIS,
  projectId: "p1",
  projectName: "Night Watch",
  activeFileId: "f-gen",
  activeFileName: "sample.usfm",
  activeFileType: "usfm",
  projectFiles: PROJECT_FILES,
  targetLanguage: "fr",
  getToken: async () => null,
}

/** Open the "Export to another format" fold on the HTML format. */
function openFoldAsWebPage() {
  fireEvent.click(screen.getByText("Export to another format"))
  fireEvent.click(screen.getByText("Web page"))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [
      { fileId: "f-gen", fileName: "sample.usfm", cells: GENESIS },
      { fileId: "f-mrk", fileName: "parity-mark.usfm", cells: MARK },
      { fileId: "f-doc", fileName: "handbook.docx", cells: HANDBOOK },
    ],
    isLoading: false,
    isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — whole-project HTML (AQU-2183)", () => {
  it("offers whole-project scope for Web page", () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsWebPage()

    // The scope control is a tab strip, not a radio group — and this tab was
    // disabled while html was file-only, so it is the whole feature's door.
    expect(screen.getByRole("tab", { name: /whole project/i })).toHaveAttribute("aria-disabled", "false")
    expect(screen.queryByText(/project scope not supported for this format/i)).toBeNull()
  })

  it("downloads one zip of book pages plus an index, and reports books and skips", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsWebPage()
    fireEvent.click(screen.getByRole("tab", { name: /whole project/i }))
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /whole project/i })).toHaveAttribute("aria-selected", "true"),
    )

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    const [blob, name] = mockDownload.mock.calls[0] as [Blob, string]
    expect(name).toMatch(/\.zip$/)

    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual(["01-GEN.html", "41-MRK.html", "index.html"])

    // The index reaches both books; each page links back to it.
    const index = await zip.file("index.html")!.async("string")
    expect(index).toContain('href="01-GEN.html"')
    expect(index).toContain('href="41-MRK.html"')
    expect(index).toContain("Night Watch")
    const genesis = await zip.file("01-GEN.html")!.async("string")
    expect(genesis).toContain('<a href="index.html">')
    expect(genesis).toContain("in the beginning")

    // The DOCX is skipped, and said to be — both counts, never silence.
    expect(await screen.findByText(/Exported 2 books as HTML/)).toBeTruthy()
    expect(screen.getByText(/skipped 1 file that isn't a USFM book/)).toBeTruthy()
  })
})
