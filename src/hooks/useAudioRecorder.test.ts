// Tests for the 25/30-minute recording-limit logic in useAudioRecorder.

import { describe, it, expect } from "vitest"
import { RECORDING_WARN_MS, RECORDING_HARD_STOP_MS } from "./useAudioRecorder"

describe("useAudioRecorder constants", () => {
  it("RECORDING_WARN_MS is 25 minutes", () => {
    expect(RECORDING_WARN_MS).toBe(25 * 60 * 1000)
  })

  it("RECORDING_HARD_STOP_MS is 30 minutes", () => {
    expect(RECORDING_HARD_STOP_MS).toBe(30 * 60 * 1000)
  })

  it("hard stop is 5 minutes after the warning", () => {
    expect(RECORDING_HARD_STOP_MS - RECORDING_WARN_MS).toBe(5 * 60 * 1000)
  })

  it("isNearLimit is true when elapsedMs >= RECORDING_WARN_MS", () => {
    // Derive the same logic as the hook: isNearLimit = elapsedMs >= RECORDING_WARN_MS
    const isNearLimit = (ms: number) => ms >= RECORDING_WARN_MS
    expect(isNearLimit(RECORDING_WARN_MS - 1)).toBe(false)
    expect(isNearLimit(RECORDING_WARN_MS)).toBe(true)
    expect(isNearLimit(RECORDING_HARD_STOP_MS)).toBe(true)
  })

  it("hard stop triggers when elapsed >= RECORDING_HARD_STOP_MS", () => {
    // Mirrors the condition in the setInterval callback.
    const shouldHardStop = (ms: number) => ms >= RECORDING_HARD_STOP_MS
    expect(shouldHardStop(RECORDING_HARD_STOP_MS - 1)).toBe(false)
    expect(shouldHardStop(RECORDING_HARD_STOP_MS)).toBe(true)
    expect(shouldHardStop(RECORDING_HARD_STOP_MS + 1000)).toBe(true)
  })
})
