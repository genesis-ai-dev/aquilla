// Decision 2026-08-05: opening the recorder silences EVERYTHING that can
// sound. pauseQueue's own state handling is covered by the programme/seek
// suites; this pins the other half — the coordinator-registered single-cell
// controller is paused too, and the call is a safe no-op when idle.
import { afterEach, describe, expect, it, vi } from "vitest"
import { pauseAllPlayback } from "./play-queue"
import { clearActiveAudioIf, setActiveAudio, type ActiveAudioController } from "./audio-coordinator"

describe("pauseAllPlayback", () => {
  let controller: ActiveAudioController | null = null
  afterEach(() => {
    if (controller) clearActiveAudioIf(controller)
    controller = null
  })

  it("pauses the coordinator's registered single-cell controller", () => {
    const pause = vi.fn()
    controller = { isPlaying: () => true, play: async () => {}, pause }
    setActiveAudio(controller)
    pauseAllPlayback()
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it("is a no-op with nothing registered and the queue idle", () => {
    expect(() => pauseAllPlayback()).not.toThrow()
  })
})
