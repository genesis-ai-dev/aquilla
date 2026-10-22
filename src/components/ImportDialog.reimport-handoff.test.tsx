/**
 * AQU-2120 — "Update existing" must update, or not be offered.
 *
 * The re-import screen defaults to "Update existing", but three paths out of
 * it ignored that answer and created a second file with the same name:
 * spreadsheets and a lone JSON document (both handed off to their own panel,
 * which never received the resolution) and media (which has no in-place
 * re-import at all).
 *
 * WHY each test matters:
 *  1. A colliding spreadsheet is handed to the column-mapping panel *with* the
 *     file it must re-import into — the hand-off is where the answer was lost.
 *  2. Same for the JSON key picker.
 *  3. Choosing Skip or Import as duplicate must still hand off no target, or
 *     every spreadsheet re-import would start overwriting.
 *  4. Media cannot be updated in place, so the screen must not offer it — a
 *     disabled button plus the reason, rather than a choice that duplicates.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"

interface CapturedPanelProps {
  reimportTarget?: { id: string; name: string } | null
}

const captured = vi.hoisted(() => ({
  spreadsheet: undefined as CapturedPanelProps | undefined,
  json: undefined as CapturedPanelProps | undefined,
}))

vi.mock("@/lib/import", () => ({
  importFile: vi.fn(),
  importEBible: vi.fn(),
  importMacula: vi.fn(),
  importTranslationNotes: vi.fn(),
  importParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  prepareEBibleTargetImport: vi.fn(),
  applyEBibleTargetImport: vi.fn(),
  parseFile: vi.fn(async () => []),
  prepareImportFile: vi.fn(async () => ({ fileType: "audio", results: [] })),
}))
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
vi.mock("@/lib/parsers/paratext-project", () => ({ detectParatextProject: vi.fn(() => null) }))
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
// The hand-off is the seam under test: stand in for both panels and record the
// props they are handed.
vi.mock("@/components/import/SpreadsheetImportPanel", () => ({
  SpreadsheetImportPanel: (props: CapturedPanelProps) => {
    captured.spreadsheet = props
    return <div>spreadsheet-panel</div>
  },
}))
vi.mock("@/components/import/JsonImportPanel", () => ({
  JsonImportPanel: (props: CapturedPanelProps) => {
    captured.json = props
    return <div>json-panel</div>
  },
}))

import { ImportDialog } from "./ImportDialog"
import { importFile } from "@/lib/import"

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-aqu2120",
  username: "consultant",
  sourceLanguage: "en",
  targetLanguage: "fra",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

/** Navigate to the Upload panel and drop one file. */
async function dropFile(file: File) {
  fireEvent.click(screen.getByText("Upload files"))
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
    fireEvent.change(fileInput)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function clickContinue() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe("AQU-2120 — the re-import choice survives the panel hand-off", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captured.spreadsheet = undefined
    captured.json = undefined
  })

  it("hands the column-mapping panel the file it must re-import into", async () => {
    render(
      <ImportDialog
        {...baseProps}
        existingFiles={[{ id: "existing-pairs", name: "pairs.csv" }]}
      />,
    )
    await dropFile(new File(["source,target\nHello,Bonjour\n"], "pairs.csv", { type: "text/csv" }))

    await waitFor(() => expect(screen.getByText(/re-import detected/i)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Update existing" })).toHaveClass("text-primary")
    await clickContinue()

    await waitFor(() => expect(screen.getByText("spreadsheet-panel")).toBeInTheDocument())
    expect(captured.spreadsheet?.reimportTarget).toEqual({ id: "existing-pairs", name: "pairs.csv" })
    expect(importFile).not.toHaveBeenCalled()
  })

  it("hands the key picker the file it must re-import into", async () => {
    render(
      <ImportDialog
        {...baseProps}
        existingFiles={[{ id: "existing-en", name: "en.json" }]}
      />,
    )
    await dropFile(new File(['{"title":"Hello"}'], "en.json", { type: "application/json" }))

    await waitFor(() => expect(screen.getByText(/re-import detected/i)).toBeInTheDocument())
    await clickContinue()

    await waitFor(() => expect(screen.getByText("json-panel")).toBeInTheDocument())
    expect(captured.json?.reimportTarget).toEqual({ id: "existing-en", name: "en.json" })
  })

  it("hands off no target when the person chooses Import as duplicate", async () => {
    render(
      <ImportDialog
        {...baseProps}
        existingFiles={[{ id: "existing-pairs", name: "pairs.csv" }]}
      />,
    )
    await dropFile(new File(["source,target\nHello,Bonjour\n"], "pairs.csv", { type: "text/csv" }))

    await waitFor(() => expect(screen.getByText(/re-import detected/i)).toBeInTheDocument())
    const duplicateButtons = screen.getAllByRole("button", { name: /import as duplicate/i })
    await act(async () => {
      fireEvent.click(duplicateButtons[duplicateButtons.length - 1])
      await new Promise((r) => setTimeout(r, 0))
    })
    await clickContinue()

    await waitFor(() => expect(screen.getByText("spreadsheet-panel")).toBeInTheDocument())
    expect(captured.spreadsheet?.reimportTarget).toBeNull()
  })

  it("does not offer an in-place update for a colliding media file", async () => {
    render(
      <ImportDialog
        {...baseProps}
        existingFiles={[{ id: "existing-media", name: "sermon.mp3" }]}
      />,
    )
    await dropFile(new File(["bytes"], "sermon.mp3", { type: "audio/mpeg" }))

    await waitFor(() => expect(screen.getByText(/re-import detected/i)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Update existing" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Update all" })).toBeDisabled()
    expect(screen.getByText(/cannot be updated in place/i)).toBeInTheDocument()
    // Skip is the default when no in-place update is possible.
    expect(screen.getByRole("button", { name: "Skip" })).toHaveClass("text-primary")
  })
})
