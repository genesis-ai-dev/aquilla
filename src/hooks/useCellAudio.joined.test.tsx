// AQU-1767 (Sam's walk, 2026-10-15): one click on a split take's waveform in
// the Recording tab played the take's head, then jumped — and every cut
// stuttered. In Safari a seek on a playing element stalls about a third of a
// second, sounding the old position meanwhile. A split take now plays as ONE
// clip of its pieces joined, nothing seeks between pieces, and a click starts
// the take where it was clicked.
import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: null }) }))
const cached = vi.hoisted(() => ({ bytes: null as Uint8Array | null }))
vi.mock("@/lib/audio/bytes-cache", () => ({
  audioCacheGet: async () => cached.bytes,
  audioCachePut: async () => {},
  audioCacheEvict: async () => {},
}))

import { useCellAudio, playingSpans, joinedClockFor, toJoinedSec, toRecordingSec } from "./useCellAudio"

class FakeAudio {
  src = ""
  currentTime = 0
  duration = 2.5
  readyState = 1
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
  addEventListener() {}
  removeEventListener() {}
}
let instances: FakeAudio[] = []
let blobs: Blob[] = []

beforeEach(async () => {
  instances = []
  blobs = []
  cached.bytes = new Uint8Array(await encodeWavPcm16(new Float32Array(48000 * 4), 48000).arrayBuffer())
  Object.defineProperty(globalThis, "Audio", { writable: true, configurable: true, value: FakeAudio })
  Object.defineProperty(globalThis.URL, "createObjectURL", { writable: true, configurable: true, value: vi.fn((b: Blob) => { blobs.push(b); return `blob:${blobs.length}` }) })
  Object.defineProperty(globalThis.URL, "revokeObjectURL", { writable: true, configurable: true, value: vi.fn() })
})

const project = { id: "p1" } as unknown as ProjectRecord
const cell = {
  metadata: {
    attachments: { "a1.wav": { url: "frontier-audio://a1.wav", type: "audio", durationMs: 4000 } },
    selectedAudioId: "a1.wav",
  },
} as unknown as CodexCell
// Two pieces: 0–1s and 1.5–3s of a 4s recording.
const gaps = [{ start: 1, end: 1.5 }]

describe("the joined clock", () => {
  it("lists what plays and maps both ways, a gap landing on the next piece", () => {
    const spans = playingSpans(0, 3, gaps)
    expect(spans).toEqual([{ start: 0, end: 1 }, { start: 1.5, end: 3 }])
    const j = joinedClockFor("k", spans)
    expect(j.total).toBeCloseTo(2.5)
    expect(toJoinedSec(j, 0.5)).toBeCloseTo(0.5)
    expect(toJoinedSec(j, 1.2)).toBeCloseTo(1)
    expect(toJoinedSec(j, 2)).toBeCloseTo(1.5)
    expect(toRecordingSec(j, 1.5)).toBeCloseTo(2)
    expect(toRecordingSec(j, 0.99)).toBeCloseTo(0.99)
  })
})

describe("useCellAudio — a split take plays as one joined clip", () => {
  it("plays its pieces joined, and a click starts it where it was clicked", async () => {
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    act(() => result.current.setTrim(0, 3, gaps))
    // One click, 2.0s into the recording, before anything has loaded.
    await act(async () => {
      result.current.seek(2)
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(instances).toHaveLength(1)
    const a = instances[0]
    // The joined clip: 1s + 1.5s of 48kHz mono 16-bit, after its header.
    expect(blobs.at(-1)?.size).toBe(44 + 2.5 * 48000 * 2)
    act(() => a.onloadedmetadata?.())
    // 2.0s into the recording is 1.5s into the joined clip — set before it plays.
    expect(a.currentTime).toBeCloseTo(1.5)
    expect(a.paused).toBe(false)
    // Its playhead speaks the recording's clock.
    a.currentTime = 0.5
    act(() => a.ontimeupdate?.())
    expect(result.current.currentTime).toBeCloseTo(0.5)
    a.currentTime = 1.2
    act(() => a.ontimeupdate?.())
    expect(result.current.currentTime).toBeCloseTo(1.7)
    // The recording's length stays the waveform's, not the joined clip's.
    expect(result.current.duration).toBeCloseTo(4)
  })

  it("never makes two players when clicked twice while loading", async () => {
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    act(() => result.current.setTrim(0, 3, gaps))
    await act(async () => {
      result.current.seek(0.5)
      result.current.seek(2)
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(instances).toHaveLength(1)
  })
})
