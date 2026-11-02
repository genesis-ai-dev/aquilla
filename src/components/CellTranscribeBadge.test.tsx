// WHY: transcription failures used to be invisible — the error state existed
// in transcribe-status but no mounted component rendered it, so the button
// just reverted to "Transcribe". The badge (now mounted in the Recording tab)
// must surface the failure and offer Retry.
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expectClickNote, renderWithTooltips } from "@/test-utils/tooltip"
import { CellTranscribeBadge } from "./CellTranscribeBadge"
import { setTranscribeStatus, clearTranscribeStatus } from "@/lib/audio/transcribe-status"

const AUDIO_ID = "audio-test-1"

afterEach(() => clearTranscribeStatus(AUDIO_ID))

describe("CellTranscribeBadge error state", () => {
  it("renders a visible failed pill when transcription errors", () => {
    setTranscribeStatus(AUDIO_ID, { kind: "error", message: "model download failed" })
    render(<CellTranscribeBadge audioId={AUDIO_ID} hasTimings={false} />)
    expect(screen.getByText("Transcription failed")).toBeInTheDocument()
  })

  it("offers Retry in the expanded error popover and invokes the callback", () => {
    setTranscribeStatus(AUDIO_ID, { kind: "error", message: "model download failed" })
    const onRetry = vi.fn()
    render(<CellTranscribeBadge audioId={AUDIO_ID} hasTimings={false} onRetry={onRetry} />)

    fireEvent.click(screen.getByText("Transcription failed"))
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("offers Change model when the hosted model itself failed", () => {
    setTranscribeStatus(AUDIO_ID, { kind: "error", message: "Hosted transcription model unavailable (502)." })
    const onChangeModel = vi.fn()
    render(<CellTranscribeBadge audioId={AUDIO_ID} hasTimings={false} onRetry={vi.fn()} onChangeModel={onChangeModel} />)

    fireEvent.click(screen.getByText("Transcription failed"))
    fireEvent.click(screen.getByRole("button", { name: /change model/i }))
    expect(onChangeModel).toHaveBeenCalledTimes(1)
  })

  it("does not offer Change model for failures another model would not fix", () => {
    setTranscribeStatus(AUDIO_ID, { kind: "error", message: "model download failed" })
    render(<CellTranscribeBadge audioId={AUDIO_ID} hasTimings={false} onChangeModel={vi.fn()} />)
    fireEvent.click(screen.getByText("Transcription failed"))
    expect(screen.queryByRole("button", { name: /change model/i })).toBeNull()
  })

  it("renders nothing when idle", () => {
    const { container } = render(<CellTranscribeBadge audioId={AUDIO_ID} hasTimings={false} />)
    expect(container.firstChild).toBeNull()
  })
})

// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. The
// gutter pills explain themselves on a click.
describe("CellTranscribeBadge — pills open their notes on click", () => {
  async function expectNoHover(el: Element) {
    await userEvent.setup().hover(el)
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(screen.queryByRole("tooltip")).toBeNull()
  }

  it("says the model is downloading, with its percentage", async () => {
    setTranscribeStatus(AUDIO_ID, { kind: "loading", loaded: 42, total: 100, file: "m.onnx" })
    renderWithTooltips(<CellTranscribeBadge audioId={AUDIO_ID} hasTimings={false} />)
    await expectClickNote(screen.getByText("42%"), "Downloading transcription model (42%)")
  })

  it("says what it is waiting for", async () => {
    setTranscribeStatus(AUDIO_ID, { kind: "transcribing", waiting: "model" })
    renderWithTooltips(<CellTranscribeBadge audioId={AUDIO_ID} hasTimings={false} />)
    await expectClickNote(screen.getByText("waiting for model"), "zero-shot model")
  })

  it("the transcribing pill says it all, with no hover", async () => {
    setTranscribeStatus(AUDIO_ID, { kind: "transcribing" })
    renderWithTooltips(<CellTranscribeBadge audioId={AUDIO_ID} hasTimings={false} />)
    await expectNoHover(screen.getByText("transcribing"))
  })

  it("the done flash jumps to the transcript on a click, with no hover", async () => {
    setTranscribeStatus(AUDIO_ID, { kind: "loading", loaded: 1, total: 2, file: "m" })
    const onJump = vi.fn()
    renderWithTooltips(<CellTranscribeBadge audioId={AUDIO_ID} hasTimings={false} onJumpToTranscript={onJump} />)
    act(() => setTranscribeStatus(AUDIO_ID, { kind: "done", wordCount: 12, durationMs: 3400 }))
    const pill = screen.getByRole("button", { name: /Transcribed 12 words in 3.4s/ })
    await expectNoHover(pill)
    fireEvent.click(pill)
    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it("the done flash with nowhere to jump says what it did on a click", async () => {
    setTranscribeStatus(AUDIO_ID, { kind: "loading", loaded: 1, total: 2, file: "m" })
    renderWithTooltips(<CellTranscribeBadge audioId={AUDIO_ID} hasTimings={false} />)
    act(() => setTranscribeStatus(AUDIO_ID, { kind: "done", wordCount: 12, durationMs: 3400 }))
    await expectClickNote(screen.getByText("12w"), "Transcribed 12 words in 3.4s")
  })
})
