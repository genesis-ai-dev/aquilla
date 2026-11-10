// AQU-2494 (review, Nov 9): a take's volume and fades were ignored by the
// line's own play button, the takes list and the recording window — the
// three players built on this hook. They now play what the timeline plays:
// the same mixer, the same level, piece by piece for a cut take. A take with
// no level set plays exactly as before, off the mixer.
import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"
import { levelAt, type ClipLevels } from "@/lib/audio/mixer"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "j", username: "u" } }) }))
vi.mock("@/lib/offline/connectivity", () => ({ isOnline: async () => null }))
const cache = vi.hoisted(() => ({ bytes: null as Uint8Array | null }))
vi.mock("@/lib/audio/bytes-cache", () => ({
  audioCacheGet: async () => cache.bytes,
  audioCachePut: async () => {},
  audioCacheEvict: async () => {},
}))
const net = vi.hoisted(() => ({ fetched: 0, bytes: null as Uint8Array | null }))
vi.mock("@/lib/audio/upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: vi.fn(async () => { net.fetched += 1; return net.bytes }),
  getCellAudioStreamUrl: vi.fn(async () => "https://sync.example/audio/p1/f1/a1.wav?t=x"),
}))
// The mixer as a browser has it: a blob's sound can go through it, a
// cross-origin stream's can't. Its level maths are the real ones.
const mixer = vi.hoisted(() => ({ calls: [] as Array<{ el: unknown; key: string; level: ClipLevels | null }>, routed: new Set<unknown>() }))
vi.mock("@/lib/audio/mixer", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mixElement: vi.fn((el: { src: string }, key: string, level: ClipLevels | null) => {
    if (!mixer.routed.has(el) && !el.src.startsWith("blob:")) return false
    mixer.routed.add(el)
    mixer.calls.push({ el, key, level })
    return true
  }),
  isMixed: (el: unknown) => mixer.routed.has(el),
}))

import { useCellAudio } from "./useCellAudio"

class FakeAudio {
  src = ""
  currentTime = 0
  duration = 5
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
let blobs = 0

const wav = async (sec: number) => new Uint8Array(await encodeWavPcm16(new Float32Array(48000 * sec), 48000).arrayBuffer())
beforeEach(async () => {
  instances = []
  blobs = 0
  mixer.calls = []
  mixer.routed = new Set()
  net.fetched = 0
  cache.bytes = await wav(5)
  net.bytes = cache.bytes
  Object.defineProperty(globalThis, "Audio", { writable: true, configurable: true, value: FakeAudio })
  Object.defineProperty(globalThis.URL, "createObjectURL", { writable: true, configurable: true, value: vi.fn(() => `blob:${++blobs}`) })
  Object.defineProperty(globalThis.URL, "revokeObjectURL", { writable: true, configurable: true, value: vi.fn() })
})

const project = { id: "p1" } as unknown as ProjectRecord
type Att = Record<string, unknown>
const cellOf = (attachments: Record<string, Att>, selectedAudioId: string) =>
  ({ metadata: { attachments, selectedAudioId } }) as unknown as CodexCell
const take = (over: Att): Att => ({ url: "frontier-audio://a1.wav", type: "audio", durationMs: 5000, slot: "recording", ...over })
const dB = (db: number) => Math.pow(10, db / 20)
const flush = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe("useCellAudio plays a take at its volume and fades", () => {
  it("a whole take: through the mixer, on its track, at its level", async () => {
    const cell = cellOf({ "a1.wav": take({ gainDb: 9, fadeInMs: 500, trimEndMs: 2000 }) }, "a1.wav")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    act(() => result.current.setTrim(0, 2))
    await act(async () => { await result.current.play() })
    expect(mixer.calls).toHaveLength(1)
    const { el, key, level } = mixer.calls[0]
    expect(el).toBe(instances[0])
    expect(key).toBe("recording")
    expect(levelAt(0.25, level!)).toBeCloseTo(dB(9) * 0.5)
    expect(levelAt(1, level!)).toBeCloseTo(dB(9))
  })

  it("a take with no level set plays exactly as before: off the mixer", async () => {
    const cell = cellOf({ "a1.wav": take({}) }, "a1.wav")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await act(async () => { await result.current.play() })
    expect(instances).toHaveLength(1)
    expect(mixer.calls).toHaveLength(0)
    expect(instances[0].volume).toBe(1)
  })

  it("a cut take on an added track: each piece at its own level, on the recording's clock", async () => {
    // Cut at 2.5s (AQU-2494's rule: both keep the volume, the fade-in stays on
    // the first piece, the fade-out goes to the last).
    const cell = cellOf({
      "a1.wav": take({ slot: "trk-2", trimEndMs: 2500, gainDb: 6, fadeInMs: 200 }),
      "a1-2.wav": take({ slot: "trk-2", trimStartMs: 2500, pieceOf: "a1.wav", gainDb: 6, fadeOutMs: 500 }),
    }, "a1.wav")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    act(() => result.current.setTrim(0, 5))
    await act(async () => { await result.current.play() })
    const { key, level } = mixer.calls[0]
    expect(key).toBe("trk-2")
    expect(levelAt(0.1, level!)).toBeCloseTo(dB(6) * 0.5)
    expect(levelAt(1, level!)).toBeCloseTo(dB(6))
    // Past the cut: still raised, not faded out at the cut.
    expect(levelAt(2.6, level!)).toBeCloseTo(dB(6))
    expect(levelAt(4.75, level!)).toBeCloseTo(dB(6) * 0.5)
  })

  it("a cut take whose pieces play joined: each piece's level where it sits in the joined clip", async () => {
    const cell = cellOf({
      "a1.wav": take({ trimEndMs: 1000, gainDb: 6, fadeOutMs: 200 }),
      "a1-2.wav": take({ trimStartMs: 1500, trimEndMs: 3000, pieceOf: "a1.wav", gainDb: -6 }),
    }, "a1.wav")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    act(() => result.current.setTrim(0, 3, [{ start: 1, end: 1.5 }]))
    await act(async () => { await result.current.play() })
    await flush()
    const { level } = mixer.calls[0]
    expect(levelAt(0.5, level!)).toBeCloseTo(dB(6))
    expect(levelAt(0.9, level!)).toBeCloseTo(dB(6) * 0.5)
    // 1.2s into the joined clip is 1.7s into the recording: the second piece.
    expect(levelAt(1.2, level!)).toBeCloseTo(dB(-6))
    expect(levelAt(2.4, level!)).toBeCloseTo(dB(-6))
  })

  it("the imported source recording plays as recorded, as the timeline plays it", async () => {
    const cell = cellOf({ "a1.wav": take({ role: "source", gainDb: 6 }) }, "a1.wav")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await act(async () => { await result.current.play() })
    expect(mixer.calls).toHaveLength(0)
  })

  it("a take with a level, not on this device yet, plays from its bytes so the level can be applied", async () => {
    cache.bytes = null
    const cell = cellOf({ "a1.wav": take({ gainDb: -6 }) }, "a1.wav")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await act(async () => { await result.current.play() })
    expect(net.fetched).toBe(1)
    expect(instances[0].src.startsWith("blob:")).toBe(true)
    expect(levelAt(1, mixer.calls[0].level!)).toBeCloseTo(dB(-6))
  })

  it("…while one with no level still streams, as before", async () => {
    cache.bytes = null
    const cell = cellOf({ "a1.wav": take({}) }, "a1.wav")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await act(async () => { await result.current.play() })
    expect(net.fetched).toBe(0)
    expect(instances[0].src.startsWith("https://")).toBe(true)
  })

  it("a level changed while the take is loaded (the Station) reaches its player at once", async () => {
    let cell = cellOf({ "a1.wav": take({ gainDb: 3 }) }, "a1.wav")
    const { result, rerender } = renderHook(() => useCellAudio(project, cell, "f1"))
    await act(async () => { await result.current.play() })
    cell = cellOf({ "a1.wav": take({ gainDb: 9, fadeOutMs: 1000 }) }, "a1.wav")
    rerender()
    const last = mixer.calls.at(-1)!
    expect(last.el).toBe(instances[0])
    expect(levelAt(1, last.level!)).toBeCloseTo(dB(9))
    expect(levelAt(4.5, last.level!)).toBeCloseTo(dB(9) * 0.5)
  })

  it("a player streamed before the take had a level is made again from its bytes, where it was", async () => {
    cache.bytes = null
    let cell = cellOf({ "a1.wav": take({}) }, "a1.wav")
    const { result, rerender } = renderHook(() => useCellAudio(project, cell, "f1"))
    await act(async () => { await result.current.play() })
    const streamed = instances[0]
    expect(streamed.src.startsWith("https://")).toBe(true)
    act(() => result.current.pause())
    streamed.currentTime = 1.2
    // Raised 9 dB in the Station.
    cell = cellOf({ "a1.wav": take({ gainDb: 9 }) }, "a1.wav")
    rerender()
    await act(async () => { await result.current.play() })
    expect(instances).toHaveLength(2)
    const made = instances[1]
    expect(made.src.startsWith("blob:")).toBe(true)
    expect(mixer.calls.at(-1)?.el).toBe(made)
    act(() => made.onloadedmetadata?.())
    expect(made.currentTime).toBeCloseTo(1.2)
    expect(made.paused).toBe(false)
  })
})
