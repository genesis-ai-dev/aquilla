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

  it("never seeks outside the kept part", async () => {
    const { result } = renderHook(() => usePreviewTake(take))
    await waitFor(() => expect(result.current.peaksState).toBe("ready"))
    act(() => result.current.setTrim(0.5, 1.5))
    act(() => result.current.seek(1.2))
    expect(made[0].currentTime).toBe(1.2)
    act(() => result.current.seek(0.1))
    expect(made[0].currentTime).toBe(0.5)
    act(() => result.current.seek(1.9))
    expect(made[0].currentTime).toBeGreaterThanOrEqual(0.5)
    expect(made[0].currentTime).toBeLessThanOrEqual(1.5)
  })

  it("is idle with no take", () => {
    const { result } = renderHook(() => usePreviewTake(null))
    expect(result.current.peaksState).toBe("idle")
    expect(result.current.duration).toBe(0)
  })
})
