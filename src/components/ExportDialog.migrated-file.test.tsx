// AQU-2211: a file migrated from Codex now carries the type it had there
// ("usfm", "docx", …) but, unlike a file imported into Aquilla, no original
// upload (AQU-991). The round-trip exports write the translation INTO that
// upload, so for such a file they could only 404 — the dialog must not offer
// them, as a primary download or in the format list. A file that does have its
// original keeps them, and one the server has not described yet is treated as
// before. Formats built from the cells are untouched either way.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({
  downloadBlob: vi.fn(),
}))
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: vi.fn(),
}))

import { useProjectCells } from "@/hooks/useProjectCells"

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

function props(type: string, name: string, hasOriginal: boolean | undefined) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    cells: [cell("c1", "hola")],
    projectId: "p1",
    projectName: "Migrated",
    activeFileId: "f1",
    activeFileName: name,
    activeFileType: type,
    activeFileHasOriginalSource: hasOriginal,
    projectFiles: [{ id: "f1", name, type }],
    targetLanguage: "es",
    getToken: async () => "token",
  }
}

const formatRadio = (label: RegExp) => screen.queryByRole("radio", { name: label })

/** A type with a native download keeps the fold closed until it is opened. */
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

describe("ExportDialog — a migrated file has no original upload (AQU-2211)", () => {
  it.each([
    ["usfm", "MAT", /^USFM/],
    ["docx", "Bible_Translation_Story", /^Word \(\.docx\)/],
  ])("%s file without its original: no primary download, format hidden, list open", (type, name, radio) => {
    render(<ExportDialog {...props(type, name, false)} />)
    expect(screen.queryByRole("button", { name: /^Download /i })).not.toBeInTheDocument()
    // The conversion section is expanded so the user still has options…
    expect(screen.getByRole("radiogroup", { name: "Export format" })).toBeVisible()
    // …built from the cells, not from the upload the file does not have.
    expect(formatRadio(radio)).toBeNull()
    expect(formatRadio(/^Markdown/)).not.toBeNull()
  })

  it("the same file with its original keeps the primary download and the format", () => {
    render(<ExportDialog {...props("docx", "notes.docx", true)} />)
    expect(screen.getByRole("button", { name: /^Download notes/i })).toBeInTheDocument()
    openFoldIfClosed()
    expect(formatRadio(/^Word \(\.docx\)/)).not.toBeNull()
  })

  it("a file the server has not described yet is offered as before", () => {
    render(<ExportDialog {...props("usfm", "rut.usfm", undefined)} />)
    expect(screen.getByRole("button", { name: /^Download rut/i })).toBeInTheDocument()
    openFoldIfClosed()
    expect(formatRadio(/^USFM/)).not.toBeNull()
  })

  it("a native format built from the cells does not need the original", () => {
    render(<ExportDialog {...props("md", "README.md", false)} />)
    expect(screen.getByRole("button", { name: /^Download README/i })).toBeInTheDocument()
  })
})
