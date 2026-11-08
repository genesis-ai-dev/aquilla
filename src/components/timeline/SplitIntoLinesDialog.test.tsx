// AQU-2426, board 58 part 3: Split into lines… opens on At pauses with its
// preview; At sentences, with words shows its cost, transcribes, previews the
// lines with their words; Cancel after the words keeps them on the line;
// someone who may not transcribe sees it greyed with the reason behind a click.

import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const PCM_RATE = 16_000
/** 12 s: speech 0.5–3, 4.5–7, 8.5–11.5. */
function speech(): Float32Array {
  const pcm = new Float32Array(12 * PCM_RATE)
  for (const [a, b] of [[0.5, 3], [4.5, 7], [8.5, 11.5]]) {
    for (let i = a * PCM_RATE; i < b * PCM_RATE; i++) pcm[i] = 0.5 * Math.sin(i / 3)
  }
  return pcm
}

const { transcribeLineWords } = vi.hoisted(() => ({ transcribeLineWords: vi.fn() }))
vi.mock("@/lib/audio/recording-split", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audio/recording-split")>()
  return { ...actual, loadLinePcm: vi.fn(async () => speech()), transcribeLineWords }
})
vi.mock("@/lib/audio/transcribe", () => ({ audioBytesToWhisperPcm: vi.fn(), readClipBytes: vi.fn(), transcribeAudio: vi.fn() }))

import { SplitIntoLinesDialog, type SplitIntoLinesDialogProps } from "./SplitIntoLinesDialog"
import { estimateTranscriptionCost } from "@/lib/audio/transcription-cost"

function renderDialog(over: Partial<SplitIntoLinesDialogProps> = {}) {
  const props: SplitIntoLinesDialogProps = {
    name: "Ruth 1 intro.m4a",
    startMs: 0,
    endMs: 12_000,
    durationMs: 12_000,
    audio: { projectId: "p", fileId: "f", url: "frontier-audio://p/f/clip.m4a", lo: 0, hi: 12_000 },
    session: null,
    wordsCost: estimateTranscriptionCost({ durationsMs: [12_000], chosenModel: "auto", languageTag: "en", onDevice: false }),
    block: null,
    keepsLine: false,
    onSplit: vi.fn(async () => true),
    onKeepWords: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  render(<SplitIntoLinesDialog {...props} />)
  return props
}

beforeEach(() => vi.clearAllMocks())

describe("Split into lines… (AQU-2426)", () => {
  it("opens on At pauses with its preview, and splits into the lines it shows", async () => {
    const props = renderDialog()
    expect(await screen.findByTestId("split-preview")).toBeInTheDocument()
    expect(screen.getByTestId("split-count")).toHaveTextContent("3 lines")
    fireEvent.click(screen.getByRole("button", { name: "Split into 3 lines" }))
    await waitFor(() => expect(props.onSplit).toHaveBeenCalledOnce())
    const pieces = vi.mocked(props.onSplit).mock.calls[0][0]
    expect(pieces).toHaveLength(3)
    expect(pieces[0].startMs).toBe(0)
    expect(pieces[2].endMs).toBe(12_000)
    expect(props.onClose).toHaveBeenCalled()
  })

  it("At sentences, with words shows its cost, then the lines with their words", async () => {
    transcribeLineWords.mockResolvedValue({
      words: [
        { text: "In", start: 0.5, end: 0.8 }, { text: "the", start: 0.8, end: 1.0 }, { text: "beginning.", start: 1.0, end: 2.9 },
        { text: "God", start: 4.5, end: 5.0 }, { text: "spoke.", start: 5.0, end: 7.0 },
      ],
      text: "In the beginning. God spoke.",
    })
    const props = renderDialog({ initialMode: "sentences" })
    expect(screen.getByText("Requests")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Transcribe and preview" }))
    expect(await screen.findByTestId("split-words")).toHaveTextContent("In the beginning.")
    expect(screen.getByText("Transcribed: 2 sentences found.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Split into 2 lines" }))
    await waitFor(() => expect(props.onSplit).toHaveBeenCalledOnce())
    expect(vi.mocked(props.onSplit).mock.calls[0][0].map((p) => p.text)).toEqual(["In the beginning.", "God spoke."])
  })

  it("Cancel after the words keeps them on the line", async () => {
    transcribeLineWords.mockResolvedValue({ words: [{ text: "Hello.", start: 0.5, end: 1 }], text: "Hello." })
    const props = renderDialog({ initialMode: "sentences" })
    fireEvent.click(screen.getByRole("button", { name: "Transcribe and preview" }))
    await screen.findByTestId("split-words")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(props.onKeepWords).toHaveBeenCalledWith("Hello.")
    expect(props.onSplit).not.toHaveBeenCalled()
  })

  it("someone who may not transcribe sees At sentences greyed, with the reason behind a click", async () => {
    renderDialog({ block: { kind: "import", floor: 600 }, initialMode: "sentences" })
    expect(await screen.findByTestId("split-preview")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "About At sentences, with words" }))
    expect(screen.getByText(/only people who can import files/i)).toBeVisible()
  })

  it("says so when a translation or takes are already on the line", async () => {
    renderDialog({ keepsLine: true })
    expect(screen.getByText("A translation or takes already on this line stay on the first new line.")).toBeInTheDocument()
  })
})
