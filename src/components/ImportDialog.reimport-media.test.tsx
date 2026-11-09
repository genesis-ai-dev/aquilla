/**
 * A file's Re-import given a recording or a film.
 *
 * A recording or film can't replace a document's contents. Re-import used to
 * skip every step and silently make a NEW media file, leaving the file being
 * re-imported untouched with nothing said. It now says so, and imports the
 * upload as a new file only when the person asks for that.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"

vi.mock("@/lib/import", () => ({
  importFile: vi.fn(async (file: File) => ({
    refs: [{ fileId: "new-media", name: file.name, cellCount: 1 }], speakerPairs: [], skipped: [],
  })),
  importEBible: vi.fn(),
  importMacula: vi.fn(),
  importTranslationNotes: vi.fn(),
  importParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  prepareEBibleTargetImport: vi.fn(),
  applyEBibleTargetImport: vi.fn(),
  parseFile: vi.fn(async () => []),
  prepareImportFile: vi.fn(async () => ({ fileType: "audio", results: [] })),
  probeMediaDurationMs: vi.fn(async () => 60_000),
}))
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({
  filesToProjectEntries: vi.fn(async (files: File[]) => files.map((file) => ({ path: file.name, file }))),
}))
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

import { ImportDialog } from "./ImportDialog"
import { importFile } from "@/lib/import"

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-reimport-media",
  username: "lead",
  sourceLanguage: "en",
  targetLanguage: "fra",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

async function pick(file: File) {
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
    fireEvent.change(fileInput)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe("Re-import with a recording or film", () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(["Episode 1.mov", "Reading.wav", "Take.webm"])(
    "%s: says it can't replace the file, and imports nothing on its own",
    async (name) => {
      render(<ImportDialog {...baseProps} reimportTarget={{ fileId: "subs", name: "Episode 1.vtt" }} />)
      await pick(new File([new Uint8Array(16)], name))

      expect(await screen.findByTestId("reimport-media-notice")).toHaveTextContent(
        `${name} is a recording or film, so it can't replace what's in Episode 1.vtt.`,
      )
      expect(importFile).not.toHaveBeenCalled()
    },
  )

  it("imports it as a new file, with no target, when the person asks", async () => {
    render(<ImportDialog {...baseProps} reimportTarget={{ fileId: "subs", name: "Episode 1.vtt" }} />)
    const film = new File([new Uint8Array(16)], "Episode 1.mov")
    await pick(film)

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Import as a new file" }))
      await new Promise((r) => setTimeout(r, 0))
    })
    // AQU-2426: with no subtitle file, the import's last step asks first.
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Import whole recording" }))
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => expect(importFile).toHaveBeenCalledTimes(1))
    const [file, options] = vi.mocked(importFile).mock.calls[0] as unknown as [File, Record<string, unknown>]
    expect(file).toBe(film)
    expect(options).not.toHaveProperty("sidebarReimport")
    expect(screen.queryByTestId("reimport-media-notice")).not.toBeInTheDocument()
  })
})
