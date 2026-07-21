/**
 * AQU-277 — Persist partial-import report.
 *
 * WHY: When a Paratext import skips books (e.g. 16 of 66) the dialog used to
 * immediately call onImported + close, destroying the skip report before the
 * consultant could read it. The fix intercepts at handleChildImported: if
 * skippedBooks.length > 0 the dialog switches to the "result" screen and holds
 * the close until the user explicitly dismisses.
 *
 * Tests:
 *  1. Partial import (skipped > 0) → dialog stays on result screen;
 *     onImported + onOpenChange(false) NOT called until user dismisses.
 *  2. Result screen shows each skipped book + reason + "Copy report" button.
 *  3. "Copy report" calls navigator.clipboard.writeText with book names.
 *  4. Clean import (no skipped books) → onImported + close fire immediately
 *     (existing auto-close behavior unchanged).
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"

// ── heavy deps that ImportDialog imports ──────────────────────────────────────
vi.mock("@/lib/import", () => ({
  importFile: vi.fn(),
  importEBible: vi.fn(),
  importMacula: vi.fn(),
  importTranslationNotes: vi.fn(),
  // AQU-310: ParatextChoice parses on mount (prepare) and uploads on confirm (commit).
  prepareParatextProject: vi.fn(),
  commitParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  prepareEBibleTargetImport: vi.fn(),
  applyEBibleTargetImport: vi.fn(),
  prepareImportFile: vi.fn(async () => ({ fileType: "txt", results: [] })),
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
// ScrollArea uses @base-ui/react which calls getAnimations() — not in jsdom.
// Replace with a simple passthrough div to avoid unhandled-exception noise.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

import { ImportDialog } from "./ImportDialog"
import { importFile, prepareImportFile, prepareParatextProject, commitParatextProject } from "@/lib/import"
import { detectParatextProject } from "@/lib/parsers/paratext-project"
import { filesToProjectEntries } from "@/lib/import/file-entries"

const mockFile = new File(["dummy"], "Settings.xml", { type: "text/xml" })

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-fro277",
  username: "consultant",
  // Non-ambiguous languages so direction prompt is skipped.
  sourceLanguage: "hbo",
  targetLanguage: "spa",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

/** Set up mocks so a file drop detects a Paratext project and runSource()
 *  resolves with the given skipped array. */
function setupParatextMocks(skipped: { book: string; reason: string }[]) {
  vi.mocked(filesToProjectEntries).mockResolvedValue([
    { name: "Settings.xml", file: mockFile },
  ] as never)
  vi.mocked(detectParatextProject).mockReturnValue({
    sfmEntries: [{ name: "GEN.usfm", file: mockFile }],
  } as never)
  // AQU-310: the preview screen renders from the prepared plan before any upload.
  vi.mocked(prepareParatextProject).mockResolvedValue({
    project: { settings: { language: "hbo" }, bookNames: new Map(), books: [] },
    books: [
      {
        book: { fileName: "GEN.usfm", bookId: "GEN", displayName: "Genesis", corpusMarker: "OT", order: 1, rawSource: "", verseCount: 2 },
        strings: [
          { id: "s1", original: "In the beginning", translated: "", context: "GEN 1:1", group: "GEN 1:1" },
          { id: "s2", original: "And the earth", translated: "", context: "GEN 1:2", group: "GEN 1:2" },
        ],
        duplicateRefs: [],
        cellCount: 2,
      },
    ],
  } as never)
  vi.mocked(commitParatextProject).mockResolvedValue({
    refs: [{ fileId: "f1" }] as never,
    settings: { language: "hbo" },
    skipped,
  } as never)
}

/** Navigate: open → Upload Files → (mocked) Paratext choice → Source text */
async function navigateToRunSource() {
  // Click the "Upload files" landing card
  fireEvent.click(screen.getByText("Upload files"))

  // Trigger file input change → handleFiles → detectParatextProject returns a project
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(fileInput, "files", {
      value: [mockFile],
      configurable: true,
    })
    fireEvent.change(fileInput)
    // Allow handleFiles async work to resolve
    await new Promise((r) => setTimeout(r, 0))
  })

  // ParatextChoice "Source text" button should now be visible
  const sourceBtn = await screen.findByText("Source text")
  await act(async () => {
    fireEvent.click(sourceBtn)
    // Allow runSource to resolve
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe("AQU-277 — partial import holds dialog open", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(filesToProjectEntries).mockResolvedValue([])
    vi.mocked(detectParatextProject).mockReturnValue(null)
    vi.mocked(prepareImportFile).mockImplementation(async () => ({ fileType: "txt", results: [] }))
    // Stub clipboard
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    })
  })

  it("partial import: result screen shown; onImported and close NOT called", async () => {
    const onOpenChange = vi.fn()
    const onImported = vi.fn(async () => undefined)

    setupParatextMocks([
      { book: "Leviticus", reason: "parse error: unexpected marker" },
      { book: "Numbers", reason: "empty book body" },
    ])

    render(
      <ImportDialog {...baseProps} onOpenChange={onOpenChange} onImported={onImported} />,
    )

    await navigateToRunSource()

    // Result screen heading must be visible
    expect(
      screen.getByText(/import complete — some items skipped/i),
    ).toBeInTheDocument()

    // onImported must NOT have been called yet
    expect(onImported).not.toHaveBeenCalled()

    // Dialog must NOT have been closed
    const falseCloses = onOpenChange.mock.calls.filter(([v]) => v === false)
    expect(falseCloses).toHaveLength(0)
  })

  it("result screen lists all skipped books with reasons", async () => {
    setupParatextMocks([
      { book: "Leviticus", reason: "parse error: unexpected marker" },
      { book: "Numbers", reason: "empty book body" },
    ])

    render(<ImportDialog {...baseProps} />)
    await navigateToRunSource()

    expect(screen.getByText("Leviticus")).toBeInTheDocument()
    expect(screen.getByText(/parse error: unexpected marker/i)).toBeInTheDocument()
    expect(screen.getByText("Numbers")).toBeInTheDocument()
    expect(screen.getByText(/empty book body/i)).toBeInTheDocument()
    // Copy report button present
    expect(screen.getByRole("button", { name: /copy report/i })).toBeInTheDocument()
  })

  it("Copy report calls clipboard.writeText including book names", async () => {
    setupParatextMocks([
      { book: "Ruth", reason: "unrecognized book code RUT" },
    ])

    render(<ImportDialog {...baseProps} />)
    await navigateToRunSource()

    const copyBtn = screen.getByRole("button", { name: /copy report/i })
    await act(async () => {
      fireEvent.click(copyBtn)
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(navigator.clipboard.writeText).toHaveBeenCalledOnce()
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0] as string
    expect(text).toContain("Ruth")
    expect(text).toContain("unrecognized book code RUT")
  })

  it("AQU-310: preview gates the upload — commit fires only on confirm, with unchecked books excluded", async () => {
    setupParatextMocks([])
    render(<ImportDialog {...baseProps} />)

    fireEvent.click(screen.getByText("Upload files"))
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [mockFile], configurable: true })
      fireEvent.change(fileInput)
      await new Promise((r) => setTimeout(r, 0))
    })

    // Preview rendered from the client-side parse: book row with cell count.
    expect(await screen.findByText("Genesis")).toBeInTheDocument()
    expect(screen.getByText(/GEN · 2 cells/)).toBeInTheDocument()
    // Nothing uploaded yet — preview-before-commit.
    expect(commitParatextProject).not.toHaveBeenCalled()

    // Unchecking the only book disables both import actions.
    fireEvent.click(screen.getByLabelText("Include Genesis"))
    expect(screen.getByText("Source text").closest("button")).toBeDisabled()

    // Re-include and confirm — commit runs with no skipKeys.
    fireEvent.click(screen.getByLabelText("Include Genesis"))
    await act(async () => {
      fireEvent.click(screen.getByText("Source text"))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(commitParatextProject).toHaveBeenCalledOnce()
    const ctxArg = vi.mocked(commitParatextProject).mock.calls[0][1]
    expect([...(ctxArg.skipKeys ?? [])]).toEqual([])
  })

  it("clean import (skipped=[]) auto-closes: onImported fired, no result screen", async () => {
    setupParatextMocks([])

    const onOpenChange = vi.fn()
    const onImported = vi.fn(async () => undefined)

    render(
      <ImportDialog {...baseProps} onOpenChange={onOpenChange} onImported={onImported} />,
    )

    await navigateToRunSource()

    // Result screen must NOT appear
    expect(screen.queryByText(/import complete — some books skipped/i)).toBeNull()

    // onImported must have been called (clean path)
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())

    // onOpenChange(false) must have been called (dialog closes)
    await waitFor(() =>
      expect(onOpenChange).toHaveBeenCalledWith(false),
    )
  })

  it("reports a partial ordinary multi-file import instead of showing a generic failure", async () => {
    const first = new File(["one"], "one.txt", { type: "text/plain" })
    const second = new File(["two"], "two.txt", { type: "text/plain" })
    const third = new File(["three"], "three.txt", { type: "text/plain" })
    vi.mocked(prepareImportFile).mockImplementation(async (file) => ({
      fileType: "txt",
      results: [{
        name: file.name,
        strings: [{ id: file.name, original: file.name, translated: "", context: "", group: "", type: "text" }],
      }],
    }))
    vi.mocked(importFile)
      .mockResolvedValueOnce({
        refs: [{ id: "file-one", name: "one.txt", type: "txt", createdAt: "now", cellCount: 1 }],
        speakerPairs: [],
      })
      .mockRejectedValueOnce(new Error("source artifact upload failed"))
    const onImported = vi.fn(async () => undefined)

    render(<ImportDialog {...baseProps} onImported={onImported} />)
    fireEvent.click(screen.getByText("Upload files"))
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [first, second, third], configurable: true })
      fireEvent.change(fileInput)
    })
    fireEvent.click(await screen.findByRole("button", { name: /confirm import/i }))

    expect(await screen.findByText(/import complete — some items skipped/i)).toBeInTheDocument()
    expect(screen.getByText("two.txt")).toBeInTheDocument()
    expect(screen.getByText(/source artifact upload failed/i)).toBeInTheDocument()
    expect(screen.getByText("three.txt")).toBeInTheDocument()
    expect(screen.getByText(/not attempted after an earlier file failed/i)).toBeInTheDocument()
    expect(onImported).not.toHaveBeenCalled()
  })

  it("keeps and reports skips returned from a multi-book file import", async () => {
    const bundle = new File(["bundle"], "books.usfm", { type: "text/plain" })
    vi.mocked(prepareImportFile).mockResolvedValue({
      fileType: "usfm",
      results: [{
        name: "Genesis",
        strings: [{ id: "GEN 1:1", original: "In the beginning", translated: "", context: "GEN 1:1", group: "GEN 1:1", type: "verse" }],
      }],
    })
    vi.mocked(importFile).mockResolvedValue({
      refs: [{ id: "file-gen", name: "Genesis", type: "usfm", createdAt: "now", cellCount: 1 }],
      speakerPairs: [],
      skipped: [{ book: "Exodus", reason: "source artifact upload failed" }],
    })
    const onImported = vi.fn(async () => undefined)

    render(<ImportDialog {...baseProps} onImported={onImported} />)
    fireEvent.click(screen.getByText("Upload files"))
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [bundle], configurable: true })
      fireEvent.change(fileInput)
    })
    fireEvent.click(await screen.findByRole("button", { name: /confirm import/i }))

    expect(await screen.findByText(/import complete — some items skipped/i)).toBeInTheDocument()
    expect(screen.getByText("Exodus")).toBeInTheDocument()
    expect(screen.getByText(/source artifact upload failed/i)).toBeInTheDocument()
    expect(onImported).not.toHaveBeenCalled()
  })
})
