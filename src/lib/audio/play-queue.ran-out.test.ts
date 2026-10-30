// AQU-1758: a book's timeline holds one chapter and so does the run it starts.
// The workspace carries Play all into the next chapter when a run RAN OUT —
// played its last line to the end — and only then: a stop or a pause is the
// person's, and must never start the next chapter.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getQueueState,
  onQueueRanOut,
  pauseQueue,
  setQueueTimingMode,
  startQueue,
  stopQueue,
  type PlayContext,
} from "./play-queue"
import type { CellData } from "@/hooks/useCells"

const CLIP = "http://audio.test/imported.mp3" // direct URL → no token/network path

class FakeAudio {
  static instances: FakeAudio[] = []
  /** Readiness gate tests: sources matching this predicate construct UNREADY
   *  (readyState 0, no metadata, play() held) until `makeReady()` is called —
   *  a clip still crossing the network. Default: everything ready instantly. */
  static deferSrc: (src: string) => boolean = () => false
  /** Every ENGINE write to currentTime (a seek). `tick()` — the element's own
   *  playback progress — bypasses this. The seek-free boundary work (pre-merge
   *  round) asserts on it: an automatic contiguous advance must record ZERO
   *  seeks. */
  seekLog: number[] = []
  /** Engine-initiated pauses (progQuiet and friends). */
  pauseCount = 0
  private _t = 0
  get currentTime(): number {
    return this._t
  }
  set currentTime(v: number) {
    this.seekLog.push(v)
    this._t = v
  }
  duration = 600
  paused = true
  ended = false
  muted = false
  volume = 1
  playbackRate = 1
  /** HAVE_ENOUGH_DATA by default; 0 while deferred. */
  readyState = 4
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  oncanplay: (() => void) | null = null
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  /** play() promises issued while unready — resolved by makeReady(). */
  private pendingPlays: (() => void)[] = []
  private deferred: boolean
  constructor(src: string) {
    this.src = src
    this.deferred = FakeAudio.deferSrc(src)
    if (this.deferred) this.readyState = 0
    FakeAudio.instances.push(this)
    // A real element announces metadata shortly after the src is set, which is
    // when the queue applies a pending seek (Safari rejects earlier ones).
    if (!this.deferred) queueMicrotask(() => this.onloadedmetadata?.())
  }
  async play(): Promise<void> {
    if (this.deferred) {
      // A real element's play() during buffering resolves once playback can
      // begin — hold it, like the network would.
      await new Promise<void>((res) => this.pendingPlays.push(res))
    }
    this.paused = false
    this.onplay?.()
  }
  pause(): void {
    if (this.paused) return
    this.pauseCount++
    this.paused = true
    this.onpause?.()
  }
  /** The deferred clip's bytes arrived: fire metadata + canplay, release
   *  held play() calls. */
  makeReady(): void {
    if (!this.deferred) return
    this.deferred = false
    this.readyState = 4
    this.onloadedmetadata?.()
    this.oncanplay?.()
    this.emit("canplay")
    const held = this.pendingPlays.splice(0)
    for (const res of held) res()
  }
  /** Simulate a network/decode failure for a deferred clip. */
  failLoad(): void {
    this.deferred = false
    this.pendingPlays.splice(0) // held play() promises just never resolve play
    this.onerror?.()
    this.emit("error")
  }
  /** Drive a timeupdate tick, the way a real element would ~4×/second.
   *  Writes the backing field directly — playback progress is not a seek. */
  tick(t: number): void {
    this._t = t
    this.ontimeupdate?.()
  }
  // Listener support for the gate's source-readiness watch (canplay/seeked/
  // error). makeReady/failLoad fire these alongside the on* fields.
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
    // Matches real elements closely enough for the gate: a ready element
    // fires canplay-class listeners immediately after subscription in our
    // fake (the gate checks readyState first, so this is rarely reached).
    if (!this.deferred && (type === "canplay" || type === "seeked")) queueMicrotask(() => this.emit(type))
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  private emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn()
  }
}

/** Let the transport's awaits (src resolution, overlay fire) settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

/** A verse with a section of an imported recording. */
function verse(id: string, startTime: number, endTime: number): CellData {
  return {
    id, fileId: "f1", original: "", translated: "", medium: "media", startTime, endTime,
    attachments: { [SOURCE_ID]: { type: "audio", url: CLIP } },
  } as unknown as CellData
}

/** A verse of a book: no times, one recorded take. */
function bookVerse(id: string): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id, fileId: "f1", original: `Verse ${id}`, translated: "", medium: "text",
    selectedAudioId: takeId,
    attachments: { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, durationMs: 2_000 } },
  } as unknown as CellData
}

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

const sourceEl = (): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src === CLIP)
const takeEl = (id: string): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src.includes(`/${id}.webm`))

let ranOut: PlayContext[] = []
let unsubscribe: () => void = () => {}

beforeEach(() => {
  FakeAudio.instances = []
  FakeAudio.deferSrc = () => false
  vi.stubGlobal("Audio", FakeAudio)
  ranOut = []
  unsubscribe = onQueueRanOut((ctx) => { ranOut.push(ctx) })
})

afterEach(() => {
  unsubscribe()
  stopQueue()
  setQueueTimingMode("dubbing")
  vi.unstubAllGlobals()
})

describe("a run that plays to the end of its lines", () => {
  it("says so once, with its own lines, after the queue has gone idle (laid out end to end)", async () => {
    const ctx = ctxFor([verse("v1", 0, 4)])
    setQueueTimingMode("audioFirst")
    let stateWhenTold: string | null = null
    const off = onQueueRanOut(() => { stateWhenTold = getQueueState().kind })
    startQueue(ctx, 0)
    await settle()
    sourceEl()!.tick(4)
    await settle()
    off()
    expect(ranOut).toEqual([ctx])
    expect(stateWhenTold).toBe("idle")
  })

  it("says so for a book played line by line", async () => {
    const ctx = ctxFor([bookVerse("a"), bookVerse("b")])
    startQueue(ctx, 0)
    await settle()
    takeEl("a")!.onended?.()
    await settle()
    expect(ranOut).toEqual([])
    takeEl("b")!.onended?.()
    await settle()
    expect(ranOut).toEqual([ctx])
    expect(getQueueState().kind).toBe("idle")
  })

  it("says nothing when the person stops or pauses", async () => {
    setQueueTimingMode("audioFirst")
    startQueue(ctxFor([verse("v1", 0, 4), verse("v2", 4, 8)]), 0)
    await settle()
    pauseQueue()
    await settle()
    stopQueue()
    await settle()
    expect(ranOut).toEqual([])
  })
})
