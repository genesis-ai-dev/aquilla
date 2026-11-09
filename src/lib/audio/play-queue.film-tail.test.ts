// AQU-2253 (Sam, Nov 9): following the recordings, a LINKED film plays on its
// own clock, so Play runs to whichever ends later: the lines or the film.
//
// The film is not the queue's to play: its picture follows the programme's
// clock (MediaVideoPane), with its own sound. What the queue does is keep that
// clock running past the last line, to the film's end, the way it already does
// under a take on another track that runs on past the last line
// (`progEnterTail`). The workspace says how long the film is and which lines
// it belongs to (`setProgrammeFilm`); with no film, an imported one, one that
// could not be loaded, or following the source, it says nothing and playback
// ends where the lines end, as it always did.
//
// The clock after the last line is a held ticker, not an element, so these
// tests drive fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getQueueProgress,
  getQueueState,
  onQueueRanOut,
  pauseQueue,
  resumeQueue,
  seekQueueToTime,
  setProgrammeFilm,
  setQueueLayerTrackSlots,
  setQueueRate,
  setQueueTargetSlots,
  setQueueTimingMode,
  skipBack,
  startQueue,
  startQueueAtTime,
  stopQueue,
  updateQueueCells,
  type PlayContext,
} from "./play-queue"
import { resetSkipSilentLinesPrefCacheForTests, setSkipSilentLinesPref } from "@/lib/store/skip-silent-lines-pref"
import type { CellData } from "@/hooks/useCells"

class FakeAudio {
  static instances: FakeAudio[] = []
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
  preload = ""
  error = null
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  oncanplay: (() => void) | null = null
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
    queueMicrotask(() => this.onloadedmetadata?.())
  }
  async play(): Promise<void> {
    this.paused = false
    this.onplay?.()
  }
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.onpause?.()
  }
  /** A timeupdate tick — playback progress, not a seek. */
  tick(t: number): void {
    this._t = t
    this.ontimeupdate?.()
  }
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
    if (type === "canplay" || type === "seeked") queueMicrotask(() => fn())
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
}

const TRACK = "trk-1"

/**
 * A line of a file with a linked film. Recorded: a take of `takeMs` on the
 * main track. Not recorded: a stand-in from its words, which here always
 * lasts exactly 1.5 s ("bN words" reads in well under the 1.5 s floor).
 * `layerMs`: a take on Track 1 as well, from the line's start.
 */
function line(id: string, takeMs?: number, layerMs?: number): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  const layerId = `audio-${id}-1700000500-track.webm`
  return {
    id,
    fileId: "f1",
    original: `${id} words`,
    translated: "",
    medium: "text",
    ...(takeMs != null ? { selectedAudioId: takeId } : {}),
    ...(layerMs != null ? { selectedBySlot: { [TRACK]: layerId } } : {}),
    attachments: {
      ...(takeMs != null ? { [takeId]: { type: "audio", url: `http://audio.test/${id}.webm`, slot: "recording", durationMs: takeMs } } : {}),
      ...(layerMs != null
        ? { [layerId]: { type: "audio", url: `http://audio.test/${id}-track.webm`, slot: TRACK, durationMs: layerMs, targetOffsetMs: 0 } }
        : {}),
    },
  } as unknown as CellData
}

const ctxFor = (cells: CellData[], over: Partial<PlayContext> = {}): PlayContext => ({
  cells,
  projectId: "p1",
  session: { jwt: "t", username: "dev", createdAt: "" } as PlayContext["session"],
  ...over,
})

/** The workspace's word: this file's lines have a linked film `endSec` long. */
const linkFilm = (endSec: number, cells: CellData[]) =>
  setProgrammeFilm({ endSec, cellIds: new Set(cells.map((c) => c.id)) })

const el = (name: string): FakeAudio | undefined =>
  [...FakeAudio.instances].reverse().find((a) => a.src === `http://audio.test/${name}.webm`)
const anythingSounding = (): boolean => FakeAudio.instances.some((a) => !a.paused)

/** Let the transport's awaits settle, then move the clock on `ms`. */
const wait = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

// b1 recorded 2 s → [0, 2); b2 recorded 3 s → [2, 5). The lines end at 5 s.
const recorded = () => [line("b1", 2_000), line("b2", 3_000)]

/** Play the two recorded lines out, to the end of the last one. */
async function playTheLinesOut(cells: CellData[], over: Partial<PlayContext> = {}): Promise<void> {
  startQueue(ctxFor(cells, over), 0)
  await wait()
  el("b1")!.tick(2)
  await wait()
  expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
  el("b2")!.tick(3)
  await wait()
}

let ranOut = 0
let stopRanOut: () => void = () => {}

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal("Audio", FakeAudio)
  localStorage.removeItem("aq.skip-silent-lines.v1")
  resetSkipSilentLinesPrefCacheForTests()
  vi.useFakeTimers()
  setQueueTargetSlots(["recording"])
  setQueueLayerTrackSlots([])
  setQueueTimingMode("audioFirst")
  ranOut = 0
  stopRanOut = onQueueRanOut(() => { ranOut++ })
})

afterEach(() => {
  stopRanOut()
  stopQueue()
  setProgrammeFilm(null)
  setQueueRate(1)
  setQueueTimingMode("dubbing")
  setQueueTargetSlots(["recording"])
  setQueueLayerTrackSlots([])
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.removeItem("aq.skip-silent-lines.v1")
  resetSkipSilentLinesPrefCacheForTests()
})

describe("a linked film longer than the lines: Play runs on to the film's end", () => {
  it("carries on past the last line, the clock moving and the transport playing, and stops at the film's end", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)

    // The last line is over. Still playing, on the film's clock, from 5 s.
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(5, 2)
    expect(getQueueProgress().programmeClock).toBe(true)
    // None of the queue's own players sound there: the film voices itself.
    expect(anythingSounding()).toBe(false)
    expect(ranOut).toBe(0)

    await wait(3_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(8, 1)

    // 12 s: the film's end.
    await wait(4_050)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("the length the transport reports is the film's", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueProgress().duration).toBeCloseTo(12, 5)
  })

  it("a click past the last line, then Play, plays the film from there to its end", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    // The click: the queue is idle, so it is cued, paused, where the click was.
    startQueueAtTime(ctxFor(cells), 9, { play: false })
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(9, 5)

    await resumeQueue()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(9, 1)
    // Not the lines again.
    expect(anythingSounding()).toBe(false)

    await wait(1_000)
    expect(getQueueProgress().currentTime).toBeCloseTo(10, 1)
    await wait(2_050)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("a seek past the last line while playing keeps playing from there", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    seekQueueToTime(10)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(10, 1)
    expect(anythingSounding()).toBe(false)
    await wait(2_050)
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("no line is playing over the film's tail (what captions the picture reads)", () => {
  it("says so past the last line, playing or cued there, and not on a line", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueProgress().filmTail).toBe(false)
    el("b1")!.tick(2)
    await wait()
    expect(getQueueProgress().filmTail).toBe(false)
    el("b2")!.tick(3)
    await wait()
    expect(getQueueProgress().filmTail).toBe(true)
    await wait(1_000)
    expect(getQueueProgress().filmTail).toBe(true)
    pauseQueue()
    expect(getQueueProgress().filmTail).toBe(true)
    // Back onto a line: that line is playing again.
    seekQueueToTime(3, { play: true })
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmTail).toBe(false)
  })

  it("a film shorter than the lines has no tail: the last line is the line, to its last moment", async () => {
    const cells = recorded()
    linkFilm(3, cells)
    startQueueAtTime(ctxFor(cells), 9, { play: false })
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    expect(getQueueProgress().filmTail).toBe(false)
  })

  it("under a take on another track playing out with no film, the last line is still the line playing", async () => {
    setQueueTargetSlots(["recording", TRACK])
    setQueueLayerTrackSlots([TRACK])
    await playTheLinesOut([line("b1", 2_000), line("b2", 3_000, 5_000)])
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().filmTail).toBe(false)
  })
})

describe("over the film's tail, the transport's other commands", () => {
  it("pause holds the clock where it is, and Play carries on from there", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(2_000)
    pauseQueue()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    const at = getQueueProgress().currentTime
    expect(at).toBeCloseTo(7, 1)

    // Paused is paused: nothing moves, nothing ends.
    await wait(20_000)
    expect(getQueueState()).toMatchObject({ kind: "paused" })
    expect(getQueueProgress().currentTime).toBe(at)

    await resumeQueue()
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(8, 1)
    await wait(4_050)
    expect(getQueueState().kind).toBe("idle")
  })

  it("a seek back into the lines plays the line there", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    seekQueueToTime(1)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    expect(getQueueProgress().currentTime).toBeCloseTo(1, 2)
    expect(el("b1")!.paused).toBe(false)
    // The tail's clock is gone: nothing ends the run while b1 plays.
    await wait(20_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
  })

  it("previous line goes back to the last line", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    skipBack()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(2, 2)
  })

  it("Stop stops, and nothing starts again later", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    stopQueue()
    expect(getQueueState().kind).toBe("idle")
    await wait(20_000)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(0)
  })

  it("a change of speed moves the clock at the new speed from where it was", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    expect(getQueueProgress().currentTime).toBeCloseTo(6, 1)
    setQueueRate(2)
    // 6 s left of the film, at double speed: 2 s of it in 1 s...
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing" })
    expect(getQueueProgress().currentTime).toBeCloseTo(8, 1)
    // ...and its end 3 s after the change, not 6.
    await wait(2_050)
    expect(getQueueState().kind).toBe("idle")
  })

  it("a take landing meanwhile does not disturb it", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    // The bar hands the queue the file's lines again on every change.
    updateQueueCells(recorded())
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(7, 1)
    expect(getQueueProgress().duration).toBeCloseTo(12, 5)
  })

  it("a line added meanwhile does not end it, whichever of the film's word and the run's list arrives first", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    // b0 is new, ahead of the others: the lines still end at b2.
    const more = [line("b0"), ...recorded()]
    // The film's word first: for a beat its lines are not the run's.
    linkFilm(12, more)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    updateQueueCells(more)
    linkFilm(12, more)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    // The lines are 1.5 s longer now (b0's stand-in); the film ends where it did.
    expect(getQueueProgress().duration).toBeCloseTo(12, 5)
    await wait(10_000)
    expect(getQueueState().kind).toBe("idle")
  })

  it("the film's length arriving late, over the tail of a take on another track, carries the run on to the film's end", async () => {
    setQueueTargetSlots(["recording", TRACK])
    setQueueLayerTrackSlots([TRACK])
    // b2's Track 1 take runs to 7 s, 2 s past the lines' end.
    const cells = [line("b1", 2_000), line("b2", 3_000, 5_000)]
    await playTheLinesOut(cells)
    await wait(1_000)
    linkFilm(12, cells)
    expect(getQueueProgress().duration).toBeCloseTo(12, 5)
    await wait(3_000)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(9, 1)
    await wait(3_050)
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("where Play still ends with the lines", () => {
  it("no film to run on (none, an imported one, one that could not be loaded): ends at the last line's end", async () => {
    await playTheLinesOut(recorded())
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("a film that stops being playable over its tail ends the run there: no waiting on a dead film", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    await wait(1_000)
    expect(getQueueState()).toMatchObject({ kind: "playing" })
    // The film pane reports it could not be loaded.
    setProgrammeFilm(null)
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("a film shorter than the lines: ends at the last line's end, and reports the lines' length", async () => {
    const cells = recorded()
    linkFilm(3, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueProgress().duration).toBeCloseTo(5, 5)
    el("b1")!.tick(2)
    await wait()
    el("b2")!.tick(3)
    await wait()
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("a seek past the end with no film lands on the last line's final moment", async () => {
    startQueueAtTime(ctxFor(recorded()), 9, { play: false })
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "paused", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(5, 2)
  })

  it("following the source: the film's length changes nothing the queue does", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    setQueueTimingMode("dubbing")
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    // The take's own clock and length, as ever.
    expect(getQueueProgress().programmeClock).toBe(false)
    expect(getQueueProgress().duration).not.toBeCloseTo(12, 5)
    // Its last line ends the run.
    el("b1")!.onended?.()
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    el("b2")!.onended?.()
    await wait()
    expect(getQueueState().kind).toBe("idle")
    await wait(20_000)
    expect(getQueueState().kind).toBe("idle")
  })

  it("a run of only some of the file's lines (a selection) stops at the end of those lines", async () => {
    const cells = [...recorded(), line("b3", 1_000)]
    linkFilm(12, cells)
    // b1 and b2 only.
    await playTheLinesOut(cells.slice(0, 2))
    expect(getQueueState().kind).toBe("idle")
    expect(ranOut).toBe(1)
  })

  it("one line played on its own stops at its end", async () => {
    const cells = recorded()
    linkFilm(12, cells)
    startQueue(ctxFor([cells[1]], { snapshot: true }), 0)
    await wait()
    el("b2")!.tick(3)
    await wait()
    expect(getQueueState().kind).toBe("idle")
  })

  it("another file's lines are not this film's", async () => {
    const cells = recorded()
    setProgrammeFilm({ endSec: 12, cellIds: new Set(["x1", "x2"]) })
    await playTheLinesOut(cells)
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("a take on another track running on past the last line (AQU-2252), beside a film", () => {
  // b2's Track 1 take is a layer of 5 s from b2's start: to 7 s, 2 s past the
  // lines' end at 5 s.
  const layered = () => [line("b1", 2_000), line("b2", 3_000, 5_000)]
  beforeEach(() => {
    setQueueTargetSlots(["recording", TRACK])
    setQueueLayerTrackSlots([TRACK])
  })

  it("with no film it plays out to its own end, as before", async () => {
    await playTheLinesOut(layered())
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().duration).toBeCloseTo(7, 5)
    expect(el("b2-track")!.paused).toBe(false)
    await wait(2_050)
    expect(getQueueState().kind).toBe("idle")
  })

  it("with a longer film the run goes on to the film's end", async () => {
    const cells = layered()
    linkFilm(12, cells)
    await playTheLinesOut(cells)
    expect(getQueueProgress().duration).toBeCloseTo(12, 5)
    expect(el("b2-track")!.paused).toBe(false)
    await wait(2_050)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(5_000)
    expect(getQueueState().kind).toBe("idle")
  })

  it("with a film that ends before it, the run goes on to the take's end", async () => {
    const cells = layered()
    linkFilm(6, cells)
    await playTheLinesOut(cells)
    expect(getQueueProgress().duration).toBeCloseTo(7, 5)
    await wait(1_500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    await wait(550)
    expect(getQueueState().kind).toBe("idle")
  })
})

describe("nothing recorded yet, Skip lines with nothing to play OFF", () => {
  beforeEach(() => setSkipSilentLinesPref(false))

  it("the lines are played through as before, then the film's tail", async () => {
    const cells = [line("b1"), line("b2")]
    linkFilm(6, cells)
    startQueue(ctxFor(cells), 0)
    await wait()
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b1" })
    await wait(3_500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b2" })
    expect(getQueueProgress().currentTime).toBeCloseTo(3.5, 1)
    await wait(2_550)
    expect(getQueueState().kind).toBe("idle")
  })

  it("a film shorter than the lines: every line is still played through, to the lines' end", async () => {
    const cells = [line("b1"), line("b2"), line("b3")]
    linkFilm(2, cells)
    startQueue(ctxFor(cells), 0)
    await wait(3_500)
    expect(getQueueState()).toMatchObject({ kind: "playing", cellId: "b3" })
    await wait(1_050)
    expect(getQueueState().kind).toBe("idle")
  })
})
