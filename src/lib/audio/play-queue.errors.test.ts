import { describe, expect, it } from "vitest"
import { isMissingAudioError, MISSING_AUDIO_MESSAGE } from "./play-queue"

// AQU-660: a media clip whose R2 bytes are gone surfaced fetchCellAudio's raw
// "audio not found (404): not found" and dead-ended the transport. The queue
// now classifies that 404 sentinel so it can skip the dead clip and show a
// clear missing state instead of a misleading generic failure.
describe("isMissingAudioError", () => {
  it("matches the 404 status sentinel thrown by fetchCellAudio", () => {
    const err = Object.assign(new Error("audio not found (404): not found"), { status: 404 })
    expect(isMissingAudioError(err)).toBe(true)
  })

  it("matches by message even without the status marker", () => {
    expect(isMissingAudioError(new Error("audio not found (404): gone"))).toBe(true)
  })

  it("does not match transient/auth failures that should surface as errors", () => {
    expect(isMissingAudioError(new Error("audio fetch failed (500): boom"))).toBe(false)
    expect(isMissingAudioError(new Error("Sign in to play audio"))).toBe(false)
    expect(isMissingAudioError(new Error("Audio failed to load"))).toBe(false)
  })

  it("is null/undefined safe", () => {
    expect(isMissingAudioError(null)).toBe(false)
    expect(isMissingAudioError(undefined)).toBe(false)
    expect(isMissingAudioError("audio not found (404)")).toBe(false)
  })

  it("exposes user-facing copy for the missing state", () => {
    expect(MISSING_AUDIO_MESSAGE).toMatch(/missing/i)
  })
})
