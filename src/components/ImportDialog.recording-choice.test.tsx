/**
 * AQU-2426 (Sam, Nov 3 and 5): nothing brought in is cut into lines or
 * transcribed on its own. A recording dropped with no subtitle file ends on a
 * last step — Import (whole), or Import and transcribe… with its cost
 * shown first — and Cancel imports nothing. Board 58, part 1.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const { mockImportFile } = vi.hoisted(() => ({ mockImportFile: vi.fn() }))
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
  probeMediaDurationMs: vi.fn(async () => 52 * 60_000 + 14_000),
}))
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
vi.mock("@/lib/parsers/paratext-project", () => ({ detectParatextProject: vi.fn(() => null) }))
vi.mock("@/lib/parsers/ebible", () => ({
  fetchTranslationsList: vi.fn(async () => []), fetchTranslationText: vi.fn(async () => ""), parseEBibleCorpus: vi.fn(() => []),
}))
vi.mock("uuid", () => ({ v7: () => "mock-uuid" }))

import { ImportDialog } from "./ImportDialog"
import { estimateTranscriptionCost } from "@/lib/audio/transcription-cost"
import type { PrepareTranscribeChoice } from "@/components/import/recording-choice-context"

function renderDialog(prepareTranscribeChoice?: PrepareTranscribeChoice) {
  return render(
    <ImportDialog open onOpenChange={vi.fn()} projectId="proj1" username="lee" sourceLanguage="en" targetLanguage="es"
      getToken={vi.fn(async () => "tok")} onImported={vi.fn(async () => undefined)}
      {...(prepareTranscribeChoice ? { prepareTranscribeChoice } : {})} />,
  )
}

async function dropRecordings(...names: string[]) {
  fireEvent.click(screen.getByText("Upload files"))
  const files = names.map((name) => new File([new Uint8Array([0, 1, 2])], name, { type: "audio/mpeg" }))
  const inputs = document.querySelectorAll('input[type="file"]')
  fireEvent.change(inputs[0], { target: { files } })
  await screen.findByTestId("recording-import-choice")
}

describe("the import's last step for a recording with no subtitle file (AQU-2426)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockImportFile.mockResolvedValue({ refs: [], speakerPairs: [] })
  })

  it("Import brings it in whole", async () => {
    renderDialog()
    await dropRecordings("Session 4.mp3")
    expect(screen.getByText("No subtitle file came with this recording. Bring it in whole, or transcribe it to find its lines.")).toBeInTheDocument()
    expect(mockImportFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    await waitFor(() => expect(mockImportFile).toHaveBeenCalledOnce())
    expect(mockImportFile.mock.calls[0][1]).toMatchObject({ mediaMode: "whole" })
  })

  it("Import and transcribe… shows the cost first, then imports to transcribe", async () => {
    renderDialog()
    await dropRecordings("Session 4.mp3")
    fireEvent.click(screen.getByRole("button", { name: "Import and transcribe…" }))
    // Review, Nov 9: a few more requests than minutes, sent one at a time.
    expect(await screen.findByText("About 55, one for each minute")).toBeInTheDocument()
    expect(screen.getByText("About 7 minutes")).toBeInTheDocument()
    expect(mockImportFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Transcribe and import" }))
    await waitFor(() => expect(mockImportFile).toHaveBeenCalledOnce())
    expect(mockImportFile.mock.calls[0][1]).toMatchObject({ mediaMode: "transcribe" })
  })

  it("several recordings ask once, with the total", async () => {
    renderDialog()
    await dropRecordings("Session 4.mp3", "Session 5.mp3")
    expect(screen.getByText("Import 2 recordings")).toBeInTheDocument()
    expect(screen.getByText("In all")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    await waitFor(() => expect(mockImportFile).toHaveBeenCalledTimes(2))
    for (const call of mockImportFile.mock.calls) expect(call[1]).toMatchObject({ mediaMode: "whole" })
  })

  // AQU-2344 (review, Nov 9): captions inside an .mp4 over the source ceiling
  // are not read (it would hold the whole film in memory). The film landed on
  // this step as if it had none, with nothing said.
  it("says when a film was too big to be checked for captions inside it", async () => {
    renderDialog()
    fireEvent.click(screen.getByText("Upload files"))
    const episode = new File([new Uint8Array([0, 1, 2])], "Episode 101.mp4", { type: "video/mp4" })
    Object.defineProperty(episode, "size", { value: 1.8 * 1024 * 1024 * 1024 })
    const read = vi.spyOn(episode, "arrayBuffer")
    fireEvent.change(document.querySelectorAll('input[type="file"]')[0], { target: { files: [episode] } })
    await screen.findByTestId("recording-import-choice")
    expect(read).not.toHaveBeenCalled()
    expect(screen.getByTestId("recording-import-captions-unread")).toHaveTextContent(
      "Episode 101.mp4 is over 95.0 MB, so it was not checked for captions inside it. If it has any, import them as a subtitle file along with it.",
    )
  })

  it("says nothing of the kind for a recording that was checked, or never holds captions", async () => {
    renderDialog()
    await dropRecordings("Session 4.mp3")
    expect(screen.queryByTestId("recording-import-captions-unread")).toBeNull()
  })

  it("Cancel imports nothing", async () => {
    renderDialog()
    await dropRecordings("Session 4.mp3")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByTestId("recording-import-choice")).not.toBeInTheDocument())
    expect(mockImportFile).not.toHaveBeenCalled()
  })

  it("someone who may not transcribe sees it greyed, with the reason behind a click", async () => {
    renderDialog(async (durationsMs) => ({
      block: { kind: "creditsToday" },
      cost: estimateTranscriptionCost({ durationsMs, chosenModel: "auto", onDevice: false }),
      credits: null,
    }))
    await dropRecordings("Session 4.mp3")
    expect(screen.getByRole("button", { name: "Import and transcribe…" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Why you can't transcribe here" }))
    expect(screen.getByText(/reached today's AI limit/)).toBeVisible()
  })
})
