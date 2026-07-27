// CellWaveform failure-state rendering: a permanently missing clip
// (peaksState "missing", from the fetchCellAudio 404 sentinel) must show calm
// non-retryable copy, while transient failures (peaksState "error") keep the
// retry chip.

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { CellWaveform } from "./CellWaveform"
import { MISSING_AUDIO_MESSAGE } from "@/lib/audio/play-queue"
import type { UseCellAudioResult } from "@/hooks/useCellAudio"

function makeController(overrides: Partial<UseCellAudioResult> = {}): UseCellAudioResult {
  return {
    state: "cloud",
    error: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    peaks: null,
    peaksState: "idle",
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setTrim: vi.fn(),
    requestPeaks: vi.fn(async () => undefined),
    ensureBytes: vi.fn(async () => new Uint8Array()),
    ...overrides,
  } as unknown as UseCellAudioResult
}

describe("CellWaveform", () => {
  it("renders a calm non-retryable message when the clip's audio is missing", () => {
    render(<CellWaveform controller={makeController({ peaksState: "missing" })} />)

    expect(screen.getByText(MISSING_AUDIO_MESSAGE)).toBeInTheDocument()
    // Permanent deletion — retrying can never succeed, so no retry affordance.
    expect(screen.queryByLabelText("Retry waveform")).not.toBeInTheDocument()
  })

  it("keeps the retry chip for transient failures", () => {
    render(<CellWaveform controller={makeController({ peaksState: "error" })} />)

    expect(screen.getByLabelText("Retry waveform")).toBeInTheDocument()
    expect(screen.queryByText(MISSING_AUDIO_MESSAGE)).not.toBeInTheDocument()
  })
})
