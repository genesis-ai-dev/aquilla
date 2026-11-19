// AQU-2680 (question 54, Sam's decision Nov 19): wherever Export offers "New
// Word document", it also offers "PDF". The PDF opens in the browser's print
// window with one line saying to choose "Save as PDF". Where this browser
// cannot print, the Word file is saved with the sentence on saving it as PDF
// from Word.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))
vi.mock("@/lib/export/print-window", () => ({ printHtml: vi.fn() }))

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"
import { printHtml } from "@/lib/export/print-window"

const mockDownload = vi.mocked(downloadBlob)
const mockPrint = vi.mocked(printHtml)

const CELLS = [
  { id: "c1", fileId: "f1", original: "Chapter One", translated: "Capítulo uno", type: "heading", context: "Heading 1", group: "", paragraphStart: true },
  { id: "c2", fileId: "f1", original: "First line.", translated: "Primera línea.", type: "text", context: "Paragraph", group: "", paragraphStart: true },
] as CellData[]

function props(type: string, name: string, hasOriginal: boolean | undefined) {
  return {
    open: true, onOpenChange: vi.fn(), cells: CELLS, projectId: "p1", projectName: "Notes",
    activeFileId: "f1", activeFileName: name, activeFileType: type, activeFileHasOriginalSource: hasOriginal,
    projectFiles: [{ id: "f1", name, type }], targetLanguage: "es", getToken: async () => "token",
  }
}

const CHOOSE = 'In the print window, choose "Save as PDF" to save the file.'
const radio = (label: RegExp) => screen.queryByRole("radio", { name: label })
function openFoldIfClosed() {
  if (screen.queryByRole("radiogroup", { name: "Export format" })) return
  fireEvent.click(screen.getByText("Export to another format"))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(useProjectCells).mockReturnValue({ files: [], isLoading: false, isTruncated: false } as unknown as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog: PDF from the print window (AQU-2680)", () => {
  it.each([
    ["pdf", "notes.pdf", true],
    ["txt", "story.txt", true],
    ["docx", "notes.docx", false],
  ] as const)("a %s file offered New Word document is offered PDF too", (type, name, hasOriginal) => {
    render(<ExportDialog {...props(type, name, hasOriginal)} />)
    openFoldIfClosed()
    expect(radio(/^New Word document \(\.docx\)/)).not.toBeNull()
    expect(radio(/^PDF \(\.pdf\)/)).not.toBeNull()
  })

  it("a Word file with its original is not offered it, as it is not offered New Word document", () => {
    render(<ExportDialog {...props("docx", "notes.docx", true)} />)
    openFoldIfClosed()
    expect(radio(/^PDF \(\.pdf\)/)).toBeNull()
  })

  it("opens the lines in the print window and says to choose Save as PDF, downloading nothing", async () => {
    mockPrint.mockResolvedValue(true)
    render(<ExportDialog {...props("pdf", "notes.pdf", true)} />)
    fireEvent.click(radio(/^PDF \(\.pdf\)/)!)
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(screen.getByText(CHOOSE)).toBeInTheDocument())
    const [page] = mockPrint.mock.calls[0] as [string]
    expect(page).toContain("<title>notes</title>")
    expect(page).toContain("<h1>Capítulo uno</h1>")
    expect(page).toContain('<html lang="es">')
    expect(mockDownload).not.toHaveBeenCalled()
  })

  // AQU-2680 re-check finding 5: Chrome's print window holds the page until
  // it closes, so the message is on screen before it opens, worded to be
  // true before and after.
  it("shows the Save as PDF message before the print window opens", async () => {
    let shownBeforePrint = false
    mockPrint.mockImplementation(async (_page, options) => {
      options?.beforePrint?.()
      shownBeforePrint = screen.queryByText(CHOOSE) !== null
      return true
    })
    render(<ExportDialog {...props("pdf", "notes.pdf", true)} />)
    fireEvent.click(radio(/^PDF \(\.pdf\)/)!)
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockPrint).toHaveBeenCalled())
    expect(shownBeforePrint).toBe(true)
  })

  // AQU-2680 re-check finding 3: Gmail, Slack, X, LinkedIn and Telegram on
  // iPhone have no print and don't say so; the Word file is always one click
  // away beside the print message, so nobody is stuck.
  it("offers the Word file beside the print message", async () => {
    mockPrint.mockResolvedValue(true)
    render(<ExportDialog {...props("pdf", "notes.pdf", true)} />)
    fireEvent.click(radio(/^PDF \(\.pdf\)/)!)
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    const word = await screen.findByRole("button", { name: "Or download the Word file" })
    expect(mockDownload).not.toHaveBeenCalled()
    fireEvent.click(word)
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    expect(mockDownload.mock.calls[0][1]).toBe("notes.docx")
    expect((mockDownload.mock.calls[0][0] as Blob).type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  })

  it("saves the Word file with the sentence on saving it as PDF where this browser cannot print", async () => {
    mockPrint.mockResolvedValue(false)
    render(<ExportDialog {...props("pdf", "notes.pdf", true)} />)
    fireEvent.click(radio(/^PDF \(\.pdf\)/)!)
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    expect(mockDownload.mock.calls[0][1]).toBe("notes.docx")
    expect(await screen.findByText("Printing isn't available here, so this is the Word file. Save it as PDF from Word or Pages, or open this page in Safari or Chrome.")).toBeInTheDocument()
  })
})
