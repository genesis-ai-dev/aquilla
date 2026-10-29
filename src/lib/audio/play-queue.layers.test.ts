// AQU-2252 (Sam, Oct 28, option A): following the recordings, a take on an
// added track is a LAYER, and it PLAYS — from its own start, for its own
// length, mixed with its line, still ringing when the next line starts, and
// silenced by its track's mute.
//
// Before this the programme transport cued only each line's main take and its
// source: every added track was silent while the file followed its
// recordings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getDubDebugSnapshot,
  getQueueState,
  pauseQueue,
  resumeQueue,
  setQueueAudibility,
  setQueueTargetSlots,
  setQueueTimingMode,
  startQueue,
  startQueueAtTime,
  stopQueue,
  type PlayContext,
} from "./play-queue"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
  /** Sources matching this construct UNREADY until `makeReady()`. */
  static deferSrc: (src: string) => boolean = () => false
  private _t = 0
  get currentTime(): number {
    return this._t
  }
  set currentTime(v: number) {
    this._t = v
  }
  duration = 600
  paused = true
  ended = false
  muted = false
  volume = 1
  playbackRate = 1
  readyState = 4
  error = null
  preload = ""
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  oncanplay: (() => void) | null = null
  onplay: (() => void) | null = null
  onplaying: (() => void) | null = null
  onpause: (() => void) | null = null
  private pendingPlays: (() => void)[] = []
  private deferred: boolean
  constructor(src: string) {
    this.src = src
    this.deferred = FakeAudio.deferSrc(src)
    if (this.deferred) this.readyState = 0
    FakeAudio.instances.push(this)
    if (!this.deferred) queueMicrotask(() => this.onloadedmetadata?.())
  }
  async play(): Promise<void> {
    if (this.deferred) await new Promise<void>((res) => this.pendingPlays.push(res))
    this.paused = false
    this.onplay?.()
  }
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.onpause?.()
  }
  makeReady(): void {
    if (!this.deferred) return
    this.deferred = false
    this.readyState = 4
    this.onloadedmetadata?.()
    this.oncanplay?.()
    for (const fn of [...(this.listeners.get("canplay") ?? [])]) fn()
    for (const res of this.pendingPlays.splice(0)) res()
  }
  /** A timeupdate tick at clip second `t` — playback, not a seek. */
  tick(t: number): void {
    this._t = t
    this.ontimeupdate?.()
  }
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
    if (!this.deferred && (type === "canplay" || type === "seeked")) queueMicrotask(fn)
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
}

const settle = async (): Promise<void> => {
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((res) => setTimeout(res, 0))
  }
}

const TRACK = "trk-1"

type Take = { durationMs: number; trimStartMs?: number; trimEndMs?: number; targetOffsetMs?: number }

/** A line of a book with no times: a main take and maybe a Track 1 take. */
function line(id: string, mainMs: number | null, layer?: Take, over: Partial<CellData> = {}): CellData {
  const mainId = `audio-${id}-1700000000-main.webm`
  const layerId = `audio-${id}-1700000500-layer.webm`
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    ...(mainMs != null ? { selectedAudioId: mainId } : {}),
    ...(layer ? { selectedBySlot: { [TRACK]: layerId } } : {}),
    attachments: {
      ...(mainMs != null ? { [mainId]: { type: "audio", url: `http://audio.test/${id}.webm`, slot: "recording", durationMs: mainMs } } : {}),
      ...(layer ? { [layerId]: { type: "audio", url: `http://audio.test/${id}-layer.webm`, slot: TRACK, ...layer } } : {}),
    },
    ...over,
  } as unknown as CellData
}

/**
 * b1: 0–2 s. b2: 2–4 s, with a Track 1 take of 3 s trimmed to 0.5–3.0 whose
 * sample zero is placed on b2's start — so it sounds 2.5–5.0 s, running a
 * second over b3. b3: 4–6 s.
 */
const LAYER: Take = { durationMs: 3000, trimStartMs: 500, trimEndMs: 3000, targetOffsetMs: 0 }
const book = (over: Partial<CellData> = {}) => [line("b1", 2000), line("b2", 2000, LAYER, over), line("b3", 2000)]

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

const el = (name: string): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src === `http://audio.test/${name}.webm`)
const layerEntries = () => getDubDebugSnapshot().pool.filter((e) => e.slot === TRACK)

beforeEach(() => {
  FakeAudio.instances = []
  FakeAudio.deferSrc = () => false
  vi.stubGlobal("Audio", FakeAudio)
  setQueueTargetSlots(["recording", TRACK])
  setQueueAudibility({ source: true, target: true })
  setQueueTimingMode("audioFirst")
})

afterEach(() => {
  stopQueue()
  setQueueTimingMode("dubbing")
  setQueueTargetSlots(["recording"])
  vi.unstubAllGlobals()
})

describe("following the recordings, a take on an added track plays (AQU-2252)", () => {
  it("sounds from its own start, mixed with its line", async () => {
    startQueue(ctxFor(book()), 1)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(el("b2")!.paused).toBe(false)
    // Its start is half a second into b2: nothing sounding yet (it may be
    // made ready ahead of its turn, parked, like a line's next take).
    expect(layerEntries()).toHaveLength(0)
    expect(el("b2-layer")?.paused ?? true).toBe(true)

    el("b2")!.tick(1) // programme 3.0 s
    await settle()
    const layer = el("b2-layer")!
    expect(layerEntries()).toHaveLength(1)
    expect(layer.paused).toBe(false)
    // Joined half a second past its audible start, on its own clip's clock.
    expect(layer.currentTime).toBeCloseTo(1, 2)
    // And the line's own take plays on beside it.
    expect(el("b2")!.paused).toBe(false)
  })

  it("keeps ringing when the next line starts, and stops at its own end", async () => {
    startQueue(ctxFor(book()), 1)
    await settle()
    el("b2")!.tick(1)
    await settle()
    const layer = el("b2-layer")!

    el("b2")!.tick(2) // b2's take is over — on to b3
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(layer.paused).toBe(false)
    expect(layerEntries()).toHaveLength(1)

    layer.tick(3) // its trim end
    await settle()
    expect(layerEntries()).toHaveLength(0)
    expect(el("b3")!.paused).toBe(false)
  })

  it("a seek into the middle of it, on the next line, joins it there", async () => {
    startQueueAtTime(ctxFor(book()), 4.5)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    const layer = el("b2-layer")!
    expect(layer.paused).toBe(false)
    // 2 s after its audible start at 2.5 s, past its 0.5 s head trim.
    expect(layer.currentTime).toBeCloseTo(2.5, 2)
  })

  it("is silenced by its own track's mute, and the line's take is not", async () => {
    startQueueAtTime(ctxFor(book()), 3)
    await settle()
    setQueueAudibility({ source: true, target: true, bySlot: { [TRACK]: false } })
    expect(el("b2-layer")!.muted).toBe(true)
    expect(el("b2")!.muted).toBe(false)
  })

  it("pauses and resumes with the transport", async () => {
    startQueueAtTime(ctxFor(book()), 3)
    await settle()
    const layer = el("b2-layer")!
    pauseQueue()
    expect(layer.paused).toBe(true)
    await resumeQueue()
    await settle()
    expect(layer.paused).toBe(false)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
  })

  it("waits for its line's take to be ready, like every side does", async () => {
    // b3's take is still crossing the network when we land on it.
    FakeAudio.deferSrc = (src) => src.endsWith("/b3.webm")
    startQueueAtTime(ctxFor(book()), 4.5)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "loading", cellId: "b3" })
    expect(el("b2-layer")?.paused ?? true).toBe(true)

    el("b3")!.makeReady()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(el("b2-layer")!.paused).toBe(false)
  })

  it("a hidden line's layer never sounds", async () => {
    startQueueAtTime(ctxFor(book({ hidden: true } as Partial<CellData>)), 4.5)
    await settle()
    expect(el("b2-layer")).toBeUndefined()
    expect(layerEntries()).toHaveLength(0)
  })

  it("a line nobody has recorded on the main track still plays its layer", async () => {
    // b2 has no main take: it lasts its stand-in, and its layer sounds in it.
    const cells = [line("b1", 2000), line("b2", null, { durationMs: 1000, targetOffsetMs: 0 }), line("b3", 2000)]
    startQueue(ctxFor(cells), 0)
    await settle()
    el("b1")!.tick(2)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(el("b2-layer")!.paused).toBe(false)
  })
})
