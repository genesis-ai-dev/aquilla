/**
 * Work Review question 122 (Nov 27, pick: yes): a recording over the film
 * bundle's 2 GB limit (AQU-2344) was still offered "Import whole recording"
 * and "Import and transcribe…", and only failed after that. It is refused the
 * moment it is picked, with the one sentence that names the limit (import map
 * D#20), read from MAX_AUDIO_OBJECT_BYTES. Nothing is measured, priced,
 * staged or uploaded first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

const { mockImportFile, mockProbe } = vi.hoisted(() => ({ mockImportFile: vi.fn(), mockProbe: vi.fn() }))
vi.mock("@/lib/posthog", () => ({
  default: { scope() { return { ...this, enabled: () => true } },
    capture: vi.fn(), captureException: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(),
  },
}))
vi.mock("@/lib/import", () => ({
  importFile: (...args: unknown[]) => mockImportFile(...args),
  importEBible: vi.fn(),
  importParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  parseFile: vi.fn(async () => []),
  probeMediaDurationMs: (...args: unknown[]) => mockProbe(...args),
}))
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
vi.mock("@/lib/parsers/paratext-project", () => ({ detectParatextProject: vi.fn(() => null) }))
vi.mock("@/lib/parsers/ebible", () => ({
  fetchTranslationsList: vi.fn(async () => []), fetchTranslationText: vi.fn(async () => ""), parseEBibleCorpus: vi.fn(() => []),
}))
vi.mock("uuid", () => ({ v7: () => "mock-uuid" }))

import { ImportDialog } from "./ImportDialog"
import { MAX_AUDIO_OBJECT_BYTES } from "@/lib/audio/upload"

const REFUSAL = "Huge 2.1GB.wav is larger than 2 GB, so it can't be imported. Save a smaller copy and import that."

function sized(name: string, size: number, type = "audio/wav"): File {
  const file = new File([new Uint8Array([0, 1, 2])], name, { type })
  Object.defineProperty(file, "size", { value: size })
  return file
}

function renderDialog(prepareTranscribeChoice = vi.fn()) {
  render(
    <ImportDialog open onOpenChange={vi.fn()} projectId="proj1" username="lee" sourceLanguage="en" targetLanguage="es"
      getToken={vi.fn(async () => "tok")} onImported={vi.fn(async () => undefined)}
      prepareTranscribeChoice={prepareTranscribeChoice} />,
  )
  fireEvent.click(screen.getByText("Upload files"))
  return prepareTranscribeChoice
}

describe("a recording over the media limit is refused when picked (question 122)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockImportFile.mockResolvedValue({ refs: [], speakerPairs: [] })
    mockProbe.mockResolvedValue(60_000)
  })

  it("from the file picker: the sentence, and no whole-or-transcribe step", async () => {
    const prepare = renderDialog()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [sized("Huge 2.1GB.wav", 2_200 * 1024 * 1024)] } })
    expect(await screen.findByText(REFUSAL)).toBeInTheDocument()
    expect(screen.queryByTestId("recording-import-choice")).toBeNull()
    expect(mockProbe).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(mockImportFile).not.toHaveBeenCalled()
  })

  it("dropped with other files: the whole drop waits, nothing comes in", async () => {
    renderDialog()
    const zone = document.querySelector('input[type="file"]')!.closest("div.border-dashed") as HTMLElement
    fireEvent.drop(zone, { dataTransfer: { files: [
      sized("Small.mp3", 3_000, "audio/mpeg"),
      sized("Huge 2.1GB.wav", 2_200 * 1024 * 1024),
    ] } })
    expect(await screen.findByText(REFUSAL)).toBeInTheDocument()
    expect(screen.queryByTestId("recording-import-choice")).toBeNull()
    expect(mockProbe).not.toHaveBeenCalled()
    expect(mockImportFile).not.toHaveBeenCalled()
  })

  it("a recording exactly at the limit still gets the last step", async () => {
    renderDialog(vi.fn(async () => { throw new Error("offline") }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [sized("At limit.wav", MAX_AUDIO_OBJECT_BYTES)] } })
    expect(await screen.findByTestId("recording-import-choice")).toBeInTheDocument()
  })
})
