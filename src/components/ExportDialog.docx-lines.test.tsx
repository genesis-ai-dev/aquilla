// AQU-2551 (question 54): a file with no uploaded .docx to write into — a PDF
// source, a text file, a Word file migrated without its original — used to
// have no Word export at all. It now offers "New Word document", built from
// the lines. A Word file with its original keeps the round-trip Word export
// and is not offered the new one, so there is only ever one Word choice.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"
import { extractDocxStrings } from "@/lib/parsers/docx"

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

const CELLS = [
  { id: "c1", fileId: "f1", original: "Chapter One", translated: "Capítulo uno", type: "heading", context: "Heading 1", group: "", paragraphStart: true },
  { id: "c2", fileId: "f1", original: "First line.", translated: "Primera línea.", type: "text", context: "Paragraph", group: "", paragraphStart: true },
  { id: "c3", fileId: "f1", original: "Second line.", translated: "Segunda línea.", type: "text", context: "Paragraph", group: "" },
] as CellData[]

function props(type: string, name: string, hasOriginal: boolean | undefined) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    cells: CELLS,
    projectId: "p1",
    projectName: "Notes",
    activeFileId: "f1",
    activeFileName: name,
    activeFileType: type,
    activeFileHasOriginalSource: hasOriginal,
    projectFiles: [{ id: "f1", name, type }],
    targetLanguage: "es",
    getToken: async () => "token",
  }
}

const radio = (label: RegExp) => screen.queryByRole("radio", { name: label })

function openFoldIfClosed() {
  if (screen.queryByRole("radiogroup", { name: "Export format" })) return
  fireEvent.click(screen.getByText("Export to another format"))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — New Word document from the lines (AQU-2551)", () => {
  it("a PDF source offers it, and it downloads a Word document of the lines", async () => {
    render(<ExportDialog {...props("pdf", "notes.pdf", true)} />)
    // a PDF has no same-format download: the format list is open
    expect(screen.queryByRole("button", { name: /^Download /i })).not.toBeInTheDocument()
    const option = radio(/^New Word document \(\.docx\)/)
    expect(option).not.toBeNull()
    expect(radio(/^Word \(\.docx\)/)).toBeNull()
    fireEvent.click(option!)
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    const [blob, fileName] = mockDownload.mock.calls[0] as [Blob, string]
    expect(fileName).toBe("notes.docx")
    const back = await extractDocxStrings(await blob.arrayBuffer(), { cellUnit: "paragraph" })
    expect(back.map((s) => [s.type, s.original])).toEqual([
      ["heading", "Capítulo uno"],
      ["text", "Primera línea. Segunda línea."],
    ])
  })

  it.each([
    ["txt", "story.txt", true],
    ["docx", "notes.docx", false],
  ] as const)("a %s file with no Word original to write into offers it", (type, name, hasOriginal) => {
    render(<ExportDialog {...props(type, name, hasOriginal)} />)
    openFoldIfClosed()
    expect(radio(/^New Word document \(\.docx\)/)).not.toBeNull()
  })

  // Review finding: a remembered "New Word document" used to stay selected,
  // hidden, on a Word file with its original, so Export wrote the lines
  // document instead of the round trip.
  it("a remembered New Word document is not carried to a Word file that has its original", () => {
    // the workspace keeps the dialog mounted and toggles `open`
    const pdf = { ...props("pdf", "notes.pdf", true), activeFileId: "f-pdf" }
    const word = { ...props("docx", "notes.docx", true), activeFileId: "f-word" }
    const { rerender } = render(<ExportDialog {...pdf} />)
    fireEvent.click(radio(/^New Word document \(\.docx\)/)!)
    rerender(<ExportDialog {...pdf} open={false} />)
    rerender(<ExportDialog {...word} open={false} />)
    rerender(<ExportDialog {...word} />)
    openFoldIfClosed()
    expect(radio(/^Word \(\.docx\)/)).toBeChecked()
  })

  it("a Word file with its original keeps the round-trip Word export and is not offered the new one", () => {
    render(<ExportDialog {...props("docx", "notes.docx", true)} />)
    openFoldIfClosed()
    expect(radio(/^Word \(\.docx\)/)).not.toBeNull()
    expect(radio(/^New Word document/)).toBeNull()
  })
})
