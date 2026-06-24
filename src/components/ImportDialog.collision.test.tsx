/**
 * FRO-287 — Collision guard choice plumbing.
 *
 * WHY each test matters:
 *  1. When a file collides with an existing project file, onCollision is invoked
 *     instead of immediately importing — the guard intercepts the upload.
 *  2. Choosing "Skip" for all collisions results in importFile NOT being called
 *     (the file is silently dropped, matching the "skip" label).
 *  3. Choosing "Import as duplicate" for all collisions results in importFile
 *     being called (current behavior, now explicit).
 *  4. Fresh-project import (empty existingFiles) bypasses the guard entirely —
 *     no collision screen, importFile is called directly.
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
  importParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  prepareEBibleTargetImport: vi.fn(),
  applyEBibleTargetImport: vi.fn(),
  // FRO-310: preview phase parses client-side before commit
  parseFile: vi.fn(async () => [
    { name: "genesis.usfm", strings: [{ id: "s1", original: "content" }] },
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
import { importFile } from "@/lib/import"
import { filesToProjectEntries } from "@/lib/import/file-entries"
import { detectParatextProject } from "@/lib/parsers/paratext-project"

const COLLIDING_FILE = new File(["content"], "genesis.usfm", { type: "text/plain" })

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-fro287",
  username: "consultant",
  sourceLanguage: "hbo",
  targetLanguage: "spa",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

/** Set up mocks for a single-file (non-Paratext) upload collision scenario. */
function setupSingleFileMocks() {
  vi.mocked(filesToProjectEntries).mockResolvedValue([])
  vi.mocked(detectParatextProject).mockReturnValue(null)
  vi.mocked(importFile).mockResolvedValue({ refs: [{ fileId: "new-ref" } as never], speakerPairs: [] })
}

/** FRO-310: click through the preview-before-confirm screen. */
async function confirmPreview() {
  const confirmBtn = await screen.findByRole("button", { name: /confirm import/i })
  await act(async () => {
    fireEvent.click(confirmBtn)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Navigate to the Upload panel and drop the colliding file. */
async function dropCollidingFile() {
  // Landing-screen card title (the upload-screen header keeps the "Upload Files" casing).
  fireEvent.click(screen.getByText("Upload files"))

  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(fileInput, "files", {
      value: [COLLIDING_FILE],
      configurable: true,
    })
    fireEvent.change(fileInput)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe("FRO-287 — collision guard intercepts re-imports", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupSingleFileMocks()
  })

  it("shows collision screen instead of importing when file name matches existingFiles", async () => {
    render(
      <ImportDialog
        {...baseProps}
        existingFiles={[{ name: "genesis.usfm" }]}
      />,
    )

    await dropCollidingFile()

    // Collision screen should appear
    await waitFor(() => {
      expect(screen.getByText(/re-import detected/i)).toBeInTheDocument()
    })
    // importFile must NOT have been called yet
    expect(importFile).not.toHaveBeenCalled()
  })

  it("Skip choice: importFile is NOT called; onImported fires with no refs", async () => {
    const onImported = vi.fn(async () => undefined)
    const onOpenChange = vi.fn()

    render(
      <ImportDialog
        {...baseProps}
        onImported={onImported}
        onOpenChange={onOpenChange}
        existingFiles={[{ name: "genesis.usfm" }]}
      />,
    )

    await dropCollidingFile()

    // Confirm we're on collision screen (default choice is "Skip")
    await waitFor(() => expect(screen.getByText(/re-import detected/i)).toBeInTheDocument())

    // The "Skip" button for the row should already be active (default).
    // Click "Continue" to confirm the skip choice.
    const continueBtn = screen.getByRole("button", { name: /continue/i })
    await act(async () => {
      fireEvent.click(continueBtn)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })

    // importFile must NOT have been called (the file was skipped)
    expect(importFile).not.toHaveBeenCalled()
  })

  it("Import as duplicate choice: importFile IS called", async () => {
    const onImported = vi.fn(async () => undefined)

    render(
      <ImportDialog
        {...baseProps}
        onImported={onImported}
        existingFiles={[{ name: "genesis.usfm" }]}
      />,
    )

    await dropCollidingFile()

    await waitFor(() => expect(screen.getByText(/re-import detected/i)).toBeInTheDocument())

    // Click "Import as duplicate" for the colliding row
    const dupBtns = screen.getAllByRole("button", { name: /import as duplicate/i })
    // The first row-level button (not the apply-to-all)
    await act(async () => {
      fireEvent.click(dupBtns[dupBtns.length - 1])
      await new Promise((r) => setTimeout(r, 0))
    })

    // Confirm with Continue
    const continueBtn = screen.getByRole("button", { name: /continue/i })
    await act(async () => {
      fireEvent.click(continueBtn)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })

    // FRO-310: the preview screen now sits between resolution and commit
    await confirmPreview()

    // importFile must have been called (duplicate path)
    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
  })

  it("fresh project (empty existingFiles): collision screen never appears, importFile called directly", async () => {
    const onImported = vi.fn(async () => undefined)

    render(
      <ImportDialog
        {...baseProps}
        onImported={onImported}
        existingFiles={[]}
      />,
    )

    await dropCollidingFile()

    // Collision screen must NOT appear
    expect(screen.queryByText(/re-import detected/i)).toBeNull()

    // FRO-310: preview-before-confirm — commit happens after Confirm import
    await confirmPreview()

    // importFile must have been called (fresh project, no guard)
    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
  })

  it("no existingFiles prop: collision screen never appears", async () => {
    const onImported = vi.fn(async () => undefined)

    render(
      <ImportDialog
        {...baseProps}
        onImported={onImported}
        // existingFiles not passed
      />,
    )

    await dropCollidingFile()

    expect(screen.queryByText(/re-import detected/i)).toBeNull()
    await confirmPreview()
    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
  })

  it("Cancel on collision screen returns to upload panel without calling importFile", async () => {
    render(
      <ImportDialog
        {...baseProps}
        existingFiles={[{ name: "genesis.usfm" }]}
      />,
    )

    await dropCollidingFile()

    await waitFor(() => expect(screen.getByText(/re-import detected/i)).toBeInTheDocument())

    const cancelBtn = screen.getByRole("button", { name: /cancel/i })
    await act(async () => {
      fireEvent.click(cancelBtn)
      await new Promise((r) => setTimeout(r, 0))
    })

    // Should be back at upload panel (no collision heading)
    expect(screen.queryByText(/re-import detected/i)).toBeNull()
    expect(importFile).not.toHaveBeenCalled()
  })
})
