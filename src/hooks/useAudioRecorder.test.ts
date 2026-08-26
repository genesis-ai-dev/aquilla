// Tests for the 25/30-minute recording-limit logic in useAudioRecorder, and
// for the holdMic session contract — who stops the mic tracks, and when.

import { describe, it, expect, vi, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"

import { RECORDING_WARN_MS, RECORDING_HARD_STOP_MS, useAudioRecorder } from "./useAudioRecorder"

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

// The holdMic session contract (2026-08-14 round 4). Opening and closing the
// mic around takes makes the OS reconfigure the input device, and the
// recovery ramp lands inside the next take — so the recording modal holds ONE
// stream for its whole session. What must never regress in either direction:
// with holdMic, reset() (which fires on every cell switch, including the
// auto-advance hop after every save) must NOT stop the tracks; and
// releaseMic() absolutely must, because a tab recording indicator that
// outlives the dialog is a privacy bug, not a performance tweak.
describe("useAudioRecorder — the holdMic session", () => {
  function fakeMic() {
    let stops = 0
    const track = { stop: () => { stops += 1 }, kind: "audio" }
    const stream = { getTracks: () => [track] } as unknown as MediaStream
    return { stream, stopCount: () => stops }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function installMic() {
    const mic = fakeMic()
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => mic.stream) },
    })
    return mic
  }

  it("holdMic: reset() keeps the mic, releaseMic() truly stops it", async () => {
    const mic = installMic()
    const { result } = renderHook(() => useAudioRecorder({ holdMic: true }))
    await act(() => result.current.prewarm())
    expect(result.current.stream).toBe(mic.stream)

    act(() => result.current.reset())
    // The session HOLDS — this reset is the auto-advance cell hop.
    expect(mic.stopCount()).toBe(0)
    expect(result.current.stream).toBe(mic.stream)

    act(() => result.current.releaseMic!())
    expect(mic.stopCount()).toBe(1)
    expect(result.current.stream).toBeNull()
  })

  it("without holdMic, reset() releases the mic as it always did", async () => {
    const mic = installMic()
    const { result } = renderHook(() => useAudioRecorder())
    await act(() => result.current.prewarm())
    expect(result.current.stream).toBe(mic.stream)

    act(() => result.current.reset())
    expect(mic.stopCount()).toBe(1)
    expect(result.current.stream).toBeNull()
  })

  it("holdMic: unmount lets go — there is no surface left to hold it for", async () => {
    const mic = installMic()
    const { result, unmount } = renderHook(() => useAudioRecorder({ holdMic: true }))
    await act(() => result.current.prewarm())
    unmount()
    expect(mic.stopCount()).toBe(1)
  })
})
