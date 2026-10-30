// AQU-2252 (Sam, Oct 29): following the recordings, every track sets its
// lines' lengths by default, and the transport plays each line for as long as
// it lasts: a line recorded only on Boaz's track sounds Boaz's take and the
// next line waits for it; two voices over each other on two tracks are both
// heard out before the next line; a take on an added track still sounding
// when the original ends keeps the line going. A track made a layer sets no
// length, and one running on past the last line plays out to its end — the
// play strip reaches it and a seek can land in it.
//
// Before this the transport moved on the moment the line's own take (or its
// original) ended, cutting off whatever was still sounding on another track.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getDubDebugSnapshot,
  getQueueProgress,
  getQueueState,
  pauseQueue,
  resumeQueue,
  seekQueueToTime,
  setQueueAudibility,
  setQueueLayerTrackSlots,
  setQueueTargetSlots,
  setQueueTimingMode,
  skipBack,
  skipForward,
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
const CLIP = "http://audio.test/imported.mp3"
const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

type Take = { durationMs: number; trimStartMs?: number; trimEndMs?: number; targetOffsetMs?: number }

/** A line of a book with no times: maybe a main take, maybe a Track 1 take. */
function line(id: string, mainMs: number | null, track?: Take): CellData {
  const mainId = `audio-${id}-1700000000-main.webm`
  const trackId = `audio-${id}-1700000500-track.webm`
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    ...(mainMs != null ? { selectedAudioId: mainId } : {}),
    ...(track ? { selectedBySlot: { [TRACK]: trackId } } : {}),
    attachments: {
      ...(mainMs != null ? { [mainId]: { type: "audio", url: `http://audio.test/${id}.webm`, slot: "recording", durationMs: mainMs } } : {}),
      ...(track ? { [trackId]: { type: "audio", url: `http://audio.test/${id}-track.webm`, slot: TRACK, ...track } } : {}),
    },
  } as unknown as CellData
}

/** A timed line cut from an imported recording (its original), with maybe a
 *  Track 1 take and nothing on the main track. */
function sourceLine(id: string, startTime: number, endTime: number, track?: Take, mainMs?: number): CellData {
  const trackId = `audio-${id}-1700000500-track.webm`
  const mainId = `audio-${id}-1700000000-main.webm`
  return {
    id, fileId: "f1", original: "x".repeat(Math.round((endTime - startTime) * 14)), translated: "", medium: "media",
    startTime, endTime,
    ...(track ? { selectedBySlot: { [TRACK]: trackId } } : {}),
    ...(mainMs != null ? { selectedAudioId: mainId } : {}),
    attachments: {
      [SOURCE_ID]: { type: "audio", url: CLIP },
      ...(mainMs != null ? { [mainId]: { type: "audio", url: `http://audio.test/${id}.webm`, slot: "recording", durationMs: mainMs } } : {}),
      ...(track ? { [trackId]: { type: "audio", url: `http://audio.test/${id}-track.webm`, slot: TRACK, ...track } } : {}),
    },
  } as unknown as CellData
}

const ctxFor = (cells: CellData[]): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
})

const el = (name: string): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src === `http://audio.test/${name}.webm`)
const sourceEl = (): FakeAudio | undefined => [...FakeAudio.instances].reverse().find((a) => a.src === CLIP)
const trackEntries = () => getDubDebugSnapshot().pool.filter((e) => e.slot === TRACK)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  FakeAudio.instances = []
  FakeAudio.deferSrc = () => false
  vi.stubGlobal("Audio", FakeAudio)
  setQueueTargetSlots(["recording", TRACK])
  setQueueLayerTrackSlots([])
  setQueueAudibility({ source: true, target: true })
  setQueueTimingMode("audioFirst")
})

afterEach(() => {
  stopQueue()
  setQueueTimingMode("dubbing")
  setQueueTargetSlots(["recording"])
  setQueueLayerTrackSlots([])
  vi.unstubAllGlobals()
})

describe("following the recordings, every track's takes set their lines' lengths (AQU-2252, Oct 29)", () => {
  it("a line recorded only on an added track sounds its take, and the next line waits for it", async () => {
    // b2: nothing on the main track, a 0.3 s take on Track 1 → b2 lasts 0.3 s.
    const cells = [line("b1", 400), line("b2", null, { durationMs: 300, targetOffsetMs: 0 }), line("b3", 400)]
    startQueueAtTime(ctxFor(cells), 0.4)
    await settle()
    expect(getQueueProgress().duration).toBeCloseTo(1.1, 5)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(el("b2-track")!.paused).toBe(false)
    await wait(150)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(250)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("two voices over each other: the line waits for the longer one before moving on", async () => {
    // b2's main take is 0.2 s; its Track 1 take 0.5 s → b2 lasts 0.5 s.
    const cells = [line("b1", 400), line("b2", 200, { durationMs: 500, targetOffsetMs: 0 }), line("b3", 400)]
    startQueue(ctxFor(cells), 1)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(el("b2")!.paused).toBe(false)
    expect(el("b2-track")!.paused).toBe(false)

    el("b2")!.tick(0.2) // the main take is over…
    await settle()
    // …but Boaz is still speaking: the line holds, and b3 hasn't started.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    // (b3's take may be made ready ahead of its turn, parked.)
    expect(el("b3")?.paused ?? true).toBe(true)
    expect(el("b2-track")!.paused).toBe(false)
    expect(getQueueProgress().currentTime).toBeLessThan(0.4 + 0.5)

    await wait(450)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("following an original, the line waits for a take on an added track that outlasts it", async () => {
    // s1 is 0.3 s of the recording; its Track 1 take is 0.6 s → s1 lasts 0.6 s.
    const cells = [sourceLine("s1", 0, 0.3, { durationMs: 600, targetOffsetMs: 0 }), sourceLine("s2", 0.3, 0.6)]
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "s1" })
    expect(el("s1-track")!.paused).toBe(false)

    sourceEl()!.tick(0.3) // the original's part of s1 is over…
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "s1" })
    expect(sourceEl()!.paused).toBe(true)
    expect(el("s1-track")!.paused).toBe(false)

    await wait(450)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "s2" })
  })

  it("when the line's own take ends first, its original carries on to the line's end, then the next line", async () => {
    // s1: 1 s of the recording, a 0.2 s main take, a 0.5 s Track 1 take → s1
    // lasts 0.5 s, and the original sounds all of it.
    const cells = [sourceLine("s1", 0, 1, { durationMs: 500, targetOffsetMs: 0 }, 200), sourceLine("s2", 1, 2)]
    startQueue(ctxFor(cells), 0)
    await settle()
    el("s1")!.tick(0.2) // the main take is over
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "s1" })
    expect(sourceEl()!.paused).toBe(false)
    sourceEl()!.tick(0.3)
    expect(getQueueProgress().currentTime).toBeCloseTo(0.3, 5)
    sourceEl()!.tick(0.5) // the original's share of s1 is over, and so is s1
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "s2" })
  })

  it("pausing and resuming while the line waits on another track's take holds the rest of it", async () => {
    const cells = [line("b1", 400), line("b2", 200, { durationMs: 500, targetOffsetMs: 0 }), line("b3", 400)]
    startQueue(ctxFor(cells), 1)
    await settle()
    el("b2")!.tick(0.2)
    await settle()
    pauseQueue()
    expect(el("b2-track")!.paused).toBe(true)
    await wait(400) // paused far longer than what was left of the line
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    await resumeQueue()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(el("b2-track")!.paused).toBe(false)
    await wait(450)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
  })

  it("next line from a line waiting on another track's take goes to the next line", async () => {
    const cells = [line("b1", 400), line("b2", 200, { durationMs: 500, targetOffsetMs: 0 }), line("b3", 400)]
    startQueue(ctxFor(cells), 1)
    await settle()
    el("b2")!.tick(0.2)
    await settle()
    skipForward()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    expect(trackEntries()).toHaveLength(0)
  })

  it("making the track a layer while it plays re-lays the lines at once", async () => {
    const cells = [line("b1", 400), line("b2", 200, { durationMs: 500, targetOffsetMs: 0 }), line("b3", 400)]
    startQueue(ctxFor(cells), 0)
    await settle()
    expect(getQueueProgress().duration).toBeCloseTo(1.3, 5)
    setQueueLayerTrackSlots([TRACK])
    expect(getQueueProgress().duration).toBeCloseTo(1.0, 5)
    setQueueLayerTrackSlots([])
    expect(getQueueProgress().duration).toBeCloseTo(1.3, 5)
  })
})

describe("a layer past the last line plays out to its end (AQU-2252, Oct 29)", () => {
  // b2 is the last line, 0.4–0.6 s, 0.2 s on the main track; its Track 1
  // take, a layer, runs 0.6 s from b2's start — to 1.0 s, 0.4 s past the end
  // of the last line.
  const book = () => [line("b1", 400), line("b2", 200, { durationMs: 600, targetOffsetMs: 0 })]

  beforeEach(() => setQueueLayerTrackSlots([TRACK]))

  it("the play strip's length reaches its end", async () => {
    startQueue(ctxFor(book()), 0)
    await settle()
    expect(getQueueProgress().duration).toBeCloseTo(1.0, 5)
  })

  it("keeps sounding after the last line, then playback ends", async () => {
    startQueue(ctxFor(book()), 1)
    await settle()
    expect(el("b2-track")!.paused).toBe(false)
    el("b2")!.tick(0.2) // the last line is over
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing" })
    expect(el("b2-track")!.paused).toBe(false)
    expect(trackEntries()).toHaveLength(1)
    await wait(550)
    await settle()
    expect(getQueueState().kind).toBe("idle")
  })

  it("a seek past the last line, into the layer, joins it there", async () => {
    startQueueAtTime(ctxFor(book()), 0.7)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing" })
    const layer = el("b2-track")!
    expect(layer.paused).toBe(false)
    // 0.3 s after its start at 0.4 s.
    expect(layer.currentTime).toBeCloseTo(0.3, 2)
    expect(getQueueProgress().currentTime).toBeGreaterThanOrEqual(0.7)
    // …and a seek there while paused waits there.
    pauseQueue()
    seekQueueToTime(0.8)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "paused" })
    expect(getQueueProgress().currentTime).toBeCloseTo(0.8, 2)
  })
})

describe("after the last line, under a layer playing out (AQU-2252)", () => {
  const book = () => [line("b1", 400), line("b2", 200, { durationMs: 600, targetOffsetMs: 0 })]
  beforeEach(() => setQueueLayerTrackSlots([TRACK]))

  it("pausing and resuming there carries on there", async () => {
    startQueueAtTime(ctxFor(book()), 0.7)
    await settle()
    pauseQueue()
    const layer = el("b2-track")!
    expect(layer.paused).toBe(true)
    const at = getQueueProgress().currentTime
    await resumeQueue()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing" })
    expect(layer.paused).toBe(false)
    // Not back inside the last line.
    expect(getQueueProgress().currentTime).toBeGreaterThanOrEqual(at - 0.001)
    expect(el("b2")?.paused ?? true).toBe(true)
  })

  it("back from there is the last line", async () => {
    startQueueAtTime(ctxFor(book()), 0.7)
    await settle()
    skipBack()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(0.4, 2)
  })
})

describe("following the source, nothing changes (AQU-2252)", () => {
  it("the same takes sound at the same moments whether or not the track is a layer", async () => {
    const run = async (layered: boolean) => {
      FakeAudio.instances = []
      setQueueTimingMode("dubbing")
      setQueueLayerTrackSlots(layered ? [TRACK] : [])
      const cells = [
        sourceLine("s1", 0, 1, { durationMs: 2000, targetOffsetMs: 200 }),
        sourceLine("s2", 1, 2, { durationMs: 500, targetOffsetMs: 0 }),
      ]
      startQueue(ctxFor(cells), 0)
      await settle()
      const seen: unknown[] = []
      for (const t of [0.1, 0.3, 1.1, 1.6]) {
        sourceEl()!.tick(t)
        await settle()
        seen.push({
          state: getQueueState(),
          at: getQueueProgress().currentTime,
          pool: getDubDebugSnapshot().pool.map((e) => [e.cellId, e.slot, e.audioId]),
        })
      }
      stopQueue()
      return seen
    }
    const plain = await run(false)
    expect(plain.some((s) => (s as { pool: unknown[] }).pool.length > 0)).toBe(true)
    expect(await run(true)).toEqual(plain)
  })
})

describe("a line's own take that stops short, under another track's take (AQU-2252)", () => {
  // b2: a 2 s main take and a 2.5 s Track 1 take → b2 lasts 2.5 s (0.4–2.9).
  const book = () => [line("b1", 400), line("b2", 2000, { durationMs: 2500, targetOffsetMs: 0 }), line("b3", 400)]

  it("a take that fails partway holds the line from where it stopped, not from where it was meant to end", async () => {
    startQueue(ctxFor(book()), 1)
    await settle()
    el("b2")!.tick(0.5)
    expect(getQueueProgress().currentTime).toBeCloseTo(0.9, 5)
    el("b2")!.onerror?.() // an expired stream token, half a second in
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(el("b2-track")!.paused).toBe(false)
    // Not 2.4 s, the end of the 2 s the take was meant to play: the playhead
    // stays with Boaz's take, which is still at 0.5 s.
    expect(getQueueProgress().currentTime).toBeLessThan(1)
  })

  it("a take whose clip runs out before its measured length holds the line from where it ran out", async () => {
    startQueue(ctxFor(book()), 1)
    await settle()
    el("b2")!.tick(1.2)
    el("b2")!.onended?.()
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(1.6, 1)
  })

  it("a take that plays to its end still holds from its end", async () => {
    startQueue(ctxFor(book()), 1)
    await settle()
    el("b2")!.tick(2.0)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(2.4, 1)
  })
})

describe("more layers sounding at once than the players allow (AQU-2252)", () => {
  // Eight lines of 0.1 s, each with a 3 s take on Track 1, a layer: at 0.75 s
  // all eight are sounding, over the six players two tracks get.
  const book = () =>
    Array.from({ length: 8 }, (_, i) => line(`b${i + 1}`, 100, { durationMs: 3000, targetOffsetMs: 0 }))
  const layerPlayers = () => FakeAudio.instances.filter((a) => a.src.endsWith("-track.webm"))

  beforeEach(() => setQueueLayerTrackSlots([TRACK]))

  it("the ones sounding keep sounding; the rest wait instead of pushing each other out", async () => {
    startQueueAtTime(ctxFor(book()), 0.75)
    await settle()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b8" })
    const sounding = trackEntries().map((e) => e.cellId)
    expect(sounding.length).toBeGreaterThan(0)
    const made = layerPlayers().length
    await wait(320) // five boundary checks
    await settle()
    // No layer was stopped and started again, and none was fetched again.
    expect(layerPlayers().length).toBe(made)
    expect(trackEntries().map((e) => e.cellId)).toEqual(sounding)
    // The earliest ones sound (a music bed under the effects starts first).
    expect(sounding).toContain("b1")
  })
})
