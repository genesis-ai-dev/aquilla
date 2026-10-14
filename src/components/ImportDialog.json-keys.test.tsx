/**
 * AQU-525 — a JSON source file reaches the key picker.
 *
 * WHY: the gap Waha hit was at the entry point — dropping a `.json` file on
 * the general uploader silently flattened every string in the document into
 * cells, with no way to say which keys hold translatable text. The hand-off
 * tested here is what makes the picker reachable at all, so it is worth a test
 * of its own: a lone JSON file routes to the picker, and the two cases that
 * must NOT be hijacked (a multi-file drop, and a file that only claims to be
 * JSON) still take the old path.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent } from "@testing-library/react"

// ── heavy deps ImportDialog pulls in ─────────────────────────────────────────
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
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

import { ImportDialog } from "./ImportDialog"
import { prepareImportFile } from "@/lib/import"

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-525",
  username: "matthew",
  sourceLanguage: "eng",
  targetLanguage: "spa",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

const LOCALE_JSON = JSON.stringify({ app: { title: "My App" }, legal: "All rights reserved" })

function jsonFile(content = LOCALE_JSON, name = "en.json"): File {
  return new File([content], name, { type: "application/json" })
}

/** Open the general uploader and hand it `files`. */
async function dropFiles(files: File[]) {
  fireEvent.click(screen.getByText("Upload files"))
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(input, "files", { value: files, configurable: true })
    fireEvent.change(input)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe("AQU-525 — JSON files route to the key picker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.mocked(prepareImportFile).mockResolvedValue({ fileType: "txt", results: [] } as never)
  })

  it("a lone JSON file opens the key picker instead of importing every string", async () => {
    render(<ImportDialog {...BASE_PROPS} />)
    await dropFiles([jsonFile()])

    expect(await screen.findByText("Choose which keys to translate")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "app.title" })).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "legal" })).toBeInTheDocument()
    // Nothing was parsed down the old path.
    expect(prepareImportFile).not.toHaveBeenCalled()
  })

  it("keeps the previous behavior for a multi-file drop, so bulk imports still work", async () => {
    render(<ImportDialog {...BASE_PROPS} />)
    await dropFiles([jsonFile(), jsonFile(LOCALE_JSON, "fr.json")])

    expect(screen.queryByText("Choose which keys to translate")).not.toBeInTheDocument()
    expect(prepareImportFile).toHaveBeenCalled()
  })

  it("does not hijack a file named .json that is not JSON — the normal pipeline reports it", async () => {
    render(<ImportDialog {...BASE_PROPS} />)
    await dropFiles([jsonFile("this is not json at all", "broken.json")])

    expect(screen.queryByText("Choose which keys to translate")).not.toBeInTheDocument()
    expect(prepareImportFile).toHaveBeenCalled()
  })
})
