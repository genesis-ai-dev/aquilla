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

// The element moves once a frame, to the latest seek.
async function seekTo(result: { current: { seek: (t: number) => void } }, t: number) {
  await act(async () => {
    result.current.seek(t)
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  })
}

// Sam, 2026-09-29: scrubbing while playing froze the app, and the Audio view
// card and the Recording tab under it played the same take on top of each
// other — "stop" on one started it again over the other.
describe("useCellAudio — scrubbing and one playback per take", () => {
  it("lands a drag past the window's end just inside it, and keeps playing", async () => {
    const { result } = renderHook(() => useCellAudio(project, cellWith("a1", 3000), "f1"))
    act(() => result.current.setTrim(0.4, 2.5))
    await act(async () => { await result.current.play() })
    const a = instances[0]
    await seekTo(result, 2.9)
    expect(a.currentTime).toBeLessThan(2.5)
    expect(a.currentTime).toBeGreaterThan(2.4)
    expect(a.paused).toBe(false)
  })

  it("moves the element once a frame, to the latest of a drag's positions", async () => {
    const { result } = renderHook(() => useCellAudio(project, cellWith("a1", 3000), "f1"))
    await act(async () => { await result.current.play() })
    const a = instances[0]
    let sets = 0
    let at = a.currentTime
    Object.defineProperty(a, "currentTime", { configurable: true, get: () => at, set: (v: number) => { sets += 1; at = v } })
    await act(async () => {
      for (const t of [0.5, 1, 1.5, 2]) result.current.seek(t)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    expect(sets).toBe(1)
    expect(at).toBeCloseTo(2)
  })

  it("shows the take playing from another copy of it, and stops it there", async () => {
    const card = renderHook(() => useCellAudio(project, cellWith("a1", 3000), "f1"))
    const tab = renderHook(() => useCellAudio(project, cellWith("a1", 3000), "f1"))
    await act(async () => { await card.result.current.play() })
    expect(tab.result.current.isPlaying).toBe(true)
    // The tab's button reads "stop" — and stops the card's playback, rather
    // than starting a second one from the top.
    act(() => tab.result.current.pause())
    expect(instances).toHaveLength(1)
    expect(instances[0].paused).toBe(true)
    expect(tab.result.current.isPlaying).toBe(false)
  })

  it("resumes the take in the copy it was left in, and scrubs it there", async () => {
    const card = renderHook(() => useCellAudio(project, cellWith("a1", 3000), "f1"))
    const tab = renderHook(() => useCellAudio(project, cellWith("a1", 3000), "f1"))
    await act(async () => { await card.result.current.play() })
    instances[0].currentTime = 1.2
    act(() => tab.result.current.pause())
    // Paused in the card: the tab shows where it was left…
    expect(tab.result.current.currentTime).toBeCloseTo(1.2)
    // …and its play resumes it there — one element, not a second from 0:00.
    await act(async () => { await tab.result.current.play() })
    expect(instances).toHaveLength(1)
    expect(instances[0].paused).toBe(false)
    expect(instances[0].currentTime).toBeCloseTo(1.2)
    // A scrub on the tab moves that same playback.
    await seekTo(tab.result, 2)
    expect(instances).toHaveLength(1)
    expect(instances[0].currentTime).toBeCloseTo(2)
  })

  it("stops whatever else was sounding when it starts", async () => {
    const one = renderHook(() => useCellAudio(project, cellWith("a1", 3000), "f1"))
    const two = renderHook(() => useCellAudio(project, cellWith("a2", 3000), "f1"))
    await act(async () => { await one.result.current.play() })
    await act(async () => { await two.result.current.play() })
    expect(instances[0].paused).toBe(true)
    expect(instances[1].paused).toBe(false)
    // A different take is not "this take playing elsewhere".
    expect(one.result.current.isPlaying).toBe(false)
  })
})

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
