// The player's trim window (AQU-1217). The Recording tab and the recorder now
// play a take through its stored trim; these pin the four places the window
// used to leak.

import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: null }) }))

import { useCellAudio } from "./useCellAudio"

class FakeAudio {
  src = ""
  currentTime = 0
  duration = 3
  ended = false
  paused = true
  volume = 1
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  constructor(src?: string) { if (src) this.src = src; instances.push(this) }
  async play() { this.paused = false; this.ended = false; this.onplay?.() }
  pause() { this.paused = true; this.onpause?.() }
}
let instances: FakeAudio[] = []

beforeEach(() => {
  instances = []
  Object.defineProperty(globalThis, "Audio", { writable: true, configurable: true, value: FakeAudio })
  Object.defineProperty(globalThis.URL, "createObjectURL", { writable: true, configurable: true, value: vi.fn(() => "blob:x") })
  Object.defineProperty(globalThis.URL, "revokeObjectURL", { writable: true, configurable: true, value: vi.fn() })
})

const project = { id: "p1" } as unknown as ProjectRecord

function cellWith(audioId: string, durationMs?: number): CodexCell {
  return {
    metadata: {
      // A remote URL streams straight into the element — no fetch, no session.
      attachments: { [audioId]: { url: `https://cdn.example/${audioId}.wav`, type: "audio", durationMs } },
      selectedAudioId: audioId,
    },
  } as unknown as CodexCell
}

describe("useCellAudio trim window", () => {
  it("reports the attachment's measured length before the element loads", () => {
    const { result } = renderHook(() => useCellAudio(project, cellWith("a1", 3600), "f1"))
    expect(result.current.duration).toBeCloseTo(3.6)
  })

  it("replays a head-trimmed take from its window, not from zero, after a natural end", async () => {
    const { result } = renderHook(() => useCellAudio(project, cellWith("a1", 3000), "f1"))
    act(() => result.current.setTrim(0.4, null))
    await act(async () => { await result.current.play() })
    const a = instances[0]
    // Played to the file's natural end.
    a.currentTime = 3
    a.ended = true
    a.pause()
    await act(async () => { await result.current.play() })
    expect(a.currentTime).toBe(0.4)
  })

  it("does not seek a clip whose length is still unknown", async () => {
    const { result } = renderHook(() => useCellAudio(project, cellWith("a1"), "f1"))
    act(() => result.current.setTrim(0.4, null))
    await act(async () => { await result.current.play() })
    const a = instances[0]
    a.duration = Infinity
    act(() => a.onloadedmetadata?.())
    expect(a.currentTime).toBe(0)
    a.duration = 3
    act(() => a.onloadedmetadata?.())
    expect(a.currentTime).toBe(0.4)
  })

  it("drops the trim when the take it belongs to is swapped out", async () => {
    const { result, rerender } = renderHook(({ id }) => useCellAudio(project, cellWith(id, 3000), "f1"), {
      initialProps: { id: "a1" },
    })
    act(() => result.current.setTrim(0.4, 1.2))
    rerender({ id: "a2" })
    await act(async () => { await result.current.play() })
    const a = instances[instances.length - 1]
    a.currentTime = 2
    act(() => a.ontimeupdate?.())
    // No stale end at 1.2: playback carries on.
    expect(a.paused).toBe(false)
  })
})
