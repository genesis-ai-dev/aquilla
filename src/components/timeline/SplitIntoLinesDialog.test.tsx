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
import { loadLinePcm } from "@/lib/audio/recording-split"
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

  // AQU-2426 × AQU-2375: a minute at a time, kept as it lands. A minute that
  // fails leaves no preview and no split; transcribing again sends only it.
  it("a minute that fails: says so, keeps the words so far, and the next try sends only that minute", async () => {
    localStorage.clear()
    const long = new Float32Array(130 * PCM_RATE).map((_, i) => 0.4 * Math.sin(i / 5))
    vi.mocked(loadLinePcm).mockResolvedValueOnce(long).mockResolvedValueOnce(long)
    let call = 0
    transcribeLineWords.mockImplementation(async ({ line }: { line: { lo: number } }) => {
      call++
      if (call === 2) throw new Error("HTTP 503.")
      return { words: [{ text: `Said${line.lo}.`, start: 0.5, end: 1 }], text: `Said${line.lo}.` }
    })
    const props = renderDialog({
      initialMode: "sentences", endMs: 130_000, durationMs: 130_000,
      audio: { projectId: "p", fileId: "f", url: "frontier-audio://p/f/clip.m4a", lo: 0, hi: 130_000 },
      keepAs: { cellId: "c1", audioId: "clip", fileName: "Session 4.mp3" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Transcribe and preview" }))
    expect(await screen.findByText(/2 of 3 minutes are transcribed\. The rest couldn't be: HTTP 503\./)).toBeInTheDocument()
    expect(transcribeLineWords).toHaveBeenCalledTimes(3)
    expect(screen.queryByTestId("split-words")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Transcribe and preview" }))
    expect(await screen.findByTestId("split-words")).toBeInTheDocument()
    expect(transcribeLineWords).toHaveBeenCalledTimes(4)
    transcribeLineWords.mockReset()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(vi.mocked(props.onKeepWords).mock.calls[0][0]).toMatch(/^Said0\. Said\d+\. Said\d+\.$/)
  })

  it("Cancel after a minute failed keeps the words it has on the line", async () => {
    localStorage.clear()
    const long = new Float32Array(130 * PCM_RATE).map((_, i) => 0.4 * Math.sin(i / 5))
    vi.mocked(loadLinePcm).mockResolvedValueOnce(long).mockResolvedValueOnce(long)
    transcribeLineWords.mockImplementation(async ({ line }: { line: { lo: number } }) => {
      if (line.lo > 0) throw new Error("HTTP 503.")
      return { words: [{ text: "First.", start: 0.5, end: 1 }], text: "First." }
    })
    const props = renderDialog({
      initialMode: "sentences", endMs: 130_000, durationMs: 130_000,
      audio: { projectId: "p", fileId: "f", url: "frontier-audio://p/f/clip.m4a", lo: 0, hi: 130_000 },
      keepAs: { cellId: "c1", audioId: "clip", fileName: "Session 4.mp3" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Transcribe and preview" }))
    await screen.findByText(/1 of 3 minutes are transcribed/)
    transcribeLineWords.mockReset()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(props.onKeepWords).toHaveBeenCalledWith("First.")
  })

  // AQU-2426 (review, Nov 9): the words that were paid for outlive the split,
  // so Undo (the whole line back) doesn't mean paying for them again.
  it("splitting by its words keeps the words kept", async () => {
    localStorage.clear()
    transcribeLineWords.mockResolvedValue({
      words: [
        { text: "In", start: 0.5, end: 0.8 }, { text: "the", start: 0.8, end: 1.0 }, { text: "beginning.", start: 1.0, end: 2.9 },
        { text: "God", start: 4.5, end: 5.0 }, { text: "spoke.", start: 5.0, end: 7.0 },
      ],
      text: "In the beginning. God spoke.",
    })
    const props = renderDialog({ initialMode: "sentences", keepAs: { cellId: "c1", audioId: "clip", fileName: "Ruth 1 intro.m4a" } })
    fireEvent.click(screen.getByRole("button", { name: "Transcribe and preview" }))
    await screen.findByTestId("split-words")
    fireEvent.click(screen.getByRole("button", { name: "Split into 2 lines" }))
    await waitFor(() => expect(props.onClose).toHaveBeenCalled())
    const { findLineWordsRun } = await import("@/lib/audio/transcribe-runs")
    const kept = findLineWordsRun({ projectId: "p", fileId: "f", cellId: "c1", audioId: "clip", lo: 0, hi: 12_000 })
    expect(kept?.parked).toBe(true)
    expect(kept?.line?.words.w0?.text).toBe("In the beginning. God spoke.")
  })

  // AQU-2426 / AQU-2375 (review, Nov 9): Cancel stops a transcription that is
  // still running. It used to close the dialog and send every other minute
  // unseen, then write the whole text to the line.
  it("Cancel while it transcribes stops the run: no more minutes are sent and nothing is written", async () => {
    const pcm = new Float32Array(150 * PCM_RATE)
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.4 * Math.sin(i / 5)
    vi.mocked(loadLinePcm).mockResolvedValue(pcm)
    let finishFirst: (v: { words: never[]; text: string }) => void = () => {}
    transcribeLineWords.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
    transcribeLineWords.mockResolvedValue({ words: [], text: "more." })
    const props = renderDialog({
      initialMode: "sentences", durationMs: 150_000, endMs: 150_000,
      audio: { projectId: "p", fileId: "f", url: "frontier-audio://p/f/clip.m4a", lo: 0, hi: 150_000 },
    })
    fireEvent.click(screen.getByRole("button", { name: "Transcribe and preview" }))
    await waitFor(() => expect(transcribeLineWords).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(props.onClose).toHaveBeenCalled()
    finishFirst({ words: [], text: "First minute." })
    await new Promise((r) => setTimeout(r, 20))
    expect(transcribeLineWords).toHaveBeenCalledTimes(1)
    expect(props.onKeepWords).not.toHaveBeenCalled()
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
