/**
 * AQU-2197 — Upload files, including "Update existing": a subtitle file whose
 * times are video frame numbers written as hundredths is flagged in the
 * preview, and the import writes the times the person chose.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"
import { parseTextFormat } from "@/lib/parsers/parse-text-formats"
import { framesAsHundredthsVtt, SAMPLE_CUE } from "@/lib/parsers/frame-timecode.fixtures"

const VTT = framesAsHundredthsVtt()

vi.mock("@/lib/import", async () => {
  const { parseTextFormat: parse } = await import("@/lib/parsers/parse-text-formats")
  const { framesAsHundredthsVtt: fixture } = await import("@/lib/parsers/frame-timecode.fixtures")
  return {
    importFile: vi.fn(),
    importEBible: vi.fn(),
    importMacula: vi.fn(),
    importTranslationNotes: vi.fn(),
    importParatextProject: vi.fn(),
    importParatextAsTarget: vi.fn(),
    prepareEBibleTargetImport: vi.fn(),
    applyEBibleTargetImport: vi.fn(),
    parseFile: vi.fn(async () => []),
    prepareImportFile: vi.fn(async () => ({
      fileType: "vtt",
      results: parse({ fileType: "vtt", text: fixture(), name: "ep101.vtt" }),
    })),
  }
})
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
vi.mock("@/lib/parsers/paratext-project", () => ({ detectParatextProject: vi.fn(() => null) }))
vi.mock("@/lib/parsers/ebible", () => ({
  fetchTranslationsList: vi.fn(async () => []),
  fetchTranslationText: vi.fn(async () => ""),
  parseEBibleCorpus: vi.fn(() => []),
}))
vi.mock("uuid", async (importOriginal) => ({ ...await importOriginal<typeof import("uuid")>(), v7: () => "mock-uuid" }))
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
  projectId: "proj-aqu2197",
  username: "lead",
  sourceLanguage: "en",
  targetLanguage: "ak",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

async function drop() {
  fireEvent.click(screen.getByText("Upload files"))
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(input, "files", { value: [new File([VTT], "ep101.vtt", { type: "text/vtt" })], configurable: true })
    fireEvent.change(input)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function confirm() {
  const button = await screen.findByRole("button", { name: /confirm import/i })
  await act(async () => {
    fireEvent.click(button)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

function sampleStartWritten(): number {
  const prepared = vi.mocked(importFile).mock.calls[0][2] as { results: { strings: { original: string; start?: number }[] }[] }
  return prepared.results[0].strings.find((s) => s.original === SAMPLE_CUE.text)!.start!
}

describe("Upload files: times written as frame numbers in hundredths (AQU-2197)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(importFile).mockResolvedValue({ refs: [{ fileId: "f" } as never], speakerPairs: [] })
  })

  it("the parse flags their kind of file (sanity)", () => {
    expect(parseTextFormat({ fileType: "vtt", text: VTT, name: "x.vtt" })[0].framesAsHundredths?.suggested).toBe("24")
  })

  it("a new file: warns in the preview and imports the times converted at 24", async () => {
    render(<ImportDialog {...baseProps} />)
    await drop()
    expect(await screen.findByTestId("frames-as-hundredths")).toBeInTheDocument()
    await confirm()
    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
    expect(sampleStartWritten()).toBeCloseTo(SAMPLE_CUE.startAt24, 6)
  })

  it("Update existing: the re-import gets the same warning and writes the converted times", async () => {
    render(<ImportDialog {...baseProps} existingFiles={[{ id: "existing-101", name: "ep101.vtt" }]} />)
    await drop()
    expect(await screen.findByRole("button", { name: "Update existing" })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(await screen.findByTestId("frames-as-hundredths")).toBeInTheDocument()
    await confirm()
    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
    expect(vi.mocked(importFile).mock.calls[0][1].reimportFileIds?.get("ep101.vtt")).toBe("existing-101")
    expect(sampleStartWritten()).toBeCloseTo(SAMPLE_CUE.startAt24, 6)
  })

  it("keeping the times writes them as delivered", async () => {
    render(<ImportDialog {...baseProps} />)
    await drop()
    fireEvent.click(await screen.findByTestId("frames-as-hundredths-keep"))
    await confirm()
    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
    expect(sampleStartWritten()).toBeCloseTo(SAMPLE_CUE.start, 6)
  })
})
