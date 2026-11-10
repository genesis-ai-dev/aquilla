// AQU-2494 (review, Nov 9), findings 1 and 2: the line's play button, the takes
// list and the recording window — the players built on this hook — route a
// take with a volume change or fades through the app's one mixer. Two ways
// that went wrong:
//   1. Wired into an audio context that was asleep (Safari outside a tap, an
//      iPad after a phone call, the first press after a page load in Safari)
//      the take said it was playing and nothing was heard.
//   2. A take not on this device was downloaded whole before it played: the
//      button greyed for as long as that took, a second take could start on
//      top, and a failed download played nothing.
// Now Play wakes the context inside the press; the take goes through the mixer
// when the context runs and its bytes are on the device, and otherwise plays
// straight away, straight to the output, with its level on the player itself.
//
// The mixer here is the real one, on a stand-in context that behaves as
// Safari's does: made or woken inside a tap it runs; outside one it stays
// asleep.
import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"
import { __resetMixerForTests, MIXER_WAKE_WAIT_MS } from "@/lib/audio/mixer"
import { getOutputContext, resetOutputContextForTests } from "@/lib/audio/output-context"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "j", username: "u" } }) }))
vi.mock("@/lib/offline/connectivity", () => ({ isOnline: async () => null }))
const cache = vi.hoisted(() => ({ bytes: null as Uint8Array | null }))
vi.mock("@/lib/audio/bytes-cache", () => ({
  audioCacheGet: async () => cache.bytes,
  audioCachePut: async () => {},
  audioCacheEvict: async () => {},
}))
/** The network: a whole download, and the stream URL, each held until let go when asked. */
const net = vi.hoisted(() => ({
  fetched: 0,
  download: null as null | (() => Promise<Uint8Array>),
  streamUrl: null as null | ((audioId: string) => Promise<string>),
}))
vi.mock("@/lib/audio/upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: vi.fn(async () => { net.fetched += 1; return net.download!() }),
  getCellAudioStreamUrl: vi.fn(async (a: { audioId: string; ext: string }) =>
    net.streamUrl ? net.streamUrl(a.audioId) : `https://sync.example/audio/${a.audioId}.${a.ext}?t=x`),
}))

import { useCellAudio } from "./useCellAudio"

// ── A stand-in for Safari's audio context ───────────────────────────────────
/** True while a press is being handled (a "user gesture"). */
let tapping = false
class StubParam {
  value = 1
  setValueAtTime(v: number) { this.value = v }
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
}
class StubCtx {
  static made: StubCtx[] = []
  /** False: an iPad after a phone call, which will not wake even in a tap. */
  static canWake = true
  state: string = tapping ? "running" : "suspended"
  currentTime = 0
  resumes = 0
  destination = {}
  routed: unknown[] = []
  private listeners = new Set<() => void>()
  constructor() { StubCtx.made.push(this) }
  resume(): Promise<void> {
    this.resumes++
    if (tapping && StubCtx.canWake && this.state !== "running") {
      this.state = "running"
      for (const l of [...this.listeners]) l()
    }
    return Promise.resolve()
  }
  /** Something else woke it (the timeline's Play, say). */
  wake() {
    this.state = "running"
    for (const l of [...this.listeners]) l()
  }
  addEventListener(_t: string, fn: () => void) { this.listeners.add(fn) }
  removeEventListener(_t: string, fn: () => void) { this.listeners.delete(fn) }
  createGain() { return { gain: new StubParam(), connect() {} } }
  createMediaElementSource(el: unknown) { this.routed.push(el); return { connect() {} } }
}

class FakeAudio {
  static instances: FakeAudio[] = []
  src = ""
  get currentSrc() { return this.src }
  currentTime = 0
  duration = 5
  readyState = 1
  ended = false
  paused = true
  muted = false
  volume = 1
  playbackRate = 1
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  private listeners = new Map<string, Set<() => void>>()
  constructor(src?: string) { if (src) this.src = src; FakeAudio.instances.push(this) }
  async play() { this.paused = false; this.ended = false; this.onplay?.(); this.emit("play") }
  pause() { if (this.paused) return; this.paused = true; this.onpause?.(); this.emit("pause") }
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: () => void) { this.listeners.get(type)?.delete(fn) }
  emit(type: string) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn() }
}

const wav = async (sec: number) => new Uint8Array(await encodeWavPcm16(new Float32Array(48000 * sec), 48000).arrayBuffer())
let bytes5: Uint8Array
let blobs = 0
beforeEach(async () => {
  FakeAudio.instances = []
  StubCtx.made = []
  StubCtx.canWake = true
  tapping = false
  blobs = 0
  net.fetched = 0
  bytes5 ??= await wav(5)
  cache.bytes = bytes5
  net.download = async () => bytes5
  net.streamUrl = null
  vi.stubGlobal("AudioContext", StubCtx)
  Object.defineProperty(globalThis, "Audio", { writable: true, configurable: true, value: FakeAudio })
  Object.defineProperty(globalThis.URL, "createObjectURL", { writable: true, configurable: true, value: vi.fn(() => `blob:${++blobs}`) })
  Object.defineProperty(globalThis.URL, "revokeObjectURL", { writable: true, configurable: true, value: vi.fn() })
})
afterEach(() => {
  vi.unstubAllGlobals()
  __resetMixerForTests()
  resetOutputContextForTests()
})

const project = { id: "p1" } as unknown as ProjectRecord
type Att = Record<string, unknown>
const cellOf = (attachments: Record<string, Att>, selectedAudioId: string) =>
  ({ metadata: { attachments, selectedAudioId } }) as unknown as CodexCell
const take = (over: Att, id = "a1"): Att => ({ url: `frontier-audio://${id}.wav`, type: "audio", durationMs: 5000, slot: "recording", ...over })
const dB = (db: number) => Math.pow(10, db / 20)
const flush = async (ms = 0) => {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)) })
}
/** A press: Play's own synchronous part runs inside the tap, the rest after it. */
async function press(play: () => Promise<void>): Promise<void> {
  await act(async () => {
    tapping = true
    const p = play()
    tapping = false
    await Promise.race([p, new Promise((r) => setTimeout(r, 20))])
  })
}
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe("finding 1: a take with a level is heard whatever state the audio context is in", () => {
  it("Safari, first press after the page loads: the context is opened inside the press, so it runs, and the take goes through the mixer", async () => {
    const cell = cellOf({ a1: take({ gainDb: 9 }) }, "a1")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await press(() => result.current.play())
    await flush()
    expect(StubCtx.made).toHaveLength(1)
    const [ctx] = StubCtx.made
    expect(ctx.state).toBe("running")
    expect(ctx.routed).toEqual([FakeAudio.instances[0]])
    expect(FakeAudio.instances[0].paused).toBe(false)
  })

  it("Safari, the context asleep since an earlier play: it is woken inside the press, and the take goes through the mixer", async () => {
    const ctx = getOutputContext() as unknown as StubCtx
    expect(ctx.state).toBe("suspended")
    const cell = cellOf({ a1: take({ gainDb: 9 }) }, "a1")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await press(() => result.current.play())
    await flush()
    expect(ctx.state).toBe("running")
    expect(ctx.routed).toEqual([FakeAudio.instances[0]])
  })

  it("an iPad after a call (the context will not wake): the take plays straight to the output at its level, never into the sleeping mixer", async () => {
    StubCtx.canWake = false
    const ctx = getOutputContext() as unknown as StubCtx
    const cell = cellOf({ a1: take({ gainDb: -6 }) }, "a1")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await press(() => result.current.play())
    // It is given its moment to wake, then goes direct.
    await flush(MIXER_WAKE_WAIT_MS + 30)
    const a = FakeAudio.instances[0]
    expect(ctx.resumes).toBeGreaterThan(0)
    expect(ctx.routed).toEqual([])
    expect(a.paused).toBe(false)
    expect(a.volume).toBeCloseTo(dB(-6), 5)
  })

  it("…and once the context runs (woken by something else mid-take), it finishes direct; the next play goes through the mixer", async () => {
    StubCtx.canWake = false
    const ctx = getOutputContext() as unknown as StubCtx
    const cell = cellOf({ a1: take({ gainDb: -6 }) }, "a1")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await press(() => result.current.play())
    await flush(MIXER_WAKE_WAIT_MS + 30)
    const a = FakeAudio.instances[0]
    ctx.wake()
    a.emit("timeupdate")
    expect(ctx.routed).toEqual([])
    act(() => result.current.pause())
    a.currentTime = 1.2
    await press(() => result.current.play())
    await flush()
    expect(FakeAudio.instances).toHaveLength(1)
    expect(ctx.routed).toEqual([a])
    expect(a.volume).toBe(1)
    expect(a.currentTime).toBeCloseTo(1.2)
    expect(a.paused).toBe(false)
  })

  it("a cut take played joined, the context asleep: each piece at its own level on the player", async () => {
    StubCtx.canWake = false
    getOutputContext()
    const cell = cellOf({
      a1: take({ trimEndMs: 1000, gainDb: -6 }),
      "a1-2": take({ trimStartMs: 1500, trimEndMs: 3000, pieceOf: "a1", gainDb: -12 }),
    }, "a1")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    act(() => result.current.setTrim(0, 3, [{ start: 1, end: 1.5 }]))
    await press(() => result.current.play())
    await flush(MIXER_WAKE_WAIT_MS + 30)
    const a = FakeAudio.instances[0]
    expect(a.volume).toBeCloseTo(dB(-6), 5)
    // 1.2 s into the joined clip is 1.7 s into the recording: the second piece.
    a.currentTime = 1.2
    a.emit("timeupdate")
    expect(a.volume).toBeCloseTo(dB(-12), 5)
  })
})

describe("finding 2: a take with a level that is not on this device plays at once", () => {
  it("streams straight away with its level on the player, while its bytes are fetched behind it", async () => {
    cache.bytes = null
    const download = deferred<Uint8Array>()
    net.download = () => download.promise
    const cell = cellOf({ a1: take({ gainDb: -6 }) }, "a1")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await press(() => result.current.play())
    await flush()
    const a = FakeAudio.instances[0]
    expect(a).toBeTruthy()
    expect(a.src.startsWith("https://")).toBe(true)
    expect(a.paused).toBe(false)
    expect(result.current.state).toBe("ready")
    expect(a.volume).toBeCloseTo(dB(-6), 5)
    expect(net.fetched).toBe(1)
  })

  it("a raised take streamed plays at its recorded level, its fade-in stepped from silence", async () => {
    cache.bytes = null
    net.download = () => new Promise(() => {})
    const cell = cellOf({ a1: take({ gainDb: 9, fadeInMs: 200 }) }, "a1")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await press(() => result.current.play())
    await flush()
    const a = FakeAudio.instances[0]
    // A player's volume stops at 1: it cannot be raised above as recorded.
    expect(a.volume).toBe(0)
    a.currentTime = 0.1
    a.emit("timeupdate")
    expect(a.volume).toBe(1)
  })

  it("its bytes arriving mid-take change nothing while it plays; the next play goes through the mixer, where it was", async () => {
    cache.bytes = null
    const download = deferred<Uint8Array>()
    net.download = () => download.promise
    const ctx = getOutputContext() as unknown as StubCtx
    ctx.wake()
    const cell = cellOf({ a1: take({ gainDb: -6 }) }, "a1")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await press(() => result.current.play())
    await flush()
    const streamed = FakeAudio.instances[0]
    await act(async () => { download.resolve(bytes5); await download.promise })
    await flush()
    expect(FakeAudio.instances).toHaveLength(1)
    expect(streamed.paused).toBe(false)
    expect(ctx.routed).toEqual([])
    act(() => result.current.pause())
    streamed.currentTime = 1.2
    await press(() => result.current.play())
    await flush()
    const made = FakeAudio.instances[1]
    expect(made.src.startsWith("blob:")).toBe(true)
    expect(ctx.routed).toEqual([made])
    act(() => made.onloadedmetadata?.())
    expect(made.currentTime).toBeCloseTo(1.2)
    expect(made.paused).toBe(false)
  })

  it("a failed download still plays the take, streamed, with no error", async () => {
    cache.bytes = null
    net.download = async () => { throw new Error("offline mid-way") }
    const cell = cellOf({ a1: take({ gainDb: -6 }) }, "a1")
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    await press(() => result.current.play())
    await flush()
    expect(FakeAudio.instances[0].paused).toBe(false)
    expect(result.current.state).toBe("ready")
    expect(result.current.error).toBeNull()
  })
})

describe("one take at a time, and nothing starts after you have moved on", () => {
  it("another take started while the first was still loading: the first does not start on top of it", async () => {
    cache.bytes = null
    const held = deferred<string>()
    net.streamUrl = (id) => (id === "a1" ? held.promise : Promise.resolve(`https://sync.example/audio/${id}.wav?t=x`))
    const first = renderHook(() => useCellAudio(project, cellOf({ a1: take({ gainDb: -6 }) }, "a1"), "f1"))
    const second = renderHook(() => useCellAudio(project, cellOf({ b1: take({ gainDb: -6 }, "b1") }, "b1"), "f1"))
    await press(() => first.result.current.play())
    await press(() => second.result.current.play())
    await flush()
    const b = FakeAudio.instances.find((x) => x.src.includes("/b1."))!
    expect(b.paused).toBe(false)
    await act(async () => { held.resolve("https://sync.example/audio/a1.wav?t=x"); await held.promise })
    await flush()
    const a = FakeAudio.instances.find((x) => x.src.includes("/a1."))
    expect(a?.paused ?? true).toBe(true)
    expect(b.paused).toBe(false)
  })

  it("pause pressed while it loads: it does not start", async () => {
    cache.bytes = null
    const held = deferred<string>()
    const download = deferred<Uint8Array>()
    net.streamUrl = () => held.promise
    net.download = () => download.promise
    const { result } = renderHook(() => useCellAudio(project, cellOf({ a1: take({ gainDb: -6 }) }, "a1"), "f1"))
    await press(() => result.current.play())
    act(() => result.current.pause())
    await act(async () => { held.resolve("https://sync.example/audio/a1.wav?t=x"); download.resolve(bytes5); await held.promise })
    await flush()
    expect(FakeAudio.instances.every((x) => x.paused)).toBe(true)
  })

  it("its row gone while it loads (another file, the recording window closed): nothing plays", async () => {
    cache.bytes = null
    const held = deferred<string>()
    const download = deferred<Uint8Array>()
    net.streamUrl = () => held.promise
    net.download = () => download.promise
    const { result, unmount } = renderHook(() => useCellAudio(project, cellOf({ a1: take({ gainDb: -6 }) }, "a1"), "f1"))
    await press(() => result.current.play())
    unmount()
    await act(async () => { held.resolve("https://sync.example/audio/a1.wav?t=x"); download.resolve(bytes5); await held.promise })
    await flush()
    expect(FakeAudio.instances.every((x) => x.paused)).toBe(true)
  })
})
