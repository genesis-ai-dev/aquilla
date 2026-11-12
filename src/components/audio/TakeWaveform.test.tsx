// What a saved take shows while its shape is still on its way (Sam,
// 2026-10-01, from the 3G pass). The card, the Recording tab and the recorder
// all draw a take through this one component; on a slow connection their
// bodies stood flat for up to twenty seconds, which reads as a silent take.
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { PeaksState, UseCellAudioResult } from "@/hooks/useCellAudio"
import type { AudioMediaStrategy } from "@/lib/parsers/types"
import { TakeWaveform } from "./TakeWaveform"

function controller(peaksState: PeaksState, peaks: Float32Array | null = null): UseCellAudioResult {
  return {
    state: "cloud", error: null, isPlaying: false, currentTime: 0, duration: 3,
    peaks, peaksState,
    play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(async () => {}), ensureBytes: vi.fn(),
  }
}

function draw(c: UseCellAudioResult, strategy: AudioMediaStrategy = "lazy") {
  return render(
    <I18nProvider>
      <TakeWaveform
        controller={c}
        audioId="take-1"
        kept={{ start: null, end: null, kind: "none" }}
        height={56}
        strategy={strategy}
        testId="w"
      />
    </I18nProvider>,
  )
}

describe("TakeWaveform — while the shape loads", () => {
  it("pulses a placeholder while the take downloads or decodes", () => {
    draw(controller("loading"))
    expect(screen.getByTestId("w-loading")).toBeInTheDocument()
  })

  it("pulses before the request has started too, so it never flashes flat", () => {
    draw(controller("idle"))
    expect(screen.getByTestId("w-loading")).toBeInTheDocument()
  })

  it("draws the shape, and no placeholder, once it has arrived", () => {
    draw(controller("ready", new Float32Array([0.2, 1, 0.5])))
    expect(screen.getByTestId("w-shape")).toBeInTheDocument()
    expect(screen.queryByTestId("w-loading")).toBeNull()
  })

  it("waits for a click on a project that loads media only when asked, without a placeholder", () => {
    draw(controller("idle"), "manual")
    expect(screen.queryByTestId("w-loading")).toBeNull()
    expect(screen.getByRole("button", { name: /load waveform/i })).toBeInTheDocument()
  })

  it("says the audio is missing, or offers a retry, instead of pulsing forever", () => {
    const { unmount } = draw(controller("missing"))
    expect(screen.queryByTestId("w-loading")).toBeNull()
    unmount()
    draw(controller("error"))
    expect(screen.queryByTestId("w-loading")).toBeNull()
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument()
  })
})
