// WHY: transcription failures used to be invisible — the error state existed
// in transcribe-status but no mounted component rendered it, so the button
// just reverted to "Transcribe". The badge (now mounted in the Recording tab)
// must surface the failure and offer Retry.
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
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
