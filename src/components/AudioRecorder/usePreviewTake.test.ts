import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"

const claimed: unknown[] = []
vi.mock("@/lib/audio/audio-coordinator", () => ({
  claimActiveAudio: (c: unknown) => { claimed.push(c) },
  clearActiveAudioIf: () => {},
}))

import { usePreviewTake } from "./usePreviewTake"

class FakeAudio {
  src: string
  currentTime = 0
  paused = true
  ended = false
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  onended: (() => void) | null = null
  constructor(src: string) { this.src = src; made.push(this) }
  async play() { this.paused = false; this.onplay?.() }
  pause() { this.paused = true; this.onpause?.() }
}
let made: FakeAudio[] = []

beforeEach(() => {
  made = []
  claimed.length = 0
  Object.defineProperty(globalThis, "Audio", { writable: true, configurable: true, value: FakeAudio })
  Object.defineProperty(globalThis.URL, "createObjectURL", { writable: true, configurable: true, value: vi.fn(() => "blob:take") })
  Object.defineProperty(globalThis.URL, "revokeObjectURL", { writable: true, configurable: true, value: vi.fn() })
})

const take = encodeWavPcm16(new Float32Array(16_000).fill(0.3), 8000) // 2s

describe("usePreviewTake", () => {
  it("draws the take from its own samples and knows its length", async () => {
    const { result } = renderHook(() => usePreviewTake(take))
    expect(result.current.peaksState).toBe("loading")
    await waitFor(() => expect(result.current.peaksState).toBe("ready"))
    expect(result.current.duration).toBeCloseTo(2)
    expect(result.current.peaks?.length).toBeGreaterThan(0)
  })

  it("plays from the start of the kept part and claims the floor", async () => {
    const { result } = renderHook(() => usePreviewTake(take))
    await waitFor(() => expect(result.current.peaksState).toBe("ready"))
    act(() => result.current.setTrim(0.5, 1.5))
    await act(async () => { await result.current.play() })
    expect(made[0].currentTime).toBe(0.5)
    expect(claimed).toHaveLength(1)
  })

  // The element moves once a frame, to the latest seek.
  const seekTo = async (result: { current: { seek: (t: number) => void } }, t: number) => {
    await act(async () => {
      result.current.seek(t)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
  }

  it("never seeks outside the kept part", async () => {
    const { result } = renderHook(() => usePreviewTake(take))
    await waitFor(() => expect(result.current.peaksState).toBe("ready"))
    act(() => result.current.setTrim(0.5, 1.5))
    await seekTo(result, 1.2)
    expect(made[0].currentTime).toBe(1.2)
    await seekTo(result, 0.1)
    expect(made[0].currentTime).toBe(0.5)
    await seekTo(result, 1.9)
    expect(made[0].currentTime).toBeGreaterThanOrEqual(0.5)
    expect(made[0].currentTime).toBeLessThanOrEqual(1.5)
  })

  // Sam, 2026-09-29: scrubbing while playing froze the app. A drag into the
  // trimmed-off tail used to land ON the window's end — "reached the end" —
  // so every pointer move paused, rewound, restarted and seeked again.
  it("lands a drag past the end just inside it, and keeps playing", async () => {
    const { result } = renderHook(() => usePreviewTake(take))
    await waitFor(() => expect(result.current.peaksState).toBe("ready"))
    act(() => result.current.setTrim(0.5, 1.5))
    await act(async () => { await result.current.play() })
    const pauses = vi.spyOn(made[0], "pause")
    await seekTo(result, 1.9)
    expect(made[0].currentTime).toBeLessThan(1.5)
    expect(made[0].currentTime).toBeGreaterThan(1.4)
    expect(pauses).not.toHaveBeenCalled()
    expect(made[0].paused).toBe(false)
  })

  it("moves the element once a frame, to the latest of a drag's positions", async () => {
    const { result } = renderHook(() => usePreviewTake(take))
    await waitFor(() => expect(result.current.peaksState).toBe("ready"))
    await seekTo(result, 0.2)
    let sets = 0
    let at = made[0].currentTime
    Object.defineProperty(made[0], "currentTime", { configurable: true, get: () => at, set: (v: number) => { sets += 1; at = v } })
    await act(async () => {
      for (const t of [0.3, 0.4, 0.6, 0.9]) result.current.seek(t)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    expect(sets).toBe(1)
    expect(at).toBeCloseTo(0.9)
  })

  it("is idle with no take", () => {
    const { result } = renderHook(() => usePreviewTake(null))
    expect(result.current.peaksState).toBe("idle")
    expect(result.current.duration).toBe(0)
  })
})
