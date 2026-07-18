/**
 * AQU-430 — Import progress visible after Confirm
 * AQU-431 — .doc file acceptance
 *
 * AQU-430 WHY: Before the fix, clicking "Confirm import" in PreviewPanel switched
 * the button to "Uploading…" but showed no further progress; the dialog appeared
 * frozen because UploadPanel (where phase/progress state lives) was unmounted
 * during the preview screen. The fix surfaces phase+progress from UploadPanel's
 * doCommit to ImportDialog, which forwards them as props to PreviewPanel. After
 * clicking Confirm, the preview list is replaced by an in-progress view with the
 * phase label and (when cell counts are available) a progress bar.
 *
 * AQU-431 WHY: The file picker and detectFileType() only accepted ".docx"; users
 * with ".doc" files were silently unable to import without manual conversion. The
 * fix maps ".doc" → "docx" in detectFileType() and adds ".doc" to the file
 * picker's accept attribute. True legacy OLE2 .doc files may still fail at parse
 * time (JSZip will reject them), but the extension gate no longer blocks them.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent } from "@testing-library/react"

// ── heavy deps that ImportDialog imports ──────────────────────────────────────
vi.mock("@/lib/import", () => ({
  importFile: vi.fn(),
  importEBible: vi.fn(),
  importMacula: vi.fn(),
  importTranslationNotes: vi.fn(),
  prepareParatextProject: vi.fn(),
  commitParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  prepareEBibleTargetImport: vi.fn(),
  applyEBibleTargetImport: vi.fn(),
  // AQU-310: parseFile is called during the parse phase before preview.
  parseFile: vi.fn(async () => [
    { name: "test.docx", strings: [{ id: "s1", original: "Hello world", context: "Paragraph", group: "1" }] },
  ]),
}))
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({
  filesToProjectEntries: vi.fn(async () => []),
}))
vi.mock("@/lib/parsers/paratext-project", () => ({
  detectParatextProject: vi.fn(() => null),
}))
vi.mock("@/lib/parsers/ebible", () => ({
  fetchTranslationsList: vi.fn(async () => []),
  fetchTranslationText: vi.fn(async () => ""),
  parseEBibleCorpus: vi.fn(() => []),
}))
vi.mock("uuid", () => ({ v7: () => "mock-uuid" }))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

import { ImportDialog } from "./ImportDialog"
import { importFile, parseFile } from "@/lib/import"
import { filesToProjectEntries } from "@/lib/import/file-entries"
import { detectParatextProject } from "@/lib/parsers/paratext-project"
import { detectFileType } from "@/lib/parsers/types"

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-fro430",
  username: "consultant",
  sourceLanguage: "hbo",
  targetLanguage: "spa",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

/** Set up mocks for a single non-Paratext text file upload. */
function setupTextFileMocks() {
  vi.mocked(filesToProjectEntries).mockResolvedValue([])
  vi.mocked(detectParatextProject).mockReturnValue(null)
  vi.mocked(importFile).mockResolvedValue({ refs: [{ fileId: "new-ref" } as never], speakerPairs: [] })
}

/** Navigate to Upload panel and drop a file, then wait for preview. */
async function dropFileAndWaitForPreview(file: File) {
  // Use case-insensitive regex — card title is "Upload files" (lowercase 'f')
  fireEvent.click(screen.getByText(/upload files/i))

  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
    fireEvent.change(fileInput)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })

  // Wait for preview panel heading (contains cell count info)
  await screen.findByText(/preview.*cell/i)
}

// ── AQU-430 tests ────────────────────────────────────────────────────────────

describe("AQU-430 — import progress visible after Confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupTextFileMocks()
  })

  it("Confirm button becomes disabled immediately after click (no double-submit)", async () => {
    // importFile never resolves so we can check the in-flight state
    vi.mocked(importFile).mockReturnValue(new Promise(() => {}))

    const file = new File(["content"], "test.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
    render(<ImportDialog {...baseProps} />)

    await dropFileAndWaitForPreview(file)

    const confirmBtn = screen.getByRole("button", { name: /confirm import/i })
    await act(async () => {
      fireEvent.click(confirmBtn)
      await new Promise((r) => setTimeout(r, 0))
    })

    // Confirm button must be gone (in-progress view replaces the preview list)
    // OR it must be disabled — either way, a second click must not trigger.
    const btnAfter = screen.queryByRole("button", { name: /confirm import/i })
    if (btnAfter) {
      expect(btnAfter).toBeDisabled()
    }
    // The in-progress phase label must be visible instead of the file list
    const phase = screen.queryByTestId("preview-upload-phase")
    // After clicking confirm, we should be in the in-progress state:
    // either a phase label or the uploading text is shown
    expect(
      phase ?? screen.queryByText(/uploading/i)
    ).not.toBeNull()
  })

  it("shows in-progress view (not preview list) after Confirm is clicked", async () => {
    // importFile resolves after a tick so we can check the transitional state
    let resolveImport: () => void
    vi.mocked(importFile).mockReturnValue(
      new Promise<{ refs: never[]; speakerPairs: never[] }>((resolve) => {
        resolveImport = () => resolve({ refs: [], speakerPairs: [] })
      })
    )

    const file = new File(["x"], "chapter.txt", { type: "text/plain" })
    render(<ImportDialog {...baseProps} />)
    await dropFileAndWaitForPreview(file)

    // Preview list is visible — cell count heading should be present
    expect(screen.getByText(/preview.*cell/i)).toBeInTheDocument()

    // Click Confirm
    const confirmBtn = screen.getByRole("button", { name: /confirm import/i })
    await act(async () => {
      fireEvent.click(confirmBtn)
      await new Promise((r) => setTimeout(r, 0))
    })

    // After clicking Confirm, the preview list disappears and the in-progress
    // view is shown. The "Confirm import" button should no longer be present
    // (it is replaced by the progress overlay).
    expect(screen.queryByRole("button", { name: /confirm import/i })).toBeNull()

    // Resolve the upload
    await act(async () => {
      resolveImport!()
      await new Promise((r) => setTimeout(r, 0))
    })
  })

  it("Cancel button is not present during in-flight upload", async () => {
    // importFile never resolves so we stay in-flight
    vi.mocked(importFile).mockReturnValue(new Promise(() => {}))

    const file = new File(["x"], "doc.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
    render(<ImportDialog {...baseProps} />)
    await dropFileAndWaitForPreview(file)

    const confirmBtn = screen.getByRole("button", { name: /confirm import/i })
    await act(async () => {
      fireEvent.click(confirmBtn)
      await new Promise((r) => setTimeout(r, 0))
    })

    // Once in-flight, the Cancel button must be gone (user can't cancel mid-upload)
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull()
  })
})

// ── AQU-431 tests ────────────────────────────────────────────────────────────

describe("AQU-431 — .doc file acceptance", () => {
  it("detectFileType maps .doc extension to 'docx' type", () => {
    expect(detectFileType("myfile.doc")).toBe("docx")
  })

  it("detectFileType still maps .docx to 'docx' (regression guard)", () => {
    expect(detectFileType("document.docx")).toBe("docx")
  })

  it("file picker accept attribute includes .doc", () => {
    vi.clearAllMocks()
    setupTextFileMocks()

    render(<ImportDialog {...baseProps} />)

    // Navigate to upload screen (card title is "Upload files" with lowercase 'f')
    fireEvent.click(screen.getByText(/upload files/i))

    // The Choose Files input should accept .doc
    const fileInputs = document.querySelectorAll('input[type="file"]')
    const hasDocAccept = Array.from(fileInputs).some((inp) =>
      (inp as HTMLInputElement).accept.includes(".doc")
    )
    expect(hasDocAccept).toBe(true)
  })

  it(".doc file is routed through parseFile as 'docx' type", async () => {
    vi.clearAllMocks()
    setupTextFileMocks()

    const docFile = new File(["fake doc content"], "legacy.doc", { type: "application/msword" })
    render(<ImportDialog {...baseProps} />)

    await dropFileAndWaitForPreview(docFile)

    // parseFile must have been called (the .doc is treated like a docx in the parse phase)
    expect(parseFile).toHaveBeenCalled()
    // The file passed to parseFile should be our .doc file
    const calls = vi.mocked(parseFile).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    // The file type arg should be 'docx'
    expect(calls[0][1]).toBe("docx")
  })
})
