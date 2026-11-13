// AQU-465: chapter scope — the middle ground between "current file" and
// "whole project". WHY these guards: the picker must not appear where it means
// nothing (a one-chapter file, a package format that reinjects into the
// original document), a chapter left over from another file must not silently
// export an empty document, and the primary "Download <file>" action must keep
// handing back the WHOLE file whatever the fold is showing.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import { pickSelectOption } from "@/test-utils/select"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({
  downloadBlob: vi.fn(),
}))
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: vi.fn(),
}))
// AQU-2561: USFM is exported by the worker, so what the dialog contributes is
// the request. Only that one call is replaced; the rest of the module is real.
vi.mock("@/lib/sync/source-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/source-export")>()),
  downloadSourceFile: vi.fn(async () => ({ lossyVerseCount: 0 })),
}))

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"
import { downloadSourceFile } from "@/lib/sync/source-export"

const mockDownload = vi.mocked(downloadBlob)
const mockSourceDownload = vi.mocked(downloadSourceFile)
const mockProjectCells = vi.mocked(useProjectCells)

function cell(id: string, group: string, translated: string): CellData {
  return {
    id,
    fileId: "f-txt",
    original: `source ${id}`,
    translated,
    context: "",
    group,
  } as CellData
}

/** Two chapters, so there is something to choose between. */
const TWO_CHAPTER_CELLS = [
  cell("c1", "GEN 1:1", "in the beginning"),
  cell("c2", "GEN 1:2", "and the earth"),
  cell("c3", "GEN 2:1", "thus the heavens"),
]

const PROJECT_FILES = [
  { id: "f-txt", name: "notes.txt", type: "txt" },
  { id: "f-other", name: "other.txt", type: "txt" },
  { id: "f-usfm", name: "gen.usfm", type: "usfm" },
  { id: "f-docx", name: "gen.docx", type: "docx" },
]

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  cells: TWO_CHAPTER_CELLS,
  projectId: "p1",
  projectName: "Chapter scope",
  activeFileId: "f-txt",
  activeFileName: "notes.txt",
  activeFileType: "txt",
  projectFiles: PROJECT_FILES,
  targetLanguage: "es",
  getToken: async () => null,
}

// Base UI's Select commits on the keyboard path under happy-dom; a plain click
// on an option inside a modal Dialog does not (see AssignModal.test.tsx).
async function pickChapter(label: string) {
  const trigger = await pickSelectOption(
    /filter export by chapter/i,
    new RegExp(`^${label}$`),
  )
  // The trigger carries a chevron glyph alongside the label, so match on
  // containment rather than the whole string.
  await waitFor(() => expect(trigger.textContent).toContain(label))
}

/** Open the "Export to another format" fold on a cell-array format. */
function openFoldAsMarkdown() {
  fireEvent.click(screen.getByText("Export to another format"))
  fireEvent.click(screen.getByText("Markdown"))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — chapter scope (AQU-465)", () => {
  it("exports only the chosen chapter and names the file after it", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsMarkdown()
    await pickChapter("GEN 2")

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    const [blob, name] = mockDownload.mock.calls[0] as [Blob, string]
    const text = await blob.text()
    expect(text).toContain("thus the heavens")
    expect(text).not.toContain("in the beginning")
    expect(text).not.toContain("and the earth")
    // The chapter is in the filename — two chapters of one file must not both
    // land as `notes.md`.
    expect(name).toBe("notes_GEN-2.md")
  })

  it("reads 'All chapters' until a chapter is chosen, and again once it is unpicked", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsMarkdown()
    const trigger = screen.getByRole("combobox", { name: /filter export by chapter/i })
    // Base UI resolves the trigger label from the root's `items`; the ""
    // option has no value text of its own to fall back on, so this was blank.
    expect(trigger.textContent).toContain("All chapters")

    await pickChapter("GEN 2")
    expect(trigger.textContent).not.toContain("All chapters")

    await pickChapter("All chapters")
    expect(trigger.textContent).toContain("All chapters")
  })

  it("exports the whole file when no chapter is chosen", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsMarkdown()

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    const [blob, name] = mockDownload.mock.calls[0] as [Blob, string]
    const text = await blob.text()
    expect(text).toContain("in the beginning")
    expect(text).toContain("thus the heavens")
    expect(name).toBe("notes.md")
  })

  it("offers no chapter picker when the file has only one chapter", () => {
    render(<ExportDialog {...BASE_PROPS} cells={[cell("c1", "GEN 1:1", "only chapter")]} />)
    openFoldAsMarkdown()
    expect(screen.queryByRole("combobox", { name: /filter export by chapter/i })).toBeNull()
  })

  it("offers no chapter picker when the file has no chapter refs at all", () => {
    render(<ExportDialog {...BASE_PROPS} cells={[cell("c1", "", "a"), cell("c2", "", "b")]} />)
    openFoldAsMarkdown()
    expect(screen.queryByRole("combobox", { name: /filter export by chapter/i })).toBeNull()
  })

  it("offers no chapter picker for a package format that reinjects the original", () => {
    render(<ExportDialog {...BASE_PROPS} activeFileId="f-docx" activeFileName="gen.docx" activeFileType="docx" />)
    fireEvent.click(screen.getByText("Export to another format"))
    // DOCX is preselected for a DOCX file; a one-chapter .docx would mean
    // rebuilding the package rather than exporting it.
    expect(screen.getByRole("radio", { name: /DOCX|Word/i })).toBeChecked()
    expect(screen.queryByRole("combobox", { name: /filter export by chapter/i })).toBeNull()
  })

  // AQU-2561. USFM reinjects into the original too, but that original is plain
  // text, so the worker can cut a chapter out of it. The dialog's part is to
  // ask for the right chapter NUMBER, name the file after it, and never let
  // the primary action hand back less than the whole file.
  it("asks the worker for the chosen chapter of a USFM file and names the file after it", async () => {
    render(<ExportDialog {...BASE_PROPS} activeFileId="f-usfm" activeFileName="gen.usfm" activeFileType="usfm" />)
    fireEvent.click(screen.getByText("Export to another format"))
    expect(screen.getByRole("radio", { name: /USFM/i })).toBeChecked()
    await pickChapter("GEN 2")

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockSourceDownload).toHaveBeenCalledTimes(1))
    expect(mockSourceDownload.mock.calls[0][0]).toMatchObject({
      fileId: "f-usfm",
      chapter: 2,
      downloadName: "gen_GEN-2.SFM",
    })

    fireEvent.click(screen.getByRole("button", { name: /^Download gen\.SFM$/i }))
    await waitFor(() => expect(mockSourceDownload).toHaveBeenCalledTimes(2))
    const whole = mockSourceDownload.mock.calls[1][0]
    expect(whole.downloadName).toBe("gen.SFM")
    expect(whole).not.toHaveProperty("chapter")
  })

  it("offers no USFM chapter picker when a chapter number names more than one chapter", () => {
    // Several books in one file: "chapter 1" is both GEN 1 and EXO 1, and the
    // worker addresses a chapter by number alone.
    render(
      <ExportDialog
        {...BASE_PROPS}
        activeFileId="f-usfm"
        activeFileName="gen.usfm"
        activeFileType="usfm"
        cells={[cell("c1", "GEN 1:1", "in the beginning"), cell("c2", "EXO 1:1", "these are the names")]}
      />,
    )
    fireEvent.click(screen.getByText("Export to another format"))
    expect(screen.getByRole("radio", { name: /USFM/i })).toBeChecked()
    expect(screen.queryByRole("combobox", { name: /filter export by chapter/i })).toBeNull()
  })

  it("drops a chapter left over from the previous file instead of exporting nothing", async () => {
    const { rerender } = render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsMarkdown()
    await pickChapter("GEN 2")

    // Switch files while the dialog stays mounted, as ProjectWorkspace does.
    // The new file's chapters are different ones entirely.
    rerender(
      <ExportDialog
        {...BASE_PROPS}
        activeFileId="f-other"
        activeFileName="other.txt"
        cells={[cell("d1", "EXO 1:1", "these are the names"), cell("d2", "EXO 2:1", "a man of levi")]}
      />,
    )
    openFoldAsMarkdown()

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    const [blob, name] = mockDownload.mock.calls[0] as [Blob, string]
    const text = await blob.text()
    expect(text).toContain("these are the names")
    expect(text).toContain("a man of levi")
    expect(name).toBe("other.md")
  })

  it("keeps the primary file download whole even while a chapter is chosen", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    openFoldAsMarkdown()
    await pickChapter("GEN 2")

    fireEvent.click(screen.getByRole("button", { name: /^Download notes\.txt$/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    const [blob, name] = mockDownload.mock.calls[0] as [Blob, string]
    const text = await blob.text()
    expect(text).toContain("in the beginning")
    expect(text).toContain("thus the heavens")
    expect(name).toBe("notes.txt")
  })
})
